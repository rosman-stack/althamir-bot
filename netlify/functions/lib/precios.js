// netlify/functions/lib/precios.js
//
// Verifica el carrito del cliente contra el inventario REAL (el mismo Google Sheet
// público que usa la tienda). El navegador solo dice QUÉ producto, QUÉ tamaño y
// CUÁNTOS: el precio SIEMPRE lo pone el servidor. Así nadie puede pagar Q0.01 por
// un perfume editando la petición (el código del sitio y del servidor es público).

const https = require('https');

const SHEET_ID = '1f5c5QtzH4EmxKSaCsfhnhuVtPUfC_ko9gxYHe9JB7II';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

const TAMANOS_PERMITIDOS = ['5 ml', '10 ml']; // los que existen como columna de precio en el Sheet
const MAX_LINEAS = 30;
const MAX_CANTIDAD = 20;
const CACHE_MS = 60 * 1000;

let cache = null; // { t, productos }

function normalizar(str) {
  return String(str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Misma lógica que la tienda: respeta comas dentro de texto entre comillas
function parsearLineaCSV(linea) {
  const out = []; let actual = ''; let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (comillas && linea[i + 1] === '"') { actual += '"'; i++; } else comillas = !comillas;
    } else if (c === ',' && !comillas) { out.push(actual.trim()); actual = ''; }
    else actual += c;
  }
  out.push(actual.trim());
  return out;
}

function parsearCSV(texto) {
  const lineas = String(texto).trim().split('\n');
  if (lineas.length < 2) return [];
  const enc = parsearLineaCSV(lineas[0]).map(h => h.replace(/"/g, '').toLowerCase().trim());
  const idxNombre = enc.findIndex(h => h === 'nombre' || h.includes('nombre') || h.includes('name'));
  const idx5 = enc.findIndex(h => h === '5ml' || h === '5' || h === 'precio5ml' || h === 'precio 5ml' || h === '5 ml' || (h.includes('5') && h.includes('ml')));
  const idx10 = enc.findIndex(h => h === '10ml' || h === '10' || h === 'precio10ml' || h === 'precio 10ml' || h === '10 ml' || (h.includes('10') && h.includes('ml')));
  const idxDisp = enc.findIndex(h => h.includes('disponible') || h.includes('activo') || h.includes('active') || h === 'status');
  if (idxNombre < 0) return [];
  const productos = [];
  for (let i = 1; i < lineas.length; i++) {
    const cols = parsearLineaCSV(lineas[i]).map(c => c.replace(/"/g, '').trim());
    const nombre = cols[idxNombre] || '';
    if (!nombre) continue;
    const disp = (cols[idxDisp] || '').toLowerCase();
    productos.push({
      nombre,
      clave: normalizar(nombre),
      ml5: cols[idx5] || '',
      ml10: cols[idx10] || '',
      disponible: ['si', 'sí', 'yes', 'true', '1', 'activo', 'active', '✓', '✔'].includes(disp),
    });
  }
  return productos;
}

// Descarga con el módulo https de Node (no depende de la versión de Node: no usa fetch)
// y sigue las redirecciones de Google (docs.google.com → googleusercontent.com).
function descargarTexto(url, redirecciones = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'althamir-checkout', 'Cache-Control': 'no-cache' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirecciones <= 0) return reject(new Error('Demasiadas redirecciones'));
        return resolve(descargarTexto(new URL(res.headers.location, url).toString(), redirecciones - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      res.setEncoding('utf8');
      let datos = '';
      res.on('data', (c) => { datos += c; if (datos.length > 2e6) req.destroy(new Error('Respuesta demasiado grande')); });
      res.on('end', () => resolve(datos));
    });
    req.setTimeout(8000, () => req.destroy(new Error('Tiempo de espera agotado')));
    req.on('error', reject);
  });
}

async function cargarInventario() {
  const ahora = Date.now();
  if (cache && ahora - cache.t < CACHE_MS) return cache.productos;
  const productos = parsearCSV(await descargarTexto(`${CSV_URL}&_=${ahora}`));
  if (productos.length === 0) throw new Error('Inventario vacío');
  cache = { t: ahora, productos };
  return productos;
}

// Coincidencia exacta; si no, parcial pero SOLO si es inequívoca (un único candidato).
function buscarProducto(productos, nombre) {
  const clave = normalizar(nombre);
  if (!clave) return { error: 'sin nombre' };
  const exacto = productos.find(p => p.clave === clave);
  if (exacto) return { producto: exacto };
  const parciales = productos.filter(p => clave.includes(p.clave) || p.clave.includes(clave));
  if (parciales.length === 1) return { producto: parciales[0] };
  return { error: parciales.length ? 'ambiguo' : 'no existe' };
}

function aPrecio(valor) {
  const n = parseFloat(String(valor || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Devuelve { ok:true, items, total, productosTexto } con los PRECIOS DEL SERVIDOR,
 * o { ok:false, status, error } con un mensaje apto para mostrar al cliente.
 */
async function verificarCarrito(cart) {
  if (!Array.isArray(cart) || cart.length === 0) return { ok: false, status: 400, error: 'El carrito está vacío' };
  if (cart.length > MAX_LINEAS) return { ok: false, status: 400, error: 'El carrito tiene demasiados productos' };

  let productos;
  try { productos = await cargarInventario(); }
  catch (e) {
    console.error('[Precios] No se pudo leer el inventario:', e.message);
    return { ok: false, status: 503, error: 'No pudimos verificar los precios en este momento. Intenta de nuevo en un minuto o haz tu pedido por WhatsApp.' };
  }

  const items = [];
  for (const linea of cart) {
    const nombre = typeof linea?.name === 'string' ? linea.name.slice(0, 200) : '';
    const tamano = typeof linea?.size === 'string' ? linea.size.trim().toLowerCase().replace(/\s+/g, ' ') : '';
    const qty = linea?.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_CANTIDAD) return { ok: false, status: 400, error: 'Cantidad inválida en el carrito' };
    if (!TAMANOS_PERMITIDOS.includes(tamano)) return { ok: false, status: 400, error: `El tamaño "${String(linea?.size).slice(0, 20)}" no se puede pagar con tarjeta. Escríbenos por WhatsApp.` };

    const { producto, error } = buscarProducto(productos, nombre);
    if (!producto) return { ok: false, status: 400, error: `No encontramos "${nombre.slice(0, 60)}" en el inventario. Escríbenos por WhatsApp.` };
    if (!producto.disponible) return { ok: false, status: 400, error: `"${producto.nombre}" está bajo pedido. Escríbenos por WhatsApp.` };

    const precio = aPrecio(tamano === '5 ml' ? producto.ml5 : producto.ml10);
    if (precio === null) return { ok: false, status: 400, error: `"${producto.nombre}" no tiene precio de ${tamano}. Escríbenos por WhatsApp.` };

    items.push({ nombre: producto.nombre, tamano, precio, qty });
  }

  const total = items.reduce((s, i) => s + i.precio * i.qty, 0);
  const productosTexto = items.map(i => `${i.qty}x ${i.nombre} (${i.tamano})`).join(', ');
  return { ok: true, items, total, productosTexto };
}

module.exports = { verificarCarrito, parsearCSV, normalizar, _limpiarCache: () => { cache = null; } };
