// netlify/functions/sitemap.js — https://althamirgt.com/sitemap.xml
// Lista la tienda y todas las páginas de producto, siempre al día con el inventario.
'use strict';
const { cargarCatalogo, SITIO } = require('./lib/catalogo');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

exports.handler = async () => {
  try {
    const productos = await cargarCatalogo();
    const hoy = new Date().toISOString().slice(0, 10);
    const urls = [{ loc: SITIO + '/', prio: '1.0' }, ...productos.map(p => ({ loc: `${SITIO}/p/${p.slug}`, prio: '0.7' }))];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map(u => `  <url><loc>${esc(u.loc)}</loc><lastmod>${hoy}</lastmod><priority>${u.prio}</priority></url>`).join('\n') + '\n</urlset>\n';
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=900, s-maxage=3600' }, body: xml };
  } catch (e) {
    console.error('[Sitemap] Error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Sitemap no disponible' };
  }
};
