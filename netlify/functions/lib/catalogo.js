// netlify/functions/lib/catalogo.js
//
// Catálogo para las páginas de producto y el sitemap de la tienda.
// Mezcla dos fuentes: el Google Sheet de inventario (precios, disponibilidad, fotos y descripción EN VIVO)
// y una copia de los productos de la tienda (productos-estaticos.json), que sirve de respaldo y completa
// lo que falte. Si Google no responde, las páginas siguen funcionando con el respaldo.

'use strict';
const https = require('https');
const ESTATICOS = require('./productos-estaticos.json');

const SHEET_ID = process.env.INVENTARIO_SHEET_ID || '1f5c5QtzH4EmxKSaCsfhnhuVtPUfC_ko9gxYHe9JB7II';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const SITIO = 'https://althamirgt.com';
const CACHE_MS = 5 * 60 * 1000;
let cache = null; // { t, productos }

function normalizar(str) {
  return String(str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '').replace(/\s+/g, ' ').trim();
}
// Mismo criterio que usa la tienda en el navegador (marca + nombre → "lattafa-yara-moi")
function slugify(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function precioNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsearLineaCSV(linea) {
  const out = []; let actual = ''; let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') { if (comillas && linea[i + 1] === '"') { actual += '"'; i++; } else comillas = !comillas; }
    else if (c === ',' && !comillas) { out.push(actual.trim()); actual = ''; }
    else actual += c;
  }
  out.push(actual.trim());
  return out;
}

// Misma lectura de columnas que la tienda (marca, nombre, 5ml, 10ml, disponible, imagen, descripción)
function parsearCSV(texto) {
  const lineas = String(texto).trim().split('\n');
  if (lineas.length < 2) return [];
  const enc = parsearLineaCSV(lineas[0]).map(h => h.replace(/"/g, '').toLowerCase().trim());
  const idxMarca = enc.findIndex(h => h === 'marca' || h.includes('marca'));
  const idxNombre = enc.findIndex(h => h === 'nombre' || h.includes('nombre') || h.includes('name'));
  const idx5 = enc.findIndex(h => h === '5ml' || h === '5' || h === 'precio5ml' || h === 'precio 5ml' || h === '5 ml' || (h.includes('5') && h.includes('ml')));
  const idx10 = enc.findIndex(h => h === '10ml' || h === '10' || h === 'precio10ml' || h === 'precio 10ml' || h === '10 ml' || (h.includes('10') && h.includes('ml')));
  const idxDisp = enc.findIndex(h => h.includes('disponible') || h.includes('activo') || h.includes('active') || h === 'status');
  const idxImg = enc.findIndex(h => h === 'imagen' || h === 'foto' || h.includes('imagen') || h.includes('image') || h.includes('foto'));
  const idxDesc = enc.findIndex(h => h === 'descripcion' || h === 'descripción' || h.includes('descripcion') || h.includes('description'));
  if (idxNombre < 0) return [];
  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    const cols = parsearLineaCSV(lineas[i]).map(c => c.replace(/"/g, '').trim());
    const nombre = cols[idxNombre] || '';
    if (!nombre) continue;
    const disp = (cols[idxDisp] || '').toLowerCase();
    filas.push({
      marca: idxMarca >= 0 ? (cols[idxMarca] || '') : '',
      nombre,
      ml5: precioNum(cols[idx5]),
      ml10: precioNum(cols[idx10]),
      disponible: ['si', 'sí', 'yes', 'true', '1', 'activo', 'active', '✓', '✔'].includes(disp),
      imagenes: (idxImg >= 0 ? (cols[idxImg] || '') : '').split('|').map(u => u.trim()).filter(u => /^https:\/\//i.test(u)),
      descripcion: idxDesc >= 0 ? (cols[idxDesc] || '').trim() : ''
    });
  }
  return filas;
}

// Descarga con el módulo https (sin depender de la versión de Node) y sigue las redirecciones de Google
function descargarTexto(url, redirecciones = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'althamir-catalogo', 'Cache-Control': 'no-cache' } }, (res) => {
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

// Une el Sheet con el respaldo. Si un producto existe en los dos, la marca y el nombre son los de la tienda
// (así el enlace coincide con el que arma el navegador) y precios, fotos y descripción vienen del Sheet.
function fusionar(filasSheet) {
  const base = ESTATICOS.map(e => ({
    marca: e.marca, nombre: e.nombre, categoria: e.categoria || e.marca,
    descripcion: e.descripcion || '', imagenes: (e.imagenes || []).slice(),
    ml5: e.ml5 || null, ml10: e.ml10 || null, disponible: true, origen: 'estatico'
  }));
  const porNombre = new Map(base.map(p => [normalizar(p.nombre), p]));
  for (const f of filasSheet || []) {
    const k = normalizar(f.nombre);
    let p = porNombre.get(k);
    if (!p) { // coincidencia parcial solo si es inequívoca
      const cand = base.filter(b => { const bn = normalizar(b.nombre); return bn.includes(k) || k.includes(bn); });
      if (cand.length === 1) p = cand[0];
    }
    if (p) {
      if (f.descripcion) p.descripcion = f.descripcion;
      if (f.imagenes.length) p.imagenes = f.imagenes;
      if (f.ml5) p.ml5 = f.ml5;
      if (f.ml10) p.ml10 = f.ml10;
      p.disponible = f.disponible;
      p.origen = 'ambos';
    } else if (f.disponible && (f.ml5 || f.ml10)) { // producto nuevo creado solo en el Sheet
      const nuevo = { marca: f.marca || 'Althamir', nombre: f.nombre, categoria: f.marca || 'Althamir', descripcion: f.descripcion, imagenes: f.imagenes, ml5: f.ml5, ml10: f.ml10, disponible: true, origen: 'sheet' };
      base.push(nuevo); porNombre.set(k, nuevo);
    }
  }
  const usados = new Set();
  for (const p of base) {
    let s = slugify(`${p.marca} ${p.nombre}`) || 'producto', n = 2, cand = s;
    while (usados.has(cand)) cand = `${s}-${n++}`;
    usados.add(cand); p.slug = cand;
  }
  return base;
}

async function cargarCatalogo() {
  const ahora = Date.now();
  if (cache && ahora - cache.t < CACHE_MS) return cache.productos;
  try {
    const filas = parsearCSV(await descargarTexto(`${CSV_URL}&_=${ahora}`));
    const productos = fusionar(filas);
    cache = { t: ahora, productos, enVivo: true };
    return productos;
  } catch (e) {
    console.error('[Catálogo] No se pudo leer el Sheet, se usa el respaldo:', e.message);
    if (cache) return cache.productos;                 // última versión buena
    const productos = fusionar([]);                     // solo el respaldo
    cache = { t: ahora - CACHE_MS + 60 * 1000, productos, enVivo: false }; // reintenta en 1 minuto
    return productos;
  }
}

module.exports = { cargarCatalogo, fusionar, parsearCSV, slugify, normalizar, precioNum, SITIO, _limpiarCache: () => { cache = null; } };
