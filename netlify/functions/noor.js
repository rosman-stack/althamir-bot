// netlify/functions/noor.js
const https = require('https');

// Límite de peticiones simple en memoria — no es perfecto (se reinicia cuando
// Netlify "duerme" la function tras inactividad), pero frena el abuso más
// común: alguien mandando spam de requests directo a esta URL para gastar
// tu cuota de Groq (el CORS no lo evita, solo detiene llamadas desde el
// navegador de otros sitios, no llamadas hechas con scripts/curl).
const MAX_REQUESTS_POR_MINUTO = 12;

// Groq limita los tokens por minuto de TODA la organización (el plan gratuito de gpt-oss-20b: 8,000), y el bot de
// WhatsApp comparte ese cupo. Para gastar menos por mensaje solo mandamos el prompt y los últimos turnos de la charla.
const MAX_TURNOS = 8;
// Si Groq responde 429, esperamos lo que indique (si es corto) y reintentamos una vez. Netlify corta a los ~10 s.
const ESPERA_MAX_SEG = 3;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function segundosDeEspera(r) {
  const h = parseFloat(r.retryAfter);
  if (isFinite(h) && h > 0) return h;
  const m = /try again in ([0-9.]+)\s*(ms|s)/i.exec(String(r.data || ''));
  if (m) return m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
  return 3;
}

function pedirAGroq(payload, apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data, retryAfter: res.headers && res.headers['retry-after'] }));
    });
    req.on('error', (err) => resolve({ status: 0, data: '', error: err.message }));
    req.write(payload);
    req.end();
  });
}
const registroPeticiones = new Map(); // ip -> [timestamps]

function excedeLimite(ip) {
  const ahora = Date.now();
  const ventana = 60 * 1000;
  const historial = (registroPeticiones.get(ip) || []).filter(t => ahora - t < ventana);
  historial.push(ahora);
  registroPeticiones.set(ip, historial);
  // Limpieza simple para no acumular IPs viejas indefinidamente
  if (registroPeticiones.size > 500) {
    const primerKey = registroPeticiones.keys().next().value;
    registroPeticiones.delete(primerKey);
  }
  return historial.length > MAX_REQUESTS_POR_MINUTO;
}

exports.handler = async (event) => {
  // Headers CORS para permitir llamadas desde el navegador
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://althamirgt.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'desconocida';
  if (excedeLimite(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Demasiadas solicitudes, espera un momento.' }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key no configurada' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  // Validación básica: evita payloads absurdos que inflen el costo por request
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el arreglo de mensajes' }) };
  }
  if (body.messages.length > 30) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Conversación demasiado larga' }) };
  }

  // Prompt del sistema + últimos turnos (que empiecen con un mensaje del cliente)
  const sistema = body.messages.filter((m) => m && m.role === 'system').slice(0, 1);
  const resto = body.messages.filter((m) => m && m.role !== 'system').slice(-MAX_TURNOS);
  while (resto.length && resto[0].role !== 'user') resto.shift();

  const payload = JSON.stringify({
    model: 'openai/gpt-oss-20b',
    max_tokens: 400,
    temperature: 0.7,
    messages: [...sistema, ...resto]
  });

  let r = await pedirAGroq(payload, apiKey);
  if (r.status === 429 && segundosDeEspera(r) <= ESPERA_MAX_SEG) {
    await esperar(Math.ceil(segundosDeEspera(r) * 1000) + 250);
    r = await pedirAGroq(payload, apiKey);
  }
  if (r.status === 200) return { statusCode: 200, headers, body: r.data };

  // Nunca se le devuelve al cliente el error de Groq (trae datos de tu cuenta): se registra aquí y se responde algo neutro
  console.error('[noor] Groq respondió', r.status, String(r.data || r.error || '').slice(0, 300));
  if (r.status === 429) {
    return { statusCode: 503, headers, body: JSON.stringify({
      error: { code: 'busy', message: 'Noor está atendiendo a varias personas.' },
      retry_after: Math.min(8, Math.ceil(segundosDeEspera(r)))
    }) };
  }
  return { statusCode: 502, headers, body: JSON.stringify({ error: { code: 'unavailable', message: 'Noor no está disponible por ahora.' } }) };
};
