const { google } = require('googleapis');
const Ofertas = require('./netlify/functions/lib/ofertas'); // misma lógica que el checkout web (fechas, vigencia, texto para Noor)

const SHEET_ID = '1f5c5QtzH4EmxKSaCsfhnhuVtPUfC_ko9gxYHe9JB7II';
const SHEET_RANGE = 'A1:F200';

let cacheCatalogo = null;
let ultimaActualizacion = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const CACHE_MAX_AGE = 2 * 60 * 60 * 1000; // 2 horas (forzar recarga)

let clienteDePrueba = null; // solo para pruebas automáticas
async function getSheetsClient() {
  if (clienteDePrueba) return clienteDePrueba;
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
  
  // ✅ CORRECCIÓN: Forzar recarga si el caché es muy antiguo
  if (cacheCatalogo && ahora - ultimaActualizacion > CACHE_MAX_AGE) {
    console.log('[Sheets] Caché muy antiguo (>2h), forzando recarga...');
    cacheCatalogo = null;
  }
  
  // Usar caché si está dentro del TTL
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
    if (!filas || filas.length < 2) {
      console.warn('[Sheets] No hay datos suficientes en el sheet');
      return null;
    }
    
    const encabezados = filas[0].map(h => h.toLowerCase().trim());
    const idxMarca = encabezados.indexOf('marca');
    const idxNombre = encabezados.indexOf('nombre');
    const idxMl5 = encabezados.findIndex(h => h.includes('5'));
    const idxMl10 = encabezados.findIndex(h => h.includes('10'));
    const idxDisponible = encabezados.findIndex(h => 
      h.includes('disponible') || h.includes('activo') || h.includes('active')
    );
    const idxImgs = encabezados.findIndex(h => h.includes('img') || h.includes('foto') || h.includes('imagen') || h.includes('url'));
    
    const productos = [];
    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila || fila.length === 0) continue;
      
      const nombre = fila[idxNombre] || '';
      if (!nombre) continue;
      
      const disponible = (fila[idxDisponible] || '').toString().toLowerCase().trim();
      const estaActivo = ['si', 'sí', 'yes', 'true', '1', 'activo', 'active', '✓', '✔'].includes(disponible);
      
      if (!estaActivo) continue;

      const imagenes = (idxImgs !== -1 && fila[idxImgs]) 
  ? fila[idxImgs].split('|').map(url => url.trim()).filter(Boolean) 
  : [];
      
      productos.push({
  marca: fila[idxMarca] || '',
  nombre,
  ml5: fila[idxMl5] || '',
  ml10: fila[idxMl10] || '',
  imagenes
}); }
    
    cacheCatalogo = productos;
    ultimaActualizacion = ahora;
    console.log(`[Sheets] ✅ ${productos.length} productos activos cargados`);
    return productos;
    
  } catch (err) {
    console.error('[Sheets] ❌ Error leyendo inventario:', err.message);
    // Retorna el caché aunque esté viejo (mejor que nada)
    return cacheCatalogo;
  }
}

// ─── Ofertas (pestaña "Ofertas" del mismo Sheet) ───
// Se guarda la hoja cruda 60 s; la vigencia (Inicio/Fin) se evalúa en CADA consulta, así una oferta
// que termina deja de mencionarse al instante aunque la hoja siga en caché.
const OFERTAS_RANGE = "'Ofertas'!A1:O60";
const OFERTAS_TTL = 60 * 1000;
let cacheOfertas = null; // { t, filas }

async function leerOfertas() {
  const ahora = Date.now();
  if (!cacheOfertas || ahora - cacheOfertas.t >= OFERTAS_TTL) {
    try {
      const sheets = await getSheetsClient();
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: OFERTAS_RANGE });
      cacheOfertas = { t: ahora, filas: r.data.values || [] };
    } catch (err) {
      if (/unable to parse range|not found|400/i.test(err.message)) {
        cacheOfertas = { t: ahora, filas: [] };   // la pestaña "Ofertas" todavía no existe: simplemente no hay ofertas
      } else {
        console.error('[Sheets] ❌ Error leyendo ofertas:', err.message);
        if (!cacheOfertas) return [];             // sin caché previo: mejor no decir nada que inventar
      }
    }
  }
  return Ofertas.procesarFilas(cacheOfertas.filas, Date.now());
}

// Bloque de texto que se agrega al prompt de Noor ('' si no hay ofertas vigentes o algo falla)
async function textoOfertasParaNoor() {
  try {
    const ofertas = await leerOfertas();
    return Ofertas.textoParaNoor(ofertas, {
      dondeComprar: 'en la sección "Ofertas Exclusivas" de althamirgt.com (se arma y se paga con tarjeta), o aquí por WhatsApp: pídele qué perfumes elige (si la oferta lo requiere) y dile que un asesor le confirma el pedido y el pago'
    });
  } catch (err) {
    console.error('[Sheets] Ofertas no disponibles para Noor:', err.message);
    return '';
  }
}

function formatearCatalogo(productos) {
  if (!productos || productos.length === 0) return null;
  
  const porMarca = {};
  for (const p of productos) {
    const marca = p.marca || 'Otras';
    if (!porMarca[marca]) porMarca[marca] = [];
    porMarca[marca].push(p);
  }
  
  let texto = 'CATÁLOGO ACTUAL (inventario en tiempo real):\n';
  for (const [marca, items] of Object.entries(porMarca)) {
    texto += `${marca}:`;
    texto += items.map(p => {
      let linea = p.nombre;
      if (p.ml5) linea += `(5ml ${p.ml5}`;
      if (p.ml10) linea += `· 10ml ${p.ml10})`;
      else if (p.ml5) linea += ')';
      return linea;
    }).join(' · ');
    texto += '\n';
  }
  
  return texto;
}

module.exports = {
  leerInventario, formatearCatalogo, leerOfertas, textoOfertasParaNoor,
  _pruebas: { setCliente: (c) => { clienteDePrueba = c; cacheOfertas = null; } }
};
