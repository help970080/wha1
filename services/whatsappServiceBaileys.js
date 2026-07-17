/**
 * Servicio WhatsApp con Baileys
 * LMV CREDIA SA DE CV
 * VERSIÓN v3.0 - ANTI-BANEO
 *
 * CAMBIOS CRÍTICOS vs v2.0:
 *   1. NO se borra auth en 403/405/500 (esto causaba loop infinito de
 *      re-registro cada 3s = camino directo al baneo permanente).
 *      Solo se borra en logout REAL (401) o por orden manual.
 *   2. Backoff exponencial real + modo pánico (deja de reintentar y avisa).
 *   3. Límite de re-registros (QR nuevos) por día: 3. Más de eso = pánico.
 *   4. readMessages() — el bot ahora marca leído (antes NUNCA lo hacía:
 *      "recibe y nunca abre" es huella de bot).
 *   5. responderHumano() para que el chatbot NO conteste en 0ms.
 *   6. Cache de onWhatsApp persistente a disco (sobrevive reinicios).
 *   7. Contador diario duro persistente + ventana horaria.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Backoff de reconexión normal (red caída, timeout)
const BACKOFF_RED = [5000, 15000, 45000, 120000, 300000, 600000];
// Backoff de re-registro (QR nuevo). Agresivo a propósito.
const BACKOFF_REGISTRO = [60000, 300000, 900000, 3600000];

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.qrCode = null;
    this.qrTimestamp = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 6;
    this.onMessageCallback = null;
    this.initializing = false;
    this.lidMap = new Map();
    this.authDir = './auth_session';
    this.estadoFile = './wa_estado.json';

    this.sentMsgCache = new Map();
    this.maxCacheSize = 500;
    this.onWhatsAppCache = new Map();

    // ── Anti-baneo ──
    this.bloqueado = false;          // modo pánico: no reintenta solo
    this.motivoBloqueo = null;
    this.registroAttempts = 0;       // QRs generados hoy
    this.enviadosHoy = 0;
    this.diaContador = this._hoy();
    this.limiteDiarioDuro = 60;      // backstop global de mensajes EN FRÍO
    this.horaInicio = 9;             // ventana permitida (hora local MX)
    this.horaFin = 20;
    this.respetarVentana = true;

    this._cargarEstado();
  }

  // ══════════════════════════════════════════
  // ESTADO PERSISTENTE (sobrevive reinicios de Render/VPS)
  // ══════════════════════════════════════════

  _hoy() {
    return new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });
  }

  _cargarEstado() {
    try {
      if (!fs.existsSync(this.estadoFile)) return;
      const d = JSON.parse(fs.readFileSync(this.estadoFile, 'utf8'));
      if (d.dia === this._hoy()) {
        this.enviadosHoy = d.enviadosHoy || 0;
        this.registroAttempts = d.registroAttempts || 0;
        this.diaContador = d.dia;
      }
      if (Array.isArray(d.waCache)) {
        const ahora = Date.now();
        for (const [num, val] of d.waCache) {
          if (val && (ahora - val.ts) < 604800000) this.onWhatsAppCache.set(num, val);
        }
      }
      console.log(`📂 Estado cargado: ${this.enviadosHoy} enviados hoy, ${this.onWhatsAppCache.size} números en cache`);
    } catch (e) {
      console.error('Error cargando estado:', e.message);
    }
  }

  _guardarEstado() {
    try {
      const waCache = [...this.onWhatsAppCache.entries()].slice(-5000);
      fs.writeFileSync(this.estadoFile, JSON.stringify({
        dia: this.diaContador,
        enviadosHoy: this.enviadosHoy,
        registroAttempts: this.registroAttempts,
        waCache
      }));
    } catch (e) {}
  }

  _rotarDia() {
    const hoy = this._hoy();
    if (hoy !== this.diaContador) {
      this.diaContador = hoy;
      this.enviadosHoy = 0;
      this.registroAttempts = 0;
      this._guardarEstado();
      console.log(`🌅 Nuevo día (${hoy}): contadores reseteados`);
    }
  }

  enVentanaHoraria() {
    if (!this.respetarVentana) return true;
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    const h = ahora.getHours();
    const dow = ahora.getDay();
    if (dow === 0) return false;                 // domingo no
    if (dow === 6 && h >= 14) return false;      // sábado solo hasta 14h
    return h >= this.horaInicio && h < this.horaFin;
  }

  // ══════════════════════════════════════════

  limpiarAuthDir() {
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
        console.log('🗑️  Carpeta de credenciales eliminada');
      }
    } catch (e) {
      console.error('Error limpiando auth:', e.message);
    }
  }

  /**
   * Modo pánico: deja de reintentar. WhatsApp ya nos está mirando feo;
   * seguir insistiendo es lo que convierte una restricción temporal en baneo.
   */
  _panico(motivo) {
    this.bloqueado = true;
    this.motivoBloqueo = motivo;
    this.connected = false;
    this.initializing = false;
    this.qrCode = null;
    console.error('');
    console.error('🛑 ═══════════════════════════════════════════════');
    console.error(`🛑 MODO PÁNICO: ${motivo}`);
    console.error('🛑 NO se reintentará automáticamente.');
    console.error('🛑 Revisa el número en el celular antes de reconectar.');
    console.error('🛑 Reintento manual: POST /api/conectar?forzar=1');
    console.error('🛑 ═══════════════════════════════════════════════');
    console.error('');
  }

  async initialize(forzar = false) {
    if (this.bloqueado && !forzar) {
      console.log(`🛑 Bloqueado (${this.motivoBloqueo}). Usa forzar=1 para reintentar.`);
      return false;
    }
    if (forzar) {
      this.bloqueado = false;
      this.motivoBloqueo = null;
      this.reconnectAttempts = 0;
    }

    if (this.initializing) {
      console.log('⏳ Ya hay una inicialización en curso...');
      return false;
    }
    this.initializing = true;
    this._rotarDia();

    try {
      console.log('🔄 Inicializando WhatsApp...');

      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          if (this.sock.ws) this.sock.ws.close();
        } catch (e) {}
        this.sock = null;
      }

      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      // Si NO hay credenciales, esto es un registro nuevo (va a pedir QR).
      const esRegistroNuevo = !state?.creds?.registered;
      if (esRegistroNuevo) {
        this.registroAttempts++;
        this._guardarEstado();
        console.log(`🆕 Registro nuevo (QR) — intento ${this.registroAttempts} de hoy`);
        if (this.registroAttempts > 3) {
          this.initializing = false;
          this._panico('Más de 3 registros con QR en un día. WhatsApp lo lee como toma de cuenta.');
          return false;
        }
      }

      const version = [2, 3000, 1039102240];
      console.log(`📌 Baileys version (manual): ${version.join('.')}`);

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '131.0.6778.85'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        retryRequestDelayMs: 5000,
        shouldSyncHistoryMessage: () => false,
        getMessage: async (key) => {
          if (key?.id && this.sentMsgCache.has(key.id)) {
            return this.sentMsgCache.get(key.id);
          }
          return { conversation: '' };
        }
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;

        if (qr) {
          console.log('📱 Nuevo código QR generado - duración 60s');
          try {
            this.qrCode = await qrcode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
            this.qrTimestamp = Date.now();
          } catch (e) {
            console.error('Error generando QR:', e.message);
          }
        }

        if (connection === 'open') {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.qrCode = null;
          this.qrTimestamp = null;
          this.initializing = false;
          const userName = this.sock?.user?.name || 'usuario';
          const userPhone = this.sock?.user?.id?.split(':')[0] || 'N/A';
          console.log(`✅ WhatsApp conectado: ${userName} (${userPhone})`);
          if (isNewLogin) console.log('🆕 Nueva sesion iniciada (primer login con este QR)');
          return;
        }

        if (connection === 'close') {
          this.connected = false;
          this.initializing = false;

          const error = lastDisconnect?.error;
          const statusCode = error?.output?.statusCode || error?.code || 0;
          const errorMessage = error?.message || 'sin detalle';
          const reason = DisconnectReason;

          console.log(`❌ Conexion cerrada. Codigo: ${statusCode} | ${errorMessage}`);

          // ─────────────────────────────────────────────────────────
          // CAMBIO CENTRAL v3.0
          // ANTES: 403/405/500 → borrar auth → QR nuevo cada 3s, sin
          // límite. Cada ciclo golpea el endpoint de registro de
          // WhatsApp. Eso NO arregla nada y es lo que provoca el
          // baneo definitivo. Ahora se distingue de verdad.
          // ─────────────────────────────────────────────────────────

          // 401 = logout REAL desde el celular. Único caso de wipe.
          if (statusCode === reason.loggedOut || statusCode === 401) {
            console.log('🚪 Sesion cerrada desde el celular. Se requiere QR nuevo.');
            this.limpiarAuthDir();
            this.qrCode = null;
            if (this.registroAttempts >= 3) {
              this._panico('Logout repetido: 3+ QR hoy.');
              return;
            }
            setTimeout(() => this.initialize(), 10000);
            return;
          }

          // 403 = el número está restringido/marcado. NO borrar, NO insistir.
          if (statusCode === 403) {
            this._panico('403 Forbidden — el número está restringido por WhatsApp. Ábrelo en el celular y revisa si hay aviso de restricción. NO reconectes en frío.');
            return;
          }

          // 429 = rate limit. Bandera roja máxima.
          if (statusCode === 429) {
            this._panico('429 Too Many Requests — WhatsApp está limitando el número. Espera 24h.');
            return;
          }

          // 515 = restart esperado tras escanear QR. Normal.
          if (statusCode === reason.restartRequired || statusCode === 515) {
            console.log('🔄 Restart requerido (esperado tras QR)');
            setTimeout(() => this.initialize(), 3000);
            return;
          }

          // 440 = otro dispositivo tomó la sesión.
          if (statusCode === reason.connectionReplaced || statusCode === 440) {
            console.log('⚠️  Conexion reemplazada. No se reintenta.');
            this.reconnectAttempts = 0;
            return;
          }

          // 405 / 500 / badSession: puede ser versión vieja o sesión mala.
          // Reintentar SIN borrar. Solo si falla 3 veces seguidas → pánico.
          if (statusCode === 405 || statusCode === 500 || statusCode === reason.badSession) {
            this.reconnectAttempts++;
            if (this.reconnectAttempts >= 3) {
              this._panico(`Código ${statusCode} persistente. Probablemente la versión hardcodeada [${version.join('.')}] ya caducó — actualízala en el código (wppconnect.io/whatsapp-versions). NO borres auth_session.`);
              return;
            }
            const d = BACKOFF_REGISTRO[Math.min(this.reconnectAttempts - 1, BACKOFF_REGISTRO.length - 1)];
            console.log(`⚠️  ${statusCode} — reintento ${this.reconnectAttempts}/3 en ${d / 1000}s (SIN borrar auth)`);
            setTimeout(() => this.initialize(), d);
            return;
          }

          // Red: backoff exponencial normal.
          this.reconnectAttempts++;
          if (this.reconnectAttempts > this.maxReconnectAttempts) {
            this._panico(`Sin conexión tras ${this.maxReconnectAttempts} intentos (último código ${statusCode}).`);
            return;
          }
          const delay = BACKOFF_RED[Math.min(this.reconnectAttempts - 1, BACKOFF_RED.length - 1)];
          console.log(`🌐 Reconectando ${this.reconnectAttempts}/${this.maxReconnectAttempts} en ${delay / 1000}s`);
          setTimeout(() => this.initialize(), delay);
        }

        if (connection === 'connecting') {
          console.log('🔌 Conectando con servidor de WhatsApp...');
        }
      });

      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid?.includes('@g.us')) continue;
          if (this.onMessageCallback) {
            try {
              await this.onMessageCallback(msg);
            } catch (e) {
              console.error('Error en callback de mensaje:', e.message);
            }
          }
        }
      });

      // Rechazar llamadas entrantes en silencio: dejarlas sonar sin contestar
      // también cuenta como señal de cuenta abandonada/bot.
      this.sock.ev.on('call', async (calls) => {
        for (const c of calls) {
          if (c.status === 'offer') {
            try {
              await this.sock.rejectCall(c.id, c.from);
              console.log(`📵 Llamada rechazada de ${c.from}`);
            } catch (e) {}
          }
        }
      });

      return true;
    } catch (error) {
      console.error('❌ Error inicializando WhatsApp:', error.message);
      this.initializing = false;
      return false;
    }
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  isConnected() {
    return this.connected && this.sock !== null && this.sock?.user != null;
  }

  getQrCode() {
    return { qr: this.qrCode, timestamp: this.qrTimestamp };
  }

  /**
   * Para el panel: saber POR QUÉ está caído sin leer logs.
   */
  estadoSalud() {
    this._rotarDia();
    return {
      conectado: this.isConnected(),
      bloqueado: this.bloqueado,
      motivoBloqueo: this.motivoBloqueo,
      enviadosHoy: this.enviadosHoy,
      limiteDiario: this.limiteDiarioDuro,
      restantesHoy: Math.max(0, this.limiteDiarioDuro - this.enviadosHoy),
      registrosQRHoy: this.registroAttempts,
      enVentanaHoraria: this.enVentanaHoraria(),
      intentosReconexion: this.reconnectAttempts,
      numerosEnCache: this.onWhatsAppCache.size
    };
  }

  resolverLID(lid) {
    return this.lidMap.get(lid) || null;
  }

  async getInfoSesion() {
    if (!this.connected || !this.sock || !this.sock.user) return null;
    try {
      const user = this.sock.user;
      return {
        nombre: user?.name || user?.notify || 'WhatsApp',
        telefono: user?.id?.split(':')[0]?.split('@')[0] || 'N/A',
        plataforma: 'Baileys',
        id: user?.id || null
      };
    } catch (error) {
      return null;
    }
  }

  formatearNumero(telefono) {
    let limpio = String(telefono).replace(/\D/g, '');
    if (limpio.startsWith('521') && limpio.length === 13) return limpio + '@s.whatsapp.net';
    if (limpio.startsWith('52') && limpio.length === 12) return '521' + limpio.slice(2) + '@s.whatsapp.net';
    if (limpio.length === 10) return '521' + limpio + '@s.whatsapp.net';
    return limpio + '@s.whatsapp.net';
  }

  /**
   * Cache 7 días (antes 24h en RAM = se perdía en cada reinicio y
   * re-consultaba toda la cartera). Los lookups masivos de onWhatsApp
   * sobre números que no son tus contactos son señal fuerte de spam.
   */
  async numeroExisteEnWA(numeroSinAt) {
    const cached = this.onWhatsAppCache.get(numeroSinAt);
    if (cached && (Date.now() - cached.ts) < 604800000) return cached.exists;
    try {
      const [result] = await this.sock.onWhatsApp(numeroSinAt);
      const exists = !!result?.exists;
      this.onWhatsAppCache.set(numeroSinAt, { exists, ts: Date.now() });
      this._guardarEstado();
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      return exists;
    } catch (e) {
      return true;
    }
  }

  cacheMensaje(msgId, contenido) {
    if (this.sentMsgCache.size >= this.maxCacheSize) {
      const firstKey = this.sentMsgCache.keys().next().value;
      this.sentMsgCache.delete(firstKey);
    }
    this.sentMsgCache.set(msgId, contenido);
  }

  /**
   * NUEVO v3.0 — Marcar leído. El bot NUNCA hacía esto.
   * Una cuenta que recibe cientos de mensajes y jamás los abre es
   * una de las huellas más obvias de automatización.
   */
  async marcarLeido(msg) {
    try {
      if (msg?.key) await this.sock.readMessages([msg.key]);
    } catch (e) {}
  }

  /**
   * NUEVO v3.0 — Respuesta con cadencia humana.
   * El chatbot llamaba a sock.sendMessage() directo: respondía en <200ms,
   * sin presencia y sin marcar leído. Ningún humano contesta así.
   *
   * En chatbotCobranza.js, cambiar:
   *    await this.whatsapp.sock.sendMessage(jid, { text: respuesta });
   * por:
   *    await this.whatsapp.responderHumano(jid, respuesta, msg);
   */
  async responderHumano(jid, texto, msgOriginal = null) {
    if (!this.isConnected()) return { exito: false, error: 'WhatsApp no conectado' };
    try {
      if (msgOriginal) await this.marcarLeido(msgOriginal);

      // Latencia de lectura: 2-6s antes de siquiera empezar a escribir
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 4000));

      try { await this.sock.sendPresenceUpdate('composing', jid); } catch (e) {}
      const tiempoTipeo = Math.min(Math.max(texto.length * 22, 2000), 9000);
      await new Promise(r => setTimeout(r, tiempoTipeo * (0.7 + Math.random() * 0.6)));
      try { await this.sock.sendPresenceUpdate('paused', jid); } catch (e) {}

      const sentMsg = await this.sock.sendMessage(jid, { text: texto });
      if (sentMsg?.key?.id) this.cacheMensaje(sentMsg.key.id, { conversation: texto });

      setTimeout(async () => {
        try { await this.sock.sendPresenceUpdate('unavailable'); } catch (e) {}
      }, 3000 + Math.random() * 4000);

      return { exito: true, msgId: sentMsg?.key?.id };
    } catch (error) {
      console.error(`❌ Error respondiendo a ${jid}:`, error.message);
      return { exito: false, error: error.message };
    }
  }

  /**
   * @param {Object} opts - { ignorarLimite: bool, ignorarVentana: bool }
   */
  async enviarMensaje(telefono, mensaje, opts = {}) {
    if (!this.isConnected()) {
      return { exito: false, error: 'WhatsApp no conectado' };
    }

    this._rotarDia();

    // Backstop duro: aunque envioMasivoService se configure mal o alguien
    // suba el límite en el panel, aquí se frena.
    if (!opts.ignorarLimite && this.enviadosHoy >= this.limiteDiarioDuro) {
      console.log(`🛑 Límite diario duro alcanzado (${this.limiteDiarioDuro}). No se envía a ${telefono}.`);
      return { exito: false, error: `Límite diario alcanzado (${this.limiteDiarioDuro})`, telefono, limitado: true };
    }

    if (!opts.ignorarVentana && !this.enVentanaHoraria()) {
      console.log(`🌙 Fuera de ventana horaria (${this.horaInicio}-${this.horaFin}h L-S). No se envía a ${telefono}.`);
      return { exito: false, error: 'Fuera de ventana horaria', telefono, fueraVentana: true };
    }

    try {
      const jid = this.formatearNumero(telefono);
      const numeroSinAt = jid.split('@')[0];

      const existe = await this.numeroExisteEnWA(numeroSinAt);
      if (!existe) {
        console.log(`⚠️  ${telefono} no existe en WhatsApp`);
        return { exito: false, error: 'Numero no esta en WhatsApp', telefono };
      }

      try { await this.sock.sendPresenceUpdate('available'); } catch (e) {}
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1500));
      try { await this.sock.sendPresenceUpdate('composing', jid); } catch (e) {}
      const tiempoTipeo = Math.min(Math.max(mensaje.length * 22, 2500), 9000);
      await new Promise(r => setTimeout(r, tiempoTipeo * (0.7 + Math.random() * 0.6)));
      try { await this.sock.sendPresenceUpdate('paused', jid); } catch (e) {}

      const sentMsg = await this.sock.sendMessage(jid, { text: mensaje });

      if (sentMsg?.key?.id) {
        this.cacheMensaje(sentMsg.key.id, { conversation: mensaje });
      }

      this.enviadosHoy++;
      this._guardarEstado();

      setTimeout(async () => {
        try { await this.sock.sendPresenceUpdate('unavailable'); } catch (e) {}
      }, 3000 + Math.random() * 4000);

      let tel10 = String(telefono).replace(/\D/g, '');
      if (tel10.startsWith('521') && tel10.length === 13) tel10 = tel10.slice(3);
      else if (tel10.startsWith('52') && tel10.length === 12) tel10 = tel10.slice(2);

      if (sentMsg && sentMsg.key && sentMsg.key.remoteJid) {
        const lid = sentMsg.key.remoteJid.split('@')[0];
        this.lidMap.set(lid, tel10);
        console.log(`🔗 LID mapeado: ${lid} → ${tel10}`);
      }

      this.ultimoEnvio = { tel10, timestamp: Date.now() };

      console.log(`✅ Mensaje enviado a ${telefono} (${this.enviadosHoy}/${this.limiteDiarioDuro} hoy)`);
      return { exito: true, telefono, enviadosHoy: this.enviadosHoy };
    } catch (error) {
      console.error(`❌ Error enviando a ${telefono}:`, error.message);

      // Si WhatsApp devuelve rate-limit en pleno envío, cortar la campaña ya.
      const m = String(error.message || '').toLowerCase();
      if (m.includes('rate') || m.includes('429') || m.includes('overlimit')) {
        this._panico('Rate limit detectado durante envío. Campaña cortada.');
      }

      return { exito: false, error: error.message, telefono };
    }
  }

  async enviarDocumento(telefono, buffer, fileName, mimetype = 'application/pdf', caption = '') {
    if (!this.isConnected()) {
      return { exito: false, error: 'WhatsApp no conectado' };
    }

    let tmpPath = null;

    try {
      if (!buffer || buffer.length === 0) {
        console.error(`❌ enviarDocumento: buffer vacío para ${telefono}`);
        return { exito: false, error: 'Buffer vacío' };
      }
      if (!Buffer.isBuffer(buffer)) {
        console.log(`⚠️  Convirtiendo a Buffer real (era ${typeof buffer})`);
        buffer = Buffer.from(buffer);
      }

      const jid = this.formatearNumero(telefono);
      const numeroSinAt = jid.split('@')[0];
      const existe = await this.numeroExisteEnWA(numeroSinAt);
      if (!existe) {
        return { exito: false, error: 'Numero no esta en WhatsApp', telefono };
      }

      const tmpDir = '/tmp';
      const fileNameSafe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      tmpPath = path.join(tmpDir, `${Date.now()}_${fileNameSafe}`);
      fs.writeFileSync(tmpPath, buffer);
      console.log(`💾 PDF temporal escrito: ${tmpPath} (${buffer.length} bytes)`);

      try { await this.sock.sendPresenceUpdate('available'); } catch (e) {}
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

      console.log(`📎 Enviando documento a ${jid}: ${fileName}`);

      const msgPayload = {
        document: { url: tmpPath },
        mimetype: mimetype,
        fileName: fileName
      };
      if (caption && caption.trim()) msgPayload.caption = caption;

      const sentMsg = await this.sock.sendMessage(jid, msgPayload);

      let tel10 = String(telefono).replace(/\D/g, '');
      if (tel10.startsWith('521') && tel10.length === 13) tel10 = tel10.slice(3);
      else if (tel10.startsWith('52') && tel10.length === 12) tel10 = tel10.slice(2);
      if (sentMsg?.key?.remoteJid) {
        const lid = sentMsg.key.remoteJid.split('@')[0];
        this.lidMap.set(lid, tel10);
      }
      this.ultimoEnvio = { tel10, timestamp: Date.now() };

      console.log(`✅ Documento enviado a ${telefono}: ${fileName} (msgId: ${sentMsg?.key?.id || 'n/a'})`);
      return { exito: true, telefono, fileName, msgId: sentMsg?.key?.id };
    } catch (error) {
      console.error(`❌ Error enviando documento a ${telefono}:`, error.message);
      return { exito: false, error: error.message, telefono };
    } finally {
      if (tmpPath) {
        setTimeout(() => {
          try { fs.unlinkSync(tmpPath); } catch (e) {}
        }, 30000);
      }
    }
  }

  async cerrarSesion() {
    try {
      if (this.sock) {
        try { this.sock.ev.removeAllListeners(); } catch (e) {}
        try { await this.sock.logout(); } catch (e) {}
        try { if (this.sock.ws) this.sock.ws.close(); } catch (e) {}
        this.sock = null;
      }
      this.connected = false;
      this.initializing = false;
      this.qrCode = null;
      this.qrTimestamp = null;
      this.limpiarAuthDir();
      this.reconnectAttempts = 0;
      console.log('👋 Sesion cerrada y credenciales limpiadas');
    } catch (error) {
      console.error('Error cerrando sesion:', error.message);
      this.sock = null;
      this.connected = false;
      this.initializing = false;
      try { this.limpiarAuthDir(); } catch (e) {}
    }
  }
}

module.exports = WhatsAppService;
