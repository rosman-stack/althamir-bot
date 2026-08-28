require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { leerInventario, formatearCatalogo } = require('./sheets');

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const NTFY_TOPIC      = process.env.NTFY_TOPIC;
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET; // compartido con las Netlify functions de Recurrente
const pedidos = require('./pedidos');

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

const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp — una perfumería árabe auténtica ubicada en GUATEMALA. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes, como una amiga experta que disfruta genuinamente recomendar el aroma perfecto.

⚠️ MUY IMPORTANTE — MONEDA Y PAÍS:
- TODOS los precios son en QUETZALES GUATEMALTECOS (Q), NUNCA en pesos mexicanos, dólares ni ninguna otra moneda.
- Siempre escribe los precios exactamente como aparecen en el catálogo (con "Q") — nunca uses "$" ni "MXN" ni "pesos".
- Althamir opera ÚNICAMENTE en Guatemala. Si preguntan por envíos a otro país, indica con amabilidad que por ahora solo se envía dentro de Guatemala.

⚠️ MUY IMPORTANTE — PRECIOS EXACTOS, NUNCA RANGOS:
- Cada decant tiene un precio EXACTO de 5ml y un precio EXACTO de 10ml según el catálogo de abajo.
- NUNCA inventes ni generalices un "rango" de precios (por ejemplo, nunca digas algo como "los decants van de Q100 a Q450"). Eso es incorrecto y confunde al cliente.
- Si te preguntan "¿cuánto cuestan los decants?" en general, responde con 2-3 ejemplos concretos del catálogo con su precio EXACTO, o pide el nombre de la fragancia que le interesa para dar el precio preciso.
- Si una fragancia no está en el catálogo de abajo, NO inventes un precio — di que no está disponible actualmente.

⚠️ COSTOS DE ENVÍO — LEE CON CUIDADO, NO ES LO MISMO QUE EL PRECIO DE UN PERFUME:
- El envío/entrega/delivery es un cargo APARTE del precio del decant. Cuando pregunten por "envío", "entrega", "delivery" o "cuánto cuesta que me lo lleven", responde con estos montos exactos — NUNCA con el precio de una fragancia:
  - Ciudad de Guatemala (capital): Q30
  - Interior del país: Q40
- Ejemplo de cómo distinguir la pregunta:
  Cliente: "¿Cuánto cuesta el envío?" → Respuesta correcta: "El envío es Q30 dentro de la capital o Q40 al interior 📦"
  Cliente: "¿Cuánto cuesta Yara Moi?" → Respuesta correcta: da el precio del decant de esa fragancia (5ml/10ml), no el costo de envío.
- Si preguntan por el total de un pedido, SÍ puedes sumar producto + envío, pero acláralo como dos montos separados, no un solo precio fusionado.

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

async function enviarMensaje(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error enviando mensaje:', err.response?.data || err.message);
  }
}

async function notificarAdmin(tipo, telefono, mensaje) {
  const titulo = tipo === 'asesor' ? 'Asesor requerido - Althamir' : 'Nueva orden - Althamir';
  const cuerpo = `Cliente: +${telefono}\n${mensaje}`;

  if (NTFY_TOPIC) {
    try {
      await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, cuerpo, {
        headers: { 'Title': titulo, 'Priority': 'high', 'Content-Type': 'text/plain' }
      });
    } catch(e) {
      console.error('Error notificando admin (ntfy):', e.message);
    }
  }

  // Envía también a Telegram y guarda el message_id -> teléfono, para que si el
  // asesor responde a ESE mensaje (con "Reply" en Telegram), sepamos a qué
  // cliente reenviar la respuesta por WhatsApp.
  const msgId = await telegramEnviarAdmin(`📣 *${titulo}*\n\n${cuerpo}\n\n_Responde a este mensaje para contestarle por WhatsApp._`, telefono);
  return msgId;
}

// Reenvía un mensaje nuevo del cliente mientras está esperando asesor
// (para que el asesor vea la conversación completa en Telegram, no solo el primero).
async function reenviarMensajeClienteATelegram(telefono, texto) {
  await telegramEnviarAdmin(`💬 +${telefono}: ${texto}\n\n_Responde a este mensaje para contestarle._`, telefono);
}

async function telegramEnviarAdmin(texto, telefono) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: 'Markdown' }
    );
    const msgId = res.data?.result?.message_id;
    if (msgId) telegramMsgToPhone[msgId] = telefono;
    return msgId;
  } catch (e) {
    console.error('Error notificando admin (Telegram):', e.response?.data || e.message);
    return null;
  }
}

async function llamarGroq(historial) {
  const systemPrompt = await getNoorSystem();
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'system', content: systemPrompt }, ...historial],
      max_tokens: 450,
      temperature: 0.7
    },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
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
  res.sendStatus(200);
  try {
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== 'text') return;
    const telefono = mensaje.from;
    const texto = mensaje.text.body.trim();
    console.log(`Mensaje de ${telefono}: ${texto}`);

    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `Orden recibida. Un asesor te contactará en breve para confirmar detalles. Horario Lun-Sab 9am-8pm`);
      // Nota: ya NO avisamos aquí a Telegram — el pedido se registra y notifica
      // desde el sitio al momento de dar clic en "Enviar Orden" (ruta POST
      // /pedido), antes de que el cliente llegue a mandar este mensaje. Avisar
      // otra vez aquí duplicaría el aviso del mismo pedido.
      return;
    }

    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Con gusto te comunico con un asesor. En un momento alguien del equipo Althamir estará contigo. Horario: Lun-Sab 9am-8pm`);
      if (!esperandoAsesor.has(telefono)) {
        esperandoAsesor.add(telefono);
        await notificarAdmin('asesor', telefono, texto);
      }
      return;
    }

    if (esperandoAsesor.has(telefono)) {
      console.log(`Cliente ${telefono} esperando asesor — Noor en pausa`);
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
    conversaciones[telefono].push({ role: 'assistant', content: respuesta });
    await enviarMensaje(telefono, respuesta);
    console.log(`Respuesta enviada a ${telefono}`);

  } catch (error) {
    console.error('Error procesando mensaje:', error.message);
    // Antes este catch solo logueaba — el cliente se quedaba sin ninguna
    // respuesta. Ahora le avisamos algo razonable y te notificamos a ti
    // por Telegram para que puedas atenderlo manualmente si hace falta.
    try {
      const mensajeOriginal = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const telefono = mensajeOriginal?.from;
      if (telefono) {
        await enviarMensaje(telefono, 'Disculpa, tuve un problema técnico procesando tu mensaje 🙏 Un asesor te va a escribir en breve, o puedes visitar althamirgt.com mientras tanto.');
        await notificarAdmin('asesor', telefono, `[FALLO TÉCNICO] ${error.message} — mensaje original: "${mensajeOriginal?.text?.body || ''}"`);
      }
    } catch (errorFallback) {
      console.error('Error enviando mensaje de respaldo:', errorFallback.message);
    }
  }
});

// ─── Rutas de administración ─────────────────────────────────────────────────

app.get('/liberar', requireAdminToken, (req, res) => {
  const telefono = req.query.telefono;
  if (!telefono) return res.status(400).json({ error: 'Falta el parámetro telefono' });
  esperandoAsesor.delete(telefono);
  conversaciones[telefono] = [];
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

    // Solo procesamos si es una RESPUESTA (reply) a uno de nuestros avisos —
    // así evitamos que cualquier mensaje suelto en el chat intente reenviarse.
    const replyToId = mensaje.reply_to_message?.message_id;
    if (!replyToId) {
      await telegramEnviarAdmin('⚠️ Para responderle al cliente, usa "Responder" (Reply) sobre su mensaje, no escribas suelto.', null);
      return;
    }

    const telefono = telegramMsgToPhone[replyToId];
    if (!telefono) {
      await telegramEnviarAdmin('⚠️ No encontré a qué cliente corresponde ese mensaje (puede ser muy antiguo).', null);
      return;
    }

    await enviarMensaje(telefono, mensaje.text);
    // Nota: NO liberamos automáticamente a Noor aquí — dejamos que tú decidas
    // cuándo terminó la conversación usando /liberar?telefono=...&token=...
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

app.options(['/pedido', '/pedido/:telefono', '/pedido/confirmar-pago'], (req, res) => {
  conCORS(res); res.sendStatus(200);
});

// Crear un pedido nuevo — lo llama el sitio (WhatsApp) y recurrente-checkout.js (tarjeta)
app.post('/pedido', async (req, res) => {
  conCORS(res);
  try {
    const { cliente, telefono, direccion, productos, total, canal, estado } = req.body;
    if (!telefono || !productos || !total) {
      return res.status(400).json({ error: 'Faltan datos del pedido (telefono, productos, total)' });
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
app.get('/pedido/:telefono', async (req, res) => {
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

app.get('/health', async (req, res) => {
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
    problemas.push(`Sheet de Pedidos inaccesible (revisa el nombre de la pestaña en pedidos.js): ${e.message}`);
  }

  const ok = problemas.length === 0;

  if (!ok) {
    const ahora = Date.now();
    if (ahora - ultimaAlertaSalud > ALERTA_COOLDOWN_MS) {
      ultimaAlertaSalud = ahora;
      await telegramEnviarAdmin(`🚨 *Monitor de salud detectó un problema*\n\n${problemas.map(p => '• ' + p).join('\n')}`, null);
    }
  }

  res.status(ok ? 200 : 503).json({ ok, problemas, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Noor bot activo en puerto ${PORT}`);
  // Pre-cargar inventario al arrancar
  leerInventario().then(p => console.log(`[Inicio] ${p?.length || 0} productos cargados desde Sheets`));
});
