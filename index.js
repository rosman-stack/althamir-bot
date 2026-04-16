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

// --- MEMORIA PARA EVITAR DUPLICADOS ---
const mensajesProcesados = new Set();

const conversaciones = {};
const esperandoAsesor = new Set();

const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp. Althamir es una empresa de perfumería árabe auténtica en Guatemala... (tu prompt completo)`;

const CATALOGO_FALLBACK = `CATÁLOGO (puede no estar actualizado)...`;

// ... (tus funciones getNoorSystem, getSaludo, esOrdenWeb, quiereAsesor se mantienen igual)

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

// ─── Webhook ────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  // 1. RESPUESTA INMEDIATA: Evita que Chatwoot piense que fallamos
  res.sendStatus(200);

  try {
    const cw = req.body;

    // ── FILTRO PARA EVITAR DOBLE RESPUESTA DESDE CHATWOOT ──
    if (cw.event === 'message_created' && cw.message_type === 'outgoing' && !cw.private) {
      
      // Verificamos si ya procesamos este ID de mensaje de Chatwoot
      const messageId = cw.id;
      if (mensajesProcesados.has(messageId)) {
        console.log(`[Chatwoot] Ignorando duplicado: ${messageId}`);
        return;
      }

      // Agregamos al Set y limpiamos en 10 segundos
      mensajesProcesados.add(messageId);
      setTimeout(() => mensajesProcesados.delete(messageId), 10000);

      const telefono = cw.conversation?.meta?.sender?.phone_number?.replace('+', '');
      const contenido = cw.content;

      if (telefono && contenido) {
        console.log(`[Chatwoot] Enviando respuesta ÚNICA a ${telefono}: ${contenido}`);
        await enviarMensaje(telefono, contenido);
      }
      return;
    }

    // ── MENSAJES ENTRANTES DE WHATSAPP ──
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== 'text') return;

    const telefono = mensaje.from;
    const texto = mensaje.text.body.trim();

    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `Orden recibida. Un asesor te contactará en breve para confirmar detalles.`);
      return;
    }

    if (esperandoAsesor.has(telefono)) {
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      return;
    }

    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Con gusto te comunico con un asesor...`);
      esperandoAsesor.add(telefono);
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      return;
    }

    // Lógica normal de Noor (IA)
    if (!conversaciones[telefono]) conversaciones[telefono] = [];
    const esPrimerMensaje = conversaciones[telefono].length === 0;
    conversaciones[telefono].push({ role: 'user', content: texto });
    
    let historial = [...conversaciones[telefono]];
    if (esPrimerMensaje) {
      historial[0] = { role: 'user', content: `(El cliente escribe a las ${getSaludo()}) ${texto}` };
    }

    const respuesta = await llamarGroq(historial);
    conversaciones[telefono].push({ role: 'assistant', content: respuesta });
    await enviarMensaje(telefono, respuesta);

  } catch (error) {
    console.error('Error procesando webhook:', error.message);
  }
});

// ... (Resto de tus rutas /liberar, /reload-inventario se mantienen igual)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Noor bot activo en puerto ${PORT}`);
});
