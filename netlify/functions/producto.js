// netlify/functions/producto.js
//
// Página propia de cada perfume: https://althamirgt.com/p/lattafa-yara-moi
// Se arma en el momento con el inventario del Sheet (precios y disponibilidad al día), incluye los datos
// estructurados que Google usa para mostrar precio y disponibilidad, y funciona aunque el Sheet no responda.

'use strict';
const { cargarCatalogo, SITIO } = require('./lib/catalogo');
const { snippet, gaIdPorDefecto } = require('./lib/analitica-snippet');

const WHATSAPP = '50252547623';
const GA_ID = process.env.GA_ID || gaIdPorDefecto;
const IMAGEN_SOCIAL = 'https://res.cloudinary.com/dwnqasp3x/image/upload/w_1200,h_630,c_fill,f_auto,q_auto/imagen_001_q9ncz3.png'; // la misma imagen que usa la tienda al compartirse

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// JSON dentro de <script>: se escapan los caracteres que podrían cerrar la etiqueta
const jsonSeguro = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const dinero = (n) => 'Q' + (Number.isInteger(n) ? n : n.toFixed(2));
const recortar = (t, max) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'; };
const wa = (texto) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(texto)}`;

function obtenerSlug(event) {
  const crudo = (event.queryStringParameters && event.queryStringParameters.slug) || String(event.path || '').split('/p/')[1] || '';
  return decodeURIComponent(String(crudo)).split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function paginaNoEncontrada(slug) {
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perfume no encontrado | Althamir GT</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/styles.css">
<style>body{display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}a{color:var(--gold)}</style></head>
<body><main><h1 style="font-family:'Playfair Display',serif;font-weight:400">Ese perfume no está en el catálogo</h1>
<p style="color:var(--text-dim);margin:14px 0 24px">Puede que ya no esté disponible o que el enlace tenga un error.</p>
<p><a href="/">Ver todo el catálogo</a> · <a href="${esc(wa('Hola Althamir 👋 Busco un perfume que no encuentro en la tienda. ¿Me ayudan?'))}">Pedir uno por WhatsApp</a></p></main></body></html>`;
  return { statusCode: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' }, body: html };
}

function paginaProducto(p, todos) {
  const url = `${SITIO}/p/${p.slug}`;
  const tamanos = [];
  if (p.ml5) tamanos.push({ ml: 5, precio: p.ml5 });
  if (p.ml10) tamanos.push({ ml: 10, precio: p.ml10 });
  const precioTxt = tamanos.map(t => `${t.ml} ml (${dinero(t.precio)})`).join(' y ');
  const desc = p.descripcion || `${p.nombre} de ${p.marca}.`;
  const primeraFrase = recortar(desc.split(/(?<=[.!?])\s/)[0], 90);
  const titulo = recortar(`${p.nombre} ${p.marca}: decant ${tamanos.map(t => t.ml).join(' y ')} ml | Althamir GT`, 64);
  const metaDesc = recortar(`${p.nombre} de ${p.marca}: decants de ${precioTxt || '5 y 10 ml'} en Guatemala. ${primeraFrase}`, 158);
  const imagen = p.imagenes[0] || IMAGEN_SOCIAL;
  const precioBase = tamanos.length ? tamanos[0].precio : undefined;
  const disponibilidad = p.disponible ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder';

  const producto = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.nombre, description: recortar(desc, 500), sku: p.slug,
    brand: { '@type': 'Brand', name: p.marca }, category: 'Perfumes', url,
    image: p.imagenes.length ? p.imagenes : [IMAGEN_SOCIAL]
  };
  if (tamanos.length) {
    producto.offers = tamanos.map(t => ({
      '@type': 'Offer', name: `Decant ${t.ml} ml`, price: t.precio.toFixed(2), priceCurrency: 'GTQ', availability: disponibilidad,
      itemCondition: 'https://schema.org/NewCondition', url,
      seller: { '@type': 'Organization', name: 'Althamir GT', url: SITIO }
    }));
  }
  const migas = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITIO + '/' },
    { '@type': 'ListItem', position: 2, name: 'Catálogo', item: SITIO + '/#catalogo' },
    { '@type': 'ListItem', position: 3, name: p.nombre, item: url } ] };

  const relacionados = todos.filter(x => x.slug !== p.slug && x.categoria === p.categoria).concat(todos.filter(x => x.slug !== p.slug && x.categoria !== p.categoria)).slice(0, 4);
  const msgPedido = `Hola Althamir 👋 Me interesa el decant de *${p.nombre}* (${p.marca}). ¿Está disponible?`;
  const msgBotella = `Hola, me interesa conocer el precio de botella completa de *${p.nombre}*. ¿Podrías ayudarme?`;
  const utm = `utm_source=tienda&utm_medium=ficha&utm_campaign=${encodeURIComponent(p.slug)}`;

  const filasPrecio = tamanos.map(t => `<li><span>Decant ${t.ml} ml</span><strong>${dinero(t.precio)}</strong></li>`).join('');
  const miniaturas = p.imagenes.slice(1, 5).map(u => `<img src="${esc(u)}" alt="${esc(p.nombre)}, otra foto" loading="lazy">`).join('');

  const html = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="theme-color" content="#060d08">
<meta property="og:type" content="product"><meta property="og:site_name" content="Althamir GT"><meta property="og:locale" content="es_LA">
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(imagen)}">
${precioBase ? `<meta property="product:price:amount" content="${precioBase.toFixed(2)}"><meta property="product:price:currency" content="GTQ">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(titulo)}"><meta name="twitter:description" content="${esc(metaDesc)}"><meta name="twitter:image" content="${esc(imagen)}">
<link rel="icon" type="image/png" href="https://res.cloudinary.com/dwnqasp3x/image/upload/w_32,h_32,c_fill,f_auto/imagen_001_q9ncz3.png">
<link rel="apple-touch-icon" href="https://res.cloudinary.com/dwnqasp3x/image/upload/w_180,h_180,c_fill,f_auto/imagen_001_q9ncz3.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Jost:wght@200;300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<style>
.pp{max-width:1040px;margin:0 auto;padding:24px 20px 60px;position:relative;z-index:1}
.pp-top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:26px;font-size:13px}
.pp-top a{color:var(--gold);text-decoration:none}
.pp-crumbs{color:var(--text-muted);font-size:12px;letter-spacing:1px}
.pp-grid{display:grid;gap:36px;grid-template-columns:1fr}
@media(min-width:780px){.pp-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}}
.pp-foto{border:1px solid var(--gold-border);border-radius:18px;overflow:hidden;background:var(--bg2);aspect-ratio:4/5}
.pp-foto img{width:100%;height:100%;object-fit:cover;display:block}
.pp-mini{display:flex;gap:10px;margin-top:12px}.pp-mini img{width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--gold-border)}
.pp-marca{font-size:11px;letter-spacing:5px;text-transform:uppercase;color:var(--gold)}
.pp h1{font-family:'Playfair Display',serif;font-weight:400;font-size:clamp(32px,6vw,52px);line-height:1.1;margin:10px 0 18px}
.pp-desc{color:var(--text-dim);line-height:1.75;font-size:15px;margin:0 0 22px}
.pp-precios{list-style:none;margin:0 0 22px;padding:0;border:1px solid var(--gold-border);border-radius:14px;background:var(--bg2)}
.pp-precios li{display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--gold-border)}
.pp-precios li:last-child{border-bottom:0}.pp-precios strong{color:var(--gold);font-weight:500}
.pp-aviso{border:1px dashed var(--gold-border);border-radius:12px;padding:12px 16px;color:var(--text-dim);font-size:13px;margin:0 0 18px}
.pp-btns{display:grid;gap:12px}
.pp-btn{display:block;text-align:center;padding:15px 20px;border-radius:999px;text-decoration:none;font-size:14px;letter-spacing:1px;border:1px solid var(--gold);color:var(--gold);background:transparent;cursor:pointer;font-family:inherit}
.pp-btn.principal{background:var(--gold);color:#17110f;font-weight:500}
.pp-nota{color:var(--text-muted);font-size:12px;margin-top:14px;line-height:1.6}
.pp h2{font-family:'Playfair Display',serif;font-weight:400;font-size:26px;margin:46px 0 16px}
.pp-rel{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.pp-rel a{display:block;border:1px solid var(--gold-border);border-radius:14px;padding:16px 18px;text-decoration:none;color:var(--text);background:var(--bg2)}
.pp-rel small{display:block;color:var(--gold);letter-spacing:3px;text-transform:uppercase;font-size:10px;margin-bottom:6px}
.pp-links{margin-top:46px;color:var(--text-muted);font-size:13px;line-height:2}.pp-links a{color:var(--gold)}
.pp-pie{margin-top:50px;padding-top:22px;border-top:1px solid var(--gold-border);color:var(--text-muted);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 14px}
.pp-pie a{color:inherit}
</style>
<script type="application/ld+json">${jsonSeguro(producto)}</script>
<script type="application/ld+json">${jsonSeguro(migas)}</script>
${snippet.replace('__GA_ID__', GA_ID)}
</head>
<body>
<div class="pp">
  <div class="pp-top"><a href="/">← Volver a la tienda</a><span class="pp-crumbs">Inicio › Catálogo › ${esc(p.nombre)}</span></div>
  <main class="pp-grid">
    <div>
      <div class="pp-foto"><img src="${esc(imagen)}" alt="${esc(p.nombre)} de ${esc(p.marca)}, decant" fetchpriority="high"></div>
      ${miniaturas ? `<div class="pp-mini">${miniaturas}</div>` : ''}
    </div>
    <div>
      <div class="pp-marca">${esc(p.marca)}</div>
      <h1>${esc(p.nombre)}</h1>
      <p class="pp-desc">${esc(desc)}</p>
      ${filasPrecio ? `<ul class="pp-precios">${filasPrecio}</ul>` : ''}
      ${p.disponible ? '' : '<p class="pp-aviso">Este perfume está <strong>bajo pedido</strong>: escríbenos y te confirmamos el tiempo de entrega.</p>'}
      <div class="pp-btns">
        <a class="pp-btn principal btn-wa" href="${esc(wa(msgPedido))}" target="_blank" rel="noopener">Pedir por WhatsApp</a>
        <a class="pp-btn" href="/?producto=${esc(p.slug)}#catalogo">Ver en la tienda y agregar al carrito</a>
        <a class="pp-btn btn-wa" href="${esc(wa(msgBotella))}" target="_blank" rel="noopener">Cotizar la botella completa</a>
        <button class="pp-btn" type="button" id="pp-compartir">Compartir este perfume</button>
      </div>
      <p class="pp-nota">Un decant es una porción del perfume original en un atomizador de 5 o 10 ml: el mismo aroma, para probarlo antes de comprar el frasco. Envíos solo dentro de Guatemala (Q30 capital, Q40 interior). Precios y disponibilidad pueden cambiar.</p>
    </div>
  </main>
  ${relacionados.length ? `<section class="pp"><h2>También te puede gustar</h2><div class="pp-rel">${relacionados.map(r => `<a href="/p/${esc(r.slug)}"><small>${esc(r.marca)}</small>${esc(r.nombre)}</a>`).join('')}</div></section>` : ''}
  <p class="pp-links">¿Primera vez con decants? Lee <a href="https://herramientas.althamirgt.com/guias/que-es-un-decant/?${utm}">qué es un decant</a>, calcula <a href="https://herramientas.althamirgt.com/costo-por-spray/?${utm}">cuánto te cuesta cada spray</a> o haz el <a href="https://herramientas.althamirgt.com/test-de-perfumes/?${utm}">test para encontrar tu aroma</a>.</p>
  <div class="pp-pie"><span>Althamir GT · Perfumería árabe en Guatemala</span><a href="/">Tienda</a><a href="https://herramientas.althamirgt.com/guias/?${utm}">Guías</a><a href="https://herramientas.althamirgt.com/privacidad/">Privacidad</a><span id="altCookiesWrap"><a href="#cookies" id="altCookiesLink">Cookies</a></span></div>
</div>
<script>
(function () {
  var D = ${jsonSeguro({ nombre: p.nombre, marca: p.marca, precio: precioBase || 0, slug: p.slug })};
  try { altTrack('view_item', { currency: 'GTQ', value: D.precio, items: [altItem(D.nombre, D.marca, '', D.precio)] }); } catch (e) {}
  var b = document.getElementById('pp-compartir');
  if (b) b.addEventListener('click', function () {
    var u = location.origin + '/p/' + D.slug, t = D.nombre + ' (' + D.marca + ') · Althamir GT';
    try { altTrack('share', { method: navigator.share ? 'nativo' : 'copiar', item_id: D.slug }); } catch (e) {}
    if (navigator.share) { navigator.share({ title: t, text: t, url: u }).catch(function () {}); }
    else if (navigator.clipboard) { navigator.clipboard.writeText(u).then(function () { b.textContent = '¡Enlace copiado!'; setTimeout(function () { b.textContent = 'Compartir este perfume'; }, 2200); }); }
  });
})();
</script>
</body></html>`;
  return html;
}

exports.handler = async (event) => {
  const slug = obtenerSlug(event);
  try {
    const productos = await cargarCatalogo();
    const p = productos.find(x => x.slug === slug);
    if (!p) return paginaNoEncontrada(slug);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400' },
      body: paginaProducto(p, productos)
    };
  } catch (e) {
    console.error('[Producto] Error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'No pudimos cargar este perfume en este momento. Intenta de nuevo en un minuto.' };
  }
};
