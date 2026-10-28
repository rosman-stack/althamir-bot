require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { leerInventario, formatearCatalogo } = require('./sheets');

const app = express();
app.set('trust proxy', 1); // Render va detrás de un proxy: así req.ip es la IP real de cada visitante
// Guardamos el cuerpo "crudo" para poder verificar la firma que Meta manda en /webhook
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET; // compartido con las Netlify functions de Recurrente
const META_APP_SECRET = process.env.META_APP_SECRET; // "Clave secreta de la app" en developers.facebook.com → Configuración → Básica
const crypto = require('crypto');
const pedidos = require('./pedidos');

// ─── Seguridad: firma de Meta, llamadas internas y límite de peticiones ──────
function compararSeguro(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Meta firma cada notificación con HMAC-SHA256 usando el secreto de la app.
// Sin esta verificación, cualquiera que conozca la URL del bot (el repo es
// público) podría mandarle mensajes falsos y hacer que escriba a cualquier número.
function firmaMetaValida(req) {
  if (!META_APP_SECRET) return true; // modo compatible: se avisa al iniciar que falta configurarlo
  const recibida = req.headers['x-hub-signature-256'] || '';
  if (!req.rawBody || !recibida.startsWith('sha256=')) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  return compararSeguro(recibida, esperada);
}

function esLlamadaInterna(req) {
  return !!INTERNAL_API_SECRET && compararSeguro(req.headers['x-internal-secret'], INTERNAL_API_SECRET);
}

// Limitador simple en memoria: máximo `max` peticiones por minuto por IP.
function limitar(max, ventanaMs = 60 * 1000) {
  const registro = new Map();
  return (req, res, next) => {
    const ahora = Date.now();
    const clave = req.ip || 'desconocida';
    const historial = (registro.get(clave) || []).filter(t => ahora - t < ventanaMs);
    historial.push(ahora);
    registro.set(clave, historial);
    if (registro.size > 2000) registro.delete(registro.keys().next().value);
    if (historial.length > max) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'Demasiadas solicitudes, intenta de nuevo en un minuto.' });
    }
    next();
  };
}

// Middleware simple para proteger rutas de administración con un token.
// Uso: agregar ?token=TU_ADMIN_TOKEN a la URL, o header 'x-admin-token'.
function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN) {
    console.warn('[Seguridad] ADMIN_TOKEN no configurado — ruta de admin sin protección');
    return res.status(500).json({ error: 'ADMIN_TOKEN no configurado en el servidor' });
  }
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    console.warn(`[Seguridad] Intento de acceso no autorizado a ${req.path} desde IP ${req.ip}`);
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

const conversaciones = {};
// Mapea el ID de cada mensaje enviado a Telegram -> teléfono del cliente,
// para saber a quién reenviar cuando el asesor responde con "Reply" en Telegram.
const telegramMsgToPhone = {};
const esperandoAsesor = new Set();
const actividadAsesor = new Map();            // teléfono → última actividad (ms)
const AUTO_LIBERAR_MS = 6 * 60 * 60 * 1000;   // Noor retoma el chat tras 6 h sin actividad

const desdeAsesor = new Map();                // teléfono → cuándo empezó la espera (ms)
const ultimoGuardado = new Map();             // teléfono → última vez que se escribió en el Sheet
const GUARDAR_ACTIVIDAD_CADA_MS = 10 * 60 * 1000; // la "última actividad" se refresca en el Sheet como máximo cada 10 min

// El estado de espera también vive en la pestaña "Asesor" del Sheet de pedidos, para sobrevivir a
// reinicios y deploys de Render. Si el Sheet falla, el bot sigue funcionando con la memoria.
function persistirEspera(tel, estado, desdeMs, ultimaMs) {
  ultimoGuardado.set(tel, Date.now());
  pedidos.guardarEsperaAsesor(tel, {
    desde: new Date(desdeMs).toISOString(), ultima: new Date(ultimaMs).toISOString(), estado
  }).catch(e => console.error('[Asesor] No se pudo guardar en el Sheet:', e.message));
}

function ponerEnEspera(tel) {
  const ahora = Date.now();
  const nuevo = !esperandoAsesor.has(tel);
  esperandoAsesor.add(tel);
  actividadAsesor.set(tel, ahora);
  if (nuevo || !desdeAsesor.has(tel)) desdeAsesor.set(tel, ahora);
  persistirEspera(tel, 'Esperando', desdeAsesor.get(tel), ahora);
}
function tocarEspera(tel) {
  if (!esperandoAsesor.has(tel)) return;
  const ahora = Date.now();
  actividadAsesor.set(tel, ahora);
  if (ahora - (ultimoGuardado.get(tel) || 0) > GUARDAR_ACTIVIDAD_CADA_MS) {
    persistirEspera(tel, 'Esperando', desdeAsesor.get(tel) || ahora, ahora);
  }
}
function liberarCliente(tel) {
  const estaba = esperandoAsesor.delete(tel);
  if (estaba) persistirEspera(tel, 'Liberado', desdeAsesor.get(tel) || Date.now(), actividadAsesor.get(tel) || Date.now());
  actividadAsesor.delete(tel);
  desdeAsesor.delete(tel);
  ultimoGuardado.delete(tel);
  conversaciones[tel] = [];
  return estaba;
}

// Si un cliente lleva 6 h sin actividad, Noor retoma el chat y te avisa.
function barrerEsperas() {
  const ahora = Date.now();
  for (const [tel, t] of [...actividadAsesor]) {
    if (ahora - t > AUTO_LIBERAR_MS) {
      liberarCliente(tel);
      console.log(`Cliente ${tel} liberado automáticamente (sin actividad)`);
      telegramEnviarAdmin(`🔓 Noor retomó el chat con +${tel} (6 h sin actividad).`, tel);
    }
  }
}
setInterval(barrerEsperas, 10 * 60 * 1000).unref();

// Al iniciar: recupera del Sheet a quienes seguían esperando asesor y aplica de inmediato la regla de 6 h.
async function restaurarEsperas() {
  try {
    const filas = await Promise.race([
      pedidos.cargarEsperasAsesor(),
      new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo de espera agotado')), 8000))
    ]);
    let n = 0;
    for (const f of filas) {
      if (f.estado !== 'Esperando') continue;
      esperandoAsesor.add(f.telefono);
      actividadAsesor.set(f.telefono, f.ultima);
      desdeAsesor.set(f.telefono, f.desde);
      ultimoGuardado.set(f.telefono, Date.now());
      n++;
    }
    console.log(`[Asesor] ${n} cliente(s) en espera restaurado(s) desde el Sheet`);
    barrerEsperas();
  } catch (e) {
    console.error('[Asesor] No se pudo restaurar el estado desde el Sheet (se sigue con memoria vacía):', e.message);
  }
}

// Horario de atención: Lun-Sab 9am-8pm, hora de Guatemala (UTC-6, sin horario de verano).
function enHorario(ahora = new Date(Date.now())) {
  const gt = new Date(ahora.getTime() - 6 * 60 * 60 * 1000);
  const dia = gt.getUTCDay(), hora = gt.getUTCHours();
  return dia !== 0 && hora >= 9 && hora < 20;
}
function fraseAsesor() {
  return enHorario()
    ? 'En un momento alguien del equipo Althamir estará contigo. Horario: Lun-Sab 9am-8pm'
    : 'Ahora estamos fuera de horario (Lun-Sab 9am-8pm), pero un asesor te responderá en cuanto abramos.';
}

const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp — una perfumería árabe auténtica ubicada en GUATEMALA. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes, como una amiga experta que disfruta genuinamente recomendar el aroma perfecto.

⚠️ MUY IMPORTANTE — MONEDA Y PAÍS:
- TODOS los precios son en QUETZALES GUATEMALTECOS (Q), NUNCA en pesos mexicanos, dólares ni ninguna otra moneda.
- Siempre escribe los precios exactamente como aparecen en el catálogo (con "Q") — nunca uses "$" ni "MXN" ni "pesos".
- Althamir opera ÚNICAMENTE en Guatemala. Si preguntan por envíos a otro país, indica con amabilidad que por ahora solo se envía dentro de Guatemala.

⚠️ MUY IMPORTANTE — PRECIOS EXACTOS, NUNCA RANGOS:
- Cada decant tiene un precio EXACTO de 5ml y un precio EXACTO de 10ml según el catálogo de abajo.
- NUNCA inventes ni generalices un "rango" de precios (por ejemplo, nunca digas algo como "los decants van de Q100 a Q450"). Eso es incorrecto y confunde al cliente.
- Si te preguntan "¿cuánto cuestan los decants?" en general, responde con 2-3 ejemplos concretos del catálogo con su precio EXACTO, o pide el nombre de la fragancia que le interesa para dar el precio preciso.
- Si una fragancia no está en el catálogo de abajo, NO inventes un precio — di que por ahora no la tenemos disponible como decant y ofrece que, si quiere que un asesor la consulte o la cotice, escriba la palabra *asesor*.

⚠️ BOTELLAS COMPLETAS Y MAYOREO — SIEMPRE CON UN ASESOR:
- El catálogo de abajo es SOLO de decants (5ml y 10ml). Las botellas completas NO aparecen en ese catálogo porque un asesor las cotiza una por una.
- NUNCA digas que una botella "no está disponible" ni que "no hay" solo porque no la ves en el catálogo, y NUNCA inventes precios de botellas completas.
- Si preguntan por botella completa, frasco, 50ml, 100ml, mayoreo o reventa: responde que con gusto se les cotiza y que un asesor los atenderá, e invítalos a escribir la palabra *asesor* para comunicarlos.

⚠️ COSTOS DE ENVÍO — LEE CON CUIDADO, NO ES LO MISMO QUE EL PRECIO DE UN PERFUME:
- El envío/entrega/delivery es un cargo APARTE del precio del decant. Cuando pregunten por "envío", "entrega", "delivery" o "cuánto cuesta que me lo lleven", responde con estos montos exactos — NUNCA con el precio de una fragancia:
  - Ciudad de Guatemala (capital): Q30
  - Interior del país: Q40
- Ejemplo de cómo distinguir la pregunta:
  Cliente: "¿Cuánto cuesta el envío?" → Respuesta correcta: "El envío es Q30 dentro de la capital o Q40 al interior 📦"
  Cliente: "¿Cuánto cuesta Yara Moi?" → Respuesta correcta: da el precio del decant de esa fragancia (5ml/10ml), no el costo de envío.
- Si preguntan por el total de un pedido, SÍ puedes sumar producto + envío, pero acláralo como dos montos separados, no un solo precio fusionado.

HERRAMIENTAS Y GUÍAS GRATIS (úsalas solo cuando ayuden al cliente: máximo UN enlace por respuesta, sin presionar y sin repetirlos si ya los enviaste):
- Si no sabe qué perfume elegir o qué aroma le conviene: test de perfumes: https://herramientas.althamirgt.com/test-de-perfumes/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
- Si pregunta cuánto rinde un perfume o cuánto cuesta cada spray o decant: https://herramientas.althamirgt.com/costo-por-spray/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
- Si quiere combinar o mezclar perfumes (layering): https://herramientas.althamirgt.com/layering-de-perfumes/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
- Si pregunta qué es un decant: https://herramientas.althamirgt.com/guias/que-es-un-decant/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
- Si pregunta si un perfume es original: https://herramientas.althamirgt.com/guias/como-saber-si-un-perfume-es-original/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
- Si pregunta cómo aplicar el perfume para que dure más: https://herramientas.althamirgt.com/guias/como-aplicar-perfume-para-que-dure-mas/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
- Si pregunta cómo guardar sus perfumes o decants: https://herramientas.althamirgt.com/guias/como-guardar-perfumes-y-decants/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
- Para otras dudas de perfumería (índice de guías): https://herramientas.althamirgt.com/guias/?utm_source=noor&utm_medium=whatsapp&utm_campaign=bot
Reglas: usa SOLO los enlaces de esta lista, nunca inventes otros. Responde primero la duda del cliente y luego ofrece el enlace en una frase corta. Los precios y la disponibilidad se confirman siempre con el catálogo, nunca con las herramientas.

{{CATALOGO}}

PERSONALIDAD Y TONO:
- Habla con calidez, cercanía y un toque de elegancia — como una amiga experta en perfumes, no un robot
- Usa frases completas y naturales, evita respuestas tipo lista fría
- Varía tus respuestas, no repitas siempre la misma estructura
- Muestra entusiasmo genuino al hablar de las fragancias (ej. "Ese aroma es precioso", "Es uno de mis favoritos")
- Usa emojis con moderación y naturalidad

REGLAS IMPORTANTES:
- Saluda siempre con el saludo apropiado según la hora indicada en el contexto
- Para ver el catálogo completo con fotos siempre comparte: althamirgt.com
- Para pedidos, dile al cliente que un asesor le va a confirmar los detalles
- Si no sabes algo, di que un asesor le ayudará enseguida
- Respuestas cortas y conversacionales, máximo 4-5 líneas. Ve directo a la respuesta — evita relleno o repetir la pregunta antes de contestar, así no se corta la respuesta a media frase.
- Nunca inventes productos, precios ni rangos de precio fuera del catálogo
- Nunca uses pesos, dólares ni ninguna moneda que no sea quetzales (Q)
- Si un producto NO aparece en el catálogo, indica que no está disponible actualmente
- Si alguien pregunta qué recomiendas, pregunta con calidez: ¿prefieres algo floral, amaderado, cítrico o especiado? ¿es para el día a día o una ocasión especial?
- Usa lenguaje neutro al dirigirte al cliente. Nunca asumas género.`;

// Catálogo de respaldo por si falla Sheets
const CATALOGO_FALLBACK = `CATÁLOGO (puede no estar actualizado):
LATTAFA: Yara Moi (5ml Q40 · 10ml Q65) · Yara Rosa (5ml Q40 · 10ml Q65) · Asad (5ml Q45 · 10ml Q75) · Ra'ed Luxe (5ml Q35 · 10ml Q60)
AL HARAMAIN: Amber Oud Gold Edition (5ml Q50 · 10ml Q90)
Para catálogo completo y actualizado visita althamirgt.com`;

async function getNoorSystem() {
  try {
    const productos = await leerInventario();
    const catalogo = formatearCatalogo(productos);
    return NOOR_SYSTEM_BASE.replace('{{CATALOGO}}', catalogo || CATALOGO_FALLBACK);
  } catch (err) {
    console.error('[Noor] Usando catálogo de respaldo:', err.message);
    return NOOR_SYSTEM_BASE.replace('{{CATALOGO}}', CATALOGO_FALLBACK);
  }
}

function getSaludo() {
  const hora = new Date(Date.now() - 6 * 60 * 60 * 1000).getUTCHours();
  if (hora >= 5 && hora < 12) return 'buenos días';
  if (hora >= 12 && hora < 19) return 'buenas tardes';
  return 'buenas noches';
}

function esOrdenWeb(texto) {
  return texto.includes('NUEVA ORDEN ALTHAMIR') || texto.includes('ALT-');
}

function quiereAsesor(texto) {
  const t = texto.toLowerCase();
  return t.includes('asesor') || t.includes('persona') || t.includes('humano') ||
         t.includes('agente') || t.includes('hablar con') || t.includes('vendedor') ||
         t.includes('pedido') || t.includes('confirmar') || t.includes('ordenar');
}

function sinAcentos(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

// Las botellas completas y el mayoreo no están en el catálogo de decants: los cotiza un asesor.
// Se detecta aquí (no con el modelo) para que SIEMPRE se derive y nunca se conteste "no hay".
// Si el mensaje habla de "decant", se deja que Noor responda con el catálogo.
function tipoCotizacion(texto) {
  const t = sinAcentos(texto);
  if (/\bdecants?\b/.test(t)) return null;
  if (/\b(mayoreo|mayorista|mayoristas|por mayor|al por mayor|revender|reventa)\b/.test(t)) return 'mayoreo';
  if (/\b(botella|botellas|frasco|frascos)\b/.test(t) || /\b(50|100)\s?ml\b/.test(t)) return 'botella';
  return null;
}

// Meta puede entregar el MISMO mensaje más de una vez (reintentos). Recordamos el id de
// cada mensaje 15 minutos para no contestarlo dos veces.
const mensajesVistos = new Map();
function yaProcesado(id) {
  if (!id) return false;
  const ahora = Date.now();
  if (mensajesVistos.size > 500) {
    for (const [k, t] of mensajesVistos) if (ahora - t > 15 * 60 * 1000) mensajesVistos.delete(k);
  }
  if (mensajesVistos.has(id)) return true;
  mensajesVistos.set(id, ahora);
  return false;
}

async function enviarMensaje(telefono, mensaje) {
  const texto = typeof mensaje === 'string' ? mensaje.trim() : '';
  if (!texto) {
    console.warn(`[WhatsApp] Mensaje vacío para ${telefono} — no se envía (WhatsApp lo rechazaría)`);
    return false;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto.slice(0, 4096) } },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch (err) {
    console.error('Error enviando mensaje:', err.response?.data || err.message);
    return false;
  }
}

async function notificarAdmin(tipo, telefono, mensaje) {
  const titulo = tipo === 'asesor' ? 'Asesor requerido - Althamir' : 'Nueva orden - Althamir';
  const cuerpo = `Cliente: +${telefono}\n${mensaje}`;

  // Envía a Telegram y guarda el message_id -> teléfono, para que si el
  // asesor responde a ESE mensaje (con "Reply" en Telegram), sepamos a qué
  // cliente reenviar la respuesta por WhatsApp.
  const aviso = enHorario() ? '' : '\n🌙 Fuera de horario: atender cuando abras.';
  const msgId = await telegramEnviarAdmin(`📣 *${titulo}*\n\n${cuerpo}${aviso}\n\n_Responde a este mensaje para contestarle por WhatsApp. Escribe /liberar como respuesta para que Noor retome el chat._`, telefono);
  return msgId;
}

// Reenvía un mensaje nuevo del cliente mientras está esperando asesor
// (para que el asesor vea la conversación completa en Telegram, no solo el primero).
async function reenviarMensajeClienteATelegram(telefono, texto) {
  tocarEspera(telefono);
  await telegramEnviarAdmin(`💬 +${telefono}: ${texto}\n\n_Responde a este mensaje para contestarle. /liberar para que Noor retome el chat._`, telefono);
}

async function telegramEnviarAdmin(texto, telefono) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    let res;
    try {
      res = await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: 'Markdown' });
    } catch (e) {
      // Un nombre o mensaje con _ * ` [ rompe el formato Markdown y Telegram lo rechaza (400):
      // antes el aviso se perdía. Reintentamos sin formato para que SIEMPRE llegue.
      if (e.response?.status !== 400) throw e;
      res = await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: texto });
    }
    const msgId = res.data?.result?.message_id;
    if (msgId) telegramMsgToPhone[msgId] = telefono;
    return msgId;
  } catch (e) {
    console.error('Error notificando admin (Telegram):', e.response?.data || e.message);
    return null;
  }
}

// Arma un cuerpo multipart/form-data a mano (sin depender de la versión de Node ni de paquetes extra)
function armarMultipart(campos, archivo) {
  const limite = '----althamir' + crypto.randomBytes(8).toString('hex');
  const partes = [];
  for (const [k, v] of Object.entries(campos)) {
    partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  const nombre = String(archivo.nombre || 'archivo').replace(/["\r\n\\]/g, '_');
  partes.push(
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${archivo.campo}"; filename="${nombre}"\r\nContent-Type: ${archivo.mime || 'application/octet-stream'}\r\n\r\n`),
    archivo.buffer,
    Buffer.from(`\r\n--${limite}--\r\n`)
  );
  return { body: Buffer.concat(partes), tipo: `multipart/form-data; boundary=${limite}` };
}

const NOMBRE_ARCHIVO = { image: 'foto', audio: 'audio', video: 'video', document: 'documento', location: 'ubicación' };
const MAX_ARCHIVO = 20 * 1024 * 1024; // 20 MB

// Descarga el archivo desde WhatsApp y lo manda a tu Telegram para que lo veas sin abrir WhatsApp
async function reenviarArchivoATelegram(m, telefono, leyenda) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const tipo = m.type, datos = m[tipo] || {};
  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  const titulo = `📎 +${telefono} envió su ${NOMBRE_ARCHIVO[tipo]}${leyenda ? `: ${leyenda}` : ''}`.slice(0, 1000);
  try {
    if (tipo === 'location') {
      const r = await axios.post(`${base}/sendLocation`, { chat_id: TELEGRAM_CHAT_ID, latitude: datos.latitude, longitude: datos.longitude });
      if (r.data?.result?.message_id) telegramMsgToPhone[r.data.result.message_id] = telefono;
      await telegramEnviarAdmin(`${titulo}${datos.address ? `\n${datos.address}` : ''}\n\n_Responde a este mensaje para contestarle._`, telefono);
      return;
    }
    const auth = { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } };
    const info = await axios.get(`https://graph.facebook.com/v25.0/${encodeURIComponent(datos.id)}`, auth);
    if (info.data?.file_size && info.data.file_size > MAX_ARCHIVO) throw new Error('archivo demasiado grande');
    const bin = await axios.get(info.data.url, { ...auth, responseType: 'arraybuffer', maxContentLength: MAX_ARCHIVO, timeout: 25000 });
    const buffer = Buffer.from(bin.data);
    const mime = (info.data.mime_type || datos.mime_type || '').toLowerCase();
    let metodo = 'sendDocument', campo = 'document';
    if (tipo === 'image' && /^image\/(jpeg|png)/.test(mime)) { metodo = 'sendPhoto'; campo = 'photo'; }
    else if (tipo === 'audio' && mime.includes('ogg')) { metodo = 'sendVoice'; campo = 'voice'; }
    else if (tipo === 'audio' && /mpeg|mp4|m4a|aac/.test(mime)) { metodo = 'sendAudio'; campo = 'audio'; }
    else if (tipo === 'video' && mime.includes('mp4')) { metodo = 'sendVideo'; campo = 'video'; }
    const extension = (mime.split('/')[1] || 'bin').split(';')[0];
    const { body, tipo: contentType } = armarMultipart(
      { chat_id: TELEGRAM_CHAT_ID, caption: `${titulo}\n\nResponde a este mensaje para contestarle.` },
      { campo, nombre: datos.filename || `${tipo}-${telefono}.${extension}`, mime, buffer }
    );
    const r = await axios.post(`${base}/${metodo}`, body, { headers: { 'Content-Type': contentType }, maxBodyLength: MAX_ARCHIVO + 1024 * 1024 });
    if (r.data?.result?.message_id) telegramMsgToPhone[r.data.result.message_id] = telefono;
  } catch (e) {
    console.error('[Archivo→Telegram] No se pudo reenviar:', e.response?.data || e.message);
    await telegramEnviarAdmin(`${titulo}\n\n⚠️ No pude descargarlo: ábrelo en WhatsApp Business.\n\n_Responde a este mensaje para contestarle._`, telefono);
  }
}

async function procesarArchivo(m) {
  const tipo = m.type;
  if (!NOMBRE_ARCHIVO[tipo]) { console.log(`[Webhook] Mensaje tipo "${tipo}" de ${m.from} — ignorado`); return; }
  const telefono = m.from;
  const leyenda = String((m[tipo] || {}).caption || '').slice(0, 500);
  console.log(`Archivo (${tipo}) de ${telefono}`);
  if (!esperandoAsesor.has(telefono)) {
    ponerEnEspera(telefono);
    await enviarMensaje(telefono, `Recibí tu ${NOMBRE_ARCHIVO[tipo]} 🙏 Un asesor lo revisará y te responderá. ${fraseAsesor()}`);
    await notificarAdmin('asesor', telefono, `[ARCHIVO: ${NOMBRE_ARCHIVO[tipo]}]${leyenda ? ' ' + leyenda : ''}`);
  } else {
    tocarEspera(telefono);
  }
  await reenviarArchivoATelegram(m, telefono, leyenda);
}

async function llamarGroq(historial) {
  const systemPrompt = await getNoorSystem();
  const pedir = async (maxTokens) => {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'system', content: systemPrompt }, ...historial],
        max_tokens: maxTokens,
        temperature: 0.7
      },
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    const eleccion = res.data.choices?.[0];
    return { texto: (eleccion?.message?.content || '').trim(), motivo: eleccion?.finish_reason };
  };
  // Este modelo "razona" antes de contestar y ese razonamiento gasta parte de max_tokens:
  // a veces se agota el límite y la respuesta llega VACÍA (y WhatsApp rechaza un texto vacío).
  // Reintentamos una vez con más margen; si sigue vacía, devolvemos '' y el webhook deriva a un asesor.
  let r = await pedir(450);
  if (!r.texto) {
    console.warn(`[Groq] Respuesta vacía (finish_reason: ${r.motivo}) — reintentando con más margen`);
    r = await pedir(1000);
    if (!r.texto) console.warn(`[Groq] Respuesta vacía otra vez (finish_reason: ${r.motivo})`);
  }
  return r.texto;
}

// ─── Webhook ────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  if (!firmaMetaValida(req)) {
    console.warn('[Seguridad] /webhook con firma inválida — descartado');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  // Un mismo aviso de Meta puede traer varios mensajes: se atienden todos (antes solo el primero).
  for (const entrada of req.body?.entry || []) {
    for (const cambio of entrada.changes || []) {
      for (const mensaje of cambio.value?.messages || []) {
        if (yaProcesado(mensaje.id)) {
          console.log(`[Webhook] Mensaje ${mensaje.id} repetido por Meta — ignorado`);
          continue;
        }
        await procesarMensaje(mensaje);
      }
    }
  }
});

async function procesarMensaje(mensaje) {
  try {
    await estadoCargado;
    if (!mensaje) return;
    if (mensaje.type !== 'text') { await procesarArchivo(mensaje); return; }
    const telefono = mensaje.from;
    const texto = mensaje.text.body.trim();
    console.log(`Mensaje de ${telefono}: ${texto}`);

    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `Orden recibida. ${enHorario() ? 'Un asesor te contactará en breve para confirmar detalles. Horario Lun-Sab 9am-8pm' : 'Estamos fuera de horario (Lun-Sab 9am-8pm); un asesor te contactará en cuanto abramos para confirmar los detalles.'}`);
      // Nota: ya NO avisamos aquí a Telegram — el pedido se registra y notifica
      // desde el sitio al momento de dar clic en "Enviar Orden" (ruta POST
      // /pedido), antes de que el cliente llegue a mandar este mensaje. Avisar
      // otra vez aquí duplicaría el aviso del mismo pedido.
      return;
    }

    const cotizacion = tipoCotizacion(texto);
    if (cotizacion && !esperandoAsesor.has(telefono)) {
      const aviso = cotizacion === 'mayoreo'
        ? `Con gusto te ayudamos con precios de mayoreo. Te comunico con un asesor. ${fraseAsesor()}`
        : `Con gusto te cotizamos la botella completa. Te comunico con un asesor. ${fraseAsesor()}`;
      await enviarMensaje(telefono, aviso);
      ponerEnEspera(telefono);
      await notificarAdmin('asesor', telefono, `[COTIZAR ${cotizacion.toUpperCase()}] ${texto}`);
      return;
    }

    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Con gusto te comunico con un asesor. ${fraseAsesor()}`);
      if (!esperandoAsesor.has(telefono)) {
        ponerEnEspera(telefono);
        await notificarAdmin('asesor', telefono, texto);
      }
      return;
    }

    if (esperandoAsesor.has(telefono)) {
      console.log(`Cliente ${telefono} esperando asesor — Noor en pausa`);
      tocarEspera(telefono);
      await reenviarMensajeClienteATelegram(telefono, texto);
      return;
    }

    if (!conversaciones[telefono]) conversaciones[telefono] = [];
    const esPrimerMensaje = conversaciones[telefono].length === 0;
    conversaciones[telefono].push({ role: 'user', content: texto });
    if (conversaciones[telefono].length > 20) conversaciones[telefono] = conversaciones[telefono].slice(-20);

    let historial = [...conversaciones[telefono]];
    if (esPrimerMensaje) {
      historial[0] = { role: 'user', content: `(El cliente escribe a las ${getSaludo()}, salúdale apropiadamente.) ${texto}` };
    }

    const respuesta = await llamarGroq(historial);
    if (!respuesta) {
      // El modelo no produjo texto (ni con reintento): no dejamos al cliente sin respuesta.
      conversaciones[telefono].pop(); // no guardamos el turno fallido
      await enviarMensaje(telefono, `Disculpa, no pude procesar tu mensaje 🙏 Te comunico con un asesor para atenderte mejor. ${fraseAsesor()}`);
      if (!esperandoAsesor.has(telefono)) {
        ponerEnEspera(telefono);
        await notificarAdmin('asesor', telefono, `[NOOR SIN RESPUESTA] ${texto}`);
      }
      return;
    }
    conversaciones[telefono].push({ role: 'assistant', content: respuesta });
    if (await enviarMensaje(telefono, respuesta)) console.log(`Respuesta enviada a ${telefono}`);

  } catch (error) {
    console.error('Error procesando mensaje:', error.message);
    // Antes este catch solo logueaba — el cliente se quedaba sin ninguna
    // respuesta. Ahora le avisamos algo razonable y te notificamos a ti
    // por Telegram para que puedas atenderlo manualmente si hace falta.
    try {
      const mensajeOriginal = mensaje;
      const telefono = mensajeOriginal?.from;
      if (telefono) {
        await enviarMensaje(telefono, 'Disculpa, tuve un problema técnico procesando tu mensaje 🙏 Un asesor te va a escribir en breve, o puedes visitar althamirgt.com mientras tanto.');
        await notificarAdmin('asesor', telefono, `[FALLO TÉCNICO] ${error.message} — mensaje original: "${mensajeOriginal?.text?.body || ''}"`);
      }
    } catch (errorFallback) {
      console.error('Error enviando mensaje de respaldo:', errorFallback.message);
    }
  }
}

// ─── Rutas de administración ─────────────────────────────────────────────────

app.get('/liberar', requireAdminToken, (req, res) => {
  const telefono = req.query.telefono;
  if (!telefono) return res.status(400).json({ error: 'Falta el parámetro telefono' });
  liberarCliente(telefono);
  console.log(`Cliente ${telefono} liberado — Noor retoma el chat`);
  res.json({ success: true, mensaje: `Noor retoma el chat con ${telefono}` });
});

// Endpoint para forzar recarga del inventario (útil después de editar el Sheet)
app.get('/reload-inventario', requireAdminToken, async (req, res) => {
  try {
    const { leerInventario, formatearCatalogo } = require('./sheets');
    // Forzar recarga limpiando caché internamente llamando directo
    const productos = await leerInventario();
    res.json({ success: true, productos_activos: productos?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Puente Telegram → WhatsApp ──────────────────────────────────────────────
// Cuando respondes ("Reply") a un mensaje de aviso en Telegram, este webhook
// recibe la actualización, identifica al cliente original por el message_id
// al que respondiste, y reenvía tu texto al cliente por WhatsApp.

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // Telegram solo necesita el 200 rápido, no espera contenido
  try {
    // Si configuraste el secret_token al registrar el webhook, lo validamos aquí
    // para asegurarnos que la petición viene realmente de Telegram.
    if (TELEGRAM_WEBHOOK_SECRET) {
      const secretRecibido = req.headers['x-telegram-bot-api-secret-token'];
      if (secretRecibido !== TELEGRAM_WEBHOOK_SECRET) {
        console.warn('[Telegram] Webhook con secret inválido — descartado');
        return;
      }
    }

    const mensaje = req.body.message;
    if (!mensaje || !mensaje.text) return;

    // Solo aceptamos mensajes que vengan de TU chat de Telegram
    if (TELEGRAM_CHAT_ID && String(mensaje.chat?.id) !== String(TELEGRAM_CHAT_ID)) {
      console.warn('[Telegram] Mensaje de un chat no autorizado — descartado');
      return;
    }

    await estadoCargado; // si el bot acaba de iniciar, primero se recupera quién esperaba asesor

    const comando = mensaje.text.trim();
    const mLiberar = comando.match(/^\/liberar(?:@\w+)?(?:\s+\+?(\d{8,15}))?\s*$/i);

    if (/^\/pendientes(?:@\w+)?\s*$/i.test(comando)) {
      const lista = [...actividadAsesor].map(([tel, t]) => `+${tel} (hace ${Math.round((Date.now() - t) / 60000)} min)`);
      await telegramEnviarAdmin(lista.length ? `⏳ Clientes esperando asesor:\n${lista.join('\n')}` : '✅ No hay clientes esperando asesor.', null);
      return;
    }
    if (mLiberar && mLiberar[1]) { // /liberar 502XXXXXXXX (sin necesidad de responder a un aviso)
      const hubo = liberarCliente(mLiberar[1]);
      await telegramEnviarAdmin(hubo ? `🔓 Noor retomó el chat con +${mLiberar[1]}.` : `ℹ️ +${mLiberar[1]} no estaba esperando asesor.`, null);
      return;
    }

    // Solo procesamos si es una RESPUESTA (reply) a uno de nuestros avisos —
    // así evitamos que cualquier mensaje suelto en el chat intente reenviarse.
    const replyToId = mensaje.reply_to_message?.message_id;
    const replyToTexto = mensaje.reply_to_message?.text || mensaje.reply_to_message?.caption || '';
    if (!replyToId) {
      await telegramEnviarAdmin(mLiberar ? '⚠️ Usa /liberar como respuesta (Reply) al aviso del cliente, o escribe /liberar 502XXXXXXXX.' : '⚠️ Para responderle al cliente, usa "Responder" (Reply) sobre su mensaje, no escribas suelto. Comandos: /pendientes y /liberar.', null);
      return;
    }

    // Primero busca en memoria (rápido). Si el proceso se reinició — Render
    // free duerme el servicio tras inactividad y esa memoria se borra — no
    // pasa nada: Telegram sí conserva el texto del mensaje original, y ese
    // texto siempre trae el teléfono ("Cliente: +502..." o "💬 +502...:"),
    // así que lo recuperamos de ahí como respaldo, sin depender de la memoria.
    let telefono = telegramMsgToPhone[replyToId];
    if (!telefono) {
      const match = replyToTexto.match(/\+(\d{8,15})/);
      telefono = match ? match[1] : null;
      if (telefono) console.log(`[Telegram→WhatsApp] Teléfono recuperado del texto (memoria vacía, probable reinicio del servicio): ${telefono}`);
    }

    if (!telefono) {
      await telegramEnviarAdmin('⚠️ No encontré el teléfono del cliente en ese mensaje. Intenta responder directamente sobre el aviso original de "Cliente: +502...".', null);
      return;
    }

    if (mLiberar) {
      const hubo = liberarCliente(telefono);
      await telegramEnviarAdmin(hubo ? `🔓 Noor retomó el chat con +${telefono}.` : `ℹ️ +${telefono} no estaba esperando asesor.`, null);
      return;
    }
    if (comando.startsWith('/')) { // un comando desconocido jamás se reenvía al cliente
      await telegramEnviarAdmin('⚠️ Comando no reconocido. Disponibles: /liberar y /pendientes.', null);
      return;
    }

    await enviarMensaje(telefono, mensaje.text);
    tocarEspera(telefono);
    // Nota: NO liberamos automáticamente a Noor aquí — dejamos que tú decidas
    // cuándo terminó la conversación escribiendo /liberar (como respuesta al aviso del cliente)
    // en Telegram; si pasan 6 h sin actividad, Noor retoma el chat sola.
    // (así evitamos que Noor y tú respondan al mismo tiempo a media conversación)
    console.log(`[Telegram→WhatsApp] Respuesta del asesor reenviada a ${telefono}`);

  } catch (error) {
    console.error('[Telegram webhook] Error:', error.message);
  }
});

// ─── Sistema de Pedidos ───────────────────────────────────────────────────
const ALLOWED_ORIGIN = 'https://althamirgt.com';

function conCORS(res) {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Secret');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

const limitePedidosCrear = limitar(6);
const limitePedidosConsultar = limitar(15);
const conLimite = (limite) => (req, res, next) => { conCORS(res); return limite(req, res, next); };

app.options(['/pedido', '/pedido/:telefono', '/pedido/confirmar-pago'], (req, res) => {
  conCORS(res); res.sendStatus(200);
});

// Crear un pedido nuevo — lo llama el sitio (WhatsApp) y recurrente-checkout.js (tarjeta)
app.post('/pedido', (req, res, next) => (esLlamadaInterna(req) ? next() : conLimite(limitePedidosCrear)(req, res, next)), async (req, res) => {
  conCORS(res);
  try {
    const cuerpo = req.body || {};
    const { cliente, telefono, direccion, productos } = cuerpo;
    const total = Number(cuerpo.total);
    // Quien llama desde el navegador (público) NO puede elegir canal ni estado:
    // solo las funciones de Netlify (con el secreto interno) pueden crear pedidos de tarjeta.
    const interno = esLlamadaInterna(req);
    const canal = interno && cuerpo.canal === 'Tarjeta' ? 'Tarjeta' : 'WhatsApp';
    const estado = interno && cuerpo.estado === 'Pendiente de pago' ? 'Pendiente de pago' : 'Procesando';

    const telefonoOk = typeof telefono === 'string' && telefono.replace(/\D/g, '').length >= 8 && telefono.length <= 30;
    const productosOk = typeof productos === 'string' && productos.trim().length > 0 && productos.length <= 1500;
    const totalOk = Number.isFinite(total) && total > 0 && total <= 50000;
    const largoOk = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
    if (!telefonoOk || !productosOk || !totalOk || !largoOk(cliente, 120) || !largoOk(direccion, 400)) {
      return res.status(400).json({ error: 'Datos del pedido inválidos (teléfono, productos, total)' });
    }
    const orderId = await pedidos.crearPedido({ cliente, telefono, direccion, productos, total, canal, estado });

    const icono = canal === 'Tarjeta' ? '💳' : '💵';
    const estadoInicial = estado || (canal === 'Tarjeta' ? 'Pendiente de pago' : 'Procesando');
    await telegramEnviarAdmin(
      `${icono} *Nuevo pedido* (${canal || 'WhatsApp'})\n\n` +
      `📋 Orden: ${orderId}\n` +
      `👤 Cliente: ${cliente || 'Sin nombre'}\n` +
      `📞 Teléfono: ${telefono}\n` +
      `📍 Dirección: ${direccion || 'No especificada'}\n` +
      `🧴 Productos: ${productos}\n` +
      `💰 Total: Q${total}\n` +
      `📌 Estado: ${estadoInicial}`,
      telefono
    );

    res.json({ orderId });
  } catch (error) {
    console.error('[Pedido] Error creando pedido:', error.message);
    res.status(500).json({ error: 'No se pudo registrar el pedido' });
  }
});

// Consulta pública del cliente por teléfono — sin login, solo ve sus propios pedidos
app.get('/pedido/:telefono', conLimite(limitePedidosConsultar), async (req, res) => {
  conCORS(res);
  try {
    const resultados = await pedidos.buscarPorTelefono(req.params.telefono);
    res.json({ pedidos: resultados });
  } catch (error) {
    console.error('[Pedido] Error buscando por teléfono:', error.message);
    res.status(500).json({ error: 'No se pudo consultar el pedido' });
  }
});

// Confirmación de pago — SOLO la llama el webhook de Recurrente (Netlify), nunca el navegador
app.post('/pedido/confirmar-pago', async (req, res) => {
  const secretRecibido = req.headers['x-internal-secret'];
  if (!INTERNAL_API_SECRET || secretRecibido !== INTERNAL_API_SECRET) {
    console.warn('[Pedido] Intento de confirmar pago sin secret interno válido');
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const { telefono, monto } = req.body;
    const orderId = await pedidos.buscarPendienteParaConfirmar(telefono, monto);
    if (!orderId) {
      console.warn('[Pedido] No se encontró pedido pendiente que coincida con el pago');
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    await pedidos.actualizarEstadoPedido(orderId, { estado: 'Pagado' });
    res.json({ orderId, actualizado: true });
  } catch (error) {
    console.error('[Pedido] Error confirmando pago:', error.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/', (req, res) => res.send('Noor - Bot de WhatsApp Althamir funcionando'));

// ─── Monitor de salud ───────────────────────────────────────────────────────
// Pensado para que un servicio externo (ej. cron-job.org) le pegue cada
// 10-15 min. No solo confirma que el servidor responde — hace una llamada
// REAL a Groq (con costo mínimo) para detectar justo el tipo de falla que
// nos dejó sin Noor en WhatsApp cuando decomisionaron el modelo viejo sin
// que nos enteráramos a tiempo.
let ultimaAlertaSalud = 0;
const ALERTA_COOLDOWN_MS = 45 * 60 * 1000; // no repetir la misma alerta antes de 45 min

let saludCache = null; // { t, status, body } — evita que llamar /health en bucle gaste cuota de Groq y de Sheets
app.get('/health', async (req, res) => {
  if (saludCache && Date.now() - saludCache.t < 60 * 1000) return res.status(saludCache.status).json(saludCache.body);
  const problemas = [];

  if (!GROQ_API_KEY) {
    problemas.push('GROQ_API_KEY no configurada');
  } else {
    try {
      await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
    } catch (e) {
      problemas.push(`Groq falló: ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);
    }
  }

  if (!process.env.WHATSAPP_TOKEN) problemas.push('WHATSAPP_TOKEN no configurada');
  if (!process.env.PHONE_NUMBER_ID) problemas.push('PHONE_NUMBER_ID no configurada');
  if (!process.env.GOOGLE_CREDENTIALS_JSON) problemas.push('GOOGLE_CREDENTIALS_JSON no configurada');

  try {
    const { leerInventario } = require('./sheets');
    const inv = await leerInventario();
    if (!inv || inv.length === 0) problemas.push('Sheets: inventario vacío o inaccesible');
  } catch (e) {
    problemas.push(`Sheets falló: ${e.message}`);
  }

  try {
    await pedidos.verificarConexion();
  } catch (e) {
    // Antes todo error decía "revisa el nombre de la pestaña", aunque fuera un fallo pasajero de Google.
    const codigo = Number(e.code || (e.response && e.response.status));
    let causa;
    if (codigo === 400 && /parse range|range/i.test(e.message)) causa = `no encuentro la pestaña: revisa el nombre en pedidos.js (${e.message})`;
    else if (codigo === 403) causa = `sin permiso: comparte el Sheet de pedidos con la cuenta de servicio como Editor (${e.message})`;
    else if (codigo === 404) causa = `no encuentro el archivo: revisa PEDIDOS_SHEET_ID (${e.message})`;
    else if (codigo === 429 || codigo >= 500 || /Internal error/i.test(e.message)) causa = `Google Sheets tuvo un error temporal, incluso tras reintentar (${codigo || 's/c'}: ${e.message}). Suele resolverse solo; no es el nombre de la pestaña.`;
    else causa = e.message;
    problemas.push(`Sheet de Pedidos inaccesible: ${causa}`);
  }

  const ok = problemas.length === 0;

  if (!ok) {
    const ahora = Date.now();
    if (ahora - ultimaAlertaSalud > ALERTA_COOLDOWN_MS) {
      ultimaAlertaSalud = ahora;
      await telegramEnviarAdmin(`🚨 *Monitor de salud detectó un problema*\n\n${problemas.map(p => '• ' + p).join('\n')}`, null);
    }
  }

  const cuerpoSalud = { ok, problemas, timestamp: new Date().toISOString() };
  saludCache = { t: Date.now(), status: ok ? 200 : 503, body: cuerpoSalud };
  res.status(ok ? 200 : 503).json(cuerpoSalud);
});

const PORT = process.env.PORT || 3000;
const estadoCargado = restaurarEsperas(); // los mensajes esperan a que termine (máx. 8 s)

app.listen(PORT, () => {
  console.log(`Noor bot activo en puerto ${PORT}`);
  if (!META_APP_SECRET) console.warn('[Seguridad] META_APP_SECRET no configurado — /webhook NO verifica la firma de Meta. Configúralo en Render.');
  if (!TELEGRAM_WEBHOOK_SECRET) console.warn('[Seguridad] TELEGRAM_WEBHOOK_SECRET no configurado — /telegram-webhook acepta cualquier origen.');
  if (!INTERNAL_API_SECRET) console.warn('[Seguridad] INTERNAL_API_SECRET no configurado — los pedidos con tarjeta no podrán registrarse.');
  // Pre-cargar inventario al arrancar
  leerInventario().then(p => console.log(`[Inicio] ${p?.length || 0} productos cargados desde Sheets`));
});
