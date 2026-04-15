const axios = require('axios');

const CHATWOOT_URL = 'https://app.chatwoot.com';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

// Mapa para guardar contact_id y conversation_id por teléfono
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

async function obtenerOCrearContacto(telefono, nombre = null) {
  // Buscar si ya existe
  try {
    const busqueda = await api('get', `/contacts/search?q=${telefono}`);
    if (busqueda.payload?.length > 0) {
      return busqueda.payload[0].id;
    }
  } catch (e) {}

  // Crear contacto nuevo
  const contacto = await api('post', '/contacts', {
    phone_number: `+${telefono}`,
    name: nombre || `+${telefono}`,
    inbox_id: parseInt(CHATWOOT_INBOX_ID)
  });
  return contacto.id;
}

async function crearConversacion(contactId, telefono) {
  const conv = await api('post', '/conversations', {
    contact_id: contactId,
    inbox_id: parseInt(CHATWOOT_INBOX_ID),
    additional_attributes: { phone: telefono }
  });
  return conv.id;
}

async function enviarMensajeChatwoot(conversationId, mensaje, tipo = 'incoming') {
  await api('post', `/conversations/${conversationId}/messages`, {
    content: mensaje,
    message_type: tipo,  // 'incoming' = del cliente, 'outgoing' = del asesor
    private: false
  });
}

async function transferirAChatwoot(telefono, mensajeCliente, historialPrevio = []) {
  try {
    // Obtener o crear contacto
    let contactId = chatwootSesiones[telefono]?.contactId;
    if (!contactId) {
      contactId = await obtenerOCrearContacto(telefono);
    }

    // Obtener o crear conversación
    let conversationId = chatwootSesiones[telefono]?.conversationId;
    if (!conversationId) {
      conversationId = await crearConversacion(contactId, telefono);
      chatwootSesiones[telefono] = { contactId, conversationId };
    }

    // Enviar historial previo resumido si es nueva conversación
    if (historialPrevio.length > 0 && !chatwootSesiones[telefono]?.historialEnviado) {
      const resumen = historialPrevio
        .slice(-6) // últimos 6 mensajes
        .map(m => `${m.role === 'user' ? '👤 Cliente' : '🤖 Noor'}: ${m.content}`)
        .join('\n');
      await enviarMensajeChatwoot(conversationId, `📋 *Contexto de la conversación:*\n${resumen}`, 'activity');
      chatwootSesiones[telefono].historialEnviado = true;
    }

    // Enviar el mensaje actual del cliente
    await enviarMensajeChatwoot(conversationId, mensajeCliente, 'incoming');

    console.log(`[Chatwoot] Conversación ${conversationId} activa para ${telefono}`);
    return conversationId;

  } catch (err) {
    console.error('[Chatwoot] Error transfiriendo:', err.response?.data || err.message);
    return null;
  }
}

async function enviarMensajeDeAsesor(telefono, mensaje) {
  const conversationId = chatwootSesiones[telefono]?.conversationId;
  if (!conversationId) return;
  await enviarMensajeChatwoot(conversationId, mensaje, 'outgoing');
}

async function cerrarConversacion(telefono) {
  const conversationId = chatwootSesiones[telefono]?.conversationId;
  if (!conversationId) return;
  try {
    await api('patch', `/conversations/${conversationId}`, { status: 'resolved' });
    delete chatwootSesiones[telefono];
    console.log(`[Chatwoot] Conversación ${conversationId} cerrada`);
  } catch (e) {
    console.error('[Chatwoot] Error cerrando conversación:', e.message);
  }
}

function getConversationId(telefono) {
  return chatwootSesiones[telefono]?.conversationId || null;
}

module.exports = {
  transferirAChatwoot,
  enviarMensajeDeAsesor,
  cerrarConversacion,
  getConversationId,
  chatwootSesiones
};
