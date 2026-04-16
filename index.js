require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { leerInventario, formatearCatalogo } = require('./sheets');
const { transferirAChatwoot, cerrarConversacion } = require('./chatwoot');

const app = express();
app.use(express.json());

// ═══════════════════════════════════════
//  NOOR — BOT DE WHATSAPP ALTHAMIR
// ═══════════════════════════════════════

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const NTFY_TOPIC      = process.env.NTFY_TOPIC;

const conversaciones = {};
const esperandoAsesor = new Set();

const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp. Althamir es una empresa de perfumería árabe auténtica en Guatemala. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes.

SOBRE ALTHAMIR:
- Vendemos decants y perfumes completos sellados de perfumería árabe auténtica
- Guatemala, envíos a todo el país
- Catálogo completo con fotos: althamirgt.com
- Pedidos y consultas: este mismo WhatsApp

¿QUÉ ES UN DECANT?
Un decant es una muestra de perfume original transferida directamente de la botella sellada a un frasco pequeño (5ml o 10ml). Es 100% auténtico, ideal para probar una fragancia antes de comprar la botella completa o para llevar de viaje.

{{CATALOGO}}

ENVÍOS: Ciudad de Guatemala entrega rápida. Interior del país coordinamos con transportistas.

REGLAS IMPORTANTES:
- Saluda siempre con el saludo apropiado según la hora indicada en el contexto
- Para ver el catálogo completo con fotos siempre comparte: althamirgt.com
- Para pedidos, dile al cliente que un asesor le va a confirmar los detalles
- Si no sabes algo, di que un asesor le ayudará enseguida
- Respuestas cortas y directas, máximo 4 líneas
- Usa emojis con moderación: 🖤 ✨ 🌙 🕌
- Nunca inventes productos ni precios fuera del catálogo
- Si un producto NO aparece en el catálogo actualmente, indícalo con amabilidad
- Siempre ofrece recomendar una fragancia si el cliente no sabe qué elegir
- Si alguien pregunta qué recomiendas, pregunta: ¿prefieres floral, amaderado, cítrico o especiado? ¿uso diario u ocasión especial?
- Usa lenguaje neutro al dirigirte al cliente. Nunca asumas género.`;

const CATALOGO_FALLBACK = `CATÁLOGO (puede no estar actualizado, visita althamirgt.com para el catálogo completo):
LATTAFA: Yara Moi (5ml Q40 · 10ml Q65) · Yara Rosa (5ml Q40 · 10ml Q65) · Yara Tous (5ml Q40 · 10ml Q65) · Asad (5ml Q45 · 10ml Q75) · Ra'ed Luxe (5ml Q35 · 10ml Q60) · Emeer (5ml Q50 · 10ml Q80) · Ramz Lattafa (5ml Q40 · 10ml Q60) · Bade'e Al Oud Amethyst (5ml Q40 · 10ml Q70) · Nebras (5ml Q45 · 10ml Q75) · Fakhar Black/Gold/Rose (5ml Q40 · 10ml Q70) · Najdia Intense (5ml Q40 · 10ml Q70) · Ejaazi (5ml Q40 · 10ml Q70) · Ajwad (5ml Q40 · 10ml Q70)
ARMAF ODYSSEY: Mandarin Sky (5ml Q40 · 10ml Q70) · Odyssey Limoni (5ml Q40 · 10ml Q70)
AL HARAMAIN: Amber Oud Gold Edition (5ml Q50 · 10ml Q90)
EMPER: Phantom My Hero (5ml Q50 · 10ml Q80)
RAYHAAN: Rayhaan Elixir (5ml Q50 · 10ml Q80)
Otras marcas: Maison Alhambra, Afnan, Bharara, French Avenue`;

async function getNoorSystem() {
  try {
    const productos = await leerInventario();
    const catalogo = formatearCatalogo(productos);
    return NOOR_SYSTEM_BASE.replace('{{CATALOGO}}', catalogo || CATALOGO_FALLBACK);
  } catch (err) {
    console.error('[Noor] Usando catálogo de respaldo:', err.message);
    return NOOR_SYSTEM_BASE.replace('{{CATALOGO}}', CATALOGO_FALLBACK);
  }
}

function getSaludo() {
  const hora = new Date(Date.now() - 6 * 60 * 60 * 1000).getUTCHours();
  if (hora >= 5 && hora < 12) return 'buenos días';
  if (hora >= 12 && hora < 19) return 'buenas tardes';
  return 'buenas noches';
}

function esOrdenWeb(texto) {
  return texto.includes('NUEVA ORDEN ALTHAMIR') || texto.includes('ALT-');
}

function quiereAsesor(texto) {
  const t = texto.toLowerCase();
  return t.includes('asesor') || t.includes('persona') || t.includes('humano') ||
         t.includes('agente') || t.includes('hablar con') || t.includes('vendedor') ||
         t.includes('pedido') || t.includes('confirmar') || t.includes('ordenar');
}

async function enviarMensaje(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error enviando mensaje:', err.response?.data || err.message);
  }
}

async function notificarAdmin(tipo, telefono, mensaje) {
  if (!NTFY_TOPIC) return;
  const titulo = tipo === 'asesor' ? '🔔 Asesor requerido - Althamir' : '📦 Nueva orden - Althamir';
  const cuerpo = `Cliente: +${telefono}\n${mensaje}`;
  try {
    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, cuerpo, {
      headers: { 'Title': titulo, 'Priority': 'high', 'Content-Type': 'text/plain' }
    });
    console.log(`Notificado via ntfy — tipo: ${tipo}, cliente: ${telefono}`);
  } catch(e) {
    console.error('Error notificando admin:', e.message);
  }
}

async function llamarGroq(historial) {
  const systemPrompt = await getNoorSystem();
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: systemPrompt }, ...historial],
      max_tokens: 350,
      temperature: 0.7
    },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

// ═══ WEBHOOK VERIFICACIÓN ═══
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado ✅');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ═══ WEBHOOK MENSAJES ENTRANTES ═══
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    // ── Asesor responde desde Chatwoot → reenviar al cliente por WhatsApp ──
    const cw = req.body;
    if (cw.event === 'message_created' && cw.message_type === 'outgoing' && !cw.private) {
      const telefono = cw.conversation?.meta?.sender?.phone_number?.replace('+', '');
      const contenido = cw.content;
      if (telefono && contenido) {
        console.log(`[Chatwoot] Asesor → ${telefono}: ${contenido}`);
        await enviarMensaje(telefono, contenido);
      }
      return;
    }

    // ── Mensajes entrantes de WhatsApp ──
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== 'text') return;

    const telefono = mensaje.from;
    const texto    = mensaje.text.body.trim();
    console.log(`📩 Mensaje de ${telefono}: ${texto}`);

    // Orden desde la web
    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `✅ *¡Orden recibida!*\n\nGracias por tu pedido 🖤 Un asesor de Althamir te contactará en breve para confirmar los detalles y coordinar la entrega.\n\n_Horario de atención: Lun-Sáb 9am-8pm_`);
      await notificarAdmin('orden', telefono, texto);
      return;
    }

    // Cliente ya esperando asesor → reenviar mensajes a Chatwoot
    if (esperandoAsesor.has(telefono)) {
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      console.log(`[Chatwoot] Mensaje de ${telefono} reenviado al panel`);
      return;
    }

    // Cliente pide asesor
    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Claro, con gusto te comunico con un asesor 🖤\n\nEn un momento alguien del equipo Althamir estará contigo. Horario: Lun-Sáb 9am-8pm 🌙`);
      esperandoAsesor.add(telefono);
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      await notificarAdmin('asesor', telefono, texto);
      return;
    }

    // Conversación normal con Noor
    if (!conversaciones[telefono]) conversaciones[telefono] = [];
    const esPrimerMensaje = conversaciones[telefono].length === 0;
    conversaciones[telefono].push({ role: 'user', content: texto });
    if (conversaciones[telefono].length > 20) conversaciones[telefono] = conversaciones[telefono].slice(-20);

    let historial = [...conversaciones[telefono]];
    if (esPrimerMensaje) {
      historial[0] = { role: 'user', content: `(El cliente escribe a las ${getSaludo()}, salúdale apropiadamente.) ${texto}` };
    }

    const respuesta = await llamarGroq(historial);
    conversaciones[telefono].push({ role: 'assistant', content: respuesta });
    await enviarMensaje(telefono, respuesta);
    console.log(`✅ Respuesta enviada a ${telefono}`);

  } catch (error) {
    console.error('Error procesando mensaje:', error.message);
  }
});

// ═══ LIBERAR CLIENTE ═══
app.get('/liberar', (req, res) => {
  const telefono = req.query.telefono;
  if (!telefono) return res.status(400).json({ error: 'Falta el parámetro telefono' });
  esperandoAsesor.delete(telefono);
  conversaciones[telefono] = [];
  cerrarConversacion(telefono);
  console.log(`✅ Cliente ${telefono} liberado — Noor retoma el chat`);
  res.json({ success: true, mensaje: `Noor retoma el chat con ${telefono}` });
});

// ═══ RECARGAR INVENTARIO ═══
app.get('/reload-inventario', async (req, res) => {
  try {
    const productos = await leerInventario();
    res.json({ success: true, productos_activos: productos?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ RUTA DE SALUD ═══
app.get('/', (req, res) => res.send('🖤 Noor - Bot de WhatsApp Althamir funcionando'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Noor bot activo en puerto ${PORT}`);
  leerInventario().then(p => console.log(`[Inicio] ${p?.length || 0} productos cargados desde Sheets`));
});
