require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ═══════════════════════════════════════
//  NOOR — BOT DE WHATSAPP ALTHAMIR
// ═══════════════════════════════════════

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Historial de conversaciones por usuario
const conversaciones = {};

// Sistema de Noor con conocimiento completo de Althamir
const NOOR_SYSTEM = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp. Althamir es una empresa de perfumería árabe auténtica en Guatemala. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes.

SOBRE ALTHAMIR:
- Vendemos decants y perfumes completos sellados de perfumería árabe auténtica
- Guatemala, envíos a todo el país
- Catálogo completo: althamir.gt
- Pedidos y consultas: este mismo WhatsApp

¿QUÉ ES UN DECANT?
Un decant es una muestra de perfume original transferida directamente de la botella sellada a un frasco pequeño (5ml o 10ml). Es 100% auténtico, ideal para probar una fragancia antes de comprar la botella completa o para llevar de viaje.

CATÁLOGO CON PRECIOS:
LATTAFA: Yara Moi (5ml Q40 · 10ml Q65) · Yara Rosa (5ml Q40 · 10ml Q65) · Yara Tous (5ml Q40 · 10ml Q65) · Asad (5ml Q45 · 10ml Q75) · Ra'ed Luxe (5ml Q35 · 10ml Q60) · Emeer (5ml Q50 · 10ml Q80) · Ramz Lattafa (5ml Q40 · 10ml Q60) · Bade'e Al Oud Amethyst (5ml Q40 · 10ml Q70) · Nebras (5ml Q45 · 10ml Q75) · Fakhar Black/Gold/Rose (5ml Q40 · 10ml Q70) · Najdia Intense (5ml Q40 · 10ml Q70) · Ejaazi (5ml Q40 · 10ml Q70) · Ajwad (5ml Q40 · 10ml Q70)
ARMAF ODYSSEY: Mandarin Sky (5ml Q40 · 10ml Q70) · Odyssey Limoni (5ml Q40 · 10ml Q70)
AL HARAMAIN: Amber Oud Gold Edition (5ml Q50 · 10ml Q90)
EMPER: Phantom My Hero (5ml Q50 · 10ml Q80)
RAYHAAN: Rayhaan Elixir (5ml Q50 · 10ml Q80)
Otras marcas: Maison Alhambra, Afnan, Bharara, French Avenue

ENVÍOS: Ciudad de Guatemala entrega rápida. Interior del país coordinamos con transportistas.

REGLAS IMPORTANTES:
- Saluda siempre con el saludo apropiado según la hora (buenos días/tardes/noches)
- Para ver el catálogo completo con fotos siempre comparte: althamir.gt
- Para pedidos, dile al cliente que un asesor le va a confirmar los detalles
- Si no sabes algo, di que un asesor le ayudará enseguida
- Respuestas cortas y directas, máximo 4 líneas
- Usa emojis con moderación: 🖤 ✨ 🌙 🕌
- Nunca inventes productos ni precios fuera del catálogo
- Siempre ofrece recomendar una fragancia si el cliente no sabe qué elegir
- Si alguien pregunta qué recomiendas, pregunta: ¿prefieres floral, amaderado, cítrico o especiado? ¿uso diario u ocasión especial?`;

// Obtener saludo según hora Guatemala (UTC-6)
function getSaludo() {
  const hora = new Date(Date.now() - 6 * 60 * 60 * 1000).getUTCHours();
  if (hora >= 5 && hora < 12) return 'Buenos días';
  if (hora >= 12 && hora < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

// Detectar si es una orden desde la web
function esOrdenWeb(texto) {
  return texto.includes('NUEVA ORDEN ALTHAMIR') || texto.includes('ALT-');
}

// Detectar si el cliente quiere hablar con asesor
function quiereAsesor(texto) {
  const t = texto.toLowerCase();
  return t.includes('asesor') || t.includes('persona') || t.includes('humano') ||
         t.includes('agente') || t.includes('hablar con') || t.includes('vendedor');
}

// Enviar mensaje de WhatsApp
async function enviarMensaje(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'text',
        text: { body: mensaje }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('Error enviando mensaje:', err.response?.data || err.message);
  }
}

// Llamar a Groq
async function llamarGroq(historial) {
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: NOOR_SYSTEM },
        ...historial
      ],
      max_tokens: 350,
      temperature: 0.7
    },
    {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.choices[0].message.content;
}

// ═══ WEBHOOK VERIFICACIÓN ═══
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
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
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const mensaje = value?.messages?.[0];

    if (!mensaje || mensaje.type !== 'text') return;

    const telefono = mensaje.from;
    const texto = mensaje.text.body.trim();

    console.log(`📩 Mensaje de ${telefono}: ${texto}`);

    // Si es una orden de la web
    if (esOrdenWeb(texto)) {
      const respuesta = `✅ *¡Orden recibida!*\n\nGracias por tu pedido 🖤 Un asesor de Althamir te contactará en breve para confirmar los detalles y coordinar la entrega.\n\n_Tiempo de respuesta: menos de 1 hora en horario de atención (Lun-Sáb 9am-8pm)_`;
      await enviarMensaje(telefono, respuesta);
      return;
    }

    // Si quiere hablar con asesor humano
    if (quiereAsesor(texto)) {
      const respuesta = `Claro, con gusto te comunico con un asesor 🖤\n\nEn un momento alguien del equipo Althamir estará contigo. Horario de atención: Lun-Sáb 9am-8pm 🌙`;
      await enviarMensaje(telefono, respuesta);
      return;
    }

    // Inicializar historial si es nuevo usuario
    if (!conversaciones[telefono]) {
      conversaciones[telefono] = [];
    }

    // Si es el primer mensaje, agregar saludo al contexto
    const esPrimerMensaje = conversaciones[telefono].length === 0;

    // Agregar mensaje del usuario al historial
    conversaciones[telefono].push({ role: 'user', content: texto });

    // Limitar historial a últimas 10 interacciones
    if (conversaciones[telefono].length > 20) {
      conversaciones[telefono] = conversaciones[telefono].slice(-20);
    }

    // Si es primer mensaje, agregar contexto de saludo
    let historialConContexto = [...conversaciones[telefono]];
    if (esPrimerMensaje) {
      historialConContexto[0] = {
        role: 'user',
        content: `[${getSaludo()}] ${texto}`
      };
    }

    // Obtener respuesta de Groq
    const respuesta = await llamarGroq(historialConContexto);

    // Guardar respuesta en historial
    conversaciones[telefono].push({ role: 'assistant', content: respuesta });

    // Enviar respuesta
    await enviarMensaje(telefono, respuesta);
    console.log(`✅ Respuesta enviada a ${telefono}`);

  } catch (error) {
    console.error('Error procesando mensaje:', error.message);
  }
});

// Ruta de salud
app.get('/', (req, res) => {
  res.send('🖤 Noor - Bot de WhatsApp Althamir funcionando');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Noor bot activo en puerto ${PORT}`);
  
  // Registrar número en WhatsApp Cloud API con certificado
  try {
    const reg = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/register`,
      {
        messaging_product: 'whatsapp',
        pin: '000000',
        cert: 'CmUKIQihvPmavPHFAhIGZW50OndhIghBbHRoYW1pclDLgfHOBhpAJ3GJ9LDF8mGarlhhYzCnMoc9CkPisq/UXE/HydI3PGDCaqe4fvyNWvHe8Uo4RuQ9wOaSfk/pf+Cwl4UUgXfiBxIubVdRz87OqefwWrW3mK5oK5Be4+NextjWxz1PTq08CTCZL9bR5QeHJe++jPRYZA=='
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Número registrado:', JSON.stringify(reg.data));
  } catch(e) {
    console.log('ℹ️ Registro:', e.response?.data?.error?.message || e.message);
  }
