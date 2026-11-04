// netlify/functions/lib/ofertas.js
//
// Lógica ÚNICA de las ofertas (pestaña "Ofertas" del Google Sheet). La usan:
//   - recurrente-checkout.js (vía precios.js): valida las ofertas del carrito y pone el PRECIO.
//   - sheets.js del bot de Noor (Render): para que Noor sepa qué ofertas hay.
// No tiene dependencias: solo funciones puras (el que la llama le pasa las filas ya descargadas).
//
// Columnas de la pestaña (el orden no importa, solo los nombres):
//   Activa | Titulo | Etiqueta | Descripcion | Precio | PrecioAntes | Inicio | Fin | Boton | Enlace | Estilo | Nota | Tipo | Cantidad | Tamano
//
// Tipo = combo  → se compra en el carrito: `Cantidad` decants de `Tamano` (5 o 10) por `Precio` TOTAL.
// Cualquier otro Tipo (o vacío) → oferta informativa (botón a WhatsApp / enlace), sin carrito.

'use strict';

const HORAS_GT = 6;            // Guatemala = UTC-6 todo el año (sin horario de verano)
const MAX_CANTIDAD_COMBO = 6;  // máximo de decants dentro de un combo
const MAX_PRECIO_COMBO = 5000; // tope de cordura: un combo más caro que esto se considera mal escrito

function normalizar(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Parser CSV completo: respeta comillas, comas y saltos de línea dentro de una celda
function filasCSV(texto) {
  const out = []; let fila = []; let c = ''; let q = false;
  texto = String(texto == null ? '' : texto).replace(/^\uFEFF/, '');
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (q) {
      if (ch === '"') { if (texto[i + 1] === '"') { c += '"'; i++; } else q = false; }
      else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { fila.push(c); c = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      fila.push(c); c = ''; out.push(fila); fila = [];
    } else c += ch;
  }
  if (c !== '' || fila.length) { fila.push(c); out.push(fila); }
  return out.filter(f => f.some(x => String(x).trim() !== ''));
}

// "2026-11-30 23:59[:59]" o "30/11/2026 23:59" (también 11/30/2026) → milisegundos UTC, interpretando la hora como Guatemala
function fechaGT(txt, esFin) {
  txt = String(txt == null ? '' : txt).trim();
  if (!txt) return null;
  let y, mo, d, m;
  let h = esFin ? 23 : 0, mi = esFin ? 59 : 0, se = esFin ? 59 : 0;
  if ((m = txt.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else if ((m = txt.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) {
    d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000;
    if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
  } else return null;
  if (m[4] !== undefined) { h = +m[4]; mi = +m[5]; se = m[6] !== undefined ? +m[6] : (esFin ? 59 : 0); }   // "Fin 23:59" = hasta el último segundo de ese minuto
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return Date.UTC(y, mo - 1, d, h + HORAS_GT, mi, se);
}

function numero(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const esSi = (v) => ['si', 'yes', 'true', '1'].includes(normalizar(v));

/**
 * filas: arreglo de arreglos (la primera fila son los encabezados).
 * Devuelve las ofertas ACTIVAS y VIGENTES (dentro de Inicio/Fin) en el orden del Sheet.
 * Si no hay columnas "Activa" y "Titulo" (por ejemplo, Google devolvió otra hoja) devuelve [].
 */
function procesarFilas(filas, ahora) {
  ahora = ahora === undefined ? Date.now() : ahora;
  if (!Array.isArray(filas) || filas.length < 2) return [];
  const cab = filas[0].map(normalizar);
  const ix = (...nombres) => { for (const n of nombres) { const i = cab.indexOf(n); if (i > -1) return i; } return -1; };
  const I = {
    act: ix('activa', 'activo'), tit: ix('titulo', 'oferta'), eti: ix('etiqueta'), des: ix('descripcion'),
    pre: ix('precio'), ant: ix('precioantes', 'antes'), ini: ix('inicio'), fin: ix('fin'), bot: ix('boton'),
    enl: ix('enlace'), est: ix('estilo'), not: ix('nota'), tip: ix('tipo'), can: ix('cantidad'), tam: ix('tamano', 'tamanoml', 'size')
  };
  if (I.act < 0 || I.tit < 0) return [];

  const res = []; const usados = new Set();
  for (let r = 1; r < filas.length; r++) {
    const f = filas[r] || [];
    const v = (i) => (i > -1 && f[i] !== undefined && f[i] !== null ? String(f[i]).trim() : '');
    if (!esSi(v(I.act))) continue;
    const titulo = v(I.tit); if (!titulo) continue;
    const inicio = fechaGT(v(I.ini), false), fin = fechaGT(v(I.fin), true);
    if (inicio !== null && ahora < inicio) continue;   // todavía no empieza
    if (fin !== null && ahora >= fin) continue;        // ya terminó

    let id = normalizar(titulo).slice(0, 60) || ('oferta' + r);
    if (usados.has(id)) id += '-' + r;
    usados.add(id);

    const etiqueta = v(I.eti);
    const precioNum = numero(v(I.pre));
    const o = {
      id, titulo, etiqueta, descripcion: v(I.des),
      precio: v(I.pre), precioNum, precioAntes: v(I.ant),
      inicio, fin, boton: v(I.bot), enlace: v(I.enl), estilo: v(I.est), nota: v(I.not),
      relampago: /relampago|flash/.test(normalizar(etiqueta)),
      tipo: 'info', cantidad: null, tamano: null
    };

    if (normalizar(v(I.tip)) === 'combo') {
      const cantidad = parseInt(v(I.can), 10);
      const tam = normalizar(v(I.tam)).replace(/ml$/, '');
      const tamano = tam === '5' ? '5 ml' : tam === '10' ? '10 ml' : null;
      const ok = Number.isInteger(cantidad) && cantidad >= 1 && cantidad <= MAX_CANTIDAD_COMBO &&
        tamano && precioNum !== null && precioNum <= MAX_PRECIO_COMBO;
      if (ok) { o.tipo = 'combo'; o.cantidad = cantidad; o.tamano = tamano; }
      else o.errorCombo = 'Combo mal configurado (revisa Cantidad 1-' + MAX_CANTIDAD_COMBO + ', Tamano 5 o 10 y un Precio numérico)';
    }
    res.push(o);
  }
  return res;
}

function procesarCSV(texto, ahora) { return procesarFilas(filasCSV(texto), ahora); }

// ───────── Texto para Noor ─────────
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fechaLegible(ms) {
  const g = new Date(ms - HORAS_GT * 3600000);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return `${g.getUTCDate()} ${MESES[g.getUTCMonth()]} ${pad(g.getUTCHours())}:${pad(g.getUTCMinutes())} (hora de Guatemala)`;
}
function faltan(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min >= 2880) return Math.floor(min / 1440) + ' días';
  if (min >= 120) return Math.floor(min / 60) + ' horas';
  if (min >= 60) return '1 hora y ' + (min - 60) + ' min';
  return min + ' min';
}
const q = (n) => 'Q' + (Math.round(n * 100) % 100 === 0 ? Math.round(n) : n.toFixed(2));

/**
 * Bloque de texto para el prompt de Noor. '' si no hay ofertas vigentes.
 * Instruye a Noor a SOLO anunciar el tipo de oferta (con urgencia si es relámpago) y a dar detalles únicamente si preguntan.
 */
function textoParaNoor(ofertas, opciones) {
  const ahora = (opciones && opciones.ahora) || Date.now();
  const dondeComprar = (opciones && opciones.dondeComprar) || 'en la sección "Ofertas Exclusivas" de althamirgt.com (pago con tarjeta) o por WhatsApp';
  const vivas = (ofertas || []).filter(o => (o.fin === null || o.fin > ahora) && (o.inicio === null || o.inicio <= ahora));
  if (!vivas.length) return '';

  const lineas = vivas.map((o, i) => {
    const tipo = o.relampago ? 'RELÁMPAGO' : (o.etiqueta ? 'OFERTA: ' + o.etiqueta : 'OFERTA ESPECIAL');
    let l = `${i + 1}) [${tipo}] "${o.titulo}"`;
    if (o.tipo === 'combo') l += ` — combo de ${o.cantidad} decant${o.cantidad > 1 ? 's' : ''} de ${o.tamano} a ${q(o.precioNum)} en total (se elige cualquier fragancia disponible)`;
    else if (o.precio) l += ` — precio ${/^\d/.test(o.precio) ? 'Q' + o.precio : o.precio}`;
    if (o.descripcion) l += `. ${o.descripcion}`;
    if (o.nota) l += ` Nota: ${o.nota}`;
    if (o.fin !== null) l += ` Termina: ${fechaLegible(o.fin)}, faltan ${faltan(o.fin - ahora)}.`;
    return l;
  });

  const hayRelampago = vivas.some(o => o.relampago);
  // Los ejemplos salen SOLO de las ofertas que existen ahora (nada de "Navidad" si hoy no hay una de Navidad)
  const ejemplos = [];
  if (hayRelampago) ejemplos.push('"por cierto, ahora mismo tenemos una oferta relámpago ⚡"');
  const otra = vivas.find(o => !o.relampago);
  if (otra) ejemplos.push(otra.etiqueta ? `"tenemos una oferta de ${otra.etiqueta}"` : '"tenemos una oferta especial"');
  return [
    '',
    'OFERTAS VIGENTES AHORA (datos reales de la tienda; todo lo que no esté aquí NO existe):',
    ...lineas,
    '',
    'CÓMO HABLAR DE LAS OFERTAS:',
    '- Por defecto SOLO menciona que existe, sin precio ni detalles, en una frase corta y natural, por ejemplo ' + ejemplos.join(' o ') + ' (usa la etiqueta tal cual).',
    '- Menciónala una sola vez por conversación, cuando venga al caso (saludo, preguntas por precios, dudas sobre qué comprar). No la repitas ni la fuerces.',
    '- Si es RELÁMPAGO: habla con urgencia real y cálida (que dura poco, que conviene aprovecharla pronto). Nunca inventes escasez, cupos ni horas: usa solo el tiempo que figura arriba.',
    '- Si NO es relámpago: tono tranquilo y sin presión.',
    '- Si el cliente pregunta por la oferta o pide detalles, dalos EXACTOS como están arriba (qué incluye, tamaño, precio, hasta cuándo). No cambies precios ni condiciones.',
    `- Dónde se aprovecha: ${dondeComprar}.`
  ].join('\n');
}

module.exports = {
  procesarFilas, procesarCSV, filasCSV, fechaGT, textoParaNoor, normalizar, numero,
  MAX_CANTIDAD_COMBO, HORAS_GT
};
