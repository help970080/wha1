/**
 * Servicio WhatsApp con Baileys
 * LMV CREDIA SA DE CV
 * VERSIÓN v2.0 - Arreglo error 403 + actualización a API actual de Baileys
 * 
 * CAMBIOS CRÍTICOS vs v1.x:
 *   - Quitado printQRInTerminal (deprecado, causaba 403)
 *   - Browser config compatible con WhatsApp Web actual
 *   - markOnlineOnConnect: false (anti-baneo)
 *   - Manejo de error 405 y otros codigos no documentados
 *   - Auto-borrado de auth corrupta en mas escenarios
 *   - Logger mejorado para debugging del QR
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.qrCode = null;
    this.qrTimestamp = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.onMessageCallback = null;
    this.initializing = false;
    this.lidMap = new Map(); // LID → telefono (10 digitos)
    this.authDir = './auth_session';
    // Cache para getMessage retries (anti-baneo)
    this.sentMsgCache = new Map();
    this.maxCacheSize = 500;
    // Cache de validaciones onWhatsApp (24h)
    this.onWhatsAppCache = new Map();
  }

  /**
   * Borra todas las credenciales locales (sesion corrupta o logout)
   */
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

  async initialize() {
    // Evitar inicializaciones simultáneas
    if (this.initializing) {
      console.log('⏳ Ya hay una inicialización en curso...');
      return false;
    }
    this.initializing = true;

    try {
      console.log('🔄 Inicializando WhatsApp...');

      // Limpiar socket anterior si existe
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          if (this.sock.ws) this.sock.ws.close();
        } catch (e) {}
        this.sock = null;
      }
      
      // Asegurar que existe el directorio de auth
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      
      // ════════════════════════════════════════════════════════════
      // VERSION CRITICA: WhatsApp rechaza versiones viejas con error 405
      // (Bug conocido de Baileys - issue #2376)
      // fetchLatestBaileysVersion() devuelve una version obsoleta que
      // ya no acepta WhatsApp. Hardcodeamos la version actual de WhatsApp
      // Web (consultar https://wppconnect.io/whatsapp-versions/ si vuelve
      // a fallar con 405 - actualizar este numero).
      // ════════════════════════════════════════════════════════════
      const version = [2, 3000, 1039102240]; // 8 mayo 2026 - alpha stable
      console.log(`📌 Baileys version (manual): ${version.join('.')}`);

      // CONFIGURACION ARREGLADA — sin printQRInTerminal, browser compatible
      this.sock = makeWASocket({
        version,
        auth: state,
        // ❌ printQRInTerminal: ELIMINADO (deprecado, causaba 403)
        logger: pino({ level: 'silent' }),
        // ✅ Browser string compatible con WhatsApp Web actual
        browser: ['Ubuntu', 'Chrome', '120.0.6099.129'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        // ✅ markOnlineOnConnect: false → anti-baneo
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        retryRequestDelayMs: 2000,
        // Necesario para cargar mensajes correctamente
        shouldSyncHistoryMessage: () => false,
        // ✅ getMessage real - devuelve mensajes cacheados para retries
        getMessage: async (key) => {
          if (key?.id && this.sentMsgCache.has(key.id)) {
            return this.sentMsgCache.get(key.id);
          }
          return { conversation: '' };
        }
      });

      // Guardar credenciales cuando cambien
      this.sock.ev.on('creds.update', saveCreds);

      // Manejar conexión - aqui es donde se genera el QR
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;

        // QR generado - convertir a data URL
        if (qr) {
          console.log('📱 Nuevo código QR generado - duración 60s');
          try {
            this.qrCode = await qrcode.toDataURL(qr, {
              errorCorrectionLevel: 'M',
              margin: 2,
              width: 300
            });
            this.qrTimestamp = Date.now();
            console.log('✅ QR convertido a imagen base64 listo para mostrar');
          } catch (e) {
            console.error('Error generando QR:', e.message);
          }
        }

        // Conexion abierta exitosamente
        if (connection === 'open') {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.qrCode = null;
          this.qrTimestamp = null;
          this.initializing = false;
          const userName = this.sock?.user?.name || 'usuario';
          const userPhone = this.sock?.user?.id?.split(':')[0] || 'N/A';
          console.log(`✅ WhatsApp conectado: ${userName} (${userPhone})`);
          if (isNewLogin) {
            console.log('🆕 Nueva sesion iniciada (primer login con este QR)');
          }
          return;
        }

        // Conexion cerrada - manejar segun motivo
        if (connection === 'close') {
          this.connected = false;
          this.initializing = false;
          
          const error = lastDisconnect?.error;
          const statusCode = error?.output?.statusCode || error?.code || 0;
          const errorMessage = error?.message || 'sin detalle';
          
          console.log(`❌ Conexion cerrada. Codigo: ${statusCode} | ${errorMessage}`);

          const reason = DisconnectReason;
          let accion = 'reconectar'; // Por defecto

          // Determinar accion segun statusCode
          if (statusCode === reason.loggedOut || statusCode === 401) {
            accion = 'limpiar_y_reconectar';
            console.log('🚪 Sesion cerrada por el usuario (logout)');
          
          } else if (statusCode === 403) {
            // 403 = forbidden. Casi siempre es auth corrupta o protocolo viejo
            accion = 'limpiar_y_reconectar';
            console.log('🚫 403 Forbidden - limpiando auth corrupta');
          
          } else if (statusCode === reason.badSession || statusCode === 500) {
            accion = 'limpiar_y_reconectar';
            console.log('💔 Sesion corrupta');
          
          } else if (statusCode === reason.restartRequired || statusCode === 515) {
            accion = 'reconectar_inmediato';
            console.log('🔄 Restart requerido (esperado tras escanear QR)');
          
          } else if (statusCode === reason.connectionReplaced || statusCode === 440) {
            accion = 'detener';
            console.log('⚠️  Conexion reemplazada (otro dispositivo se conecto)');
          
          } else if (statusCode === 405) {
            // Codigo nuevo no documentado en enums viejos
            accion = 'limpiar_y_reconectar';
            console.log('⚠️  405 Method Not Allowed - limpiando auth');
          
          } else if (statusCode === reason.connectionClosed || 
                     statusCode === reason.connectionLost || 
                     statusCode === reason.timedOut ||
                     statusCode === 408 || statusCode === 428) {
            accion = 'reconectar';
            console.log('🌐 Problema de red');
          
          } else if (statusCode === 0) {
            // Sin codigo (error interno)
            accion = 'reconectar';
            console.log('⚠️  Error sin codigo');
          
          } else {
            accion = 'reconectar';
            console.log(`❓ Codigo desconocido ${statusCode}`);
          }

          // Ejecutar accion
          if (accion === 'limpiar_y_reconectar') {
            this.limpiarAuthDir();
            this.qrCode = null;
            // Espera mas larga despues de limpiar
            setTimeout(() => this.initialize(), 3000);
          
          } else if (accion === 'reconectar_inmediato') {
            setTimeout(() => this.initialize(), 1000);
          
          } else if (accion === 'reconectar') {
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++;
              const delay = Math.min(3000 * this.reconnectAttempts, 30000);
              console.log(`🔄 Reconectando... Intento ${this.reconnectAttempts}/${this.maxReconnectAttempts} (espera ${delay/1000}s)`);
              setTimeout(() => this.initialize(), delay);
            } else {
              console.log('❌ Maximo de intentos alcanzado. Llama a /api/conectar para reintentar.');
              this.reconnectAttempts = 0;
            }
          
          } else if (accion === 'detener') {
            console.log('🛑 No se reintentara automaticamente');
            this.reconnectAttempts = 0;
          }
        }

        // Estado intermedio
        if (connection === 'connecting') {
          console.log('🔌 Conectando con servidor de WhatsApp...');
        }
      });

      // Escuchar mensajes entrantes
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

      return true;
    } catch (error) {
      console.error('❌ Error inicializando WhatsApp:', error.message);
      console.error(error.stack);
      this.initializing = false;
      
      // Si el error es de credenciales corruptas, limpiar y reintentar una vez
      if (error.message?.includes('auth') || error.message?.includes('cred')) {
        console.log('🗑️  Error parece ser de credenciales, limpiando...');
        this.limpiarAuthDir();
        if (this.reconnectAttempts < 1) {
          this.reconnectAttempts++;
          setTimeout(() => this.initialize(), 5000);
        }
      }
      
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
    return {
      qr: this.qrCode,
      timestamp: this.qrTimestamp
    };
  }

  // Resolver LID a telefono de 10 digitos
  resolverLID(lid) {
    return this.lidMap.get(lid) || null;
  }

  async getInfoSesion() {
    if (!this.connected || !this.sock || !this.sock.user) {
      return null;
    }
    
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
    // Si ya tiene 521 + 10 digitos (13 total) → listo
    if (limpio.startsWith('521') && limpio.length === 13) {
      return limpio + '@s.whatsapp.net';
    }
    // Si tiene 52 + 10 digitos (12 total) sin el 1 → agregar 1
    if (limpio.startsWith('52') && limpio.length === 12) {
      return '521' + limpio.slice(2) + '@s.whatsapp.net';
    }
    // Si tiene 10 digitos → agregar 521
    if (limpio.length === 10) {
      return '521' + limpio + '@s.whatsapp.net';
    }
    return limpio + '@s.whatsapp.net';
  }

  // Cache de validaciones onWhatsApp (24h)
  async numeroExisteEnWA(numeroSinAt) {
    const cached = this.onWhatsAppCache.get(numeroSinAt);
    if (cached && (Date.now() - cached.ts) < 86400000) {
      return cached.exists;
    }
    try {
      const [result] = await this.sock.onWhatsApp(numeroSinAt);
      const exists = !!result?.exists;
      this.onWhatsAppCache.set(numeroSinAt, { exists, ts: Date.now() });
      return exists;
    } catch(e) {
      return true;
    }
  }

  // Guardar mensaje enviado en cache (para getMessage retries)
  cacheMensaje(msgId, contenido) {
    if (this.sentMsgCache.size >= this.maxCacheSize) {
      const firstKey = this.sentMsgCache.keys().next().value;
      this.sentMsgCache.delete(firstKey);
    }
    this.sentMsgCache.set(msgId, contenido);
  }

  async enviarMensaje(telefono, mensaje) {
    if (!this.isConnected()) {
      return { exito: false, error: 'WhatsApp no conectado' };
    }

    try {
      const jid = this.formatearNumero(telefono);
      const numeroSinAt = jid.split('@')[0];
      
      // Validar con cache 24h
      const existe = await this.numeroExisteEnWA(numeroSinAt);
      if (!existe) {
        console.log(`⚠️  ${telefono} no existe en WhatsApp`);
        return { exito: false, error: 'Numero no esta en WhatsApp', telefono };
      }
      
      // Secuencia humana: leer → escribir → pausar → enviar → cerrar
      try { await this.sock.sendPresenceUpdate('available'); } catch(e) {}
      await new Promise(r => setTimeout(r, 300 + Math.random() * 900));
      try { await this.sock.sendPresenceUpdate('composing', jid); } catch(e) {}
      const tiempoTipeo = Math.min(Math.max(mensaje.length * 18, 1500), 6000);
      await new Promise(r => setTimeout(r, tiempoTipeo + (Math.random() * 1500 - 750)));
      try { await this.sock.sendPresenceUpdate('paused', jid); } catch(e) {}
      
      const sentMsg = await this.sock.sendMessage(jid, { text: mensaje });
      
      if (sentMsg?.key?.id) {
        this.cacheMensaje(sentMsg.key.id, { conversation: mensaje });
      }
      
      setTimeout(async () => {
        try { await this.sock.sendPresenceUpdate('unavailable'); } catch(e) {}
      }, 2000 + Math.random() * 3000);
      
      // LID mapping
      let tel10 = String(telefono).replace(/\D/g, '');
      if (tel10.startsWith('521') && tel10.length === 13) tel10 = tel10.slice(3);
      else if (tel10.startsWith('52') && tel10.length === 12) tel10 = tel10.slice(2);
      
      if (sentMsg && sentMsg.key && sentMsg.key.remoteJid) {
        const lid = sentMsg.key.remoteJid.split('@')[0];
        this.lidMap.set(lid, tel10);
        console.log(`🔗 LID mapeado: ${lid} → ${tel10}`);
      }
      
      this.ultimoEnvio = { tel10, timestamp: Date.now() };
      
      console.log(`✅ Mensaje enviado a ${telefono}`);
      return { exito: true, telefono };
    } catch (error) {
      console.error(`❌ Error enviando a ${telefono}:`, error.message);
      return { exito: false, error: error.message, telefono };
    }
  }

  /**
   * v3.2 (2026-05): Envía un documento (PDF) por WhatsApp.
   * 
   * ESTRATEGIA: escribe el PDF a /tmp y lo manda con { document: { url: path } }.
   * Esta es la forma DOCUMENTADA y CONFIABLE en Baileys. Pasar Buffer directo
   * funciona a veces pero falla silenciosamente en otras (lo que pasaba con
   * Adriana - el cliente recibía el texto pero no el PDF).
   * 
   * @param {String} telefono - 10 dígitos
   * @param {Buffer} buffer - contenido del archivo
   * @param {String} fileName - nombre del archivo (ej. 'Convenio_LGX-B-001.pdf')
   * @param {String} mimetype - default 'application/pdf'
   * @param {String} caption - texto opcional bajo el documento
   */
  async enviarDocumento(telefono, buffer, fileName, mimetype = 'application/pdf', caption = '') {
    if (!this.isConnected()) {
      return { exito: false, error: 'WhatsApp no conectado' };
    }
    
    let tmpPath = null;
    
    try {
      // Validar buffer
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

      // ─── Escribir a disco temporal ───
      // Baileys es más estable cuando lee de URL/path que cuando se le pasa Buffer crudo.
      // Esto fue el bug: el cliente recibía el texto pero el PDF no llegaba.
      const tmpDir = '/tmp';
      // Sanitizar nombre de archivo y agregar timestamp para evitar colisiones
      const fileNameSafe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      tmpPath = path.join(tmpDir, `${Date.now()}_${fileNameSafe}`);
      fs.writeFileSync(tmpPath, buffer);
      console.log(`💾 PDF temporal escrito: ${tmpPath} (${buffer.length} bytes)`);

      // Secuencia humana corta
      try { await this.sock.sendPresenceUpdate('available'); } catch(e) {}
      await new Promise(r => setTimeout(r, 500 + Math.random() * 800));

      console.log(`📎 Enviando documento a ${jid}: ${fileName}`);

      // Construir payload usando { url: path } - método documentado y robusto
      const msgPayload = {
        document: { url: tmpPath },
        mimetype: mimetype,
        fileName: fileName
      };
      if (caption && caption.trim()) {
        msgPayload.caption = caption;
      }

      const sentMsg = await this.sock.sendMessage(jid, msgPayload);

      // LID mapping (igual que enviarMensaje)
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
      console.error('   Stack:', error.stack?.split('\n').slice(0, 3).join('\n'));
      return { exito: false, error: error.message, telefono };
    } finally {
      // Limpiar archivo temporal después de 30s (dar tiempo a que Baileys termine de subir)
      if (tmpPath) {
        setTimeout(() => {
          try { fs.unlinkSync(tmpPath); } catch(e) {}
        }, 30000);
      }
    }
  }

  async cerrarSesion() {
    try {
      if (this.sock) {
        try { this.sock.ev.removeAllListeners(); } catch(e) {}
        try { await this.sock.logout(); } catch(e) {}
        try { if (this.sock.ws) this.sock.ws.close(); } catch(e) {}
        this.sock = null;
      }
      this.connected = false;
      this.initializing = false;
      this.qrCode = null;
      this.qrTimestamp = null;
      // ★ FIX 2026-05: borrar credenciales del numero anterior.
      // Sin esto, al reconectar con OTRO numero se cargaban las llaves de
      // Signal viejas desde ./auth_session -> el socket conectaba (isConnected
      // = true, panel mostraba ✅) pero los mensajes salian cifrados con la
      // sesion anterior y el destinatario NO los recibia ("conecta pero no
      // manda"). Solo se ejecuta en desconexion manual, asi que NO afecta la
      // reconexion automatica por red (esa no pasa por cerrarSesion).
      this.limpiarAuthDir();
      // Resetear contador para que el siguiente QR arranque limpio
      this.reconnectAttempts = 0;
      console.log('👋 Sesion cerrada y credenciales limpiadas');
    } catch (error) {
      console.error('Error cerrando sesion:', error.message);
      this.sock = null;
      this.connected = false;
      this.initializing = false;
      // Garantizar limpieza aunque algo haya fallado arriba
      try { this.limpiarAuthDir(); } catch(e) {}
    }
  }
}

module.exports = WhatsAppService;
