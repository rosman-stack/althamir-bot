require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const NTFY_TOPIC      = process.env.NTFY_TOPIC;

const conversaciones = {};
const esperandoAsesor = new Set();

const NOOR_SYSTEM = `Eres Noor, la asistente virtual de ALTHAMIR por WhatsApp. Althamir es una empresa de perfumería árabe auténtica en Guatemala. Tu personalidad es elegante, cálida y apasionada por las fragancias árabes.

SOBRE ALTHAMIR:
- Vendemos decants y perfumes completos sellados de perfumería árabe auténtica
- Guatemala, envíos a todo el país
- Catálogo completo: althamir.gt
- Pedidos y consultas: este mismo WhatsApp

QUÉ ES UN DECANT:
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
- Saluda siempre con el saludo apropiado según la hora indicada en el contexto
- Para ver el catálogo completo con fotos siempre comparte: althamir.gt
- Para pedidos, dile al cliente que un asesor le va a confirmar los detalles
- Si no sabes algo, di que un asesor le ayudará enseguida
- Respuestas cortas y directas, máximo 4 líneas
- Usa emojis con moderación
- Nunca inventes productos ni precios fuera del catálogo
- Siempre ofrece recomendar una fragancia si el cliente no sabe qué elegir
- Si alguien pregunta qué recomiendas, pregunta: prefiere floral, amaderado, cítrico o especiado, uso diario u ocasión especial
- Usa lenguaje neutro al dirigirte al cliente. Nunca asumas género.`;

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
  const titulo = tipo === 'asesor' ? 'Asesor requerido — Althamir' : 'Nueva orden — Althamir';
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
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: NOOR_SYSTEM }, ...historial], max_tokens: 350, temperature: 0.7 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

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
      await enviarMensaje(telefono, `Orden recibida. Un asesor te contactara en breve para confirmar detalles. Horario Lun-Sab 9am-8pm`);
      await notificarAdmin('orden', telefono, texto);
      return;
    }

    if (quiereAsesor(texto)) {
      await enviarMensaje(telefono, `Con gusto te comunico con un asesor. En un momento alguien del equipo Althamir estara contigo. Horario: Lun-Sab 9am-8pm`);
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

app.get('/liberar', (req, res) => {
  const telefono = req.query.telefono;
  if (!telefono) return res.status(400).json({ error: 'Falta el parametro telefono' });
  esperandoAsesor.delete(telefono);
  conversaciones[telefono] = [];
  console.log(`Cliente ${telefono} liberado — Noor retoma el chat`);
  res.json({ success: true, mensaje: `Noor retoma el chat con ${telefono}` });
});

app.get('/', (req, res) => res.send('Noor - Bot de WhatsApp Althamir funcionando'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Noor bot activo en puerto ${PORT}`));
