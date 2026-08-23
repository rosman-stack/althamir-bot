// netlify/functions/recurrente-webhook.js
//
// Recibe la notificación de Recurrente cuando un pago se completa, verifica
// que realmente venga de Recurrente (firma Svix), y te avisa por Telegram.
//
// Variables de entorno requeridas en NETLIFY (no en Render — esta function
// corre en Netlify, separado del bot de WhatsApp):
//   RECURRENTE_WEBHOOK_SECRET = whsec_... (se obtiene al registrar el endpoint
//                                en Recurrente: Configuración → Desarrolladores
//                                y API → Webhooks)
//   TELEGRAM_BOT_TOKEN = mismo bot que ya usas en el bot de WhatsApp
//   TELEGRAM_CHAT_ID   = tu chat id de Telegram

const https = require('https');
const crypto = require('crypto');

const RENDER_API_URL = 'althamir-bot.onrender.com';

function confirmarPagoEnRender(telefono, monto) {
  return new Promise((resolve) => {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) { console.warn('[Pedido] INTERNAL_API_SECRET no configurado en Netlify'); return resolve(); }
    const payload = JSON.stringify({ telefono, monto });
    const req = https.request({
      hostname: RENDER_API_URL,
      path: '/pedido/confirmar-pago',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Internal-Secret': secret }
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', (e) => { console.error('[Pedido] Error confirmando en Render:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

function enviarTelegram(texto) {
  return new Promise((resolve) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) { console.warn('[Telegram] Faltan TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID'); return resolve(); }

    const payload = JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', (e) => { console.error('[Telegram] Error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

function firmaValida(rawBody, headers, secret) {
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Protección contra replay: rechaza si el timestamp tiene más de 5 min
  const ahora = Math.floor(Date.now() / 1000);
  if (Math.abs(ahora - parseInt(svixTimestamp, 10)) > 300) {
    console.warn('[Webhook] Timestamp fuera de rango, posible replay');
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const secretBytes = Buffer.from(secret.split('_')[1], 'base64');
  const esperada = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // El header puede traer varias firmas separadas por espacio, cada una "v1,<firma>"
  const candidatas = svixSignature.split(' ').map(s => s.split(',')[1]).filter(Boolean);
  return candidatas.some(candidata => {
    try {
      return crypto.timingSafeEqual(Buffer.from(candidata), Buffer.from(esperada));
    } catch (e) {
      return false; // longitudes distintas → no coincide
    }
  });
}

exports.handler = async (event) => {
  const secret = process.env.RECURRENTE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Webhook] RECURRENTE_WEBHOOK_SECRET no configurada');
    return { statusCode: 500, body: 'Webhook secret no configurado' };
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const headersLower = {};
  Object.entries(event.headers || {}).forEach(([k, v]) => { headersLower[k.toLowerCase()] = v; });

  if (!firmaValida(rawBody, headersLower, secret)) {
    console.warn('[Webhook] Firma inválida — posible intento falso');
    return { statusCode: 401, body: 'Firma inválida' };
  }

  let evento;
  try {
    evento = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'JSON inválido' };
  }

  // Solo nos interesa cuando un pago se completó de verdad
  if (evento.event_type === 'intent.succeeded') {
    const monto = (evento.amount_in_cents / 100).toFixed(2);
    const moneda = evento.currency || 'GTQ';
    const cliente = evento.customer?.full_name || 'Cliente sin nombre';
    const telefono = evento.customer?.phone || 'sin teléfono';
    const canal = evento.details?.channel || evento.type || '';
    const recibo = evento.receipt_number || evento.id;

    await enviarTelegram(
      `💳 <b>¡Pago recibido!</b>\n` +
      `Monto: Q${monto} ${moneda}\n` +
      `Cliente: ${cliente}\n` +
      `Teléfono: ${telefono}\n` +
      `Canal: ${canal}\n` +
      `Recibo: ${recibo}`
    );

    await confirmarPagoEnRender(evento.customer?.phone, evento.amount_in_cents / 100);
  }
  // Otros event_type (intent.failed, intent.pending, etc.) los ignoramos por ahora,
  // pero igual respondemos 200 para que Recurrente no siga reintentando.

  return { statusCode: 200, body: 'OK' };
};
