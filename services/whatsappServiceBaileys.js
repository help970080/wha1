/**
 * Servicio WhatsApp con Baileys
 * LMV CREDIA SA DE CV
 * VERSIÓN CORREGIDA - Conexión estable
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');

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

      // Limpiar socket anterior si existe (evita listeners duplicados)
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          this.sock.ws.close();
        } catch (e) {}
        this.sock = null;
      }
      
      const authDir = './auth_session';
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      console.log(`📌 Baileys version: ${version.join('.')}`);

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
        fireInitQueries: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        retryRequestDelayMs: 2000
      });

      // Guardar credenciales
      this.sock.ev.on('creds.update', saveCreds);

      // Manejar conexión
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('📱 Nuevo código QR generado');
          try {
            this.qrCode = await qrcode.toDataURL(qr);
            this.qrTimestamp = Date.now();
          } catch (e) {
            console.error('Error generando QR:', e.message);
          }
        }

        if (connection === 'close') {
          this.connected = false;
          this.initializing = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = DisconnectReason;
          
          console.log(`❌ Conexión cerrada. Código: ${statusCode}`);

          switch (statusCode) {
            case reason.loggedOut:
              // Sesión cerrada por el usuario - limpiar todo
              console.log('🚪 Sesión cerrada. Eliminando credenciales...');
              try {
                fs.rmSync(authDir, { recursive: true, force: true });
              } catch (e) {}
              this.qrCode = null;
              break;

            case reason.restartRequired:
              // Restart requerido - reconectar inmediatamente
              console.log('🔄 Restart requerido, reconectando...');
              setTimeout(() => this.initialize(), 1000);
              break;

            case reason.connectionClosed:
            case reason.connectionLost:
            case reason.timedOut:
            case reason.connectionReplaced:
              // Problemas de red - reconectar con backoff
              if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = Math.min(3000 * this.reconnectAttempts, 15000);
                console.log(`🔄 Reconectando... Intento ${this.reconnectAttempts}/${this.maxReconnectAttempts} (espera ${delay/1000}s)`);
                setTimeout(() => this.initialize(), delay);
              } else {
                console.log('❌ Máximo de intentos alcanzado. Usa /api/conectar para reintentar.');
                this.reconnectAttempts = 0;
              }
              break;

            case reason.badSession:
              // Sesión corrupta - limpiar y pedir nuevo QR
              console.log('🗑️ Sesión corrupta. Limpiando...');
              try {
                fs.rmSync(authDir, { recursive: true, force: true });
              } catch (e) {}
              setTimeout(() => this.initialize(), 2000);
              break;

            default:
              // Cualquier otro error
              if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                console.log(`🔄 Reconectando por error ${statusCode}... Intento ${this.reconnectAttempts}`);
                setTimeout(() => this.initialize(), 5000);
              }
              break;
          }
        } else if (connection === 'open') {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.qrCode = null;
          this.initializing = false;
          console.log('✅ WhatsApp conectado exitosamente!');
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
      this.initializing = false;
      return false;
    }
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  isConnected() {
    return this.connected && this.sock !== null;
  }

  getQrCode() {
    return {
      qr: this.qrCode,
      timestamp: this.qrTimestamp
    };
  }

  async getInfoSesion() {
    if (!this.connected || !this.sock) {
      return null;
    }
    
    try {
      const user = this.sock.user;
      return {
        nombre: user?.name || 'WhatsApp',
        telefono: user?.id?.split(':')[0] || 'N/A',
        plataforma: 'Baileys'
      };
    } catch (error) {
      return null;
    }
  }

  formatearNumero(telefono) {
    let limpio = telefono.toString().replace(/\D/g, '');
    if (limpio.startsWith('52') && limpio.length === 12) {
      return limpio + '@s.whatsapp.net';
    }
    if (limpio.length === 10) {
      return '52' + limpio + '@s.whatsapp.net';
    }
    return limpio + '@s.whatsapp.net';
  }

  async enviarMensaje(telefono, mensaje) {
    if (!this.connected || !this.sock) {
      return { exito: false, error: 'WhatsApp no conectado' };
    }

    try {
      const jid = this.formatearNumero(telefono);
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
        this.sock.ev.removeAllListeners();
        await this.sock.logout();
        this.sock = null;
      }
      this.connected = false;
      this.initializing = false;
      console.log('👋 Sesión cerrada');
    } catch (error) {
      console.error('Error cerrando sesión:', error.message);
      this.sock = null;
      this.connected = false;
      this.initializing = false;
    }
  }
}

module.exports = WhatsAppService;
