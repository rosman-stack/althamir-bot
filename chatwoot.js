const axios = require('axios');

const CHATWOOT_URL = 'https://app.chatwoot.com';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;

// Limpieza de ACCOUNT_ID para evitar errores de URL (quita barras diagonales si existen)
const ACCOUNT_ID_CLEAN = CHATWOOT_ACCOUNT_ID ? CHATWOOT_ACCOUNT_ID.toString().replace(/\/$/, '').split('/').pop() : '';

const chatwootSesiones = {};

/**
 * Función base para peticiones a la API de Chatwoot
 */
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

/**
 * Busca un contacto por teléfono o lo crea si no existe
 */
async function obtenerOCrearContacto(telefono) {
  try {
    // Buscar contacto (Chatwoot usa el query para buscar coincidencias)
    const busqueda = await api('get', `/contacts/search?q=${telefono}`);
    if (busqueda.payload && busqueda.payload.length > 0) {
      return busqueda.payload[0].id;
    }
  } catch (e) {
    console.log(`[Chatwoot] Buscando contacto: ${telefono} no encontrado, creando uno nuevo...`);
  }

  // Si no existe, se crea
  const contacto = await api('post', '/contacts', {
    phone_number: `+${telefono}`,
    name: `Cliente WhatsApp (+${telefono})`,
    inbox_id: parseInt(CHATWOOT_INBOX_ID)
  });
  return contacto.payload.contact.id;
}

/**
 * Crea una nueva conversación para un contacto
 */
async function crearConversacion(contactId) {
  const conv = await api('post', '/conversations', {
    contact_id: contactId,
    inbox_id: parseInt(CHATWOOT_INBOX_ID)
  });
  return conv.id;
}

/**
 * Envía un mensaje a una conversación específica
 */
async function enviarMensajeChatwoot(conversationId, mensaje, tipo = 'incoming') {
  await api('post', `/conversations/${conversationId}/messages`, {
    content: mensaje,
    message_type: tipo,
    private: false
  });
}

/**
 * Transfiere la sesión actual de Noor a un asesor humano en Chatwoot
 */
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

      // Enviar historial previo como contexto para el asesor (Últimos 8 mensajes)
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

    // Enviar el mensaje actual del cliente
    await enviarMensajeChatwoot(conversationId, mensajeCliente, 'incoming');
    console.log(`[Chatwoot] Mensaje de ${telefono} enviado a la conversación ${conversationId}`);
    return conversationId;

  } catch (err) {
    console.error('[Chatwoot] Error en el proceso de transferencia:', err.message);
    return null;
  }
}

/**
 * Marca la conversación como resuelta y libera la sesión local
 */
async function cerrarConversacion(telefono) {
  const conversationId = chatwootSesiones[telefono]?.conversationId;
  if (!conversationId) return;
  
  try {
    await api('patch', `/conversations/${conversationId}`, { status: 'resolved' });
    delete chatwootSesiones[telefono];
    console.log(`[Chatwoot] Conversación ${conversationId} marcada como resuelta`);
  } catch (e) {
    console.error('[Chatwoot] Error al cerrar conversación:', e.message);
  }
}

module.exports = { 
  transferirAChatwoot, 
  cerrarConversacion, 
  chatwootSesiones 
};
