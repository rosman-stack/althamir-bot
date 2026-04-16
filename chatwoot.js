const axios = require('axios');

const CHATWOOT_URL = 'https://app.chatwoot.com';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

const ACCOUNT_ID_CLEAN = CHATWOOT_ACCOUNT_ID ? CHATWOOT_ACCOUNT_ID.toString().replace(/\/$/, '').split('/').pop() : '';

const chatwootSesiones = {};

async function api(method, path, data = null) {
  try {
    const res = await axios({
      method,
      url: `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID_CLEAN}${path}`,
      headers: {
        'api_access_token': CHATWOOT_TOKEN,
        'Content-Type': 'application/json'
      },
      data
    });
    return res.data;
  } catch (err) {
    console.error(`[Chatwoot API Error] ${method} ${path}:`, err.response?.data || err.message);
    throw err;
  }
}

async function obtenerOCrearContacto(telefono) {
  try {
    const busqueda = await api('get', `/contacts/search?q=${telefono}`);
    if (busqueda.payload && busqueda.payload.length > 0) {
      return busqueda.payload[0].id;
    }
  } catch (e) {
    console.log(`[Chatwoot] Contacto ${telefono} no encontrado, creando...`);
  }

  const contacto = await api('post', '/contacts', {
    phone_number: `+${telefono}`,
    name: `Cliente (+${telefono})`,
    inbox_id: parseInt(CHATWOOT_INBOX_ID)
  });
  // Ajuste de acceso al ID según la respuesta de la API de Chatwoot
  return contacto.payload ? contacto.payload.contact.id : contacto.id;
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

      if (historialPrevio.length > 0) {
        const resumen = historialPrevio
          .slice(-8)
          .map(m => `${m.role === 'user' ? '👤 Cliente' : '✨ Noor'}: ${m.content}`)
          .join('\n');
        
        await enviarMensajeChatwoot(
          conversationId, 
          `🏛️ *ALTHAMIR - CONTEXTO PREVIO*\n\n${resumen}\n\n─── Entra asesor humano ───`, 
          'incoming'
        );
      }
    }

    await enviarMensajeChatwoot(conversationId, mensajeCliente, 'incoming');
    return conversationId;

  } catch (err) {
    console.error('[Chatwoot] Error transfiriendo:', err.message);
    return null;
  }
}

async function cerrarConversacion(telefono) {
  const conversationId = chatwootSesiones[telefono]?.conversationId;
  if (!conversationId) return;
  
  try {
    await api('patch', `/conversations/${conversationId}`, { status: 'resolved' });
    delete chatwootSesiones[telefono];
    console.log(`[Chatwoot] Conversación ${conversationId} cerrada.`);
  } catch (e) {
    console.error('[Chatwoot] Error al cerrar:', e.message);
  }
}

module.exports = { 
  transferirAChatwoot, 
  cerrarConversacion, 
  chatwootSesiones 
};
