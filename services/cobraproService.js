/**
 * ═══════════════════════════════════════════════════════════
 * INTEGRACIÓN CON COBRAPRO (solo LECTURA — Fase 1)
 * ═══════════════════════════════════════════════════════════
 * Jala clientes morosos de una AGENCIA (tenant) de CobraPro para
 * cargarlos como campaña en el bot. NO escribe nada en CobraPro.
 *
 * Flujo (todo con la API que YA existe en CobraPro):
 *   1) POST /api/auth/login {usuario,password}  -> token SUPER
 *   2) GET  /api/super/tenants                  -> lista de agencias
 *   3) POST /api/super/enter/:id                -> token del tenant
 *   4) GET  /api/contactos  (clientes sin pago) -> morosos de la semana
 *      GET  /api/clients    (saldo>0)           -> universo completo
 *   -> se unen, deduplican por teléfono y se normalizan para campaña.
 *
 * Credenciales por variables de entorno (Render), NO en código:
 *   COBRAPRO_BASE  (default https://cobrapro.legaxia.uk)
 *   COBRAPRO_USER
 *   COBRAPRO_PASS
 * ═══════════════════════════════════════════════════════════
 */

const BASE = (process.env.COBRAPRO_BASE || 'https://cobrapro.legaxia.uk').replace(/\/+$/, '');
const USER = process.env.COBRAPRO_USER || '';
const PASS = process.env.COBRAPRO_PASS || '';

// Caches de token (super 12h; tenant 6h). Renuevo con margen.
let _superTok = null, _superExp = 0;
const _tenantTok = {}; // tenantId -> { token, exp }

function _configurado() { return !!(USER && PASS); }

async function _fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { _raw: txt }; }
  if (!r.ok) {
    const msg = (data && (data.error || data.mensaje)) || ('HTTP ' + r.status);
    const e = new Error(msg); e.status = r.status; e.body = data; throw e;
  }
  return data;
}

// 1) Login superadmin (con cache)
async function _tokenSuper() {
  if (!_configurado()) throw new Error('CobraPro no configurado: falta COBRAPRO_USER / COBRAPRO_PASS en el entorno.');
  const now = Date.now();
  if (_superTok && now < _superExp) return _superTok;
  const data = await _fetchJson(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: USER, password: PASS })
  });
  if (!data || !data.token) throw new Error('Login CobraPro sin token');
  if (!data.super) throw new Error('El usuario de CobraPro no es superadmin');
  _superTok = data.token;
  _superExp = now + 11 * 3600 * 1000; // 11h (token dura 12h)
  return _superTok;
}

// 2) Listar agencias registradas
async function listarAgencias() {
  const tok = await _tokenSuper();
  const list = await _fetchJson(BASE + '/api/super/tenants', {
    headers: { Authorization: 'Bearer ' + tok }
  });
  return (list || [])
    .filter(t => t.activo !== false)
    .map(t => ({ id: t.id, nombre: t.nombre, clientes: t.stats ? t.stats.clientes : null }));
}

// 3) Token de un tenant (con cache)
async function _tokenTenant(tenantId) {
  const now = Date.now();
  const c = _tenantTok[tenantId];
  if (c && now < c.exp) return c.token;
  const tok = await _tokenSuper();
  const data = await _fetchJson(BASE + '/api/super/enter/' + tenantId, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (!data || !data.token) throw new Error('No se pudo entrar a la agencia ' + tenantId);
  _tenantTok[tenantId] = { token: data.token, exp: now + 5 * 3600 * 1000 }; // 5h (dura 6h)
  return data.token;
}

// Utilidades de normalización
function _tel10(v) { return String(v || '').replace(/\D/g, '').slice(-10); }
function _diasDesde(fechaMx) {
  // fechaMx en dd/mm/aaaa (formato CobraPro). Devuelve días transcurridos, o 0.
  if (!fechaMx) return 0;
  const p = String(fechaMx).split('/');
  if (p.length !== 3) return 0;
  const t = new Date(+p[2], +p[1] - 1, +p[0]).getTime();
  if (!t) return 0;
  const d = Math.floor((Date.now() - t) / 86400000);
  return d > 0 ? d : 0;
}

// 4) Traer morosos de una agencia (contactos ∪ saldo>0), deduplicado
async function getMorosos(tenantId, opts = {}) {
  const incluirTodos = opts.incluirTodos !== false; // por defecto suma /api/clients (saldo>0)
  const tok = await _tokenTenant(tenantId);
  const H = { Authorization: 'Bearer ' + tok };
  const porTel = new Map();

  // (a) Contactos = clientes sin pago de la semana (fuente principal, trae vencido)
  try {
    const c = await _fetchJson(BASE + '/api/contactos', { headers: H });
    const rows = (c && c.rows) || [];
    for (const r of rows) {
      const tel = _tel10(r.tel);
      if (tel.length < 10) continue;
      porTel.set(tel, {
        nombre: r.nombre || 'Cliente',
        telefono: tel,
        saldo: Math.round(r.saldo || 0),
        diasAtraso: _diasDesde(r.ultima_fecha_pago),
        vencido: Math.round(r.monto_atraso || 0),
        folio: r.folio || '',
        sucursalId: r.sucursalId,
        cobrador: r.cobrador || '',
        fuente: 'contactos'
      });
    }
  } catch (e) { /* si contactos falla, seguimos con clients */ }

  // (b) Universo completo con saldo>0 (rellena a los que no salieron en contactos)
  if (incluirTodos) {
    const clients = await _fetchJson(BASE + '/api/clients', { headers: H });
    for (const c of (clients || [])) {
      const tel = _tel10(c.tel);
      if (tel.length < 10) continue;
      const saldo = (c.creditos || []).reduce((a, s) => a + Math.max(0, s.saldo || 0), 0);
      if (saldo <= 0) continue;
      if (porTel.has(tel)) continue; // ya vino en contactos (más completo)
      porTel.set(tel, {
        nombre: c.nombre || 'Cliente',
        telefono: tel,
        saldo: Math.round(saldo),
        diasAtraso: 0,
        vencido: 0,
        folio: (c.creditos && c.creditos[0] && c.creditos[0].folio) || '',
        sucursalId: (c.creditos && c.creditos[0] && c.creditos[0].sucursalId),
        cobrador: c.prom || '',
        fuente: 'cartera'
      });
    }
  }

  return Array.from(porTel.values());
}

module.exports = {
  configurado: _configurado,
  base: () => BASE,
  listarAgencias,
  getMorosos
};
