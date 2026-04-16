require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { leerInventario, formatearCatalogo } = require('./sheets');
const {
  transferirAChatwoot,
  cerrarConversacion,
  chatwootSesiones
} = require('./chatwoot');

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;

const mensajesProcesados = new Set();
const conversaciones = {};
const esperandoAsesor = new Set();

const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR. Althamir es una empresa de perfumería árabe auténtica en Guatemala. Tu personalidad es elegante, cálida y apasionada.
- Vendemos decants (5ml y 10ml) y perfumes sellados.
- Web: althamirgt.com
- Si el cliente quiere comprar o hablar con alguien, usa la palabra 'asesor'.
{{CATALOGO}}
Respuestas cortas (máximo 4 líneas).`;

// --- FUNCIONES DE APOYO ---

async function getNoorSystem() {
  try {
    const productos = await leerInventario();
    const catalogo = formatearCatalogo(productos);
    return NOOR_SYSTEM_BASE.replace('{{CATALOGO}}', catalogo);
  } catch (err) {
    return NOOR_SYSTEM_BASE.replace('{{CATALOGO}}', 'Catálogo disponible en althamirgt.com');
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

function esOrdenWeb(texto) {
  return texto.toUpperCase().includes('ALT-');
}

function quiereAsesor(texto) {
  const t = texto.toLowerCase();
  return t.includes('asesor') || t.includes('humano') || t.includes('pedido') || t.includes('comprar');
}

async function enviarMensaje(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) { console.error('Error WhatsApp:', err.message); }
}

// ─── WEBHOOK ────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const cw = req.body;

    // RESPUESTA DEL ASESOR (CHATWOOT)
    if (cw.event === 'message_created' && cw.message_type === 'outgoing' && !cw.private) {
      if (mensajesProcesados.has(cw.id)) return;
      mensajesProcesados.add(cw.id);
      setTimeout(() => mensajesProcesados.delete(cw.id), 10000);

      const telefono = cw.conversation?.meta?.sender?.phone_number?.replace('+', '');
      if (telefono && cw.content) await enviarMensaje(telefono, cw.content);
      return;
    }

    // MENSAJE DEL CLIENTE (WHATSAPP)
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry || entry.type !== 'text') return;

    const telefono = entry.from;
    const texto = entry.text.body.trim();

    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `¡Orden recibida! 🏛️ Un asesor la confirmará pronto.`);
      return;
    }

    if (esperandoAsesor.has(telefono)) {
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      return;
    }

    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Te comunico con un asesor de Althamir. Un momento...`);
      esperandoAsesor.add(telefono);
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      return;
    }

    // IA NOOR
    if (!conversaciones[telefono]) conversaciones[telefono] = [];
    conversaciones[telefono].push({ role: 'user', content: texto });
    if (conversaciones[telefono].length > 10) conversaciones[telefono].shift();

    const respuesta = await llamarGroq(conversaciones[telefono]);
    conversaciones[telefono].push({ role: 'assistant', content: respuesta });
    await enviarMensaje(telefono, respuesta);

  } catch (error) { console.error('Error Webhook:', error.message); }
});

// ─── INICIO ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Noor bot activo en puerto ${PORT}`);
  leerInventario().then(p => console.log(`[Sheets] ${p?.length || 0} productos listos.`));
});
