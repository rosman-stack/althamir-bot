// Botellas completas por WhatsApp: si el cliente pregunta por la botella de un perfume que tiene
// precio en la columna "Botella" del Sheet, Noor responde con ese precio. Cualquier otro caso
// (perfume sin precio, sin stock, no identificado, o más de 3) se deriva a un asesor, como siempre.
// El mayoreo NUNCA pasa por aquí: siempre va con asesor (ver tipoCotizacion en index.js).

function sinAcentos(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function normalizar(t) { return sinAcentos(t).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// Perfumes del catálogo (activos y sin stock) que el mensaje menciona por nombre.
function perfumesMencionados(texto, productos) {
  const t = ' ' + normalizar(texto) + ' ';
  const candidatos = [];
  for (const p of (productos || [])) candidatos.push({ p, activo: true, n: normalizar(p.nombre) });
  for (const p of ((productos && productos.bajoPedido) || [])) candidatos.push({ p, activo: false, n: normalizar(p.nombre) });
  const hallados = candidatos.filter(c => c.n.length >= 3 && t.includes(' ' + c.n + ' '));
  // "Yara Moi" también contiene "Yara": si coinciden ambos, nos quedamos con el más específico
  return hallados.filter(a => !hallados.some(b => b !== a && b.n.length > a.n.length && (' ' + b.n + ' ').includes(' ' + a.n + ' ')));
}

// Devuelve la lista de productos a cotizar, o null si debe atenderlo un asesor.
function resolverBotella(texto, productos) {
  const m = perfumesMencionados(texto, productos);
  if (!m.length || m.length > 3) return null;
  if (m.some(x => !x.activo || !x.p.botella)) return null;
  return m.map(x => x.p);
}

function mensajeBotella(lista) {
  const lineas = lista.map(p => `• *${p.nombre}* — botella completa${p.tamBotella ? ' de ' + p.tamBotella : ''}: ${p.botella}`);
  return `${lineas.join('\n')}\n\nSi la quieres, escribe *asesor* y te confirma disponibilidad y entrega 🙌`;
}

module.exports = { perfumesMencionados, resolverBotella, mensajeBotella };
