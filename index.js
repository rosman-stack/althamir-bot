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
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const pedidos = require('./pedidos');

// ─── MIDDLEWARE DE SEGURIDAD ─────────────────────────────────────────────
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

// ─── VARIABLES DE ESTADO ──────────────────────────────────────────────────
const conversaciones = {};
const telegramMsgToPhone = {};
const esperandoAsesor = new Set();

// ─── RATE LIMITING (PREVENCIÓN DE ABUSO) ─────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX = 20; // 20 mensajes por minuto

function checkRateLimit(telefono) {
  const ahora = Date.now();
  const registro = rateLimitMap.get(telefono);
  
  if (!registro || ahora - registro.inicio > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(telefono, { inicio: ahora, count: 1 });
    return true;
  }
  
  if (registro.count >= RATE_LIMIT_MAX) {
    return false;
  }
  
  registro.count++;
  return true;
}

// ─── LIMPIEZA DE MEMORIA (PREVENCIÓN DE MEMORY LEAK) ─────────────────────
function limpiarMemoria() {
  const ahora = Date.now();
  const TIEMPO_VIDA_CONVERSACION = 24 * 60 * 60 * 1000; // 24 horas
  
  let conversacionesLimpiadas = 0;
  let rateLimitsLimpiados = 0;
  
  // Limpia conversaciones inactivas por más de 24h
  for (const telefono in conversaciones) {
    if (!esperandoAsesor.has(telefono)) {
      delete conversaciones[telefono];
      conversacionesLimpiadas++;
    }
  }
  
  // Limpia mapeo de Telegram antiguo
  for (const msgId in telegramMsgToPhone) {
    const telefono = telegramMsgToPhone[msgId];
    if (!esperandoAsesor.has(telefono)) {
      delete telegramMsgToPhone[msgId];
      conversacionesLimpiadas++;
    }
  }
  
  // Limpia rate limits antiguos
  for (const telefono in rateLimitMap) {
    const registro = rateLimitMap[telefono];
    if (ahora - registro.inicio > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(telefono);
      rateLimitsLimpiados++;
    }
  }
  
  if (conversacionesLimpiadas > 0 || rateLimitsLimpiados > 0) {
    console.log(`[Limpieza] ${conversacionesLimpiadas} conversaciones y ${rateLimitsLimpiados} rate limits eliminados`);
  }
}

// Ejecutar limpieza cada hora
setInterval(limpiarMemoria, 60 * 60 * 1000);
console.log('[Limpieza] Programada cada hora');

// ─── SISTEMA NOOR (IA) ───────────────────────────────────────────────────
const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp — una perfumería árabe auténtica ubicada en GUATEMALA. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes, como una amiga experta que disfruta genuinamente recomendar el aroma perfecto.

️ MUY IMPORTANTE — MONEDA Y PAÍS:
TODOS los precios son en QUETZALES GUATEMALTECOS (Q), NUNCA en pesos mexicanos, dólares ni ninguna otra moneda.
Siempre escribe los precios exactamente como aparecen en el catálogo (con "Q") — nunca uses "$" ni "MXN" ni "pesos".
Althamir opera ÚNICAMENTE en Guatemala. Si preguntan por envíos a otro país, indica con amabilidad que por ahora solo se envía dentro de Guatemala.

⚠️ MUY IMPORTANTE — PRECIOS EXACTOS, NUNCA RANGOS:
Cada decant tiene un precio EXACTO de 5ml y un precio EXACTO de 10ml según el catálogo de abajo.
NUNCA inventes ni generalices un "rango" de precios (por ejemplo, nunca digas algo como "los decants van de Q100 a Q450"). Eso es incorrecto y confunde al cliente.
Si te preguntan "¿cuánto cuestan los decants?" en general, responde con 2-3 ejemplos concretos del catálogo con su precio EXACTO, o pide el nombre de la fragancia que le interesa para dar el precio preciso.
Si una fragancia no está en el catálogo de abajo, NO inventes un precio — di que no está disponible actualmente.

{{CATALOGO}}

⚠️ COSTOS DE ENVÍO (siempre usa estos montos exactos, nunca otros):
Ciudad de Guatemala (capital): Q30
Interior del país: Q40
Estos costos de envío son SEPARADOS del precio del decant — nunca los mezcles ni los sumes al precio del producto al mencionarlo, acláralo como un cargo adicional de envío.

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
- Respuestas cortas y conversacionales, máximo 4-5 líneas
- Nunca inventes productos, precios ni rangos de precio fuera del catálogo
- Nunca uses pesos, dólares ni ninguna moneda que no sea quetzales (Q)
- Si un producto NO aparece en el catálogo, indica que no está disponible actualmente
- Si alguien pregunta qué recomiendas, pregunta con calidez: ¿prefieres algo floral, amaderado, cítrico o especiado? ¿es para el día a día o una ocasión especial?
- Usa lenguaje neutro al dirigirte al cliente. Nunca asumas género.`;

// Catálogo de respaldo por si falla Sheets
const CATALOGO_FALLBACK = `CATÁLOGO (puede no estar actualizado): LATTAFA: Yara Moi (5ml Q40 · 10ml Q65) · Yara Rosa (5ml Q40 · 10ml Q65) · Asad (5ml Q45 · 10ml Q75) · Ra'ed Luxe (5ml Q35 · 10ml Q60) AL HARAMAIN: Amber Oud Gold Edition (5ml Q50 · 10ml Q90) Para catálogo completo y actualizado visita althamirgt.com`;

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

// ─── FUNCIONES DE ENVÍO DE MENSAJES ──────────────────────────────────────
async function enviarMensaje(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { 
        messaging_product: 'whatsapp', 
        to: telefono, 
        type: 'text', 
        text: { body: mensaje } 
      },
      { 
        headers: { 
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 
          'Content-Type': 'application/json' 
        } 
      }
    );
  } catch (err) {
    console.error('[WhatsApp] Error enviando mensaje:', err.response?.data || err.message);
  }
}

async function notificarAdmin(tipo, telefono, mensaje) {
  const titulo = tipo === 'asesor' ? 'Asesor requerido - Althamir' : 'Nueva orden - Althamir';
  const cuerpo = `Cliente: +${telefono}\n${mensaje}`;
  
  // Notificación por NTFY
  if (NTFY_TOPIC) {
    try {
      await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, cuerpo, {
        headers: { 'Title': titulo, 'Priority': 'high', 'Content-Type': 'text/plain' }
      });
    } catch(e) {
      console.error('[NTFY] Error notificando admin:', e.message);
    }
  }
  
  // Envía también a Telegram y guarda el message_id -> teléfono
  const msgId = await telegramEnviarAdmin(`📣 *${titulo}*\n\n${cuerpo}\n\n_Responde a este mensaje para contestarle por WhatsApp._`, telefono);
  return msgId;
}

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
    console.error('[Telegram] Error notificando admin:', e.response?.data || e.message);
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
      max_tokens: 350,
      temperature: 0.7
    },
    { 
      headers: { 
        'Authorization': `Bearer ${GROQ_API_KEY}`, 
        'Content-Type': 'application/json' 
      } 
    }
  );
  return res.data.choices[0].message.content;
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  // ✅ CORRECCIÓN CRÍTICA: Procesar PRIMERO, responder 200 DESPUÉS
  try {
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== 'text') {
      return res.sendStatus(200);
    }
    
    const telefono = mensaje.from;
    const texto = mensaje.text.body.trim();
    console.log(`📨 Mensaje de ${telefono}: ${texto}`);
    
    // Rate limiting
    if (!checkRateLimit(telefono)) {
      await enviarMensaje(telefono, 'Estás enviando muchos mensajes. Por favor espera un momento.');
      return res.sendStatus(200);
    }
    
    // Orden desde web
    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `✅ Orden recibida. Un asesor te contactará en breve para confirmar detalles. Horario Lun-Sab 9am-8pm`);
      await notificarAdmin('orden', telefono, texto);
      return res.sendStatus(200);
    }
    
    // Cliente quiere asesor
    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, ` Con gusto te comunico con un asesor. En un momento alguien del equipo Althamir estará contigo. Horario: Lun-Sab 9am-8pm`);
      if (!esperandoAsesor.has(telefono)) {
        esperandoAsesor.add(telefono);
        await notificarAdmin('asesor', telefono, texto);
      }
      return res.sendStatus(200);
    }
    
    // Cliente ya está esperando asesor
    if (esperandoAsesor.has(telefono)) {
      console.log(`⏳ Cliente ${telefono} esperando asesor — Noor en pausa`);
      await reenviarMensajeClienteATelegram(telefono, texto);
      return res.sendStatus(200);
    }
    
    // Conversación normal con Noor
    if (!conversaciones[telefono]) conversaciones[telefono] = [];
    const esPrimerMensaje = conversaciones[telefono].length === 0;
    
    conversaciones[telefono].push({ role: 'user', content: texto });
    if (conversaciones[telefono].length > 20) {
      conversaciones[telefono] = conversaciones[telefono].slice(-20);
    }
    
    let historial = [...conversaciones[telefono]];
    if (esPrimerMensaje) {
      historial[0] = { 
        role: 'user', 
        content: `(El cliente escribe a las ${getSaludo()}, salúdale apropiadamente.) ${texto}` 
      };
    }
    
    const respuesta = await llamarGroq(historial);
    conversaciones[telefono].push({ role: 'assistant', content: respuesta });
    
    await enviarMensaje(telefono, respuesta);
    console.log(`✅ Respuesta enviada a ${telefono}`);
    
    // ✅ Respondemos 200 DESPUÉS de todo el procesamiento
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Error procesando mensaje:', error.message);
    
    // Fallback: notificar al cliente y al admin
    try {
      const mensajeOriginal = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const telefono = mensajeOriginal?.from;
      
      if (telefono) {
        await enviarMensaje(telefono, '🙏 Disculpa, tuve un problema técnico procesando tu mensaje. Un asesor te va a escribir en breve, o puedes visitar althamirgt.com mientras tanto.');
        await notificarAdmin('asesor', telefono, `[FALLO TÉCNICO] ${error.message} — mensaje original: "${mensajeOriginal?.text?.body || ''}"`);
      }
    } catch (errorFallback) {
      console.error('❌ Error enviando mensaje de respaldo:', errorFallback.message);
    }
    
    // Siempre respondemos 200 para que Meta no reintente
    res.sendStatus(200);
  }
});

// ─── RUTAS DE ADMINISTRACIÓN ─────────────────────────────────────────────
app.get('/liberar', requireAdminToken, (req, res) => {
  const telefono = req.query.telefono;
  if (!telefono) return res.status(400).json({ error: 'Falta el parámetro telefono' });
  
  esperandoAsesor.delete(telefono);
  conversaciones[telefono] = [];
  console.log(`✅ Cliente ${telefono} liberado — Noor retoma el chat`);
  res.json({ success: true, mensaje: `Noor retoma el chat con ${telefono}` });
});

app.get('/reload-inventario', requireAdminToken, async (req, res) => {
  try {
    const { leerInventario, formatearCatalogo } = require('./sheets');
    const productos = await leerInventario();
    res.json({ success: true, productos_activos: productos?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUENTE TELEGRAM → WHATSAPP ──────────────────────────────────────────
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  
  try {
    if (TELEGRAM_WEBHOOK_SECRET) {
      const secretRecibido = req.headers['x-telegram-bot-api-secret-token'];
      if (secretRecibido !== TELEGRAM_WEBHOOK_SECRET) {
        console.warn('[Telegram] Webhook con secret inválido — descartado');
        return;
      }
    }
    
    const mensaje = req.body.message;
    if (!mensaje || !mensaje.text) return;
    
    const replyToId = mensaje.reply_to_message?.message_id;
    if (!replyToId) {
      await telegramEnviarAdmin('⚠️ Para responderle al cliente, usa "Responder" (Reply) sobre su mensaje, no escribas suelto.', null);
      return;
    }
    
    const telefono = telegramMsgToPhone[replyToId];
    if (!telefono) {
      await telegramEnviarAdmin('️ No encontré a qué cliente corresponde ese mensaje (puede ser muy antiguo).', null);
      return;
    }
    
    await enviarMensaje(telefono, mensaje.text);
    console.log(`[Telegram→WhatsApp] Respuesta del asesor reenviada a ${telefono}`);
    
  } catch (error) {
    console.error('[Telegram webhook] Error:', error.message);
  }
});

// ── SISTEMA DE PEDIDOS ──────────────────────────────────────────────────
const ALLOWED_ORIGIN = 'https://althamirgt.com';

function conCORS(res) {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Secret');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

app.options(['/pedido', '/pedido/:telefono', '/pedido/confirmar-pago'], (req, res) => {
  conCORS(res); 
  res.sendStatus(200);
});

app.post('/pedido', async (req, res) => {
  conCORS(res);
  try {
    const { cliente, telefono, direccion, productos, total, canal, estado } = req.body;
    if (!telefono || !productos || !total) {
      return res.status(400).json({ error: 'Faltan datos del pedido (telefono, productos, total)' });
    }
    const orderId = await pedidos.crearPedido({ cliente, telefono, direccion, productos, total, canal, estado });
    res.json({ orderId });
  } catch (error) {
    console.error('[Pedido] Error creando pedido:', error.message);
    res.status(500).json({ error: 'No se pudo registrar el pedido' });
  }
});

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

// ─── RUTA PRINCIPAL ──────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🌙 Noor - Bot de WhatsApp Althamir funcionando'));

// ─── MONITOR DE SALUD ───────────────────────────────────────────────────
let ultimaAlertaSalud = 0;
const ALERTA_COOLDOWN_MS = 45 * 60 * 1000; // 45 minutos

app.get('/health', async (req, res) => {
  const problemas = [];
  
  if (!GROQ_API_KEY) {
    problemas.push('GROQ_API_KEY no configurada');
  } else {
    try {
      await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { 
          model: 'openai/gpt-oss-20b', 
          messages: [{ role: 'user', content: 'ping' }], 
          max_tokens: 1 
        },
        { 
          headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, 
          timeout: 8000 
        }
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

// ─── INICIO DEL SERVIDOR ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌙 Noor bot activo en puerto ${PORT}`);
  
  // Pre-cargar inventario al arrancar
  leerInventario().then(p => console.log(`[Inicio] ${p?.length || 0} productos cargados desde Sheets`));
});