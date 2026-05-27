require('dotenv').config();
// ═══════════════════════════════════════════════════════════════
// LeGaXi Voice Bot v10.0 - Agente conversacional con Claude
// ═══════════════════════════════════════════════════════════════
// NUEVO v10.0:
//   - Loop conversacional (máx 6 turnos)
//   - Claude Haiku 4.5 como cerebro (tool use)
//   - Tono cercano y empático (Tono B)
//   - Function calling: registrar_promesa, marcar_equivocado,
//     marcar_no_esta, marcar_rechazo, terminar_llamada
//   - Frase puente cacheada mientras Claude piensa
//   - Cola de concurrencia para edge-tts (máx 3 simultáneos)
//   - Promesas van directo a GAS addPromesa
//   - Compatible 100% con /api/llamar-bot existente
// ═══════════════════════════════════════════════════════════════

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const vosk = require('vosk-koffi');
const Anthropic = require('@anthropic-ai/sdk');

const AUDIOSOCKET_PORT = 8090;
const HTTP_API_PORT = 3002;

// v10.8: Límite duro de llamadas conversacionales simultáneas.
// Cada llamada usa ~150MB RAM por Vosk + slot edge-tts + CPU para audio.
// Default 3 = conservador (cabe en WSL2 estándar). Subir solo si se ha probado.
const MAX_CONCURRENTES = parseInt(process.env.MAX_CONCURRENTES) || 3;

// Contador global de llamadas activas en este momento
let llamadasActivas = 0;
function getLlamadasActivas() { return llamadasActivas; }
function incLlamadas() { llamadasActivas++; }
function decLlamadas() { if (llamadasActivas > 0) llamadasActivas--; }

const CACHE_DIR = path.join(__dirname, 'cache');
const RESPUESTAS_DIR = path.join(CACHE_DIR, 'respuestas_v10');
const SALUDOS_DIR = path.join(CACHE_DIR, 'saludos_v10');
const PUENTES_DIR = path.join(CACHE_DIR, 'puentes_v10');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const MODEL_PATH = path.join(__dirname, 'models/es-small');
const SAMPLE_RATE = 8000;
const FRAME_SIZE = 320;

const TTS_VOICE = 'es-MX-JorgeNeural';
const TTS_RATE = '-5%';

const SILENCE_THRESHOLD = 250;
const SILENCE_MS = 400;        // v10.5: 500→400ms (más rápido detectar fin de habla)
const MIN_SPEECH_MS = 250;     // v10.5: 300→250ms (capta "sí" más cortos)
const STALL_MS = 900;          // v10.5: 1500→900ms (corta antes el silencio)
const MAX_LISTEN_MS = 6000;    // v10.5: 12000→6000ms (no esperar 12s al cliente)
const MAX_TURNOS = 6;
const TIEMPO_MAX_LLAMADA_MS = 180000;  // 3 min duro

const FANTASMA_URL = process.env.FANTASMA_URL || 'https://phantom.legaxia.uk';
const IVR_API_TOKEN = process.env.IVR_API_TOKEN || '';
const API_TOKEN_LOCAL = process.env.BOT_API_TOKEN || 'legaxi_bot_2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// const GAS_PROMESAS_URL eliminado v10 final: las promesas van a Fantasma/Postgres,
// porque Google bloquea POSTs anónimos a Apps Script desde curl/Node.

const DESPACHO_DEFAULT = 'Legaxi Asociados';
const RETORNO_DEFAULT = '55 44 62 11 00';
const ACREEDOR_DEFAULT = 'Credia';

const KIND_HANGUP = 0x00;
const KIND_UUID = 0x01;
const KIND_AUDIO = 0x10;

[CACHE_DIR, RESPUESTAS_DIR, SALUDOS_DIR, PUENTES_DIR, RECORDINGS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

vosk.setLogLevel(-1);
console.log('Cargando modelo Vosk...');
const voskModel = new vosk.Model(MODEL_PATH);
console.log('Modelo Vosk OK');

if (!ANTHROPIC_API_KEY) {
    console.error('⚠⚠⚠ FALTA ANTHROPIC_API_KEY en .env - el bot NO funcionará');
} else {
    console.log('Claude API key cargada ✓');
}
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
console.log('');

// ═══ Cola de concurrencia para edge-tts ═══
let ttsEnVuelo = 0;
const TTS_MAX_CONCURRENT = 3;
const ttsCola = [];

function ttsSlot() {
    return new Promise(resolve => {
        if (ttsEnVuelo < TTS_MAX_CONCURRENT) {
            ttsEnVuelo++;
            resolve(() => {
                ttsEnVuelo--;
                if (ttsCola.length > 0) {
                    const next = ttsCola.shift();
                    ttsEnVuelo++;
                    next(() => {
                        ttsEnVuelo--;
                        if (ttsCola.length > 0) ttsCola.shift()(() => ttsEnVuelo--);
                    });
                }
            });
        } else {
            ttsCola.push(resolve);
        }
    });
}

// ═══ Map por teléfono ═══
const llamadasPorTelefono = new Map();
const ultimasLlamadasPorTel = new Map();
setInterval(() => {
    const corte = Date.now() - 300000;
    for (const [tel, t] of ultimasLlamadasPorTel) {
        if (t < corte) ultimasLlamadasPorTel.delete(tel);
    }
}, 60000);
const colaFIFO = [];

function registrarLlamada(datos) {
    if (datos.telefono) {
        llamadasPorTelefono.set(datos.telefono, { ...datos, originadaEn: Date.now() });
    }
    colaFIFO.push({ ...datos, originadaEn: Date.now() });
    const corte = Date.now() - 180000;
    while (colaFIFO.length > 0 && colaFIFO[0].originadaEn < corte) {
        const vieja = colaFIFO.shift();
        if (vieja.telefono) llamadasPorTelefono.delete(vieja.telefono);
    }
    for (const [tel, d] of llamadasPorTelefono) {
        if (d.originadaEn < corte) llamadasPorTelefono.delete(tel);
    }
}

function tomarMasReciente() {
    if (colaFIFO.length === 0) return null;
    return colaFIFO.pop();
}

function log(msg) {
    const t = new Date().toISOString().split('T')[1].split('.')[0];
    console.log('[' + t + '] ' + msg);
}

function buildMsg(kind, payload) {
    const len = payload ? payload.length : 0;
    const h = Buffer.alloc(3);
    h.writeUInt8(kind, 0);
    h.writeUInt16BE(len, 1);
    return payload ? Buffer.concat([h, payload]) : h;
}

function calcularRMS(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i += 2) {
        const s = buf.readInt16LE(i);
        sum += s * s;
    }
    return Math.sqrt(sum / (buf.length / 2));
}

async function generarTTS(texto, archivo) {
    const release = await ttsSlot();
    try {
        return await new Promise((resolve, reject) => {
            const mp3 = archivo + '.mp3';
            const ett = spawn('edge-tts', ['--voice', TTS_VOICE, '--rate=' + TTS_RATE, '--text', texto, '--write-media', mp3]);
            ett.on('close', code => {
                if (code !== 0) return reject(new Error('edge-tts fallo'));
                const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3,
                    '-af', 'highpass=f=300, lowpass=f=3400, dynaudnorm=p=0.9:m=10, aresample=8000:resampler=soxr:precision=33',
                    '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', '-f', 's16le', archivo]);
                ff.on('close', c => {
                    try { fs.unlinkSync(mp3); } catch(e){}
                    if (c === 0) resolve();
                    else reject(new Error('ffmpeg fallo'));
                });
            });
        });
    } finally {
        if (typeof release === 'function') release();
    }
}

async function obtenerAudioCacheado(texto, prefijo = 'cache', dir = RESPUESTAS_DIR) {
    const hash = crypto.createHash('md5').update(texto).digest('hex').substring(0, 12);
    const archivo = path.join(dir, prefijo + '_' + hash + '.raw');
    if (!fs.existsSync(archivo)) {
        log('  🎙️ Generando audio nuevo: "' + texto.substring(0, 50) + '..."');
        await generarTTS(texto, archivo);
    }
    return fs.readFileSync(archivo);
}

async function generarAudioFresco(texto) {
    // Para respuestas dinámicas de Claude (no cachea, cada turno es único)
    const archivo = path.join(RESPUESTAS_DIR, 'dyn_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.raw');
    await generarTTS(texto, archivo);
    const buf = fs.readFileSync(archivo);
    try { fs.unlinkSync(archivo); } catch(e){}
    return buf;
}

function nombreCorto(nombreCompleto) {
    if (!nombreCompleto) return null;
    const partes = nombreCompleto.trim().split(/\s+/);
    if (partes.length === 0) return null;
    if (partes.length === 1) return partes[0];
    return partes[0] + ' ' + partes[1];
}

function construirSaludo(datos) {
    const despacho = datos.despacho || DESPACHO_DEFAULT;
    const nombre = nombreCorto(datos.nombre);
    if (nombre) {
        return `Buenas tardes, ¿hablo con ${nombre}?`;
    }
    return `Buenas tardes, le hablo de ${despacho}. ¿Con quién tengo el gusto?`;
}

// ═══ FRASES PUENTE (cacheadas, se reproducen mientras Claude piensa) ═══
const FRASES_PUENTE = [
    'Permítame.',
    'Un segundo.'
];

async function precalentarPuentes() {
    log('Pre-generando frases puente...');
    for (const frase of FRASES_PUENTE) {
        try { await obtenerAudioCacheado(frase, 'puente', PUENTES_DIR); }
        catch(e) { log('  ⚠ Error pre-gen puente: ' + e.message); }
    }
    log('Puentes listos ✓');
}

async function obtenerPuenteRandom() {
    const frase = FRASES_PUENTE[Math.floor(Math.random() * FRASES_PUENTE.length)];
    return obtenerAudioCacheado(frase, 'puente', PUENTES_DIR);
}

// ═══ REPORTES A FANTASMA ═══
async function reportarResultado(datos) {
    if (!FANTASMA_URL || !IVR_API_TOKEN) return;
    try {
        await fetch(FANTASMA_URL + '/api/resultado-llamada', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + IVR_API_TOKEN },
            body: JSON.stringify(datos)
        });
    } catch(e) { log('  ⚠ Error reportando Fantasma: ' + e.message); }
}

// ═══ REGISTRAR PROMESA EN FANTASMA (Postgres) ═══
// Cambio v10 final: NO escribimos al GAS (Google bloquea POSTs anónimos a Apps Script).
// En su lugar, mandamos la promesa a Fantasma, que la guarda en Postgres.
// El sheet de Promesas sigue recibiendo las del HTML manual desde navegador.
async function registrarPromesaEnFantasma(datos) {
    if (!FANTASMA_URL || !IVR_API_TOKEN) {
        log('  ⚠ Fantasma no configurado - promesa NO registrada');
        return { ok: false, error: 'sin_fantasma' };
    }
    try {
        const payload = {
            telefono: datos.telefono || '',
            cliente: datos.nombre || '',
            promesa: {
                fecha: datos.fecha || '',
                monto: datos.monto || 0,
                nota: datos.observaciones || '',
                registrada: new Date().toISOString(),
                estado: 'pendiente',
                cobrador: 'bot_v10'
            }
        };
        const resp = await fetch(FANTASMA_URL + '/api/promesa-bot', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + IVR_API_TOKEN
            },
            body: JSON.stringify(payload)
        });
        const text = await resp.text();
        let resp_json = null;
        try { resp_json = JSON.parse(text); } catch(_) {}
        if (resp_json && resp_json.success) {
            log('  ✅ Promesa guardada en Fantasma/Postgres');
            return { ok: true, response: text };
        } else {
            log('  ⚠ Fantasma respondió sin success: ' + text.substring(0, 200));
            return { ok: false, error: (resp_json && resp_json.error) || text.substring(0, 200) };
        }
    } catch(e) {
        log('  ❌ Error registrando promesa en Fantasma: ' + e.message);
        return { ok: false, error: e.message };
    }
}

// ═══ CALCULADORA DE CONVENIO ═══
// Reglas LeGaXi v10.2:
//   - Pago semanal MÍNIMO: $500 (nunca menos)
//   - Si saldo/500 ≤ 4 semanas: SIN recargo, pago directo de $500
//   - Si saldo/500 > 4 semanas: aplicar 15% de recargo
//   - Si las semanas resultantes ≤ 104: mantener $500/sem (puede ser 53, 80, 99, etc)
//   - Si pasa de 104 semanas: forzar tope 104 y SUBIR el pago semanal proporcionalmente
// ═══ FECHA AUTOMÁTICA: VIERNES O LUNES PRÓXIMO (el que llegue antes) ═══
function calcularFechaProximoPago() {
    const hoy = new Date();
    const dow = hoy.getDay(); // 0=domingo, 1=lunes, ..., 5=viernes, 6=sábado
    
    // Días restantes hasta el próximo viernes (incluye hoy si es antes de mediodía)
    let diasAViernes;
    if (dow < 5) diasAViernes = 5 - dow;        // antes del viernes
    else if (dow === 5) diasAViernes = 7;       // hoy es viernes, ir al siguiente
    else diasAViernes = 5 + (7 - dow);          // sábado o domingo
    
    // Días restantes hasta el próximo lunes
    let diasALunes;
    if (dow === 0) diasALunes = 1;              // domingo → mañana lunes
    else if (dow === 1) diasALunes = 7;         // hoy es lunes, ir al siguiente
    else diasALunes = (8 - dow) % 7;            // martes a sábado
    
    // Elegir el más cercano
    const dias = Math.min(diasAViernes, diasALunes);
    const fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() + dias);
    
    const yyyy = fecha.getFullYear();
    const mm = String(fecha.getMonth() + 1).padStart(2, '0');
    const dd = String(fecha.getDate()).padStart(2, '0');
    const diaNombre = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][fecha.getDay()];
    
    return {
        iso: `${yyyy}-${mm}-${dd}`,
        diaNombre: diaNombre,
        legible: `${diaNombre} ${dd} de ${['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][fecha.getMonth()]}`
    };
}

function calcularConvenio(saldoOriginal) {
    const saldo = parseFloat(saldoOriginal) || 0;
    if (saldo <= 0) {
        return { error: 'Saldo inválido', saldo };
    }
    
    const PAGO_BASE = 500;
    const RECARGO_PCT = 0.15;
    const SEMANAS_LIMITE_RECARGO = 4;   // hasta 4 semanas NO hay recargo
    const SEMANAS_TOPE_DURO = 104;      // máximo absoluto de semanas
    
    // Paso 1: ¿aplica recargo?
    const semanasSinRecargo = Math.ceil(saldo / PAGO_BASE);
    let aplicaRecargo = false;
    let saldoFinal = saldo;
    
    if (semanasSinRecargo > SEMANAS_LIMITE_RECARGO) {
        aplicaRecargo = true;
        saldoFinal = saldo * (1 + RECARGO_PCT);
    }
    
    // Paso 2: calcular semanas a $500/sem
    let semanas = Math.ceil(saldoFinal / PAGO_BASE);
    let pagoSemanal = PAGO_BASE;
    let topeAplicado = null;
    
    // Paso 3: si pasa de 104 semanas, capar a 104 y SUBIR el pago semanal
    if (semanas > SEMANAS_TOPE_DURO) {
        semanas = SEMANAS_TOPE_DURO;
        pagoSemanal = Math.ceil(saldoFinal / semanas);
        topeAplicado = 'pago_ajustado_al_alza';
    }
    
    return {
        saldo_original: Math.round(saldo * 100) / 100,
        recargo_aplicado: aplicaRecargo,
        recargo_monto: aplicaRecargo ? Math.round((saldoFinal - saldo) * 100) / 100 : 0,
        saldo_total_convenio: Math.round(saldoFinal * 100) / 100,
        semanas: semanas,
        pago_semanal: pagoSemanal,
        tope_aplicado: topeAplicado
    };
}

// ═══ REGISTRAR CONVENIO EN FANTASMA ═══
async function registrarConvenioEnFantasma(datos) {
    if (!FANTASMA_URL || !IVR_API_TOKEN) {
        log('  ⚠ Fantasma no configurado - convenio NO registrado');
        return { ok: false, error: 'sin_fantasma' };
    }
    try {
        const payload = {
            telefono: datos.telefono || '',
            cliente: datos.nombre || '',
            convenio: {
                saldo_original: datos.saldo_original,
                saldo_total: datos.saldo_total,
                semanas: datos.semanas,
                pago_semanal: datos.pago_semanal,
                recargo_aplicado: datos.recargo_aplicado,
                primera_fecha: datos.primera_fecha || '',
                nota: datos.observaciones || '',
                registrado: new Date().toISOString(),
                estado: 'activo',
                cobrador: 'bot_v10'
            }
        };
        const resp = await fetch(FANTASMA_URL + '/api/convenio-bot', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + IVR_API_TOKEN
            },
            body: JSON.stringify(payload)
        });
        const text = await resp.text();
        let resp_json = null;
        try { resp_json = JSON.parse(text); } catch(_) {}
        if (resp_json && resp_json.success) {
            log('  ✅ Convenio guardado en Fantasma/Postgres');
            return { ok: true, response: text };
        } else {
            log('  ⚠ Fantasma respondió sin success: ' + text.substring(0, 200));
            return { ok: false, error: (resp_json && resp_json.error) || text.substring(0, 200) };
        }
    } catch(e) {
        log('  ❌ Error registrando convenio en Fantasma: ' + e.message);
        return { ok: false, error: e.message };
    }
}

// ═══ TOOLS QUE CLAUDE PUEDE LLAMAR ═══
const CLAUDE_TOOLS = [
    {
        name: 'registrar_promesa',
        description: 'Registra una promesa de pago ÚNICO COMPLETO del saldo. Usar SOLO cuando el deudor confirme una fecha específica Y se compromete a pagar el SALDO COMPLETO (o casi completo). NO usar para abonos pequeños, pagos parciales bajos, ni para "voy a ver". Para pagos en parcialidades usa proponer_convenio.',
        input_schema: {
            type: 'object',
            properties: {
                fecha: { type: 'string', description: 'Fecha del pago en formato YYYY-MM-DD. Si el deudor dice "el viernes", calcula la fecha real.' },
                monto: { type: 'number', description: 'Monto en pesos mexicanos (sin símbolo $). Debe ser razonable según el saldo del cliente.' },
                observaciones: { type: 'string', description: 'Contexto relevante: por qué se atrasó, situación del cliente, lugar de pago acordado, etc.' }
            },
            required: ['fecha', 'monto']
        }
    },
    {
        name: 'marcar_equivocado',
        description: 'Marca la llamada como número equivocado. Usar cuando la persona claramente NO conoce al deudor.',
        input_schema: {
            type: 'object',
            properties: {
                detalle: { type: 'string', description: 'Qué dijo la persona' }
            }
        }
    },
    {
        name: 'marcar_no_esta',
        description: 'Marca que el deudor no se encuentra pero hay un tercero que sí lo conoce. Usar cuando familiar/conocido contesta.',
        input_schema: {
            type: 'object',
            properties: {
                quien_contesto: { type: 'string', description: 'Quién contestó: esposa, hijo, vecino, etc.' },
                recado_dejado: { type: 'boolean', description: 'Si se le dejó recado de devolver llamada' }
            }
        }
    },
    {
        name: 'proponer_convenio',
        description: 'PRIMERA ACCIÓN PRINCIPAL del bot: calcula el plan de pagos semanales para proponerlo proactivamente al cliente. ÚSALA SIEMPRE al inicio de la negociación, ANTES de hablar de números al cliente. NO esperes a que el cliente diga que no puede pagar - el plan es la oferta inicial. Esta tool solo CALCULA, no registra. Devuelve: semanas, pago_semanal ($500 mínimo), saldo_total con recargo 15% si aplica.',
        input_schema: {
            type: 'object',
            properties: {
                motivo: { type: 'string', description: 'Contexto de la llamada (ej: oferta inicial, cliente pidió parcialidades, cliente rechazó pago único)' }
            }
        }
    },
    {
        name: 'registrar_convenio',
        description: 'Registra el convenio acordado. Usar APENAS el cliente acepte el plan (diga "sí", "ok", "está bien"). NO preguntes la fecha al cliente - manda "AUTO" en primera_fecha y el sistema la asignará automáticamente al próximo viernes o lunes. El sistema te devolverá el día asignado para que se lo digas al cliente.',
        input_schema: {
            type: 'object',
            properties: {
                semanas: { type: 'number', description: 'Número total de semanas del convenio (lo devuelve proponer_convenio)' },
                pago_semanal: { type: 'number', description: 'Pago semanal en pesos (lo devuelve proponer_convenio)' },
                saldo_total: { type: 'number', description: 'Saldo total del convenio incluyendo recargo si aplica (lo devuelve proponer_convenio)' },
                primera_fecha: { type: 'string', description: 'Manda "AUTO" y el sistema asigna automáticamente próximo viernes o lunes. Solo manda fecha específica YYYY-MM-DD si el cliente PIDIÓ otro día.' },
                observaciones: { type: 'string', description: 'Notas: situación del cliente, etc.' }
            },
            required: ['semanas', 'pago_semanal', 'saldo_total', 'primera_fecha']
        }
    },
    {
        name: 'marcar_rechazo',
        description: 'Marca rechazo definitivo del deudor a pagar o a continuar la llamada.',
        input_schema: {
            type: 'object',
            properties: {
                razon: { type: 'string', description: 'Por qué rechazó: agresivo, dice que no debe, pide no llamar, etc.' }
            }
        }
    },
    {
        name: 'terminar_llamada',
        description: 'Termina la llamada de forma cortés. Usar cuando ya no hay nada que negociar o la conversación se agotó sin acuerdo.',
        input_schema: {
            type: 'object',
            properties: {
                resultado: {
                    type: 'string',
                    enum: ['SIN_ACUERDO', 'CONTACTO_EFECTIVO', 'RECHAZO', 'EQUIVOCADO', 'NO_ESTA', 'PROMESA_OBTENIDA', 'CONVENIO_ACORDADO'],
                    description: 'Resultado final de la llamada'
                },
                resumen: { type: 'string', description: 'Resumen breve de qué pasó en la llamada' }
            },
            required: ['resultado']
        }
    }
];

// ═══ PROMPT DEL SISTEMA (Tono B - cercano y empático) ═══
function construirSystemPrompt(datos) {
    const despacho = datos.despacho || DESPACHO_DEFAULT;
    const acreedor = datos.acreedor || ACREEDOR_DEFAULT;
    const nombre = datos.nombre || 'cliente';
    const saldo = datos.saldo || 'pendiente';
    const diasAtraso = datos.dias_atraso || datos.diasAtraso || 'varios';
    const retorno = datos.telefono_retorno || RETORNO_DEFAULT;
    
    const hoy = new Date();
    const fechaHoy = hoy.toISOString().split('T')[0];
    const diaSemana = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][hoy.getDay()];
    
    return `Eres un agente telefónico de cobranza PROFESIONAL de ${despacho}, despacho que gestiona cuentas para ${acreedor}.

TU PERFIL: Eres un cobrador comercial experimentado. Firme, directo, pero educado. NO eres complaciente ni sumiso. Sabes que tu trabajo es recuperar dinero adeudado, no hacer amistad. Eres como un gerente de cobranza serio: tratas con respeto al cliente pero NO aceptas excusas vagas ni pagos ridículos. Tienes la oferta lista, la presentas con seguridad, y conduces al cliente a aceptarla.

DATOS DEL CLIENTE QUE LLAMAS:
- Nombre: ${nombre}
- Saldo vencido: $${saldo}
- Días de atraso: ${diasAtraso}
- Teléfono de retorno: ${retorno}
- Acreedor: ${acreedor}

CONTEXTO TEMPORAL:
- Hoy es ${diaSemana}, ${fechaHoy}
- Cuando el cliente diga "mañana", "el viernes", "la próxima semana", calcula la fecha real en formato YYYY-MM-DD

═══ TU OBJETIVO ═══
Cerrar HOY un convenio de pagos semanales firme. El plan de $500 a la semana es la MEJOR oferta para el cliente; tu trabajo es venderle esa idea con seguridad.

═══ FLUJO COMERCIAL (USA ESTE ORDEN, NO IMPROVISES) ═══

PASO 1 - Saludo y confirmación de identidad:
"Buenas tardes, ¿hablo con [nombre]?" 
Si dice sí, continúa. Si dice no, usa marcar_no_esta o marcar_equivocado.

PASO 2 - Presentar propuesta DIRECTA (en UN solo turno):
LLAMA proponer_convenio. Cuando te devuelva el plan, dile al cliente con FIRMEZA Y BREVEDAD:
"[nombre], le hablo de ${despacho} por su cuenta de [saldo] pesos con ${acreedor}. Le propongo pagar quinientos pesos semanales por [X] semanas. Al final paga [saldo_total] con quince por ciento de reestructura. ¿Le funciona?"

NO menciones días de atraso, NO digas "es la mejor opción", NO te extiendas. Directo al precio y plazo.

Si el saldo es grande y pago semanal > $500:
"[nombre], le hablo por su cuenta de [saldo] con ${acreedor}. Le propongo [pago_semanal] pesos semanales por 104 semanas, incluye quince por ciento de reestructura. ¿Le funciona?"

PASO 3 - Manejo de la respuesta:

Si ACEPTA ("sí", "ok", "está bien", "le entro") → ve INMEDIATO al PASO 4. NO confirmes otra vez. NO repitas el plan. NO digas "voy a registrar".

Si DUDA o pone excusas leves ("no sé", "está fuerte"):
INSISTE breve:
"[nombre], quinientos pesos a la semana es accesible. ¿Empezamos esta semana?"

Si propone PAGOS MENORES a $500/sem:
RECHAZA breve:
"No [nombre], el mínimo es quinientos. ¿Le acomoda?"

Si propone PAGO ÚNICO bajo (abono suelto):
RECHAZA y reproponer:
"Para abonos sueltos no le conviene. Mejor el plan semanal. ¿Le funciona?"

Si propone pagar TODO el saldo en fecha cercana:
ACEPTA y usa registrar_promesa con esa fecha y el monto total. Esto es PROMESA, no convenio.

Si rechaza DEFINITIVAMENTE:
Última oportunidad breve:
"[nombre], ¿realmente no hay manera de empezar con quinientos esta semana?"
Si sigue negando:
"Entiendo. Comuníquese al ${retorno} si cambia de opinión."
Llama terminar_llamada con SIN_ACUERDO.

PASO 4 - Cierre INMEDIATO cuando dice SÍ:
EN EL MISMO TURNO:
1. Llama registrar_convenio con primera_fecha="AUTO"
2. Di: "Perfecto [nombre], su convenio quedó registrado. Le esperamos su primer pago de quinientos pesos el [día asignado]. Que tenga buen día."
3. Llama terminar_llamada con CONVENIO_ACORDADO

NO hagas "¿está de acuerdo?" otra vez. NO preguntes fecha. NO digas "voy a registrar". Solo registra, agradece y cierra. TODO EN UN SOLO TURNO.

PASO 5 - Si cliente pide CAMBIAR fecha:
Solo si dice "no, mejor el martes": pregunta "¿Qué día?"
Cuando dé fecha, registra y cierra.

═══ REGLAS ABSOLUTAS - NO LAS VIOLES ═══

1. NUNCA aceptes pagos semanales por debajo de $500. Es el mínimo establecido.
2. NUNCA aceptes promesas vagas tipo "veo, te aviso, mañana te llamo". Insiste en un compromiso concreto.
3. NUNCA seas sumiso. Eres profesional pero firme. Tu propuesta es la mejor, defiéndela.
4. NUNCA digas "está bien" a una mala oferta del cliente solo por cerrar la llamada. Prefiere SIN_ACUERDO antes que un mal convenio.
5. NUNCA inventes números. SIEMPRE usa proponer_convenio para calcular. El sistema aplica las reglas (recargo 15%, mínimo $500/sem, máximo 104 semanas).
6. NUNCA prometas descuentos, condonaciones ni quitas.
7. NUNCA amenaces con buró, demanda o embargo. No es necesario y es contraproducente.
8. Si contesta alguien que NO es el cliente, deja recado: "Hablo de ${despacho}, dígale que se comunique al ${retorno}, es importante". Usa marcar_no_esta.
9. Si es número equivocado claro, despídete y usa marcar_equivocado.
10. Si el cliente dice "ya pagué", agradece y di que se va a verificar. No discutas.
11. Si se pone agresivo, despídete cortés y usa marcar_rechazo. No te enganches en pelea.

═══ FORMA DE HABLAR - DINÁMICA DE COBRANZA REAL ═══

- Frases MUY CORTAS, máximo 15 palabras. Cobranza es directa, no es plática.
- Trata de "usted".
- Montos en palabras claras: "quinientos pesos", "veintiocho mil pesos".
- NO uses markdown, asteriscos, listas. Esto se convierte a voz.
- Di nombres tal cual: "Credia" no "C R E D I A".
- Usa el nombre del cliente máximo 1-2 veces por turno (no en cada frase).
- NO seas pesado: si cliente confirmó algo, NO lo repitas todo otra vez ("entonces queda en pagar..."). Solo registra y cierra.
- NO digas "voy a registrar su convenio ahora" antes de hacerlo. Hazlo y di el resultado.
- NO uses dos turnos para confirmar lo mismo. Un turno = una acción + una pregunta concreta.

REGLA DE ORO DE VELOCIDAD:
Cliente dice "sí/ok/está bien/de acuerdo" al convenio → INMEDIATAMENTE llamas a registrar_convenio en el MISMO turno, y dices el cierre. NO preguntas "¿está de acuerdo?" otra vez. NO preguntas la fecha. SOLO registra y cierra.

EJEMPLO DEL FLUJO IDEAL EN 3 TURNOS (NO MÁS):
Turno 1:
  Cliente: "Sí soy Juan"
  Bot: [llama proponer_convenio] "Le hablo de Legaxi por su cuenta de veinticinco mil con Credia. Le propongo quinientos pesos semanales por cincuenta y ocho semanas, total veintiocho mil setecientos cincuenta con quince por ciento de reestructura. ¿Le funciona?"

Turno 2:
  Cliente: "Sí está bien"
  Bot: [llama registrar_convenio AUTO] "Perfecto Juan, su convenio quedó registrado. Le esperamos su primer pago de quinientos pesos el viernes veintinueve de mayo. Que tenga buen día." [llama terminar_llamada]

Eso es todo. 2 turnos + saludo = 3 intercambios. Si vas a más de 4 turnos, es que estás dando vueltas. CORRIGE.

═══ TOOLS - CUÁNDO USARLAS ═══

- proponer_convenio: ÚSALA AL INICIO en cuanto se confirme identidad. NO inventes cálculos.
- registrar_convenio: APENAS cliente acepte el plan. Manda primera_fecha="AUTO". NO preguntes fecha.
- registrar_promesa: SOLO si cliente promete pagar TODO el saldo en fecha concreta cercana.
- marcar_no_esta: tercero que conoce al cliente, dejas recado.
- marcar_equivocado: persona NO conoce al cliente.
- marcar_rechazo: cliente agresivo o pide no llamar.
- terminar_llamada: SIEMPRE al final con el resultado correcto.

Recuerda: eres COBRADOR PROFESIONAL Y RÁPIDO. Cierra el convenio en 2 turnos. Habla CORTO. Defiende tu propuesta con seguridad.`;
}

// ═══ LLAMAR A CLAUDE PARA UN TURNO ═══
async function consultarClaude(systemPrompt, historial) {
    const t0 = Date.now();
    try {
        const resp = await claude.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system: systemPrompt,
            tools: CLAUDE_TOOLS,
            messages: historial
        });
        const ms = Date.now() - t0;
        log('  🧠 Claude respondió en ' + ms + 'ms (stop: ' + resp.stop_reason + ')');
        return resp;
    } catch(e) {
        log('  ❌ Error Claude API: ' + e.message);
        return null;
    }
}

const reporteLote = {
    activo: false,
    loteId: null,
    despacho: null,
    inicioEn: null,
    resultados: []
};

function registrarEnReporte(resultado) {
    if (!reporteLote.activo) return;
    reporteLote.resultados.push(resultado);
}

// ═══════════════════════════════════════════════════════════════
// SERVIDOR AUDIOSOCKET (corazón del bot)
// ═══════════════════════════════════════════════════════════════
const audioServer = net.createServer(async (socket) => {
    try {
        const peer = socket.remoteAddress + ':' + socket.remotePort;
        incLlamadas();
        log('═════════════════════════════════════════');
        log('NUEVA LLAMADA desde ' + peer + ' (activas: ' + llamadasActivas + '/' + MAX_CONCURRENTES + ')');
        log('═════════════════════════════════════════');

        const datosLlamada = tomarMasReciente();
        if (datosLlamada) {
            log('  📋 ' + datosLlamada.nombre + ' (' + datosLlamada.telefono + ') | saldo: $' + (datosLlamada.saldo || '?'));
        } else {
            log('  ⚠ Sin datos de cliente (cola vacía)');
        }

        let buffer = Buffer.alloc(0);
        let uuid = null;
        let escuchando = false;
        let yaTerminado = false;
        let turnoActual = 0;
        let lastPartial = '';
        let lastNewTextTime = 0;
        let silenceFramesActual = 0;
        let speechFrames = 0;
        let timeoutEscucha = null;
        let stallChecker = null;
        let timeoutGlobal = null;
        const llamadaInicio = Date.now();
        const historial = [];  // mensajes para Claude: {role, content}
        let resultadoFinal = null;
        let promesaCapturada = null;
        let convenioCapturado = null;
        let convenioPropuesto = null;  // se guarda lo que devolvió proponer_convenio
        let resumenFinal = '';

        let rec = new vosk.Recognizer({ model: voskModel, sampleRate: SAMPLE_RATE });

        const systemPrompt = construirSystemPrompt(datosLlamada || {});

        // Timeout global de seguridad
        timeoutGlobal = setTimeout(() => {
            if (!yaTerminado) {
                log('  ⏰ TIMEOUT GLOBAL (3min) - cerrando');
                cerrarLlamada('TIMEOUT', 'Llamada excedió tiempo máximo');
            }
        }, TIEMPO_MAX_LLAMADA_MS);

        async function reproducirAudio(pcm) {
            const frames = Math.ceil(pcm.length / FRAME_SIZE);
            const start = Date.now();
            for (let i = 0; i < frames; i++) {
                if (socket.destroyed) return false;
                let f = pcm.slice(i*FRAME_SIZE, (i+1)*FRAME_SIZE);
                if (f.length < FRAME_SIZE) { const p = Buffer.alloc(FRAME_SIZE); f.copy(p); f = p; }
                try { socket.write(buildMsg(KIND_AUDIO, f)); } catch(_) { return false; }
                const wait = Math.max(0, start + (i+1)*20 - Date.now());
                await new Promise(r => setTimeout(r, wait));
            }
            return true;
        }

        async function cerrarLlamada(resultado, resumen) {
            if (yaTerminado) return;
            yaTerminado = true;
            escuchando = false;
            resultadoFinal = resultado;
            resumenFinal = resumen || '';

            if (timeoutEscucha) clearTimeout(timeoutEscucha);
            if (stallChecker) clearInterval(stallChecker);
            if (timeoutGlobal) clearTimeout(timeoutGlobal);

            const duracion = Math.round((Date.now() - llamadaInicio) / 1000);

            log('  ╔════════════════════════════════════════');
            log('  ║ LLAMADA TERMINADA');
            log('  ║ Resultado: ' + resultado);
            log('  ║ Turnos: ' + turnoActual);
            log('  ║ Duración: ' + duracion + 's');
            log('  ║ Resumen: ' + resumen);
            if (promesaCapturada) {
                log('  ║ PROMESA: $' + promesaCapturada.monto + ' el ' + promesaCapturada.fecha);
            }
            if (convenioCapturado) {
                log('  ║ CONVENIO: ' + convenioCapturado.semanas + ' semanas x $' + convenioCapturado.pago_semanal + ' = $' + convenioCapturado.saldo_total);
            }
            log('  ╚════════════════════════════════════════');

            // Reportar a Fantasma
            if (datosLlamada) {
                const reporte = {
                    telefono: datosLlamada.telefono,
                    cliente: datosLlamada.nombre,
                    bot: true,
                    version: 'v10',
                    categoria: resultado,
                    duration: duracion,
                    turnos: turnoActual,
                    resumen: resumen,
                    historial_conversacion: historial.map(m => ({
                        role: m.role,
                        texto: typeof m.content === 'string' ? m.content :
                               (m.content.find(c => c.type === 'text')?.text || '')
                    })),
                    promesa: promesaCapturada,
                    convenio: convenioCapturado,
                    fecha: new Date().toISOString()
                };
                reportarResultado(reporte);
                registrarEnReporte({
                    telefono: datosLlamada.telefono,
                    nombre: datosLlamada.nombre || '',
                    saldo: datosLlamada.saldo || '',
                    categoria: resultado,
                    duracion,
                    turnos: turnoActual,
                    promesa: promesaCapturada,
                    convenio: convenioCapturado,
                    fecha: new Date().toISOString()
                });
            }

            // Cerrar socket limpio
            setTimeout(() => {
                try {
                    socket.write(buildMsg(KIND_HANGUP, Buffer.alloc(0)));
                    setTimeout(() => { try { socket.end(); } catch(_){} }, 200);
                } catch(_) {}
            }, 400);
        }

        async function ejecutarTool(toolUse) {
            const { name, input } = toolUse;
            log('  🔧 Tool: ' + name + ' | input: ' + JSON.stringify(input).substring(0, 200));

            switch(name) {
                case 'registrar_promesa': {
                    promesaCapturada = {
                        fecha: input.fecha,
                        monto: input.monto,
                        observaciones: input.observaciones || ''
                    };
                    if (datosLlamada) {
                        const r = await registrarPromesaEnFantasma({
                            telefono: datosLlamada.telefono,
                            nombre: datosLlamada.nombre,
                            ...promesaCapturada
                        });
                        return { ok: r.ok, mensaje: r.ok ? 'Promesa registrada exitosamente' : 'Error: ' + r.error };
                    }
                    return { ok: true, mensaje: 'Promesa capturada (sin datos cliente para enviar a sheet)' };
                }
                case 'proponer_convenio': {
                    // Solo CALCULA, no registra. Devuelve el plan a Claude para que lo proponga al cliente.
                    if (!datosLlamada || !datosLlamada.saldo) {
                        return { ok: false, mensaje: 'No hay saldo disponible para calcular convenio. Pregunta al cliente cuánto puede pagar a la semana.' };
                    }
                    const plan = calcularConvenio(datosLlamada.saldo);
                    if (plan.error) {
                        return { ok: false, mensaje: 'Error calculando: ' + plan.error };
                    }
                    convenioPropuesto = plan;
                    log('  📋 Convenio propuesto: ' + plan.semanas + ' sem x $' + plan.pago_semanal + 
                        ' (saldo ' + plan.saldo_original + ' → total ' + plan.saldo_total_convenio + 
                        (plan.recargo_aplicado ? ' con recargo 15%' : ' sin recargo') + ')');
                    return {
                        ok: true,
                        mensaje: 'Plan calculado. Propónselo al cliente con voz natural.',
                        plan: {
                            saldo_original: plan.saldo_original,
                            saldo_total_convenio: plan.saldo_total_convenio,
                            recargo_aplicado: plan.recargo_aplicado,
                            recargo_monto: plan.recargo_monto,
                            semanas: plan.semanas,
                            pago_semanal: plan.pago_semanal,
                            tope_aplicado: plan.tope_aplicado
                        }
                    };
                }
                case 'registrar_convenio': {
                    // v10.4: si Claude manda "AUTO" o vacío, el sistema calcula viernes/lunes próximo
                    let fechaUsar = input.primera_fecha;
                    let diaLegible = '';
                    if (!fechaUsar || fechaUsar === 'AUTO' || fechaUsar === 'auto' || fechaUsar.length < 8) {
                        const auto = calcularFechaProximoPago();
                        fechaUsar = auto.iso;
                        diaLegible = auto.diaNombre;
                        log('  📅 Fecha automática asignada: ' + auto.legible + ' (' + auto.iso + ')');
                    } else {
                        // Si Claude mandó fecha específica, intentar obtener día de la semana
                        try {
                            const d = new Date(fechaUsar + 'T12:00:00');
                            diaLegible = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][d.getDay()];
                        } catch(_) {}
                    }
                    
                    convenioCapturado = {
                        semanas: input.semanas,
                        pago_semanal: input.pago_semanal,
                        saldo_total: input.saldo_total,
                        primera_fecha: fechaUsar,
                        dia_primera_fecha: diaLegible,
                        observaciones: input.observaciones || ''
                    };
                    if (datosLlamada) {
                        const saldoOrig = parseFloat(datosLlamada.saldo) || 0;
                        const r = await registrarConvenioEnFantasma({
                            telefono: datosLlamada.telefono,
                            nombre: datosLlamada.nombre,
                            saldo_original: saldoOrig,
                            saldo_total: input.saldo_total,
                            semanas: input.semanas,
                            pago_semanal: input.pago_semanal,
                            recargo_aplicado: (input.saldo_total > saldoOrig),
                            primera_fecha: fechaUsar,
                            observaciones: input.observaciones || ''
                        });
                        return { 
                            ok: r.ok, 
                            mensaje: r.ok ? 'Convenio registrado exitosamente' : 'Error: ' + r.error,
                            primera_fecha_asignada: fechaUsar,
                            dia_primera_fecha: diaLegible
                        };
                    }
                    return { ok: true, mensaje: 'Convenio capturado', primera_fecha_asignada: fechaUsar, dia_primera_fecha: diaLegible };
                }
                case 'marcar_equivocado':
                    resultadoFinal = 'EQUIVOCADO';
                    return { ok: true, mensaje: 'Marcado como número equivocado' };
                case 'marcar_no_esta':
                    resultadoFinal = 'NO_ESTA';
                    return { ok: true, mensaje: 'Marcado: ' + (input.quien_contesto || 'tercero') };
                case 'marcar_rechazo':
                    resultadoFinal = 'RECHAZO';
                    return { ok: true, mensaje: 'Rechazo registrado' };
                case 'terminar_llamada':
                    // v10.7: si Claude se cortó por max_tokens y llama terminar_llamada sin
                    // haber dicho el cierre, reproducir un cierre de emergencia para no colgar mudo
                    resultadoFinal = input.resultado || resultadoFinal || 'TERMINADO';
                    resumenFinal = input.resumen || resumenFinal || '';
                    
                    // Detectar si hubo cierre hablado en este turno
                    // (revisamos el historial: el último assistant message debe tener texto significativo)
                    const ultimoAssistant = [...historial].reverse().find(m => m.role === 'assistant');
                    let huboTextoEnCierre = false;
                    if (ultimoAssistant) {
                        const txt = typeof ultimoAssistant.content === 'string' 
                            ? ultimoAssistant.content 
                            : (Array.isArray(ultimoAssistant.content) 
                                ? ultimoAssistant.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
                                : '');
                        // Considerar "cierre" si dijo más de 30 caracteres en su último turno
                        if (txt && txt.trim().length > 30) huboTextoEnCierre = true;
                    }
                    
                    if (!huboTextoEnCierre) {
                        // Generar cierre de emergencia según el resultado
                        let cierreEmergencia;
                        const nombre = datosLlamada && datosLlamada.nombre ? nombreCorto(datosLlamada.nombre) : '';
                        const saludoNombre = nombre ? nombre + ', ' : '';
                        
                        if (resultadoFinal === 'CONVENIO_ACORDADO' && convenioCapturado) {
                            const dia = convenioCapturado.dia_primera_fecha || 'viernes';
                            cierreEmergencia = `Perfecto ${saludoNombre}su convenio quedó registrado. Le esperamos su primer pago de quinientos pesos el ${dia}. Que tenga buen día.`;
                        } else if (resultadoFinal === 'PROMESA_OBTENIDA') {
                            cierreEmergencia = `Perfecto ${saludoNombre}su compromiso quedó registrado. Que tenga buen día.`;
                        } else if (resultadoFinal === 'SIN_ACUERDO') {
                            cierreEmergencia = `Entiendo ${saludoNombre}. Comuníquese al ${(datosLlamada && datosLlamada.telefono_retorno) || RETORNO_DEFAULT} cuando pueda regularizar. Que tenga buen día.`;
                        } else if (resultadoFinal === 'EQUIVOCADO') {
                            cierreEmergencia = `Disculpe la molestia. Que tenga buen día.`;
                        } else if (resultadoFinal === 'NO_ESTA') {
                            cierreEmergencia = `Le agradezco. Por favor dele el recado. Que tenga buen día.`;
                        } else if (resultadoFinal === 'RECHAZO') {
                            cierreEmergencia = `Entiendo. Que tenga buen día.`;
                        } else {
                            cierreEmergencia = `Le agradezco. Que tenga buen día.`;
                        }
                        
                        log('  ⚠ Claude no dijo cierre (max_tokens?). Reproduciendo cierre de emergencia.');
                        try {
                            const pcm = await generarAudioFresco(cierreEmergencia);
                            await reproducirAudio(pcm);
                        } catch(e) {
                            log('  ❌ Error en cierre emergencia: ' + e.message);
                        }
                    }
                    
                    return { ok: true, mensaje: 'Listo para cerrar', terminar: true };
                default:
                    return { ok: false, mensaje: 'Tool desconocida' };
            }
        }

        async function turnoConversacional(textoCliente) {
            if (yaTerminado) return;
            turnoActual++;

            if (turnoActual > MAX_TURNOS) {
                log('  ⚠ MAX_TURNOS alcanzado - forzando cierre');
                const cierre = 'Le agradezco su tiempo. Que tenga buen día.';
                try {
                    const pcm = await generarAudioFresco(cierre);
                    await reproducirAudio(pcm);
                } catch(e) { log('  ⚠ Error cierre forzado: ' + e.message); }
                return cerrarLlamada('MAX_TURNOS', 'Conversación excedió turnos máximos');
            }

            log('  ─── TURNO ' + turnoActual + ' ───');
            log('  👤 Cliente dijo: "' + textoCliente + '"');

            // Agregar al historial
            historial.push({ role: 'user', content: textoCliente || '(silencio)' });

            // v10.4: Solo metemos puente si Claude tarda más de 800ms
            // Esto evita pausas innecesarias en respuestas rápidas (sí/no)
            const claudeStart = Date.now();
            let puenteIniciado = false;
            const puenteTimer = setTimeout(async () => {
                if (yaTerminado) return;
                puenteIniciado = true;
                try {
                    const pcm = await obtenerPuenteRandom();
                    if (!yaTerminado) await reproducirAudio(pcm);
                } catch(_) {}
            }, 800);
            
            // Llamar a Claude
            const respClaude = await consultarClaude(systemPrompt, historial);
            const claudeMs = Date.now() - claudeStart;
            
            // Si Claude respondió rápido (<800ms), cancela el puente antes de que se reproduzca
            if (!puenteIniciado) {
                clearTimeout(puenteTimer);
            }

            if (!respClaude) {
                log('  ⚠ Claude no respondió - cerrando llamada');
                try {
                    const pcm = await generarAudioFresco('Disculpe, tuvimos un problema técnico. Por favor llámenos al ' + RETORNO_DEFAULT.replace(/\s/g,' ') + '. Gracias.');
                    await reproducirAudio(pcm);
                } catch(e){}
                return cerrarLlamada('ERROR_CLAUDE', 'Falla en Claude API');
            }

            // Procesar respuesta de Claude
            const textoRespuesta = respClaude.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join(' ')
                .trim();

            const toolUses = respClaude.content.filter(b => b.type === 'tool_use');

            // Si hay texto, reproducir
            if (textoRespuesta) {
                log('  🤖 Bot dice: "' + textoRespuesta + '"');
                try {
                    const pcm = await generarAudioFresco(textoRespuesta);
                    const ok = await reproducirAudio(pcm);
                    if (!ok) {
                        log('  ⚠ Cliente colgó durante respuesta');
                        return cerrarLlamada('COLGO', 'Cliente colgó');
                    }
                } catch(e) {
                    log('  ❌ Error generando audio respuesta: ' + e.message);
                }
            }

            // Procesar tools
            let debeTerminar = false;
            let huboTools = false;
            if (toolUses.length > 0) {
                huboTools = true;
                // Agregar el assistant message completo al historial
                historial.push({ role: 'assistant', content: respClaude.content });

                const toolResults = [];
                for (const tu of toolUses) {
                    const result = await ejecutarTool(tu);
                    if (result.terminar) debeTerminar = true;
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tu.id,
                        content: JSON.stringify(result)
                    });
                }
                historial.push({ role: 'user', content: toolResults });

                // Si la tool fue terminar_llamada o marcar_equivocado, cerrar ya
                if (debeTerminar || resultadoFinal === 'EQUIVOCADO' || resultadoFinal === 'RECHAZO') {
                    return cerrarLlamada(resultadoFinal || 'TERMINADO', resumenFinal);
                }
            } else {
                // Solo texto, agregar al historial
                historial.push({ role: 'assistant', content: textoRespuesta });
            }

            if (yaTerminado) return;

            // v10.6 FIX: si Claude llamó tool SIN decir texto al cliente, NO abrir escucha.
            // Llamar a Claude inmediatamente otra vez para que continúe en el mismo turno.
            // Esto evita 6+ segundos de silencio incómodo después de cada tool_use.
            if (huboTools && !textoRespuesta && turnoActual <= MAX_TURNOS) {
                log('  ⚡ Tool sin texto → continuando inmediatamente sin esperar al cliente');
                // Re-llamar a Claude con el historial actualizado (que ya tiene el tool_result)
                const respClaude2 = await consultarClaude(systemPrompt, historial);
                if (!respClaude2) {
                    log('  ⚠ Claude no respondió en continuación');
                    return reiniciarEscucha();
                }
                
                const texto2 = respClaude2.content
                    .filter(b => b.type === 'text')
                    .map(b => b.text)
                    .join(' ')
                    .trim();
                const tools2 = respClaude2.content.filter(b => b.type === 'tool_use');
                
                if (texto2) {
                    log('  🤖 Bot dice: "' + texto2 + '"');
                    try {
                        const pcm = await generarAudioFresco(texto2);
                        const ok = await reproducirAudio(pcm);
                        if (!ok) return cerrarLlamada('COLGO', 'Cliente colgó');
                    } catch(e) { log('  ❌ Error audio cont: ' + e.message); }
                }
                
                if (tools2.length > 0) {
                    historial.push({ role: 'assistant', content: respClaude2.content });
                    const toolResults2 = [];
                    let terminar2 = false;
                    for (const tu of tools2) {
                        const result = await ejecutarTool(tu);
                        if (result.terminar) terminar2 = true;
                        toolResults2.push({
                            type: 'tool_result',
                            tool_use_id: tu.id,
                            content: JSON.stringify(result)
                        });
                    }
                    historial.push({ role: 'user', content: toolResults2 });
                    if (terminar2 || resultadoFinal === 'EQUIVOCADO' || resultadoFinal === 'RECHAZO') {
                        return cerrarLlamada(resultadoFinal || 'TERMINADO', resumenFinal);
                    }
                } else if (texto2) {
                    historial.push({ role: 'assistant', content: texto2 });
                }
                
                if (yaTerminado) return;
            }
            
            reiniciarEscucha();
        }

        function reiniciarEscucha() {
            if (yaTerminado) return;
            try { rec.free(); } catch(e){}
            rec = new vosk.Recognizer({ model: voskModel, sampleRate: SAMPLE_RATE });
            lastPartial = '';
            silenceFramesActual = 0;
            speechFrames = 0;
            lastNewTextTime = Date.now();
            escuchando = true;
            if (timeoutEscucha) clearTimeout(timeoutEscucha);
            timeoutEscucha = setTimeout(() => {
                if (!escuchando || yaTerminado) return;
                log('  ⏰ Timeout escucha turno ' + turnoActual);
                escuchando = false;
                turnoConversacional('').catch(e => log('  ❌ Error turno: ' + e.message));
            }, MAX_LISTEN_MS);
        }

        function procesarAudioCliente(payload) {
            if (yaTerminado || !escuchando) return;
            try {
                const rms = calcularRMS(payload);
                if (rms < SILENCE_THRESHOLD) {
                    silenceFramesActual++;
                } else {
                    silenceFramesActual = 0;
                    speechFrames++;
                }
                const isFinal = rec.acceptWaveform(payload);
                if (isFinal) {
                    const r = rec.result();
                    if (r && r.text && r.text !== lastPartial) {
                        lastPartial = r.text;
                        lastNewTextTime = Date.now();
                        log('  ✅ Vosk: "' + r.text + '"');
                    }
                } else {
                    const pr = rec.partialResult();
                    if (pr && pr.partial && pr.partial !== lastPartial && pr.partial.length > 0) {
                        lastPartial = pr.partial;
                        lastNewTextTime = Date.now();
                    }
                }
                const silenceMs = silenceFramesActual * 20;
                const speechMs = speechFrames * 20;
                if (silenceMs >= SILENCE_MS && speechMs >= MIN_SPEECH_MS) {
                    escuchando = false;
                    const textoFinal = rec.finalResult();
                    const usable = (textoFinal && textoFinal.text) ? textoFinal.text : lastPartial;
                    turnoConversacional(usable).catch(e => log('  ❌ Error turno: ' + e.message));
                }
            } catch(e) {
                log('  ❌ Error procesando audio: ' + e.message);
            }
        }

        socket.on('data', async (chunk) => {
            try {
                buffer = Buffer.concat([buffer, chunk]);
                while (buffer.length >= 3) {
                    const kind = buffer.readUInt8(0);
                    const len = buffer.readUInt16BE(1);
                    if (buffer.length < 3 + len) break;
                    const payload = buffer.slice(3, 3 + len);
                    buffer = buffer.slice(3 + len);

                    if (kind === KIND_UUID) {
                        uuid = payload.toString('hex');
                        log('  UUID: ' + uuid.substring(0, 8));

                        setTimeout(async () => {
                            try {
                                if (socket.destroyed) return;
                                const saludo = construirSaludo(datosLlamada || {});
                                log('  🤖 Saludo: "' + saludo + '"');
                                const pcm = await obtenerAudioCacheado(saludo, 'sal', SALUDOS_DIR);
                                const ok = await reproducirAudio(pcm);
                                if (!ok) {
                                    log('  ⚠ Cliente colgó durante saludo');
                                    return cerrarLlamada('COLGO_INICIO', 'Cliente colgó en saludo');
                                }
                                // Iniciar escucha
                                historial.push({ role: 'assistant', content: saludo });
                                log('  Activando escucha STT (turno 1)...');
                                reiniciarEscucha();
                                stallChecker = setInterval(() => {
                                    if (!escuchando || yaTerminado) return;
                                    const stalledMs = Date.now() - lastNewTextTime;
                                    const speechMs = speechFrames * 20;
                                    if (stalledMs >= STALL_MS && lastPartial.length > 0 && speechMs >= MIN_SPEECH_MS) {
                                        log('  STALL ' + stalledMs + 'ms');
                                        escuchando = false;
                                        const textoFinal = rec.finalResult();
                                        const usable = (textoFinal && textoFinal.text) ? textoFinal.text : lastPartial;
                                        turnoConversacional(usable).catch(e => log('  ❌ Error turno stall: ' + e.message));
                                    }
                                }, 250);
                            } catch(e) {
                                log('  ❌ ERROR en saludo: ' + e.message);
                                try { socket.end(); } catch(_) {}
                            }
                        }, 500);
                    }
                    else if (kind === KIND_AUDIO && escuchando) procesarAudioCliente(payload);
                    else if (kind === KIND_HANGUP) {
                        log('  HANGUP cliente');
                        if (!yaTerminado) cerrarLlamada('COLGO', 'Cliente colgó');
                    }
                }
            } catch(e) {
                log('  ❌ Error data: ' + e.message);
            }
        });

        socket.on('close', () => {
            try { rec.free(); } catch(e){}
            if (stallChecker) clearInterval(stallChecker);
            if (timeoutEscucha) clearTimeout(timeoutEscucha);
            if (timeoutGlobal) clearTimeout(timeoutGlobal);
            if (!yaTerminado) cerrarLlamada('SOCKET_CLOSE', 'Socket cerrado sin terminar limpio');
            decLlamadas();
            log('CONEXION CERRADA (activas: ' + llamadasActivas + '/' + MAX_CONCURRENTES + ')\n');
        });
        socket.on('error', e => log('  ⚠ Socket err: ' + e.message));
    } catch(globalErr) {
        log('  💥 ERROR GLOBAL en conexión: ' + globalErr.message);
        decLlamadas();
        try { socket.end(); } catch(_) {}
    }
});

audioServer.listen(AUDIOSOCKET_PORT, '0.0.0.0', async () => {
    console.log('═════════════════════════════════════════');
    console.log('  LeGaXi Voice Bot v10.8 - Claude Agent');
    console.log('═════════════════════════════════════════');
    console.log('  AudioSocket TCP: 0.0.0.0:' + AUDIOSOCKET_PORT);
    console.log('  HTTP API:        0.0.0.0:' + HTTP_API_PORT);
    console.log('  Voz TTS:         ' + TTS_VOICE);
    console.log('  Despacho:        ' + DESPACHO_DEFAULT);
    console.log('  Modelo IA:       claude-haiku-4-5');
    console.log('  Max turnos:      ' + MAX_TURNOS);
    console.log('  Max concurrentes:' + MAX_CONCURRENTES + ' (configurable con MAX_CONCURRENTES en .env)');
    console.log('  Fantasma:        ' + FANTASMA_URL);
    console.log('  Promesas:        Fantasma/Postgres ✓');
    console.log('═════════════════════════════════════════\n');
    await precalentarPuentes();
});

audioServer.on('error', e => log('💥 audioServer error: ' + e.message));

// ═══════════════════════════════════════════════════════════════
// HTTP API
// ═══════════════════════════════════════════════════════════════
const httpServer = http.createServer(async (req, res) => {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        if (req.url === '/health' || req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                version: '10.8',
                modelo_ia: 'claude-haiku-4-5',
                voz: TTS_VOICE,
                llamadasEnCola: colaFIFO.length,
                llamadasPorTel: llamadasPorTelefono.size,
                llamadasActivas: getLlamadasActivas(),
                maxConcurrentes: MAX_CONCURRENTES,
                slotsLibres: Math.max(0, MAX_CONCURRENTES - getLlamadasActivas()),
                saturado: getLlamadasActivas() >= MAX_CONCURRENTES,
                loteActivo: reporteLote.activo,
                loteResultados: reporteLote.resultados.length,
                ttsEnVuelo,
                ttsEnEspera: ttsCola.length,
                claude_ok: !!ANTHROPIC_API_KEY,
                promesas_destino: 'fantasma_postgres',
                uptime: Math.floor(process.uptime())
            }));
            return;
        }

        if (req.url === '/api/lote/iniciar' && req.method === 'POST') {
            const auth = req.headers.authorization || '';
            if (auth.replace(/^Bearer\s+/i, '') !== API_TOKEN_LOCAL) {
                res.writeHead(401); res.end(JSON.stringify({error:'Token inválido'})); return;
            }
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const { loteId, despacho } = JSON.parse(body);
                    reporteLote.activo = true;
                    reporteLote.loteId = loteId || ('lote_' + Date.now());
                    reporteLote.despacho = despacho || DESPACHO_DEFAULT;
                    reporteLote.inicioEn = new Date().toISOString();
                    reporteLote.resultados = [];
                    log('🚀 LOTE INICIADO: ' + reporteLote.loteId);
                    res.writeHead(200, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({success:true, loteId: reporteLote.loteId}));
                } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:e.message})); }
            });
            return;
        }

        if (req.url === '/api/lote/cerrar' && req.method === 'POST') {
            const auth = req.headers.authorization || '';
            if (auth.replace(/^Bearer\s+/i, '') !== API_TOKEN_LOCAL) {
                res.writeHead(401); res.end(JSON.stringify({error:'Token inválido'})); return;
            }
            const reporte = {
                loteId: reporteLote.loteId,
                despacho: reporteLote.despacho,
                inicioEn: reporteLote.inicioEn,
                cierreEn: new Date().toISOString(),
                totalLlamadas: reporteLote.resultados.length,
                promesasObtenidas: reporteLote.resultados.filter(r => r.promesa).length,
                resultados: reporteLote.resultados
            };
            reporteLote.activo = false;
            log('🏁 LOTE CERRADO: ' + reporte.totalLlamadas + ' llamadas, ' + reporte.promesasObtenidas + ' promesas');
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify(reporte));
            return;
        }

        if (req.url === '/api/capacidad' && req.method === 'GET') {
            // v10.8: endpoint para que Fantasma consulte si puede mandar más llamadas
            const activas = getLlamadasActivas();
            const enCola = colaFIFO.length;
            const slotsLibres = Math.max(0, MAX_CONCURRENTES - activas);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                max_concurrentes: MAX_CONCURRENTES,
                activas: activas,
                en_cola: enCola,
                slots_libres: slotsLibres,
                saturado: slotsLibres === 0
            }));
            return;
        }

        if (req.url === '/api/llamar-bot' && req.method === 'POST') {
            const auth = req.headers.authorization || '';
            if (auth.replace(/^Bearer\s+/i, '') !== API_TOKEN_LOCAL) {
                res.writeHead(401); res.end(JSON.stringify({error:'Token inválido'})); return;
            }
            
            // v10.8: rechazar si está saturado
            const activas = getLlamadasActivas();
            const enCola = colaFIFO.length;
            const totalPendiente = activas + enCola;
            if (totalPendiente >= MAX_CONCURRENTES) {
                log('🚦 RECHAZADA por saturación (activas: ' + activas + ', cola: ' + enCola + ' / max: ' + MAX_CONCURRENTES + ')');
                res.writeHead(429, {'Content-Type':'application/json'});
                res.end(JSON.stringify({
                    success: false,
                    error: 'Bot saturado',
                    saturado: true,
                    activas: activas,
                    en_cola: enCola,
                    max_concurrentes: MAX_CONCURRENTES,
                    reintentar_en_segundos: 30
                }));
                return;
            }
            
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const datos = JSON.parse(body);
                    if (!datos.telefono) { res.writeHead(400); res.end(JSON.stringify({error:'telefono requerido'})); return; }
                    let tel = String(datos.telefono).replace(/\D/g, '');
                    if (tel.length > 10) tel = tel.slice(-10);

                    const llamadaPrevia = ultimasLlamadasPorTel.get(tel);
                    const ahora = Date.now();
                    if (llamadaPrevia && (ahora - llamadaPrevia) < 90000) {
                        const segs = Math.round((ahora - llamadaPrevia)/1000);
                        log('⚠ ' + tel + ' ya fue llamado hace ' + segs + 's - puede ser duplicado');
                    }
                    ultimasLlamadasPorTel.set(tel, ahora);

                    registrarLlamada({
                        telefono: tel,
                        nombre: datos.nombre || null,
                        saldo: datos.saldo || null,
                        dias_atraso: datos.dias_atraso || datos.diasAtraso || null,
                        despacho: datos.despacho || null,
                        telefono_retorno: datos.telefono_retorno || null,
                        acreedor: datos.acreedor || null
                    });

                    log('📤 Originando: ' + tel + ' | ' + (datos.nombre || 's/n') + ' | $' + (datos.saldo || '?') + ' (activas: ' + getLlamadasActivas() + '/' + MAX_CONCURRENTES + ')');

                    // Pre-generar saludo
                    obtenerAudioCacheado(construirSaludo({nombre: datos.nombre, despacho: datos.despacho}), 'sal', SALUDOS_DIR)
                        .catch(e => log('  ⚠ Error pre-gen saludo: ' + e.message));

                    const cmd = 'sudo asterisk -rx "channel originate SIP/zadarma/' + tel + ' extension s@cobranza-bot"';
                    exec(cmd, { timeout: 10000 }, (err) => {
                        if (err) {
                            log('  ❌ Error originate: ' + err.message);
                            res.writeHead(500); res.end(JSON.stringify({success:false, error:err.message})); return;
                        }
                        res.writeHead(200, {'Content-Type':'application/json'});
                        res.end(JSON.stringify({
                            success:true, 
                            telefono:tel,
                            activas: getLlamadasActivas(),
                            max_concurrentes: MAX_CONCURRENTES
                        }));
                    });
                } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:e.message})); }
            });
            return;
        }

        res.writeHead(404); res.end('Not found');
    } catch(e) {
        log('💥 Error HTTP: ' + e.message);
        try { res.writeHead(500); res.end(JSON.stringify({error:e.message})); } catch(_) {}
    }
});

httpServer.listen(HTTP_API_PORT, '0.0.0.0', () => {
    console.log('HTTP API en 0.0.0.0:' + HTTP_API_PORT);
});

httpServer.on('error', e => log('💥 httpServer error: ' + e.message));

process.on('uncaughtException', (err) => {
    log('💥💥 EXCEPCIÓN NO MANEJADA: ' + err.message);
    log(err.stack);
});

process.on('unhandledRejection', (reason, p) => {
    log('💥💥 PROMESA RECHAZADA: ' + (reason && reason.message ? reason.message : reason));
});

process.on('SIGINT', () => {
    console.log('\nCerrando...');
    try { voskModel.free(); } catch(e){}
    audioServer.close();
    httpServer.close(() => process.exit(0));
});
