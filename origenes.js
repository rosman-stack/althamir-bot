// De dónde vienen los pedidos (TikTok, Instagram, Facebook...) para el resumen de las 9 am.
// El origen se guarda en la columna K ("Origen") del Sheet de pedidos, con el formato "tiktok · decant1"
// (fuente · contenido). Sin pedidos con origen, el resumen queda igual que siempre.

const DIA_MS = 24 * 3600 * 1000;
const ETIQUETAS = { tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', google: 'Google' };

function partir(origen) {
  const [f, ...r] = String(origen || '').split('·');
  return { fuente: f.trim().toLowerCase(), detalle: r.join('·').trim().toLowerCase() };
}
function etiqueta(f) { return ETIQUETAS[f] || (f ? f.charAt(0).toUpperCase() + f.slice(1) : 'Sin origen'); }

// lista = pedidos.listarPedidos(). Devuelve las líneas del bloque; [] si ningún pedido reciente trae origen.
function resumir(lista, ahora, dias = 30) {
  const recientes = (lista || []).filter(p => p.fecha && p.fecha >= ahora - dias * DIA_MS);
  const conOrigen = recientes.filter(p => partir(p.origen).fuente);
  if (!conOrigen.length) return [];
  const grupos = new Map();
  for (const p of conOrigen) {
    const { fuente, detalle } = partir(p.origen);
    const g = grupos.get(fuente) || { n: 0, q: 0, det: new Map() };
    g.n++;
    if (p.estado !== 'Pendiente de pago') g.q += p.total || 0;
    if (detalle) g.det.set(detalle, (g.det.get(detalle) || 0) + 1);
    grupos.set(fuente, g);
  }
  const lineas = [`🔗 De dónde vienen los pedidos (últimos ${dias} días; el monto no cuenta los pendientes de pago):`];
  [...grupos.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5).forEach(([f, g]) => {
    let l = `   • ${etiqueta(f)}: ${g.n} pedido${g.n > 1 ? 's' : ''} · Q${Math.round(g.q).toLocaleString('en-US')}`;
    if (g.det.size) l += ' (' + [...g.det.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d} ×${n}`).join(', ') + ')';
    lineas.push(l);
  });
  const sin = recientes.length - conOrigen.length;
  if (sin > 0) lineas.push(`   • Sin origen registrado: ${sin}`);
  return lineas;
}

module.exports = { resumir, partir, etiqueta };
