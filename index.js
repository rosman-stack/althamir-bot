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


const conversaciones = {};
const esperandoAsesor = new Set();

const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp. Althamir es una empresa de perfumería árabe auténtica en Guatemala. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes.

SOBRE ALTHAMIR:
- Vendemos decants y perfumes completos sellados de perfumería árabe auténtica
- Guatemala, envíos a todo el país
- Catálogo completo con fotos: althamirgt.com
- Pedidos y consultas: este mismo WhatsApp

QUÉ ES UN DECANT:
Un decant es una muestra de perfume original transferida directamente de la botella sellada a un frasco pequeño (5ml o 10ml). Es 100% auténtico, ideal para probar una fragancia antes de comprar la botella completa o para llevar de viaje.

{{CATALOGO}}

ENVÍOS: Ciudad de Guatemala entrega rápida. Interior del país coordinamos con transportistas.

REGLAS IMPORTANTES:
- Saluda siempre con el saludo apropiado según la hora indicada en el contexto
- Para ver el catálogo completo con fotos siempre comparte: althamirgt.com
- Para pedidos, dile al cliente que un asesor le va a confirmar los detalles
- Si no sabes algo, di que un asesor le ayudará enseguida
- Respuestas cortas y directas, máximo 4 líneas
- Usa emojis con moderación
- Nunca inventes productos ni precios fuera del catálogo
- Si un producto NO aparece en el catálogo, indica que no está disponible actualmente
- Siempre ofrece recomendar una fragancia si el cliente no sabe qué elegir
- Si alguien pregunta qué recomiendas, pregunta: prefiere floral, amaderado, cítrico o especiado, uso diario u ocasión especial
- Usa lenguaje neutro al dirigirte al cliente. Nunca asumas género.`;

const CATALOGO_FALLBACK = `CATÁLOGO (puede no estar actualizado):
LATTAFA: Yara Moi (5ml Q40 · 10ml Q65) · Yara Rosa (5ml Q40 · 10ml Q65) · Asad (5ml Q45 · 10ml Q75) · Ra'ed Luxe (5ml Q35 · 10ml Q60)
AL HARAMAIN: Amber Oud Gold Edition (5ml Q50 · 10ml Q90)
Para catálogo completo y actualizado visita althamirgt.com`;

async function getNoorSystem() {
  try {
    const productos = await leerInventario();
    const catalogo = formatearCatalogo(productos);
    return NOOR_SYSTEM_BASE.replace('{{CATALOGO}}', catalogo || CATALOGO_FALLBACK);
  } catch (err) {
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
  res.sendStatus(200); // Responder rápido a Chatwoot para evitar reintentos

  try {
    const cw = req.body;

    // ── FILTRO PARA EVITAR DOBLE RESPUESTA ──
    if (cw.event === 'message_created' && cw.message_type === 'outgoing' && !cw.private) {
      
      // 1. Verificamos que el mensaje no venga de un sistema automático (opcional)
      if (cw.sender?.type === 'bot') return;

      const telefono = cw.conversation?.meta?.sender?.phone_number?.replace('+', '');
      const contenido = cw.content;

      // 2. IMPORTANTE: Chatwoot a veces envía el evento dos veces si no recibe el 200 OK rápido.
      // Aquí podrías guardar el cw.id en una lista temporal (cache) para ignorarlo si se repite.
      
      if (telefono && contenido) {
        console.log(`[Chatwoot] Enviando respuesta única a ${telefono}`);
        await enviarMensaje(telefono, contenido);
      }
      return;
    }
    
    // ... resto de tu lógica para mensajes entrantes de WhatsApp

    // ── Mensajes entrantes de WhatsApp ──
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== 'text') return;

    const telefono = mensaje.from;
    const texto = mensaje.text.body.trim();
    console.log(`Mensaje de ${telefono}: ${texto}`);

    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `Orden recibida. Un asesor te contactará en breve para confirmar detalles. Horario Lun-Sab 9am-8pm`);
      return;
    }

    // Si ya está esperando asesor, reenviar mensaje a Chatwoot
    if (esperandoAsesor.has(telefono)) {
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      console.log(`[Chatwoot] Mensaje de ${telefono} reenviado al panel`);
      return;
    }

    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Con gusto te comunico con un asesor. En un momento alguien del equipo Althamir estará contigo. Horario: Lun-Sab 9am-8pm`);
      esperandoAsesor.add(telefono);
      await transferirAChatwoot(telefono, texto, conversaciones[telefono] || []);
      return;
    }

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
    console.log(`Respuesta enviada a ${telefono}`);

  } catch (error) {
    console.error('Error procesando mensaje:', error.message);
  }
});

// ─── Rutas de administración ─────────────────────────────────────────────────

app.get('/liberar', (req, res) => {
  const telefono = req.query.telefono;
  if (!telefono) return res.status(400).json({ error: 'Falta el parámetro telefono' });
  esperandoAsesor.delete(telefono);
  conversaciones[telefono] = [];
  cerrarConversacion(telefono);
  console.log(`Cliente ${telefono} liberado — Noor retoma el chat`);
  res.json({ success: true, mensaje: `Noor retoma el chat con ${telefono}` });
});

app.get('/reload-inventario', async (req, res) => {
  try {
    const productos = await leerInventario();
    res.json({ success: true, productos_activos: productos?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Noor - Bot de WhatsApp Althamir funcionando'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Noor bot activo en puerto ${PORT}`);
  leerInventario().then(p => console.log(`[Inicio] ${p?.length || 0} productos cargados desde Sheets`));
});
