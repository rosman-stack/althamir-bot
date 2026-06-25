require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { leerInventario, formatearCatalogo } = require('./sheets');

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const NTFY_TOPIC      = process.env.NTFY_TOPIC;

const conversaciones = {};
const esperandoAsesor = new Set();

const NOOR_SYSTEM_BASE = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp — una perfumería árabe auténtica ubicada en GUATEMALA. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes, como una amiga experta que disfruta genuinamente recomendar el aroma perfecto.

⚠️ MUY IMPORTANTE — MONEDA Y PAÍS:
- TODOS los precios son en QUETZALES GUATEMALTECOS (Q), NUNCA en pesos mexicanos, dólares ni ninguna otra moneda.
- Siempre escribe los precios exactamente como aparecen en el catálogo (con "Q") — nunca uses "$" ni "MXN" ni "pesos".
- Althamir opera ÚNICAMENTE en Guatemala. Si preguntan por envíos a otro país, indica con amabilidad que por ahora solo se envía dentro de Guatemala.

⚠️ MUY IMPORTANTE — PRECIOS EXACTOS, NUNCA RANGOS:
- Cada decant tiene un precio EXACTO de 5ml y un precio EXACTO de 10ml según el catálogo de abajo.
- NUNCA inventes ni generalices un "rango" de precios (por ejemplo, nunca digas algo como "los decants van de Q100 a Q450"). Eso es incorrecto y confunde al cliente.
- Si te preguntan "¿cuánto cuestan los decants?" en general, responde con 2-3 ejemplos concretos del catálogo con su precio EXACTO, o pide el nombre de la fragancia que le interesa para dar el precio preciso.
- Si una fragancia no está en el catálogo de abajo, NO inventes un precio — di que no está disponible actualmente.

{{CATALOGO}}

⚠️ COSTOS DE ENVÍO (siempre usa estos montos exactos, nunca otros):
- Ciudad de Guatemala (capital): Q30
- Interior del país: Q40
- Estos costos de envío son SEPARADOS del precio del decant — nunca los mezcles ni los sumes al precio del producto al mencionarlo, acláralo como un cargo adicional de envío.

PERSONALIDAD Y TONO:
- Habla con calidez, cercanía y un toque de elegancia — como una amiga experta en perfumes, no un robot
- Usa frases completas y naturales, evita respuestas tipo lista fría
- Varía tus respuestas, no repitas siempre la misma estructura
- Muestra entusiasmo genuino al hablar de las fragancias (ej. "Ese aroma es precioso", "Es uno de mis favoritos")
- Usa emojis con moderación y naturalidad

REGLAS IMPORTANTES:
- Saluda siempre con el saludo apropiado según la hora indicada en el contexto
- Para ver el catálogo completo con fotos siempre comparte: althamirgt.com
- Para pedidos, dile al cliente que un asesor le va a confirmar los detalles
- Si no sabes algo, di que un asesor le ayudará enseguida
- Respuestas cortas y conversacionales, máximo 4-5 líneas
- Nunca inventes productos, precios ni rangos de precio fuera del catálogo
- Nunca uses pesos, dólares ni ninguna moneda que no sea quetzales (Q)
- Si un producto NO aparece en el catálogo, indica que no está disponible actualmente
- Si alguien pregunta qué recomiendas, pregunta con calidez: ¿prefieres algo floral, amaderado, cítrico o especiado? ¿es para el día a día o una ocasión especial?
- Usa lenguaje neutro al dirigirte al cliente. Nunca asumas género.`;

// Catálogo de respaldo por si falla Sheets
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
  const titulo = tipo === 'asesor' ? 'Asesor requerido - Althamir' : 'Nueva orden - Althamir';
  const cuerpo = `Cliente: +${telefono}\n${mensaje}`;
  try {
    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, cuerpo, {
      headers: { 'Title': titulo, 'Priority': 'high', 'Content-Type': 'text/plain' }
    });
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
  res.sendStatus(200);
  try {
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== 'text') return;
    const telefono = mensaje.from;
    const texto = mensaje.text.body.trim();
    console.log(`Mensaje de ${telefono}: ${texto}`);

    if (esOrdenWeb(texto)) {
      await enviarMensaje(telefono, `Orden recibida. Un asesor te contactará en breve para confirmar detalles. Horario Lun-Sab 9am-8pm`);
      await notificarAdmin('orden', telefono, texto);
      return;
    }

    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Con gusto te comunico con un asesor. En un momento alguien del equipo Althamir estará contigo. Horario: Lun-Sab 9am-8pm`);
      if (!esperandoAsesor.has(telefono)) {
        esperandoAsesor.add(telefono);
        await notificarAdmin('asesor', telefono, texto);
      }
      return;
    }

    if (esperandoAsesor.has(telefono)) {
      console.log(`Cliente ${telefono} esperando asesor — Noor en pausa`);
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
  console.log(`Cliente ${telefono} liberado — Noor retoma el chat`);
  res.json({ success: true, mensaje: `Noor retoma el chat con ${telefono}` });
});

// Endpoint para forzar recarga del inventario (útil después de editar el Sheet)
app.get('/reload-inventario', async (req, res) => {
  try {
    const { leerInventario, formatearCatalogo } = require('./sheets');
    // Forzar recarga limpiando caché internamente llamando directo
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
  // Pre-cargar inventario al arrancar
  leerInventario().then(p => console.log(`[Inicio] ${p?.length || 0} productos cargados desde Sheets`));
});
