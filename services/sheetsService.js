/**
 * ═══════════════════════════════════════════════════════════
 * REGISTRO EN GOOGLE SHEETS (vía GAS Web App)
 * ═══════════════════════════════════════════════════════════
 * Guarda a quién ya se le mandó campaña (por AGENCIA) fuera de
 * Render, para no reenviar sin querer. El reenvío lo decides TÚ
 * con los checks del panel; esto solo registra y consulta.
 *
 * Variables de entorno (Render):
 *   SHEETS_URL    -> URL del Web App del GAS (termina en /exec)
 *   SHEETS_TOKEN  -> mismo token del GAS (default legaxi_sheets_2026)
 * ═══════════════════════════════════════════════════════════
 */

const URL = (process.env.SHEETS_URL || '').trim();
const TOKEN = process.env.SHEETS_TOKEN || 'legaxi_sheets_2026';

function configurado() { return !!URL; }

async function _post(payload) {
  if (!URL) return { ok: false, error: 'SHEETS_URL no configurada' };
  // GAS: text/plain + redirect follow evita que el POST se convierta en GET (302)
  const r = await fetch(URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ token: TOKEN }, payload))
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { ok: false, _raw: t }; }
}

// Registrar uno o varios envíos exitosos
async function registrarEnviados(agencia, campana, registros) {
  const lista = Array.isArray(registros) ? registros : [registros];
  return _post({ accion: 'enviado', agencia, campana, registros: lista });
}

// Registrar una respuesta de cliente (fase 2)
async function registrarRespuesta(agencia, telefono, nombre, mensaje, tipo) {
  return _post({ accion: 'respuesta', agencia, telefono, nombre, mensaje, tipo });
}

// Consultar los ya-enviados de una agencia -> { ok, telefonos:[], detalle:{ tel:{nombre,ultimo,veces} } }
async function getEnviados(agencia) {
  if (!URL) return { ok: false, telefonos: [], detalle: {} };
  const u = URL + '?token=' + encodeURIComponent(TOKEN) + '&agencia=' + encodeURIComponent(agencia || '');
  const r = await fetch(u, { redirect: 'follow' });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { ok: false, telefonos: [], detalle: {}, _raw: t }; }
}

module.exports = { configurado, registrarEnviados, registrarRespuesta, getEnviados };
