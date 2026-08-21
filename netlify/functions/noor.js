// netlify/functions/noor.js
const https = require('https');

// Límite de peticiones simple en memoria — no es perfecto (se reinicia cuando
// Netlify "duerme" la function tras inactividad), pero frena el abuso más
// común: alguien mandando spam de requests directo a esta URL para gastar
// tu cuota de Groq (el CORS no lo evita, solo detiene llamadas desde el
// navegador de otros sitios, no llamadas hechas con scripts/curl).
const MAX_REQUESTS_POR_MINUTO = 12;
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

  const payload = JSON.stringify({
    model: 'llama-3.1-8b-instant',
    max_tokens: 400,
    temperature: 0.7,
    messages: body.messages
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers, body: data });
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: err.message }) });
    });

    req.write(payload);
    req.end();
  });
};
