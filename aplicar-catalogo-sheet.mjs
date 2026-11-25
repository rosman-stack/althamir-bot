// Catálogo 100 % desde el Sheet (repo althamir-bot). Reemplaza a un .patch.
//  - Las tarjetas escritas a mano en index.html pasan a ser solo un RESPALDO: apenas carga el Sheet, el catálogo se arma
//    de cero con TODAS sus filas (Si y No), agrupadas por marca en el orden del Sheet. Una marca nueva crea su sección
//    y su botón de filtro; las marcas sin perfumes pierden su botón.
//  - Lector del Sheet más robusto (comillas, saltos de línea dentro de una celda, CRLF, "Sí.") y copia guardada en el
//    dispositivo (hasta 7 días) por si Google no responde. Si no hay Sheet ni copia, queda el respaldo del HTML.
//  - "Más vendidos" por nombre (ya no por número de tarjeta); si el Sheet tiene la columna "Más vendido" (1, 2, 3…), manda el Sheet.
//  - Panel de diagnóstico: abre la tienda con ?diag=1 para ver qué leyó del Sheet, qué filas se omiten y cuáles tienen avisos.
// Uso, desde la carpeta del repo althamir-bot:
//   node aplicar-catalogo-sheet.mjs --probar    (solo revisa, no cambia nada)
//   node aplicar-catalogo-sheet.mjs             (aplica los cambios)
// Respeta tus cambios locales y los saltos de línea de Windows. Si algún trozo de tu archivo es
// distinto, no toca NADA y te dice cuál es.
import fs from "node:fs";
import path from "node:path";

const PROBAR = process.argv.includes("--probar");

function leer(f) {
  const raw = fs.readFileSync(f, "utf8");
  return { txt: raw.replace(/\r\n/g, "\n"), crlf: raw.includes("\r\n") };
}
function aplicarPares(txt, pares) {
  const malos = [];
  let aplicados = 0, ya = 0;
  pares.forEach(([o, n], i) => {
    const veces = txt.split(o).length - 1;
    if (!o.includes(n) && txt.includes(n)) { ya++; return; }          // ya estaba aplicado
    if (veces === 1) { txt = txt.replace(o, () => n); aplicados++; return; }
    if (o.includes(n) && veces === 0 && txt.includes(n)) { ya++; return; } // borrado ya hecho
    const donde = o.split("\n").reduce((a, l) => (l.trim().length > a.trim().length ? l : a), "");
    malos.push(`cambio ${i + 1}: ${veces === 0 ? "no encontré el texto original (esa zona de tu archivo es distinta)" : "el texto aparece " + veces + " veces"} → «${donde.trim().slice(0, 80)}»`);
  });
  return { txt, aplicados, ya, malos };
}

const ARCHIVOS = {
 "index.html": [
  [
   "\nfilterBtns.forEach(btn => {\n  btn.addEventListener('click', () => {\n    const siBusq = document.getElementById('searchInput');\n    if (siBusq && siBusq.value) { siBusq.value = ''; siBusq.dispatchEvent(new Event('input')); }\n    filterBtns.forEach(b => b.classList.remove('active'));\n    btn.classList.add('active');",
   "\nfunction activarFiltroMarca(btn) {\n    const siBusq = document.getElementById('searchInput');\n    if (siBusq && siBusq.value) { siBusq.value = ''; siBusq.dispatchEvent(new Event('input')); }\n    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));\n    btn.classList.add('active');"
  ],
  [
   "    if (typeof altTrack === 'function') altTrack('filtro_marca', { marca: filter });\n  });\n});\n",
   "    if (typeof altTrack === 'function') altTrack('filtro_marca', { marca: filter });\n}\nfilterBtns.forEach(btn => btn.addEventListener('click', () => activarFiltroMarca(btn)));\n"
  ],
  [
   "    // Actualizar contador\n    updateCounter(visible, totalCards);\n",
   "    // Actualizar contador\n    updateCounter(visible, document.querySelectorAll('.product-card').length);\n"
  ],
  [
   "// ═══ MÁS VENDIDOS ═══\nconst bestsellers = [\n  { id: '3',  name: 'Asad',                  brand: 'Lattafa' },\n  { id: '1',  name: 'Yara Rosa',              brand: 'Lattafa' },\n  { id: '18', name: 'Amber Oud Gold Edition', brand: 'Al Haramain' },\n  { id: '5',  name: 'Emeer',                  brand: 'Lattafa' },\n  { id: '23', name: 'Phantom My Hero',         brand: 'Emper' },\n  { id: '26', name: 'Hawas for Him',           brand: 'Rasasi' },\n  { id: '25', name: 'Odyssey Homme White',     brand: 'Armaf' },\n];\n",
   "// ═══ MÁS VENDIDOS ═══\n// Lista de respaldo (por nombre). Si el Sheet tiene una columna \"Más vendido\" (1, 2, 3… o \"Si\"), manda el Sheet.\nconst bestsellers = [\n  { name: 'Asad',                  brand: 'Lattafa' },\n  { name: 'Yara Rosa',              brand: 'Lattafa' },\n  { name: 'Amber Oud Gold Edition', brand: 'Al Haramain' },\n  { name: 'Emeer',                  brand: 'Lattafa' },\n  { name: 'Phantom My Hero',         brand: 'Emper' },\n  { name: 'Hawas for Him',           brand: 'Rasasi' },\n  { name: 'Odyssey Homme White',     brand: 'Armaf' },\n];\nfunction listaMasVendidos() {\n  const marcados = (window.altProductos || []).filter(p => p.masVendido > 0).sort((a, b) => a.masVendido - b.masVendido);\n  return marcados.length ? marcados.map(p => ({ name: p.nombre, brand: p.marca })) : bestsellers;\n}\n"
  ],
  [
   "  let rank = 1;\n  for (const bs of bestsellers) {\n    const card = document.querySelector(`.product-card[data-id=\"${bs.id}\"]`);\n    if (!card) continue;",
   "  let rank = 1;\n  const tarjetas = Array.from(document.querySelectorAll('.product-card'));\n  for (const bs of listaMasVendidos()) {\n    const k = normalizarNombre(bs.name);\n    const card = tarjetas.find(c => normalizarNombre(c.dataset.name || '') === k);\n    if (!card) continue;"
  ],
  [
   "      <div class=\"bs-body\">\n        <p class=\"bs-brand\">${escH(bs.brand)}</p>\n        <p class=\"bs-name\">${escH(bs.name)}</p>",
   "      <div class=\"bs-body\">\n        <p class=\"bs-brand\">${escH(bs.brand || card.dataset.brand || '')}</p>\n        <p class=\"bs-name\">${escH(bs.name)}</p>"
  ],
  [
   "\nfunction parsearCSV(texto) {\n  const lineas = texto.trim().split('\\n');\n  if (lineas.length < 2) return [];\n  const encabezados = parsearLineaCSV(lineas[0]).map(h => h.replace(/\"/g, '').toLowerCase().trim());\n  const idxMarca      = encabezados.findIndex(h => h === 'marca' || h.includes('marca'));",
   "\n// Lector de CSV completo: comillas, comillas dobles escapadas, saltos de línea DENTRO de una celda y CRLF.\nfunction csvAFilas(texto) {\n  const filas = []; let fila = [], campo = '', enComillas = false;\n  const t = String(texto || '').replace(/^\\uFEFF/, '');\n  for (let i = 0; i < t.length; i++) {\n    const c = t[i];\n    if (enComillas) {\n      if (c === '\"') { if (t[i + 1] === '\"') { campo += '\"'; i++; } else enComillas = false; }\n      else campo += c;\n    } else if (c === '\"') enComillas = true;\n    else if (c === ',') { fila.push(campo); campo = ''; }\n    else if (c === '\\n' || c === '\\r') { if (c === '\\r' && t[i + 1] === '\\n') i++; fila.push(campo); campo = ''; filas.push(fila); fila = []; }\n    else campo += c;\n  }\n  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }\n  return filas;\n}\n\nconst DISP_SI = ['si', 'sí', 'yes', 'true', '1', 'activo', 'active', '✓', '✔'];\nfunction parsearCSV(texto) {\n  const diag = { filas: 0, omitidas: [], avisos: [] };\n  window.__altDiag = diag;\n  const filas = csvAFilas(texto);\n  if (filas.length < 2) return [];\n  const encabezados = filas[0].map(h => h.replace(/\"/g, '').toLowerCase().trim());\n  const idxMarca      = encabezados.findIndex(h => h === 'marca' || h.includes('marca'));"
  ],
  [
   "  const idxTamBotella = encabezados.findIndex(h => h.includes('botella') && /(tam|ml)/.test(h));\n\n  const productos = [];\n  for (let i = 1; i < lineas.length; i++) {\n    const cols = parsearLineaCSV(lineas[i]).map(c => c.replace(/\"/g, '').trim());\n    const nombre = cols[idxNombre] || '';\n    if (!nombre) continue;\n    const dispVal = (cols[idxDisponible] || '').toLowerCase();\n    const estaActivo = ['si','sí','yes','true','1','activo','active','✓','✔'].includes(dispVal);\n    const imagenCelda = (idxImagen >= 0 ? (cols[idxImagen] || '') : '').trim();\n    const imagenes = imagenCelda.split('|').map(u => u.trim()).filter(Boolean);\n    productos.push({",
   "  const idxTamBotella = encabezados.findIndex(h => h.includes('botella') && /(tam|ml)/.test(h));\n  // Opcional: \"Más vendido\" (1, 2, 3… = puesto; \"Si\" = entra al final de la lista)\n  const idxMasVend    = encabezados.findIndex(h => h.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z]/g, '') === 'masvendido' || h === 'destacado' || h === 'top');\n  if (idxNombre < 0) diag.avisos.push('No encuentro la columna \"Nombre\" en el encabezado del Sheet.');\n\n  const productos = [];\n  const vistos = new Set();\n  for (let i = 1; i < filas.length; i++) {\n    const cols = filas[i].map(c => c.trim());\n    if (!cols.some(Boolean)) continue;          // fila totalmente vacía\n    diag.filas++;\n    const nombre = (cols[idxNombre] || '').replace(/\\s+/g, ' ');\n    if (!nombre) { diag.omitidas.push(`fila ${i + 1}: sin Nombre (hay datos en otras celdas)`); continue; }\n    const k = normalizarNombre(nombre);\n    if (vistos.has(k)) { diag.omitidas.push(`fila ${i + 1}: «${nombre}» está repetido; se usa la primera fila`); continue; }\n    vistos.add(k);\n    const dispVal = (cols[idxDisponible] || '').toLowerCase().replace(/[.!\\s]+$/g, '').trim();\n    const estaActivo = DISP_SI.includes(dispVal);\n    if (!estaActivo && dispVal !== 'no') diag.avisos.push(`fila ${i + 1} «${nombre}»: Disponible dice «${cols[idxDisponible] || ''}» y se toma como No (usa Si o No)`);\n    const imagenCelda = (idxImagen >= 0 ? (cols[idxImagen] || '') : '').trim();\n    const imagenes = imagenCelda.split(/[|\\n]/).map(u => u.trim()).filter(Boolean);\n    const ml5 = cols[idxMl5] || '', ml10 = cols[idxMl10] || '';\n    if (!ml5 && !ml10) diag.avisos.push(`fila ${i + 1} «${nombre}»: sin precios de 5 ml ni de 10 ml`);\n    if (!imagenes.length) diag.avisos.push(`fila ${i + 1} «${nombre}»: sin imagen`);\n    const mv = idxMasVend >= 0 ? (cols[idxMasVend] || '').toLowerCase() : '';\n    const masVendido = /^\\d+$/.test(mv) ? parseInt(mv, 10) : (['si', 'sí', 'x', '✓', '✔'].includes(mv) ? 999 : 0);\n    productos.push({"
  ],
  [
   "      nombre,\n      ml5: cols[idxMl5] || '',\n      ml10: cols[idxMl10] || '',\n      disponible: estaActivo,",
   "      nombre,\n      ml5,\n      ml10,\n      disponible: estaActivo,"
  ],
  [
   "      imagenes, // lista completa, para el carrusel\n      descripcion: (idxDesc >= 0 ? (cols[idxDesc] || '') : '').trim(),\n      botella: idxBotella >= 0 ? precioBotellaQ(cols[idxBotella]) : '',\n      tamBotella: idxTamBotella >= 0 ? tamanoBotella(cols[idxTamBotella]) : ''\n    });",
   "      imagenes, // lista completa, para el carrusel\n      descripcion: (idxDesc >= 0 ? (cols[idxDesc] || '') : '').replace(/\\s*\\n\\s*/g, ' ').trim(),\n      botella: idxBotella >= 0 ? precioBotellaQ(cols[idxBotella]) : '',\n      tamBotella: idxTamBotella >= 0 ? tamanoBotella(cols[idxTamBotella]) : '',\n      masVendido,\n      fila: i + 1\n    });"
  ],
  [
   "\nasync function cargarInventario() {\n  try {\n    const res = await fetch(`${SHEETS_CSV_URL}&_=${Date.now()}`, { cache: 'no-store' });\n    if (!res.ok) throw new Error('HTTP ' + res.status);\n    const csv = await res.text();\n    const productos = parsearCSV(csv);\n",
   "\n// ═══ CATÁLOGO 100 % DESDE EL SHEET ═══\n// Las tarjetas que vienen escritas en el HTML son solo un respaldo (si el Sheet no carga y no hay copia guardada).\n// Apenas se lee el Sheet, el catálogo se arma de cero con TODAS sus filas (Si y No), agrupadas por marca en el orden del Sheet.\nfunction tituloMarca(m) {\n  const s = String(m || '').trim();\n  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\\s·-])(\\p{L})/gu, (x, a, b) => a + b.toUpperCase()) : s;\n}\nlet __altCatalogoSig = '';\nfunction reconstruirCatalogoDesdeSheet(productos) {\n  const grid = document.getElementById('productsGrid');\n  if (!grid || !productos.length) return false;\n  const sig = JSON.stringify(productos.map(p => [p.marca, p.nombre, p.ml5, p.ml10, p.disponible, p.imagenes, p.descripcion, p.botella, p.tamBotella]));\n  if (sig === __altCatalogoSig && grid.querySelector('.product-card[data-origen=\"sheet\"]')) return false; // sin cambios desde la última vez\n  __altCatalogoSig = sig;\n\n  const grupos = new Map();\n  productos.forEach(p => {\n    const cat = categoriaCanonica(p.marca);\n    const etiqueta = cat && cat !== p.marca ? cat : (tituloMarca(p.marca) || 'Otras');\n    const clave = claveMarca(etiqueta) || 'otras';\n    if (!grupos.has(clave)) grupos.set(clave, { etiqueta, items: [] });\n    grupos.get(clave).items.push(p);\n  });\n\n  grid.textContent = '';\n  let id = 0;\n  grupos.forEach(g => {\n    const sec = document.createElement('div');\n    sec.className = 'brand-section';\n    sec.innerHTML = `<div class=\"brand-divider\"><div class=\"bdline\"></div><span class=\"bdlabel\">✦ ${escH(g.etiqueta)} ✦</span><div class=\"bdline r\"></div></div><div class=\"brand-grid\"></div>`;\n    const bg = sec.querySelector('.brand-grid');\n    g.items.forEach(p => { const c = crearTarjetaDesdeSheet(p, id++); c.dataset.origen = 'sheet'; bg.appendChild(c); });\n    grid.appendChild(sec);\n  });\n  grid.querySelectorAll('.product-card').forEach(c => configurarCarruselTarjeta(c));\n\n  // Un botón de filtro por marca: se crean los que falten y se ocultan las marcas sin perfumes\n  const barra = document.querySelector('.filter-inner');\n  if (barra) {\n    const contador = document.getElementById('productCounter');\n    grupos.forEach(g => {\n      const existe = Array.from(barra.querySelectorAll('.filter-btn')).some(b => b.dataset.filter !== 'all' && mismaMarca(b.dataset.filter, g.etiqueta));\n      if (existe) return;\n      const btn = document.createElement('button');\n      btn.className = 'filter-btn'; btn.dataset.filter = g.etiqueta; btn.textContent = g.etiqueta;\n      btn.addEventListener('click', () => activarFiltroMarca(btn));\n      barra.insertBefore(btn, contador || null);\n    });\n    barra.querySelectorAll('.filter-btn').forEach(b => {\n      if (b.dataset.filter === 'all') return;\n      b.style.display = Array.from(grupos.values()).some(g => mismaMarca(g.etiqueta, b.dataset.filter)) ? '' : 'none';\n    });\n  }\n  // Si había una marca elegida o un texto en la búsqueda, se vuelve a aplicar sobre las tarjetas nuevas\n  const act = document.querySelector('.filter-btn.active');\n  if (act && act.dataset.filter !== 'all') aplicarFiltroMarca(act.dataset.filter);\n  const si = document.getElementById('searchInput');\n  if (si && si.value) si.dispatchEvent(new Event('input'));\n  return true;\n}\n\n// Panel de diagnóstico: abre la tienda con ?diag=1 para ver qué leyó de tu Sheet y qué filas tienen problemas\nfunction mostrarDiagnosticoCatalogo(fuente, productos) {\n  const d = window.__altDiag || { filas: 0, omitidas: [], avisos: [] };\n  const tarjetas = document.querySelectorAll('.product-card[data-origen=\"sheet\"]').length;\n  console.info(`[Sheets] ${productos.length} perfumes leídos (${fuente}), ${tarjetas} tarjetas, ${d.omitidas.length} filas omitidas, ${d.avisos.length} avisos`);\n  d.omitidas.concat(d.avisos).forEach(x => console.warn('[Sheets] ' + x));\n  if (!/[?&]diag=1/.test(location.search)) return;\n  let p = document.getElementById('altDiag');\n  if (!p) {\n    p = document.createElement('div'); p.id = 'altDiag';\n    p.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;max-width:min(440px,94vw);max-height:62vh;overflow:auto;background:#101010;color:#eee;border:1px solid #c9a84c;padding:12px 14px;font:12px/1.5 monospace;white-space:pre-wrap';\n    p.addEventListener('dblclick', () => p.remove());\n    document.body.appendChild(p);\n  }\n  const lineas = [`DIAGNÓSTICO DEL CATÁLOGO  (doble clic para cerrar)`, `Fuente: ${fuente} · ${new Date().toLocaleTimeString()}`,\n    `Filas con datos en el Sheet: ${d.filas}`, `Perfumes leídos: ${productos.length} (Si: ${productos.filter(p => p.disponible).length} · No: ${productos.filter(p => !p.disponible).length})`,\n    `Tarjetas en la página: ${tarjetas}`, ''];\n  if (d.omitidas.length) { lineas.push('FILAS OMITIDAS:'); d.omitidas.forEach(x => lineas.push(' • ' + x)); lineas.push(''); }\n  if (d.avisos.length) { lineas.push('AVISOS:'); d.avisos.forEach(x => lineas.push(' • ' + x)); }\n  if (!d.omitidas.length && !d.avisos.length) lineas.push('Sin problemas: todas las filas se leyeron bien.');\n  p.textContent = lineas.join('\\n');\n}\n\nasync function cargarInventario() {\n  try {\n    let csv = '', fuente = 'Sheet en vivo';\n    try {\n      const res = await fetch(`${SHEETS_CSV_URL}&_=${Date.now()}`, { cache: 'no-store' });\n      if (!res.ok) throw new Error('HTTP ' + res.status);\n      csv = await res.text();\n    } catch (errRed) {\n      // Sin red o Google no respondió: se usa la última copia buena guardada en este dispositivo (hasta 7 días)\n      let copia = null; try { copia = JSON.parse(localStorage.getItem('alt_inventario_csv') || 'null'); } catch (_) {}\n      if (!copia || !copia.csv || Date.now() - copia.t > 7 * 864e5) throw errRed;\n      csv = copia.csv; fuente = 'copia guardada';\n      console.warn('[Sheets] Sin conexión con el Sheet: uso la copia guardada');\n    }\n    const productos = parsearCSV(csv);\n    if (!productos.length) throw new Error('el Sheet no trajo perfumes (¿está publicado y la primera pestaña es el catálogo?)');\n    if (fuente === 'Sheet en vivo') { try { localStorage.setItem('alt_inventario_csv', JSON.stringify({ t: Date.now(), csv })); } catch (_) {} }\n    window.altProductos = productos;   // lo usan los \"Más vendidos\" y el selector de perfumes de los combos\n"
  ],
  [
   "    console.log('[Sheets] Inventario cargado:', productos.length, 'productos');\n    crearProductosNuevosDesdeSheet(productos);\n    aplicarDisponibilidad();\n    diagnosticarInventario(productos);\n    aplicarImagenesSheet();",
   "    console.log('[Sheets] Inventario cargado:', productos.length, 'productos');\n    reconstruirCatalogoDesdeSheet(productos);\n    aplicarDisponibilidad();\n    mostrarDiagnosticoCatalogo(fuente, productos);\n    aplicarImagenesSheet();"
  ],
  [
   "    renderNuevosIngresos(productos);\n    window.altProductos = productos;   // lo usa el selector de perfumes de los combos\n    if (window.altVialPrecios) window.altVialPrecios(productos);",
   "    renderNuevosIngresos(productos);\n    if (window.altVialPrecios) window.altVialPrecios(productos);"
  ]
 ]
};

for (const f of Object.keys(ARCHIVOS)) {
  if (!fs.existsSync(f)) { console.error(`✘ No encuentro ${f} aquí. Abre la terminal DENTRO de la carpeta del repo althamir-bot (y haz git pull antes).`); process.exit(1); }
}
const resultados = [];
let fallos = 0;
for (const [f, pares] of Object.entries(ARCHIVOS)) {
  const { txt, crlf } = leer(f);
  const r = aplicarPares(txt, pares);
  resultados.push({ f, crlf, ...r });
  console.log(`${r.malos.length ? "✘" : "✔"} ${f}: ${r.aplicados} cambios por aplicar, ${r.ya} ya estaban`);
  r.malos.forEach((m) => console.log("     " + m));
  fallos += r.malos.length;
}
if (fallos) { console.log(`\n✘ ${fallos} cambio(s) no se pudieron aplicar. No modifiqué ningún archivo. Mándame esta salida completa.`); process.exit(2); }
if (PROBAR) { console.log("\n(modo --probar) Todo se puede aplicar. No modifiqué nada."); process.exit(0); }
for (const r of resultados) if (r.aplicados) fs.writeFileSync(r.f, r.crlf ? r.txt.replace(/\n/g, "\r\n") : r.txt);
console.log("\n✔ Listo. Revisa con: git status   y   git diff");
