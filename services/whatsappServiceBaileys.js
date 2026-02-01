/**
 * Servicio WhatsApp con Baileys
 * LMV CREDIA SA DE CV
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
  }

  async initialize() {
    try {
      console.log('🔄 Inicializando WhatsApp...');
      
      const authDir = './auth_session';
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['CelExpress', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: false,
        fireInitQueries: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true
      });

      // Guardar credenciales
      this.sock.ev.on('creds.update', saveCreds);

      // Manejar conexión
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('📱 Nuevo código QR generado');
          this.qrCode = await qrcode.toDataURL(qr);
          this.qrTimestamp = Date.now();
        }

        if (connection === 'close') {
          this.connected = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          
          console.log(`❌ Conexión cerrada. Código: ${statusCode}`);
          
          if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconectando... Intento ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
            setTimeout(() => this.initialize(), 5000);
          } else if (statusCode === DisconnectReason.loggedOut) {
            console.log('🚪 Sesión cerrada. Eliminando credenciales...');
            fs.rmSync(authDir, { recursive: true, force: true });
          }
        } else if (connection === 'open') {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.qrCode = null;
          console.log('✅ WhatsApp conectado exitosamente!');
        }
      });

      // Escuchar mensajes entrantes
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid.includes('@g.us')) continue;
          
          if (this.onMessageCallback) {
            await this.onMessageCallback(msg);
          }
        }
      });

      return true;
    } catch (error) {
      console.error('❌ Error inicializando WhatsApp:', error.message);
      return false;
    }
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  isConnected() {
    return this.connected;
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
        await this.sock.logout();
        this.sock = null;
      }
      this.connected = false;
      console.log('👋 Sesión cerrada');
    } catch (error) {
      console.error('Error cerrando sesión:', error.message);
    }
  }
}

module.exports = WhatsAppService;
