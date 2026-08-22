// netlify/functions/recurrente-checkout.js
//
// Recibe el carrito + datos del cliente desde el frontend, crea un checkout
// en Recurrente y devuelve la URL de pago para redirigir al cliente.
//
// Variable de entorno requerida en Netlify (Site settings → Environment variables):
//   RECURRENTE_SECRET_KEY = sk_... (Secret Key del dashboard de Recurrente)
//
// IMPORTANTE: esta key es privada, por eso vive solo aquí (backend/function),
// nunca en el HTML/JS del frontend.

const https = require('https');

// Mismo limitador simple en memoria que en noor.js — frena spam de intentos
// de checkout desde un mismo origen en poco tiempo.
const MAX_REQUESTS_POR_MINUTO = 8;
const registroPeticiones = new Map();

function excedeLimite(ip) {
  const ahora = Date.now();
  const ventana = 60 * 1000;
  const historial = (registroPeticiones.get(ip) || []).filter(t => ahora - t < ventana);
  historial.push(ahora);
  registroPeticiones.set(ip, historial);
  if (registroPeticiones.size > 500) {
    const primerKey = registroPeticiones.keys().next().value;
    registroPeticiones.delete(primerKey);
  }
  return historial.length > MAX_REQUESTS_POR_MINUTO;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://althamirgt.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'desconocida';
  if (event.httpMethod === 'POST' && excedeLimite(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Demasiados intentos, espera un momento.' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const secretKey = process.env.sk_test_CT1IT73a3qDhopkKruuXpQMxjoT64veQnD2lGfAHabfCTAVoW1X0yyHN;
  if (!secretKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RECURRENTE_SECRET_KEY no configurada en Netlify' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  const cart = Array.isArray(body.cart) ? body.cart : [];
  const customer = body.customer || {};

  if (cart.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'El carrito está vacío' }) };
  }
  if (!customer.name || !customer.phone || !customer.address) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan datos del cliente (nombre, teléfono, dirección)' }) };
  }

  // Construir items en el formato que espera Recurrente
  const items = cart.map(item => ({
    name: `${item.name} (${item.size})`,
    amount_in_cents: Math.round(item.price * 100),
    currency: 'GTQ',
    quantity: item.qty
  }));

  const orderNum = 'ALT-' + Date.now().toString().slice(-5);

  // Nota: si Recurrente soporta un campo "metadata" en /api/checkouts,
  // aquí es donde conviene mandar order_num/telefono/dirección para
  // poder identificar el pedido cuando llegue el webhook de pago exitoso.
  // Verifica el nombre exacto del campo en la documentación de Recurrente
  // antes de confiar en que se guarda — si no existe, usa el orderNum como
  // referencia y captura los datos del cliente por tu cuenta (ya los tienes
  // en el body de esta request, puedes loguearlos o guardarlos donde gustes).
  const payload = JSON.stringify({
    items,
    success_url: `https://althamirgt.com/?pago=exito&orden=${orderNum}`,
    cancel_url: `https://althamirgt.com/?pago=cancelado`,
    metadata: {
      orden: orderNum,
      cliente: customer.name,
      telefono: customer.phone,
      direccion: customer.address,
      nota: customer.note || ''
    }
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'app.recurrente.com',
      path: '/api/checkouts',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SECRET-KEY': secretKey,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            resolve({
              statusCode: 200,
              headers,
              body: JSON.stringify({ checkout_url: parsed.checkout_url || parsed.url, orden: orderNum })
            });
          } catch (e) {
            resolve({ statusCode: 500, headers, body: JSON.stringify({ error: 'Respuesta inesperada de Recurrente', raw: data }) });
          }
        } else {
          resolve({ statusCode: res.statusCode, headers, body: JSON.stringify({ error: 'Error de Recurrente', detalle: data }) });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: err.message }) });
    });

    req.write(payload);
    req.end();
  });
};
