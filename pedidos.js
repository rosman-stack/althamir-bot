// pedidos.js
// Maneja el registro y consulta de pedidos en un Google Sheet PRIVADO
// (separado del inventario, que es público). Requiere que el correo de
// servicio (client_email dentro de GOOGLE_CREDENTIALS_JSON) tenga acceso
// de Editor en este Sheet.

const { google } = require('googleapis');

const PEDIDOS_SHEET_ID = '1Wpr9WlQaqe93_mdpAsGkzklN026NSzRySPkj4g0yyh4';
const HOJA = 'Hoja 1'; // Cambia esto si tu pestaña se llama distinto
const RANGO = `${HOJA}!A:J`; // order_id, fecha, cliente, telefono, direccion, productos, total, canal, estado, guia

async function getSheetsWriteClient() {
  const credencialesJSON = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!credencialesJSON) throw new Error('Falta GOOGLE_CREDENTIALS_JSON en variables de entorno');
  const credenciales = JSON.parse(credencialesJSON);
  const auth = new google.auth.GoogleAuth({
    credentials: credenciales,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], // lectura Y escritura
  });
  return google.sheets({ version: 'v4', auth });
}

function generarOrderId() {
  const yymmdd = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const sufijo = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ALT-${yymmdd}-${sufijo}`;
}

async function _leerTodasLasFilas(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: PEDIDOS_SHEET_ID, range: RANGO });
  return res.data.values || [];
}

async function crearPedido({ cliente, telefono, direccion, productos, total, canal, estado }) {
  const sheets = await getSheetsWriteClient();
  const orderId = generarOrderId();
  const fecha = new Date().toISOString();
  const fila = [orderId, fecha, cliente || '', telefono || '', direccion || '', productos || '', total || '', canal || 'WhatsApp', estado || 'Procesando', ''];

  await sheets.spreadsheets.values.append({
    spreadsheetId: PEDIDOS_SHEET_ID,
    range: RANGO,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [fila] }
  });

  console.log(`[Pedidos] Nuevo pedido ${orderId} (${canal})`);
  return orderId;
}

async function actualizarEstadoPedido(orderId, { estado, guia } = {}) {
  const sheets = await getSheetsWriteClient();
  const filas = await _leerTodasLasFilas(sheets);
  const rowIndex = filas.findIndex(f => f[0] === orderId);
  if (rowIndex === -1) {
    console.warn(`[Pedidos] No se encontró el pedido ${orderId}`);
    return false;
  }

  const filaActual = filas[rowIndex];
  const nuevoEstado = estado !== undefined ? estado : (filaActual[8] || '');
  const nuevaGuia = guia !== undefined ? guia : (filaActual[9] || '');

  await sheets.spreadsheets.values.update({
    spreadsheetId: PEDIDOS_SHEET_ID,
    range: `${HOJA}!I${rowIndex + 1}:J${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[nuevoEstado, nuevaGuia]] }
  });

  console.log(`[Pedidos] ${orderId} → estado: ${nuevoEstado}${nuevaGuia ? ', guía: ' + nuevaGuia : ''}`);
  return true;
}

// Usado por la página "Buscar mi pedido" — solo devuelve los pedidos de ESE teléfono
async function buscarPorTelefono(telefono) {
  const sheets = await getSheetsWriteClient();
  const filas = await _leerTodasLasFilas(sheets);
  if (filas.length < 2) return [];

  const limpio = (telefono || '').replace(/\D/g, '');
  if (limpio.length < 8) return []; // evita búsquedas demasiado cortas/ambiguas

  const resultados = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || !f[3]) continue;
    const filaTelefono = f[3].toString().replace(/\D/g, '');
    if (filaTelefono.endsWith(limpio) || limpio.endsWith(filaTelefono)) {
      resultados.push({
        orderId: f[0], fecha: f[1], productos: f[5], total: f[6],
        canal: f[7], estado: f[8] || 'Procesando', guia: f[9] || ''
      });
    }
  }
  return resultados.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

// Usado por el webhook de Recurrente para encontrar a qué pedido corresponde
// un pago exitoso (Recurrente no siempre nos devuelve nuestro order_id propio,
// así que emparejamos por teléfono + monto + ventana de tiempo reciente).
async function buscarPendienteParaConfirmar(telefono, monto, ventanaMinutos = 45) {
  const sheets = await getSheetsWriteClient();
  const filas = await _leerTodasLasFilas(sheets);
  const limpio = (telefono || '').replace(/\D/g, '');
  const ahora = Date.now();

  for (let i = filas.length - 1; i >= 1; i--) { // de más reciente a más antiguo
    const f = filas[i];
    if (!f || f[7] !== 'Tarjeta' || f[8] !== 'Pendiente de pago') continue;
    const totalFila = parseFloat(f[6]);
    if (isNaN(totalFila) || Math.abs(totalFila - monto) > 0.5) continue;
    const fechaFila = new Date(f[1]).getTime();
    if (isNaN(fechaFila) || (ahora - fechaFila) > ventanaMinutos * 60 * 1000) continue;
    if (limpio && f[3]) {
      const filaTelefono = f[3].toString().replace(/\D/g, '');
      if (!filaTelefono.endsWith(limpio) && !limpio.endsWith(filaTelefono)) continue;
    }
    return f[0]; // order_id
  }
  return null;
}

module.exports = { crearPedido, actualizarEstadoPedido, buscarPorTelefono, buscarPendienteParaConfirmar, generarOrderId };
