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
const { verificarCarrito } = require('./lib/precios');

const RENDER_API_URL = 'althamir-bot.onrender.com';

// Registra el pedido en el Sheet de Pedidos (vía el bot en Render, que es
// quien tiene las credenciales de Google) ANTES de mandar al cliente a pagar.
function crearPedidoEnRender({ cliente, telefono, direccion, productos, total, canal, estado }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ cliente, telefono, direccion, productos, total, canal, estado });
    const req = https.request({
      hostname: RENDER_API_URL,
      path: '/pedido',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Internal-Secret': process.env.INTERNAL_API_SECRET || '' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).orderId || null); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('[Pedido] Error registrando en Render:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}


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

  const secretKey = process.env.RECURRENTE_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RECURRENTE_SECRET_KEY no configurada en Netlify' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  const customer = body.customer || {};
  const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const nombreCliente = texto(customer.name, 120);
  const telefonoCliente = texto(customer.phone, 30);
  const direccionCliente = texto(customer.address, 400);

  if (!nombreCliente || !telefonoCliente || !direccionCliente) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan datos del cliente (nombre, teléfono, dirección)' }) };
  }
  if (telefonoCliente.replace(/\D/g, '').length < 8) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Escribe un teléfono válido' }) };
  }

  // Los PRECIOS los pone el servidor leyendo el inventario real. Del navegador solo se
  // usa qué producto, qué tamaño y cuántos; cualquier "price" que mande se ignora.
  const verificado = await verificarCarrito(body.cart);
  if (!verificado.ok) {
    return { statusCode: verificado.status, headers, body: JSON.stringify({ error: verificado.error }) };
  }

  const items = verificado.items.map(i => ({
    name: `${i.nombre} (${i.tamano})`,
    amount_in_cents: Math.round(i.precio * 100),
    currency: 'GTQ',
    quantity: i.qty
  }));
  const total = verificado.total;
  const productosTexto = verificado.productosTexto;

  const orderNum = await crearPedidoEnRender({
    cliente: nombreCliente,
    telefono: telefonoCliente,
    direccion: direccionCliente,
    productos: productosTexto,
    total,
    canal: 'Tarjeta',
    estado: 'Pendiente de pago'
  }) || ('ALT-' + Date.now().toString().slice(-5)); // respaldo si Render no respondió, para no romper el checkout

  const payload = JSON.stringify({
    items,
    success_url: `https://althamirgt.com/?pago=exito&orden=${orderNum}`,
    cancel_url: `https://althamirgt.com/?pago=cancelado`
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
            console.error('[Recurrente] Respuesta inesperada:', data.slice(0, 300));
            resolve({ statusCode: 500, headers, body: JSON.stringify({ error: 'Respuesta inesperada del servicio de pagos' }) });
          }
        } else {
          console.error('[Recurrente] Error', res.statusCode, data.slice(0, 300));
          resolve({ statusCode: 502, headers, body: JSON.stringify({ error: 'No se pudo iniciar el pago. Intenta de nuevo o haz tu pedido por WhatsApp.' }) });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Recurrente] Error de red:', err.message);
      resolve({ statusCode: 502, headers, body: JSON.stringify({ error: 'No se pudo conectar con el servicio de pagos' }) });
    });

    req.write(payload);
    req.end();
  });
};
