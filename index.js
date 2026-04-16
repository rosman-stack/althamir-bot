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

// --- FUNCIONES DE APOYO (Definidas antes del Webhook) ---

function esOrdenWeb(texto) {
  const t = texto.toUpperCase();
  return t.includes('NUEVA ORDEN ALTHAMIR') || t.includes('ALT-');
}

function quiereAsesor(texto) {
  const t = texto.toLowerCase();
  return t.includes('asesor') || t.includes('persona') || t.includes('humano') ||
         t.includes('agente') || t.includes('hablar con') || t.includes('vendedor') ||
         t.includes('pedido') || t.includes('confirmar') || t.includes('ordenar');
}

function getSaludo() {
  const hora = new Date(Date.now() - 6 * 60 * 60 * 1000).getUTCHours();
  if (hora >= 5 && hora < 12) return 'buenos días';
  if (hora >= 12 && hora < 19) return 'buenas tardes';
  return 'buenas noches';
}

async function enviarMensaje(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error enviando a WhatsApp:', err.response?.data || err.message);
  }
}

// ─── WEBHOOK (LOGICA REVISADA) ──────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Respuesta inmediata para evitar reintentos

  try {
    const cw = req.body;

    // 1. SI EL MENSAJE VIENE DE CHATWOOT (Asesor responde)
    if (cw.event === 'message_created' && cw.message_type === 'outgoing' && !cw.private) {
      const messageId = cw.id;
      if (mensajesProcesados.has(messageId)) return;

      mensajesProcesados.add(messageId);
      setTimeout(() => mensajesProcesados.delete(messageId), 10000);

      const telefono = cw.conversation?.meta?.sender?.phone_number?.replace('+', '');
      const contenido = cw.content;

      if (telefono && contenido) {
        console.log(`[Chatwoot] Respuesta única enviada a ${telefono}`);
        await enviarMensaje(telefono, contenido);
      }
      return;
    }

    // 2. SI EL MENSAJE VIENE DE WHATSAPP (Cliente escribe)
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry || entry.type !== 'text') return;

    const telefono = entry.from;
    const texto = entry.text.body.trim();
    console.log(`Mensaje de ${telefono}: ${texto}`);

    // Validar si es una orden automática del sitio web
    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `¡Gracias por tu orden en Althamir! 🏛️ Un asesor la confirmará en breve.`);
      return;
    }

    // Si el cliente ya está en el panel de Chatwoot (esperando asesor)
    if (esperandoAsesor.has(telefono)) {
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      return;
    }

    // Si el cliente pide hablar con alguien
    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Con gusto. Te comunico con un asesor de Althamir. Horario: Lun-Sab 9am-8pm.`);
      esperandoAsesor.add(telefono);
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      return;
    }

    // Lógica de Noor (IA) - Groq
    if (!conversaciones[telefono]) conversaciones[telefono] = [];f
    conversaciones[telefono].push({ role: 'user', content: texto });

    // (Aquí llamarías a tu función llamarGroq que ya tienes definida arriba)
    // ... lógica de respuesta de Noor ...

  } catch (error) {
    console.error('Error procesando webhook:', error.stack);
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Noor bot activo en puerto ${PORT}`);
  
  leerInventario()
    .then(p => {
      console.log(`[Inicio] ${p?.length || 0} productos cargados desde Sheets`);
    })
    .catch(err => {
      console.error('[Error Inicio] No se pudo cargar el inventario:', err.message);
    });

  
  // ESTA ES LA LÍNEA CLAVE:
  leerInventario()
    .then(p => console.log(`[Sheets] ${p?.length || 0} productos activos cargados correctamente`))
    .catch(err => console.error('[Error Sheets] No se pudo cargar el inventario inicial:', err.message));
});
