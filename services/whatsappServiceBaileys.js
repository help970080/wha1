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
    this.authDir = './auth_session';
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
      
      // Obtener version mas reciente de Baileys
      let version;
      try {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo.version;
        console.log(`📌 Baileys version: ${version.join('.')}`);
      } catch (e) {
        // Fallback a una version conocida estable
        version = [2, 3000, 1023224122];
        console.log(`📌 Baileys version (fallback): ${version.join('.')}`);
      }

      // CONFIGURACION ARREGLADA — sin printQRInTerminal, browser compatible
      this.sock = makeWASocket({
        version,
        auth: state,
        // ❌ printQRInTerminal: ELIMINADO (deprecado, causaba 403)
        logger: pino({ level: 'silent' }),
        // ✅ Browser string compatible con WhatsApp Web actual
        browser: ['Mac OS', 'Safari', '14.4.1'],
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
        // Para que no marque como online inmediato (anti-baneo)
        getMessage: async () => undefined
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
    if (limpio.startsWith('52') && limpio.length === 12) {
      return limpio + '@s.whatsapp.net';
    }
    if (limpio.length === 10) {
      return '52' + limpio + '@s.whatsapp.net';
    }
    return limpio + '@s.whatsapp.net';
  }

  async enviarMensaje(telefono, mensaje) {
    if (!this.isConnected()) {
      return { exito: false, error: 'WhatsApp no conectado' };
    }

    try {
      const jid = this.formatearNumero(telefono);
      
      // Verificar que el numero existe en WhatsApp antes de enviar
      // (opcional pero ayuda a evitar errores y reduce envios "fantasma")
      try {
        const [result] = await this.sock.onWhatsApp(jid.split('@')[0]);
        if (!result?.exists) {
          console.log(`⚠️  ${telefono} no existe en WhatsApp`);
          return { exito: false, error: 'Numero no esta en WhatsApp', telefono };
        }
      } catch(e) { 
        // Si la verificacion falla, intentamos enviar de todas formas
      }
      
      await this.sock.sendMessage(jid, { text: mensaje });
      
      console.log(`✅ Mensaje enviado a ${telefono}`);
      return { exito: true, telefono };
    } catch (error) {
      console.error(`❌ Error enviando a ${telefono}:`, error.message);
      return { exito: false, error: error.message, telefono };
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
      console.log('👋 Sesion cerrada');
    } catch (error) {
      console.error('Error cerrando sesion:', error.message);
      this.sock = null;
      this.connected = false;
      this.initializing = false;
    }
  }
}

module.exports = WhatsAppService;
