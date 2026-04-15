const { google } = require('googleapis');

const SHEET_ID = '1f5c5QtzH4EmxKSaCsfhnhuVtPUfC_ko9gxYHe9JB7II';
const SHEET_RANGE = 'A1:F200'; // Marca, Nombre, ml5, ml10, Disponible, (extra)

let cacheCatalogo = null;
let ultimaActualizacion = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getSheetsClient() {
  const credencialesJSON = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!credencialesJSON) throw new Error('Falta GOOGLE_CREDENTIALS_JSON en variables de entorno');

  const credenciales = JSON.parse(credencialesJSON);
  const auth = new google.auth.GoogleAuth({
    credentials: credenciales,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function leerInventario() {
  const ahora = Date.now();
  if (cacheCatalogo && ahora - ultimaActualizacion < CACHE_TTL) {
    return cacheCatalogo;
  }

  try {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
    });

    const filas = response.data.values;
    if (!filas || filas.length < 2) return null;

    // Primera fila = encabezados: Marca, Nombre, ml5, ml10, Disponible
    const encabezados = filas[0].map(h => h.toLowerCase().trim());
    const idxMarca = encabezados.indexOf('marca');
    const idxNombre = encabezados.indexOf('nombre');
    const idxMl5 = encabezados.findIndex(h => h.includes('5'));
    const idxMl10 = encabezados.findIndex(h => h.includes('10'));
    const idxDisponible = encabezados.findIndex(h => h.includes('disponible') || h.includes('activo') || h.includes('active'));

    const productos = [];
    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila || fila.length === 0) continue;

      const marca = fila[idxMarca] || '';
      const nombre = fila[idxNombre] || '';
      const ml5 = fila[idxMl5] || '';
      const ml10 = fila[idxMl10] || '';
      const disponible = fila[idxDisponible] || '';

      if (!nombre) continue;

      // Solo incluir si está disponible (acepta: SI, SÍ, YES, TRUE, 1, ACTIVO, ✓)
      const disp = disponible.toString().toLowerCase().trim();
      const estaActivo = ['si', 'sí', 'yes', 'true', '1', 'activo', 'active', '✓', '✔'].includes(disp);
      if (!estaActivo) continue;

      productos.push({ marca, nombre, ml5, ml10 });
    }

    cacheCatalogo = productos;
    ultimaActualizacion = ahora;
    console.log(`[Sheets] Inventario cargado: ${productos.length} productos activos`);
    return productos;

  } catch (err) {
    console.error('[Sheets] Error leyendo inventario:', err.message);
    return cacheCatalogo; // Devuelve el caché anterior si falla
  }
}

function formatearCatalogo(productos) {
  if (!productos || productos.length === 0) return null;

  // Agrupar por marca
  const porMarca = {};
  for (const p of productos) {
    const marca = p.marca || 'Otras';
    if (!porMarca[marca]) porMarca[marca] = [];
    porMarca[marca].push(p);
  }

  let texto = 'CATÁLOGO ACTUAL (desde inventario en tiempo real):\n';
  for (const [marca, items] of Object.entries(porMarca)) {
    texto += `${marca}: `;
    texto += items.map(p => {
      let precios = p.nombre;
      if (p.ml5) precios += ` (5ml ${p.ml5}`;
      if (p.ml10) precios += ` · 10ml ${p.ml10})`;
      else if (p.ml5) precios += ')';
      return precios;
    }).join(' · ');
    texto += '\n';
  }
  return texto;
}

module.exports = { leerInventario, formatearCatalogo };
