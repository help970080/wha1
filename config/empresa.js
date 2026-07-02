/**
 * ═══════════════════════════════════════════════════════════
 * CONFIG MANAGER — Despacho (LeGaXi) + Empresas Acreedoras
 * ═══════════════════════════════════════════════════════════
 *
 * MODELO:
 *  - EL DESPACHO gestor es SIEMPRE LeGaXi Asociados (quien saluda,
 *    quien representa, sus gestores). NO cambia.
 *  - LAS EMPRESAS ACREEDORAS (CREDIA, CREDI YA, ...) son los clientes
 *    a los que LeGaXi les presta el servicio de cobranza. LeGaXi cobra
 *    EN SU NOMBRE. Cada acreedora tiene su propia razón social (para el
 *    PDF), sus cuentas de depósito, su prefijo de folio y sus términos
 *    de convenio.
 *  - Desde el PANEL SUPER ADMIN se elige la ACREEDORA ACTIVA: a nombre
 *    de quién está cobrando el bot en este momento. El bot y el PDF
 *    toman la configuración EN VIVO (no requiere reiniciar).
 *
 * PERSISTENCIA:
 *  - Se guarda en config/empresas.json. Si no existe, se crea con los
 *    valores semilla de abajo (DEFAULTS).
 *  - En Render free tier el disco es efímero: tras un redeploy el JSON
 *    se regenera desde estos DEFAULTS. Por eso el catálogo semilla
 *    (LeGaXi + CREDIA + CREDI YA) vive aquí en código: nunca se pierde.
 *    Los cambios hechos en el panel persisten hasta el siguiente deploy;
 *    para dejarlos permanentes, actualiza también estos DEFAULTS.
 * ═══════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

const JSON_PATH = path.join(__dirname, 'empresas.json');

// ─────────────────────────────────────────────────────────
// SEMILLA (valores por defecto en código)
// ─────────────────────────────────────────────────────────
const DEFAULTS = {

  // Despacho gestor: SIEMPRE LeGaXi. Sus gestores atienden todas las
  // acreedoras (la gestión la hace LeGaXi, no el cliente).
  despacho: {
    marca:       'LeGaXi Asociados',
    lema:        'Cobranza Mercantil Especializada',
    footerCorto: 'LeGaXi Asociados · Cobranza Mercantil',
    gestores: [
      { nombre: 'Lic. Carlos',  telefono: '7352588215', activo: true },
      { nombre: 'Lic. Gustavo', telefono: '5548039744', activo: true }
    ]
  },

  // Acreedora activa (a nombre de quién cobra el bot ahora mismo)
  activaId: 'credia',

  // Catálogo de acreedoras
  empresas: {

    // CREDIA = operación actual (LMV CREDIA). Valores REALES de hoy,
    // para que con activaId='credia' el bot se comporte idéntico a antes.
    credia: {
      id: 'credia',
      nombre: 'CREDIA',
      acreedorLegal: 'LMV CREDIA, S.A. DE C.V.',
      folioPrefijo: 'LGX',
      datosBancarios: {
        spinOxxo: { nombre: 'SPIN - OXXO',    clabe: '7289 6900 0166 6769 82', tarjeta: '4217 4702 1177 5578' },
        bbva:     { nombre: 'BBVA - BANCOMER', clabe: '0121 8001 5055 5747 30', tarjeta: '4152 3143 7377 5678' },
        titular:  'Lic. Francisco Gabriel García Sánchez'
      },
      convenio: {
        planA_monto: 1000, planB_monto: 500,
        semanasSinRecargo: 4, recargo: 0.15, umbralPagoUnico: 4000,
        urlConvenio: 'https://convenios.celexpress.org/LGX_Convenios.html'
      }
    },

    // CREDI YA <<< configúrala desde el panel (o llena estos DEFAULTS).
    crediya: {
      id: 'crediya',
      nombre: 'CREDI YA',
      acreedorLegal: 'CREDI YA [RAZON SOCIAL S.A. DE C.V.]',   // <<< razon social real
      folioPrefijo: 'CRY',
      datosBancarios: {
        spinOxxo: { nombre: 'SPIN - OXXO',    clabe: 'XXXX XXXX XXXX XXXX XX', tarjeta: 'XXXX XXXX XXXX XXXX' }, // <<<
        bbva:     { nombre: 'BBVA - BANCOMER', clabe: 'XXXX XXXX XXXX XXXX XX', tarjeta: 'XXXX XXXX XXXX XXXX' }, // <<<
        titular:  '[TITULAR DE LAS CUENTAS]'   // <<<
      },
      convenio: {
        planA_monto: 1000, planB_monto: 500,
        semanasSinRecargo: 4, recargo: 0.15, umbralPagoUnico: 4000,
        urlConvenio: 'https://convenios.celexpress.org/LGX_Convenios.html'  // <<<
      }
    }

  }
};

// ─────────────────────────────────────────────────────────
// Estado en memoria + carga/guardado
// ─────────────────────────────────────────────────────────
let STATE = null;

function _clone(o) { return JSON.parse(JSON.stringify(o)); }

function _load() {
  try {
    if (fs.existsSync(JSON_PATH)) {
      const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
      STATE = {
        despacho: Object.assign(_clone(DEFAULTS.despacho), raw.despacho || {}),
        empresas: Object.assign(_clone(DEFAULTS.empresas), raw.empresas || {}),
        activaId: raw.activaId || DEFAULTS.activaId
      };
    } else {
      STATE = _clone(DEFAULTS);
      _save();
    }
  } catch (e) {
    console.error('⚠️ empresas.json corrupto o ilegible, usando DEFAULTS:', e.message);
    STATE = _clone(DEFAULTS);
  }
  if (!STATE.empresas[STATE.activaId]) {
    STATE.activaId = Object.keys(STATE.empresas)[0] || 'credia';
  }
  return STATE;
}

function _save() {
  try {
    fs.writeFileSync(JSON_PATH, JSON.stringify(STATE, null, 2));
  } catch (e) {
    console.error('❌ No se pudo guardar empresas.json:', e.message);
  }
}

function _state() { return STATE || _load(); }

// ─────────────────────────────────────────────────────────
// Vista MERGE que consumen chatbot y PDF
//   branding/gestores  -> DESPACHO (LeGaXi)
//   legal/banco/folio  -> ACREEDORA ACTIVA
// ─────────────────────────────────────────────────────────
function getConfig() {
  const s = _state();
  const d = s.despacho;
  const e = s.empresas[s.activaId] || Object.values(s.empresas)[0];
  return {
    id: e.id,
    marca:          d.marca,
    lema:           d.lema,
    footerCorto:    d.footerCorto,
    gestores:       d.gestores,
    representadaPor: d.marca,
    pdfAuthor:      d.marca,
    empresaNombre:  e.nombre,
    acreedorLegal:  e.acreedorLegal,
    folioPrefijo:   e.folioPrefijo,
    datosBancarios: e.datosBancarios,
    convenio:       e.convenio
  };
}

// ─────────────────────────────────────────────────────────
// API del manager (la usa el panel vía server.js)
// ─────────────────────────────────────────────────────────
const manager = {
  getConfig,
  reload() { STATE = null; return _load(); },

  getDespacho() { return _clone(_state().despacho); },
  getEmpresas() { return _clone(_state().empresas); },
  getActivaId() { return _state().activaId; },
  getActiva()   { const s = _state(); return _clone(s.empresas[s.activaId]); },

  setActiva(id) {
    const s = _state();
    if (!s.empresas[id]) throw new Error('La acreedora "' + id + '" no existe');
    s.activaId = id; _save();
    return getConfig();
  },

  updateDespacho(patch) {
    const s = _state();
    s.despacho = Object.assign(s.despacho, patch || {});
    _save();
    return _clone(s.despacho);
  },

  upsertEmpresa(emp) {
    if (!emp || !emp.id) throw new Error('Falta id de la empresa');
    const s = _state();
    const id = String(emp.id).toLowerCase().replace(/[^a-z0-9_]/g, '');
    const base = s.empresas[id] || _clone(DEFAULTS.empresas.crediya);
    s.empresas[id] = {
      id: id,
      nombre:        emp.nombre        != null ? emp.nombre        : base.nombre,
      acreedorLegal: emp.acreedorLegal != null ? emp.acreedorLegal : base.acreedorLegal,
      folioPrefijo:  emp.folioPrefijo  != null ? emp.folioPrefijo  : base.folioPrefijo,
      datosBancarios: emp.datosBancarios != null ? emp.datosBancarios : base.datosBancarios,
      convenio:       emp.convenio       != null ? emp.convenio       : base.convenio
    };
    _save();
    return _clone(s.empresas[id]);
  },

  deleteEmpresa(id) {
    const s = _state();
    if (!s.empresas[id]) throw new Error('La acreedora "' + id + '" no existe');
    if (Object.keys(s.empresas).length <= 1) throw new Error('No puedes borrar la única acreedora');
    delete s.empresas[id];
    if (s.activaId === id) s.activaId = Object.keys(s.empresas)[0];
    _save();
    return { ok: true, activaId: s.activaId };
  }
};

// ─────────────────────────────────────────────────────────
// Propiedades LIVE (getters) para compatibilidad:
//   chatbot y pdf leen EMPRESA.marca / EMPRESA.convenio / etc.
//   y siempre obtienen la config de la acreedora ACTIVA en ese instante.
// ─────────────────────────────────────────────────────────
[
  'id','marca','lema','footerCorto','gestores','representadaPor','pdfAuthor',
  'empresaNombre','acreedorLegal','folioPrefijo','datosBancarios','convenio'
].forEach(function (key) {
  Object.defineProperty(manager, key, {
    get: function () { return getConfig()[key]; },
    enumerable: true
  });
});

_load();

module.exports = manager;
