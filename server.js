/**
 * ═══════════════════════════════════════════════════════════
 * CELEXPRESS - WHATSAPP MASIVO + CHATBOT
 * LMV CREDIA SA DE CV
 * ═══════════════════════════════════════════════════════════
 * 
 * Sistema completo de cobranza por WhatsApp:
 * - Envío masivo controlado (anti-baneo)
 * - ChatBot automático de respuestas
 * - Notificación a gestores
 * - API REST completa
 * 
 * Gestores:
 * - Lic. Alfonso: 5564304984
 * - Lic. Gisella: 5526889735
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');

const WhatsAppService = require('./services/whatsappServiceBaileys');
const EnvioMasivoService = require('./services/envioMasivoService');
const ChatBotCobranza = require('./services/chatbotCobranza');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ═══════════════════════════════════════════════════════════
// SERVICIOS
// ═══════════════════════════════════════════════════════════

const whatsappService = new WhatsAppService();
const envioMasivoService = new EnvioMasivoService(whatsappService);
const chatbot = new ChatBotCobranza(whatsappService);

let chatbotIniciado = false;

// Auto-iniciar WhatsApp al arrancar
whatsappService.initialize().then(() => {
  console.log('🚀 WhatsApp inicializado');
});

// Iniciar chatbot cuando conecte
setInterval(() => {
  if (whatsappService.isConnected() && !chatbotIniciado) {
    chatbot.iniciar();
    chatbotIniciado = true;
  }
}, 3000);

// ═══════════════════════════════════════════════════════════
// RUTAS DE CONEXIÓN
// ═══════════════════════════════════════════════════════════

app.post('/api/conectar', async (req, res) => {
  try {
    if (whatsappService.isConnected()) {
      return res.json({
        exito: true,
        mensaje: 'WhatsApp ya está conectado',
        info: await whatsappService.getInfoSesion()
      });
    }
    await whatsappService.initialize();
    setTimeout(async () => {
      res.json({
        exito: true,
        mensaje: 'Iniciando conexión...',
        info: await whatsappService.getInfoSesion()
      });
    }, 2000);
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: error.message });
  }
});

app.get('/api/estado', async (req, res) => {
  try {
    res.json({
      conectado: whatsappService.isConnected(),
      info: await whatsappService.getInfoSesion(),
      estadisticasEnvio: envioMasivoService.getEstadisticas(),
      chatbot: chatbot.getEstadisticas()
    });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: error.message });
  }
});

app.get('/api/qr', (req, res) => {
  if (whatsappService.isConnected()) {
    return res.json({ exito: true, conectado: true, qr: null });
  }
  const qrData = whatsappService.getQrCode();
  res.json({
    exito: true,
    conectado: false,
    qr: qrData.qr,
    timestamp: qrData.timestamp
  });
});

app.post('/api/desconectar', async (req, res) => {
  await whatsappService.cerrarSesion();
  chatbotIniciado = false;
  res.json({ exito: true, mensaje: 'Desconectado' });
});

// ═══════════════════════════════════════════════════════════
// RUTAS DE ENVÍO
// ═══════════════════════════════════════════════════════════

app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    if (!telefono || !mensaje) {
      return res.status(400).json({ exito: false, mensaje: 'Faltan telefono y mensaje' });
    }
    const resultado = await whatsappService.enviarMensaje(telefono, mensaje);
    res.json(resultado);
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: error.message });
  }
});

app.post('/api/subir-excel', upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ exito: false, mensaje: 'No se recibió archivo' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (data.length === 0) {
      return res.status(400).json({ exito: false, mensaje: 'Archivo vacío' });
    }

    // Cargar al chatbot
    const clientesChatbot = data.map(row => ({
      nombre: row.Cliente || row.nombre || row.Nombre,
      telefono: row.Teléfono || row.telefono || row.Telefono,
      saldo: parseFloat(row.Saldo || row.saldo || 0),
      diasAtraso: parseInt(row['Días Atraso'] || row.diasAtraso || 0)
    })).filter(c => c.telefono);
    
    chatbot.cargarCartera(clientesChatbot);

    res.json({
      exito: true,
      columnas: Object.keys(data[0]),
      totalRegistros: data.length,
      preview: data.slice(0, 5),
      datos: data,
      clientesChatbot: clientesChatbot.length
    });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: error.message });
  }
});

app.post('/api/enviar-masivo', async (req, res) => {
  try {
    const { contactos, plantilla, columnaTeléfono } = req.body;

    if (!contactos?.length || !plantilla) {
      return res.status(400).json({ exito: false, mensaje: 'Faltan contactos o plantilla' });
    }

    // Cargar al chatbot para que responda
    const clientesChatbot = contactos.map(c => ({
      nombre: c.Cliente || c.nombre,
      telefono: c[columnaTeléfono] || c.telefono,
      saldo: parseFloat(c.Saldo || c.saldo || c.monto || 0),
      diasAtraso: parseInt(c['Días Atraso'] || c.diasAtraso || 0)
    }));
    chatbot.cargarCartera(clientesChatbot);

    // Iniciar envío en background
    envioMasivoService.enviarMasivoFlexible(contactos, plantilla, columnaTeléfono);

    res.json({
      exito: true,
      mensaje: `Envío iniciado: ${contactos.length} contactos`,
      chatbotActivo: true
    });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: error.message });
  }
});

app.get('/api/estadisticas', (req, res) => {
  res.json({
    ...envioMasivoService.getEstadisticas(),
    chatbot: chatbot.getEstadisticas()
  });
});

// ═══════════════════════════════════════════════════════════
// RUTAS CHATBOT
// ═══════════════════════════════════════════════════════════

app.post('/api/chatbot/cartera', (req, res) => {
  try {
    const { clientes } = req.body;
    if (!Array.isArray(clientes)) {
      return res.status(400).json({ error: 'Se requiere array de clientes' });
    }
    const total = chatbot.cargarCartera(clientes);
    res.json({ exito: true, mensaje: `${clientes.length} clientes cargados`, total });
  } catch (error) {
    res.status(500).json({ exito: false, error: error.message });
  }
});

app.get('/api/chatbot/estadisticas', (req, res) => {
  res.json(chatbot.getEstadisticas());
});

app.get('/api/chatbot/interacciones', (req, res) => {
  const { limite, telefono } = req.query;
  res.json(chatbot.getInteracciones(parseInt(limite) || 50, telefono));
});

app.get('/api/chatbot/conversaciones', (req, res) => {
  res.json(chatbot.getConversaciones());
});

app.get('/api/chatbot/gestores', (req, res) => {
  res.json({ gestores: chatbot.gestores });
});

app.post('/api/chatbot/gestores', (req, res) => {
  const { gestores } = req.body;
  if (gestores) chatbot.gestores = gestores;
  res.json({ exito: true, gestores: chatbot.gestores });
});

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK (para Render/UptimeRobot)
// ═══════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    whatsapp: whatsappService.isConnected(),
    chatbot: chatbot.activo,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

// ═══════════════════════════════════════════════════════════
// INTERFAZ WEB
// ═══════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>CelExpress WhatsApp + ChatBot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #1F4E79; min-height: 100vh; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: white; text-align: center; margin-bottom: 20px; }
    .card { background: white; border-radius: 15px; padding: 25px; margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); }
    .card h2 { color: #1F4E79; margin-bottom: 15px; }
    .status { padding: 15px; border-radius: 10px; text-align: center; font-weight: bold; margin-bottom: 15px; }
    .status.ok { background: #d4edda; color: #155724; }
    .status.error { background: #f8d7da; color: #721c24; }
    .status.loading { background: #fff3cd; color: #856404; }
    .btn { padding: 12px 25px; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; margin: 5px; }
    .btn-primary { background: #1F4E79; color: white; }
    .btn-success { background: #28a745; color: white; }
    .btn-danger { background: #dc3545; color: white; }
    .qr-container { text-align: center; padding: 20px; }
    .qr-container img { max-width: 250px; border-radius: 10px; }
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
    .stat { background: #f8f9fa; padding: 20px; border-radius: 10px; text-align: center; }
    .stat h3 { font-size: 2rem; color: #1F4E79; }
    .stat p { color: #666; font-size: 0.9rem; }
    .gestores { margin-top: 15px; }
    .gestor { background: #e8f4fd; padding: 10px 15px; border-radius: 8px; margin: 5px 0; display: flex; justify-content: space-between; }
    .log { background: #f8f9fa; border-radius: 10px; padding: 15px; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 0.85rem; }
    .log-item { padding: 5px 0; border-bottom: 1px solid #eee; }
    .footer { text-align: center; color: rgba(255,255,255,0.7); margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 CelExpress WhatsApp + ChatBot</h1>
    
    <div class="card">
      <h2>📱 Estado de WhatsApp</h2>
      <div class="status loading" id="status">Verificando conexión...</div>
      <div id="qrArea"></div>
      <div style="text-align:center;">
        <button class="btn btn-primary" onclick="conectar()">Conectar</button>
        <button class="btn btn-success" onclick="verificarQR()">Ver QR</button>
        <button class="btn btn-danger" onclick="desconectar()">Desconectar</button>
      </div>
    </div>
    
    <div class="card">
      <h2>📊 Estadísticas del ChatBot</h2>
      <div class="stats">
        <div class="stat"><h3 id="sClientes">0</h3><p>Clientes</p></div>
        <div class="stat"><h3 id="sConv">0</h3><p>Conversaciones</p></div>
        <div class="stat"><h3 id="sInter">0</h3><p>Interacciones Hoy</p></div>
        <div class="stat"><h3 id="sBot">-</h3><p>ChatBot</p></div>
      </div>
    </div>
    
    <div class="card">
      <h2>👥 Gestores</h2>
      <div class="gestores" id="gestores"></div>
    </div>
    
    <div class="card">
      <h2>📋 Últimas Interacciones</h2>
      <div class="log" id="log">Cargando...</div>
    </div>
    
    <p class="footer">LMV CREDIA SA DE CV - Sistema de Cobranza</p>
  </div>
  
  <script>
    async function cargarEstado() {
      try {
        const res = await fetch('/api/estado');
        const d = await res.json();
        const st = document.getElementById('status');
        
        if (d.conectado) {
          st.className = 'status ok';
          st.innerHTML = '✅ CONECTADO - ' + (d.info?.nombre || 'WhatsApp');
          document.getElementById('qrArea').innerHTML = '';
        } else {
          st.className = 'status error';
          st.innerHTML = '❌ DESCONECTADO - Escanea el QR';
        }
        
        if (d.chatbot) {
          document.getElementById('sClientes').textContent = d.chatbot.clientesRegistrados || 0;
          document.getElementById('sConv').textContent = d.chatbot.conversacionesActivas || 0;
          document.getElementById('sInter').textContent = d.chatbot.interaccionesHoy || 0;
          document.getElementById('sBot').textContent = d.chatbot.activo ? '✅ Activo' : '⏸️ Pausado';
          
          document.getElementById('gestores').innerHTML = (d.chatbot.gestores || []).map(g =>
            '<div class="gestor"><span>👤 ' + g.nombre + '</span><span>📱 ' + g.telefono + '</span></div>'
          ).join('');
        }
      } catch (e) { console.error(e); }
    }
    
    async function cargarInteracciones() {
      try {
        const res = await fetch('/api/chatbot/interacciones?limite=15');
        const data = await res.json();
        document.getElementById('log').innerHTML = data.reverse().map(i =>
          '<div class="log-item"><small>' + new Date(i.timestamp).toLocaleTimeString() + '</small> ' +
          '<strong>' + i.telefono + '</strong>: ' + i.tipo + ' - ' + (i.detalle || '').substring(0,40) + '</div>'
        ).join('') || 'Sin interacciones';
      } catch (e) {}
    }
    
    async function conectar() {
      document.getElementById('status').className = 'status loading';
      document.getElementById('status').textContent = 'Conectando...';
      await fetch('/api/conectar', { method: 'POST' });
      setTimeout(verificarQR, 2000);
    }
    
    async function verificarQR() {
      const res = await fetch('/api/qr');
      const d = await res.json();
      if (d.qr) {
        document.getElementById('qrArea').innerHTML = '<div class="qr-container"><p>📱 Escanea con WhatsApp:</p><img src="' + d.qr + '"></div>';
      } else if (d.conectado) {
        document.getElementById('qrArea').innerHTML = '<p style="text-align:center;color:green;">✅ Ya conectado</p>';
      }
      setTimeout(cargarEstado, 3000);
    }
    
    async function desconectar() {
      await fetch('/api/desconectar', { method: 'POST' });
      cargarEstado();
    }
    
    cargarEstado();
    cargarInteracciones();
    setInterval(cargarEstado, 5000);
    setInterval(cargarInteracciones, 10000);
  </script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🚀 CELEXPRESS WHATSAPP + CHATBOT');
  console.log('   LMV CREDIA SA DE CV');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📡 Servidor: http://localhost:${PORT}`);
  console.log('🤖 ChatBot: Esperando conexión WhatsApp...');
  console.log('👥 Gestores: Lic. Alfonso, Lic. Gisella');
  console.log('═══════════════════════════════════════════════════════════\n');
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Cerrando servidor...');
  await whatsappService.cerrarSesion();
  process.exit(0);
});
