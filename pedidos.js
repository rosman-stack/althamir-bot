// pedidos.js
// Maneja el registro y consulta de pedidos en un Google Sheet PRIVADO
// (separado del inventario, que es público). Requiere que el correo de
// servicio (client_email dentro de GOOGLE_CREDENTIALS_JSON) tenga acceso
// de Editor en este Sheet.

const { google } = require('googleapis');
const crypto = require('crypto');

// Evita la "inyección de fórmulas": como los datos del pedido los escribe el público,
// una celda que empiece con = + - @ se interpretaría como fórmula en Google Sheets
// (por ejemplo =IMPORTDATA(...) puede enviar el contenido de la hoja a un tercero).
// Le anteponemos una comilla para que se guarde siempre como texto.
function celda(valor, max = 500) {
  let t = valor === undefined || valor === null ? '' : String(valor);
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return t;
}
const CANALES = ['WhatsApp', 'Tarjeta'];
const ESTADOS_INICIALES = ['Procesando', 'Pendiente de pago'];

const PEDIDOS_SHEET_ID = '1Wpr9WlQaqe93_mdpAsGkzklN026NSzRySPkj4g0yyh4';
const HOJA = 'Sheet1'; // Nombre real de la pestaña en el Sheet de Pedidos
const RANGO = `'${HOJA}'!A:J`; // order_id, fecha, cliente, telefono, direccion, productos, total, canal, estado, guia

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
  const sufijo = crypto.randomBytes(3).toString('hex').toUpperCase();
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
  const totalNum = Number(total);
  const fila = [
    orderId, fecha, celda(cliente, 120), celda(telefono, 30), celda(direccion, 400), celda(productos, 1500),
    Number.isFinite(totalNum) ? totalNum : '',
    CANALES.includes(canal) ? canal : 'WhatsApp',
    ESTADOS_INICIALES.includes(estado) ? estado : 'Procesando',
    ''
  ];

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
    range: `'${HOJA}'!I${rowIndex + 1}:J${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[celda(nuevoEstado, 60), celda(nuevaGuia, 120)]] }
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
    if (filaTelefono.length >= 8 && (filaTelefono.endsWith(limpio) || limpio.endsWith(filaTelefono))) {
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

// Chequeo liviano de conectividad, usado por el monitor de salud — solo lee
// el encabezado, no escribe nada. Si el nombre de la pestaña (HOJA) está mal,
// esto falla igual que fallaría un guardado real, pero sin crear un pedido falso.
async function verificarConexion() {
  const sheets = await getSheetsWriteClient();
  await sheets.spreadsheets.values.get({ spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA}'!A1:A1` });
  return true;
}

// ─── Clientes esperando asesor ───────────────────────────────────────────────
// Se guardan en la pestaña "Asesor" del MISMO archivo de pedidos (el bot la crea sola si no
// existe), para que un reinicio o un deploy de Render no libere por error a quien espera.
// Columnas: telefono | desde | ultima_actividad | estado (Esperando / Liberado)
const HOJA_ASESOR = 'Asesor';
const DIAS_CONSERVAR_LIBERADOS = 30;
const _filaAsesor = new Map();   // teléfono → número de fila en la pestaña
let _pestanaAsesor = null;       // promesa: la pestaña ya existe
let _colaAsesor = Promise.resolve();

// Todas las operaciones sobre la pestaña van una tras otra, para que los números de fila no se crucen
function _enCola(fn) {
  const p = _colaAsesor.then(fn);
  _colaAsesor = p.catch(() => {}); // un fallo no bloquea las siguientes
  return p;
}

async function _asegurarPestanaAsesor(sheets) {
  if (_pestanaAsesor) return _pestanaAsesor;
  _pestanaAsesor = (async () => {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: PEDIDOS_SHEET_ID, fields: 'sheets.properties.title' });
    const existe = (meta.data.sheets || []).some(s => s.properties && s.properties.title === HOJA_ASESOR);
    if (!existe) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: PEDIDOS_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: HOJA_ASESOR } } }] }
      });
      console.log(`[Asesor] Pestaña "${HOJA_ASESOR}" creada en el Sheet de pedidos`);
    }
    const enc = await sheets.spreadsheets.values.get({ spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A1:D1` });
    if (!(enc.data.values && enc.data.values[0] && enc.data.values[0][0])) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A1:D1`, valueInputOption: 'RAW',
        requestBody: { values: [['telefono', 'desde', 'ultima_actividad', 'estado']] }
      });
    }
    return true;
  })().catch(e => { _pestanaAsesor = null; throw e; });
  return _pestanaAsesor;
}

// Lee la pestaña al iniciar. Devuelve [{ telefono, desde, ultima, estado }] (fechas en ms).
// De paso limpia los "Liberado" de más de 30 días y las filas vacías.
function cargarEsperasAsesor() {
  return _enCola(async () => {
    const sheets = await getSheetsWriteClient();
    await _asegurarPestanaAsesor(sheets);
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A2:D` });
    const crudas = res.data.values || [];
    const limite = Date.now() - DIAS_CONSERVAR_LIBERADOS * 24 * 60 * 60 * 1000;
    const porTelefono = new Map(); // si un teléfono apareciera dos veces, gana la última fila
    for (const f of crudas) {
      const telefono = String((f && f[0]) || '').replace(/\D/g, '');
      if (!telefono) continue;
      const desde = Date.parse(f[1]) || Date.now();
      const ultima = Date.parse(f[2]) || desde;
      const estado = f[3] === 'Esperando' ? 'Esperando' : 'Liberado';
      if (estado === 'Esperando' || ultima >= limite) porTelefono.set(telefono, { telefono, desde, ultima, estado });
    }
    const finales = [...porTelefono.values()];
    if (finales.length !== crudas.length) {
      // Compactar: primero se escriben las filas que se conservan y DESPUÉS se borra lo que sobra,
      // así un corte a mitad de camino nunca pierde a un cliente que espera.
      if (finales.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A2:D${finales.length + 1}`, valueInputOption: 'RAW',
          requestBody: { values: finales.map(f => [f.telefono, new Date(f.desde).toISOString(), new Date(f.ultima).toISOString(), f.estado]) }
        });
      }
      if (crudas.length > finales.length) {
        await sheets.spreadsheets.values.clear({ spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A${finales.length + 2}:D${crudas.length + 1}` });
      }
      console.log(`[Asesor] Pestaña ordenada: ${crudas.length - finales.length} fila(s) vieja(s) o vacía(s) eliminadas`);
    }
    _filaAsesor.clear();
    finales.forEach((f, i) => _filaAsesor.set(f.telefono, i + 2));
    return finales;
  });
}

// Guarda (o actualiza) a un cliente. estado: 'Esperando' | 'Liberado'. Fechas en ISO.
function guardarEsperaAsesor(telefono, { desde, ultima, estado }) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return Promise.resolve(false);
  return _enCola(async () => {
    const sheets = await getSheetsWriteClient();
    await _asegurarPestanaAsesor(sheets);
    const fila = [tel, desde, ultima, estado === 'Esperando' ? 'Esperando' : 'Liberado'];
    let row = _filaAsesor.get(tel);
    if (row) {
      // Por si alguien borró o movió filas a mano: comprobamos que esa fila siga siendo de este cliente
      const chk = await sheets.spreadsheets.values.get({ spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A${row}:A${row}` });
      const actual = String((chk.data.values && chk.data.values[0] && chk.data.values[0][0]) || '').replace(/\D/g, '');
      if (actual !== tel) { _filaAsesor.delete(tel); row = null; }
    }
    if (row) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A${row}:D${row}`, valueInputOption: 'RAW',
        requestBody: { values: [fila] }
      });
    } else {
      const r = await sheets.spreadsheets.values.append({
        spreadsheetId: PEDIDOS_SHEET_ID, range: `'${HOJA_ASESOR}'!A:D`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [fila] }
      });
      const m = /!A(\d+):/.exec((r.data && r.data.updates && r.data.updates.updatedRange) || '');
      if (m) _filaAsesor.set(tel, parseInt(m[1], 10));
    }
    return true;
  });
}

module.exports = { crearPedido, actualizarEstadoPedido, buscarPorTelefono, buscarPendienteParaConfirmar, generarOrderId, verificarConexion, cargarEsperasAsesor, guardarEsperaAsesor };
