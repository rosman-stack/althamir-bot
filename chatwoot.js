const axios = require('axios');

const CHATWOOT_URL = 'https://app.chatwoot.com';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

const chatwootSesiones = {};

async function api(method, path, data = null) {
  const res = await axios({
    method,
    url: `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${path}`,
    headers: {
      'api_access_token': CHATWOOT_TOKEN,
      'Content-Type': 'application/json'
    },
    data
  });
  return res.data;
}

async function obtenerOCrearContacto(telefono) {
  try {
    const busqueda = await api('get', `/contacts/search?q=${telefono}`);
    if (busqueda.payload?.length > 0) return busqueda.payload[0].id;
  } catch (e) {}

  const contacto = await api('post', '/contacts', {
    phone_number: `+${telefono}`,
    name: `+${telefono}`,
    inbox_id: parseInt(CHATWOOT_INBOX_ID)
  });
  return contacto.id;
}

async function crearConversacion(contactId) {
  const conv = await api('post', '/conversations', {
    contact_id: contactId,
    inbox_id: parseInt(CHATWOOT_INBOX_ID)
  });
  return conv.id;
}

async function enviarMensajeChatwoot(conversationId, mensaje, tipo = 'incoming') {
  await api('post', `/conversations/${conversationId}/messages`, {
    content: mensaje,
    message_type: tipo,
    private: false
  });
}

async function transferirAChatwoot(telefono, mensajeCliente, historialPrevio = []) {
  try {
    let contactId = chatwootSesiones[telefono]?.contactId;
    if (!contactId) {
      contactId = await obtenerOCrearContacto(telefono);
    }

    let conversationId = chatwootSesiones[telefono]?.conversationId;
    if (!conversationId) {
      conversationId = await crearConversacion(contactId);
      chatwootSesiones[telefono] = { contactId, conversationId };

      // Enviar historial previo como contexto (últimos 6 mensajes)
      if (historialPrevio.length > 0) {
        const resumen = historialPrevio
          .slice(-6)
          .map(m => `${m.role === 'user' ? '👤 Cliente' : '🤖 Noor'}: ${m.content}`)
          .join('\n');
        await enviarMensajeChatwoot(conversationId, `📋 *Contexto previo:*\n${resumen}`, 'incoming');
      }
    }

    await enviarMensajeChatwoot(conversationId, mensajeCliente, 'incoming');
    console.log(`[Chatwoot] Conversación ${conversationId} activa para ${telefono}`);
    return conversationId;

  } catch (err) {
    console.error('[Chatwoot] Error transfiriendo:', err.response?.data || err.message);
    return null;
  }
}

async function cerrarConversacion(telefono) {
  const conversationId = chatwootSesiones[telefono]?.conversationId;
  if (!conversationId) return;
  try {
    await api('patch', `/conversations/${conversationId}`, { status: 'resolved' });
    delete chatwootSesiones[telefono];
    console.log(`[Chatwoot] Conversación ${conversationId} cerrada`);
  } catch (e) {
    console.error('[Chatwoot] Error cerrando:', e.message);
  }
}

module.exports = { transferirAChatwoot, cerrarConversacion, chatwootSesiones };
