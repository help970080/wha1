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
 * - Panel de control web
 * - API REST completa
 * 
 * Gestores:
 * - Lic. Carlos: 7352588215
 * - Lic. Gustavo: 5548039744
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const WhatsAppService = require('./services/whatsappServiceBaileys');
const EnvioMasivoService = require('./services/envioMasivoService');
const ChatBotCobranza = require('./services/chatbotCobranza');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer para archivos (Excel + imágenes)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ═══════════════════════════════════════════════════════════
// SERVICIOS
// ═══════════════════════════════════════════════════════════

const whatsappService = new WhatsAppService();
const chatbot = new ChatBotCobranza(whatsappService);
const envioMasivoService = new EnvioMasivoService(whatsappService, chatbot);

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
    
    // Registrar handler de mensajes ENTRANTES (respuestas de clientes)
    whatsappService.onMessage(async (msg) => {
      try {
        const remoteJid = msg.key.remoteJid;
        let telefono = remoteJid.split('@')[0];
        
        // Resolver LID a telefono real
        // Primero: buscar en el mapa LID del whatsappService (se llena al enviar)
        const lidResuelto = whatsappService.resolverLID(telefono);
        if (lidResuelto) {
          console.log(`🔗 LID ${telefono} resuelto a ${lidResuelto} via lidMap`);
          telefono = lidResuelto;
        } else if (telefono.length > 13 || !telefono.match(/^52[1-9]/)) {
          // Segundo: buscar en chatbot
          const telResuelto = chatbot.resolverTelefono ? chatbot.resolverTelefono(telefono) : null;
          if (telResuelto) {
            console.log(`🔗 LID ${telefono} resuelto a ${telResuelto} via chatbot`);
            telefono = telResuelto;
          }
        }
        
        // Limpiar: quitar 521 o 52 para dejar 10 digitos
        let tel10 = telefono.replace(/\D/g, '');
        if (tel10.startsWith('521') && tel10.length === 13) tel10 = tel10.slice(3);
        else if (tel10.startsWith('52') && tel10.length === 12) tel10 = tel10.slice(2);
        
        const texto = msg.message?.conversation 
          || msg.message?.extendedTextMessage?.text 
          || msg.message?.imageMessage?.caption
          || '[media]';
        const nombre = msg.pushName || tel10;
        
        console.log(`📩 Respuesta de ${nombre} (${tel10}): ${texto.substring(0, 80)}`);
        
        // Registrar en chatbot local
        chatbot.registrarInteraccion(tel10, 'recibido', texto, remoteJid);
        
        // Notificar al panel fantasmas (guardar en seguimiento_log)
        const panelBase = process.env.FANTASMA_PANEL_URL || 'https://fantasma-rpgh.onrender.com';
        
        try {
          const resp = await fetch(panelBase + '/api/respuesta-cliente', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                telefono: tel10,
                mensaje: texto.substring(0, 500),
                nombre: nombre,
                timestamp: new Date().toISOString()
              })
            });
          const respData = await resp.json();
          if (respData.success) {
            console.log(`✅ Respuesta de ${tel10} guardada en panel fantasmas`);
          } else {
            console.log(`❌ Panel fantasmas rechazó: ${respData.error || 'unknown'}`);
          }
        } catch(e) {
          console.log(`❌ Error enviando respuesta al panel: ${e.message}`);
        }
      } catch(e) {
        console.error('Error procesando mensaje entrante:', e.message);
      }
    });
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
      progreso: envioMasivoService.getProgreso(),
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
// RUTAS DE ENVÍO MASIVO (NUEVO)
// ═══════════════════════════════════════════════════════════

// Subir Excel y previsualizar
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

    // Cargar al chatbot para que responda cuando contesten
    const clientesChatbot = data.map(row => {
      const obj = {
        nombre: row.nombre || row.Nombre || row.Cliente || row.NOMBRE || 'Cliente',
        telefono: row.telefono || row.Telefono || row.Teléfono || row.TELEFONO || '',
        saldo: parseFloat(row.saldo ?? row.Saldo ?? row.SALDO ?? 0) || 0,
        diasAtraso: parseInt(row.diasAtraso ?? row.DiasAtraso ?? row['Días Atraso'] ?? row.DIASATRASO ?? 0) || 0
      };
      return obj;
    }).filter(c => c.telefono);
    
    // Debug: ver qué se cargó
    if (clientesChatbot.length > 0) {
      const ej = clientesChatbot[0];
      console.log(`📋 Ejemplo cartera: ${ej.nombre} | tel:${ej.telefono} | saldo:${ej.saldo} | dias:${ej.diasAtraso}`);
    }
    
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

// Iniciar campaña masiva
app.post('/api/campana/iniciar', upload.single('imagen'), async (req, res) => {
  try {
    let { contactos, plantilla, nombreCampana, config } = req.body;

    // Parse JSON strings (vienen del FormData)
    if (typeof contactos === 'string') contactos = JSON.parse(contactos);
    if (typeof config === 'string') config = JSON.parse(config);

    // Imagen si viene
    let imagen = null;
    if (req.file) {
      imagen = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    } else if (req.body.imagenBase64) {
      imagen = req.body.imagenBase64;
    } else if (req.body.imagenUrl) {
      imagen = req.body.imagenUrl;
    }

    const resultado = await envioMasivoService.iniciarCampana({
      contactos,
      plantilla,
      imagen,
      nombreCampana,
      config,
    });

    res.json(resultado);
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: error.message });
  }
});

// Pausar campaña
app.post('/api/campana/pausar', (req, res) => {
  const ok = envioMasivoService.pausar();
  res.json({ exito: ok, mensaje: ok ? 'Campaña pausada' : 'No hay campaña activa o ya está pausada' });
});

// Reanudar campaña
app.post('/api/campana/reanudar', (req, res) => {
  const ok = envioMasivoService.reanudar();
  res.json({ exito: ok, mensaje: ok ? 'Campaña reanudada' : 'No hay campaña pausada' });
});

// Cancelar campaña
app.post('/api/campana/cancelar', (req, res) => {
  const ok = envioMasivoService.cancelar();
  res.json({ exito: ok, mensaje: ok ? 'Campaña cancelada' : 'No hay campaña activa' });
});

// Force reset (cuando se traba)
app.post('/api/campana/reset', (req, res) => {
  envioMasivoService.forceReset();
  res.json({ exito: true, mensaje: 'Reset completo' });
});

// Limpiar cache de clientes (borrar JSON viejo)
app.post('/api/chatbot/limpiar', (req, res) => {
  try {
    const fs = require('fs');
    if (fs.existsSync('chatbot_clientes.json')) {
      fs.unlinkSync('chatbot_clientes.json');
    }
    chatbot.clientes.clear();
    chatbot.conversaciones.clear();
    res.json({ exito: true, mensaje: 'Cache limpiado. Sube el Excel de nuevo.' });
  } catch (e) {
    res.status(500).json({ exito: false, mensaje: e.message });
  }
});

// Progreso en tiempo real
app.get('/api/campana/progreso', (req, res) => {
  res.json(envioMasivoService.getProgreso());
});

// Detalle de la cola
app.get('/api/campana/detalle', (req, res) => {
  res.json(envioMasivoService.getDetalleCola());
});

// Estadísticas completas
app.get('/api/campana/estadisticas', (req, res) => {
  res.json(envioMasivoService.getEstadisticas());
});

// Log en tiempo real del envío masivo
app.get('/api/campana/logs', (req, res) => {
  const limite = parseInt(req.query.limite) || 50;
  res.json(envioMasivoService.getLogs(limite));
});

// Conversación completa de un teléfono (ida y vuelta)
app.get('/api/conversacion/:telefono', (req, res) => {
  const tel = req.params.telefono;
  const interacciones = chatbot.getInteracciones(100, tel);
  const cliente = chatbot.obtenerCliente(tel);
  const conv = chatbot.obtenerConversacion(tel);
  res.json({
    cliente,
    estado: conv.estado || 'sin_conversacion',
    gestor: conv.gestor || null,
    mensajes: interacciones,
  });
});

// Actualizar configuración de delays
app.post('/api/campana/config', (req, res) => {
  const config = envioMasivoService.actualizarConfig(req.body);
  res.json({ exito: true, config });
});

// Enviar mensaje individual (test)
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

// Compatibilidad con envío masivo viejo
app.post('/api/enviar-masivo', async (req, res) => {
  try {
    const { contactos, plantilla, columnaTeléfono } = req.body;

    if (!contactos?.length || !plantilla) {
      return res.status(400).json({ exito: false, mensaje: 'Faltan contactos o plantilla' });
    }

    const clientesChatbot = contactos.map(c => ({
      nombre: c.Cliente || c.nombre,
      telefono: c[columnaTeléfono] || c.telefono,
      saldo: parseFloat(c.Saldo || c.saldo || c.monto || 0),
      diasAtraso: parseInt(c['Días Atraso'] || c.diasAtraso || 0)
    }));
    chatbot.cargarCartera(clientesChatbot);

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
// EXPORTAR A EXCEL
// ═══════════════════════════════════════════════════════════

app.get('/api/exportar/interacciones', (req, res) => {
  try {
    const interacciones = chatbot.getInteracciones(500);
    if (interacciones.length === 0) {
      return res.status(404).json({ error: 'No hay interacciones para exportar' });
    }
    const datos = interacciones.map(i => ({
      'Fecha': new Date(i.timestamp).toLocaleDateString('es-MX'),
      'Hora': new Date(i.timestamp).toLocaleTimeString('es-MX'),
      'Teléfono': i.telefono,
      'Tipo': i.tipo,
      'Detalle': i.detalle
    }));
    const ws = XLSX.utils.json_to_sheet(datos);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Interacciones');
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 50 }];
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fecha = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Interacciones_${fecha}.xlsx`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/exportar/conversaciones', (req, res) => {
  try {
    const conversaciones = chatbot.getConversaciones();
    if (conversaciones.length === 0) {
      return res.status(404).json({ error: 'No hay conversaciones activas' });
    }
    const datos = conversaciones.map(c => ({
      'Teléfono': c.telefono,
      'Estado': c.estado,
      'Gestor Asignado': c.gestor?.nombre || 'N/A',
      'Última Actividad': c.timestamp ? new Date(c.timestamp).toLocaleString('es-MX') : 'N/A'
    }));
    const ws = XLSX.utils.json_to_sheet(datos);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Conversaciones');
    ws['!cols'] = [{ wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fecha = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Conversaciones_${fecha}.xlsx`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/exportar/clientes', (req, res) => {
  try {
    const clientes = [...chatbot.clientes.values()];
    if (clientes.length === 0) {
      return res.status(404).json({ error: 'No hay clientes cargados' });
    }
    const datos = clientes.map(c => ({
      'Nombre': c.nombre || 'N/A',
      'Teléfono': c.telefono || 'N/A',
      'Saldo': c.saldo || 0,
      'Días Atraso': c.diasAtraso || 0
    }));
    const ws = XLSX.utils.json_to_sheet(datos);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
    ws['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 12 }, { wch: 12 }];
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fecha = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Clientes_Bot_${fecha}.xlsx`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/exportar/reporte', (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const fecha = new Date().toISOString().split('T')[0];
    
    const stats = chatbot.getEstadisticas();
    const resumen = [
      { 'Métrica': 'Clientes Registrados', 'Valor': stats.clientesRegistrados },
      { 'Métrica': 'Conversaciones Activas', 'Valor': stats.conversacionesActivas },
      { 'Métrica': 'Interacciones Hoy', 'Valor': stats.interaccionesHoy },
      { 'Métrica': 'ChatBot Activo', 'Valor': stats.activo ? 'Sí' : 'No' },
      { 'Métrica': 'Fecha Reporte', 'Valor': new Date().toLocaleString('es-MX') }
    ];
    const wsResumen = XLSX.utils.json_to_sheet(resumen);
    wsResumen['!cols'] = [{ wch: 25 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');
    
    const interacciones = chatbot.getInteracciones(500).map(i => ({
      'Fecha': new Date(i.timestamp).toLocaleDateString('es-MX'),
      'Hora': new Date(i.timestamp).toLocaleTimeString('es-MX'),
      'Teléfono': i.telefono,
      'Tipo': i.tipo,
      'Detalle': i.detalle
    }));
    if (interacciones.length > 0) {
      const wsInter = XLSX.utils.json_to_sheet(interacciones);
      wsInter['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 50 }];
      XLSX.utils.book_append_sheet(wb, wsInter, 'Interacciones');
    }
    
    const conversaciones = chatbot.getConversaciones().map(c => ({
      'Teléfono': c.telefono,
      'Estado': c.estado,
      'Gestor': c.gestor?.nombre || 'N/A',
      'Última Actividad': c.timestamp ? new Date(c.timestamp).toLocaleString('es-MX') : 'N/A'
    }));
    if (conversaciones.length > 0) {
      const wsConv = XLSX.utils.json_to_sheet(conversaciones);
      wsConv['!cols'] = [{ wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, wsConv, 'Conversaciones');
    }
    
    const gestores = stats.gestores.map(g => ({
      'Nombre': g.nombre,
      'Teléfono': g.telefono,
      'Activo': g.activo ? 'Sí' : 'No'
    }));
    const wsGest = XLSX.utils.json_to_sheet(gestores);
    wsGest['!cols'] = [{ wch: 20 }, { wch: 15 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsGest, 'Gestores');
    
    // Hoja 5: Resultados de campaña masiva
    const detalleCola = envioMasivoService.getDetalleCola();
    if (detalleCola.length > 0) {
      const wsCamp = XLSX.utils.json_to_sheet(detalleCola.map(d => ({
        'Nombre': d.nombre,
        'Teléfono': d.telefono,
        'Estado': d.estado,
        'Error': d.error || '',
        'Enviado': d.enviadoEn || ''
      })));
      wsCamp['!cols'] = [{ wch: 25 }, { wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, wsCamp, 'Campaña Masiva');
    }
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Reporte_ChatBot_${fecha}.xlsx`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// INTEGRACION FANTASMA-RPGH (NUEVO)
// Endpoints para que el sistema de seguimiento de fantasmas
// pueda enviar mensajes individuales via este bot.
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/status
 * Health check publico para que fantasma-rpgh sepa si el bot esta conectado.
 * Sin autenticacion (es solo lectura de estado).
 */
app.get('/api/status', (req, res) => {
  try {
    res.json({
      ok: true,
      conectado: whatsappService.isConnected(),
      chatbotActivo: chatbot.activo || false,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/enviar-individual
 * Endpoint AUTENTICADO para enviar UN mensaje desde otro servicio.
 * 
 * Headers requeridos:
 *   Content-Type: application/json
 *   Authorization: Bearer <BOT_API_TOKEN>
 * 
 * Body: { "telefono": "525512345678", "mensaje": "Hola..." }
 * 
 * Configurar variable de entorno BOT_API_TOKEN en Render.
 */
app.post('/api/enviar-individual', async (req, res) => {
  try {
    // 1. Validar token
    const tokenEsperado = process.env.BOT_API_TOKEN;
    if (!tokenEsperado) {
      return res.status(500).json({ 
        success: false, 
        error: 'BOT_API_TOKEN no configurado en variables de entorno' 
      });
    }
    
    const authHeader = req.headers.authorization || '';
    const tokenRecibido = authHeader.replace(/^Bearer\s+/i, '').trim();
    
    if (tokenRecibido !== tokenEsperado) {
      console.warn('[API] Intento de envio con token invalido');
      return res.status(401).json({ 
        success: false, 
        error: 'Token invalido' 
      });
    }
    
    // 2. Validar parametros
    const { telefono, mensaje } = req.body;
    
    if (!telefono || !mensaje) {
      return res.status(400).json({ 
        success: false, 
        error: 'telefono y mensaje son requeridos' 
      });
    }
    
    // 3. Verificar que WhatsApp este conectado
    if (!whatsappService.isConnected()) {
      return res.status(503).json({ 
        success: false, 
        error: 'WhatsApp no conectado. Escanea el QR primero.' 
      });
    }
    
    // 4. Enviar mensaje usando el servicio existente
    console.log('[API] Enviando a ' + telefono + ': ' + String(mensaje).substring(0, 50) + '...');
    
    const resultado = await whatsappService.enviarMensaje(telefono, mensaje);
    
    // 5. Registrar interaccion en el chatbot (para que aparezca en logs)
    try {
      if (resultado && (resultado.exito === true || resultado.success === true)) {
        chatbot.registrarInteraccion(
          telefono, 
          'enviado', 
          '[Fantasma] ' + String(mensaje).substring(0, 50),
          telefono + '@s.whatsapp.net'
        );
      }
    } catch(e) { /* no romper si falla el log */ }
    
    // 6. Respuesta uniforme con success
    const exito = resultado && (resultado.exito === true || resultado.success === true);
    
    res.json({
      success: exito,
      message: exito ? 'Mensaje enviado' : 'Falla al enviar',
      detalle: resultado,
      telefono: telefono,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[API] Error en /api/enviar-individual:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ═══════════════════════════════════════════════════════════
// VERIFICAR SI NUMERO EXISTE EN WHATSAPP
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/verificar-numero
 * Verifica si un numero tiene WhatsApp.
 * Body: { "telefono": "5512345678" }
 * Respuesta: { "success": true, "existe": true/false, "telefono": "..." }
 */
app.post('/api/verificar-numero', async (req, res) => {
  try {
    const tokenEsperado = process.env.BOT_API_TOKEN;
    if (tokenEsperado) {
      const authHeader = req.headers.authorization || '';
      const tokenRecibido = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (tokenRecibido !== tokenEsperado) {
        return res.status(401).json({ success: false, error: 'Token invalido' });
      }
    }

    const { telefono } = req.body;
    if (!telefono) {
      return res.status(400).json({ success: false, error: 'telefono requerido' });
    }

    if (!whatsappService.isConnected()) {
      return res.status(503).json({ success: false, error: 'WhatsApp no conectado' });
    }

    const jid = whatsappService.formatearNumero(telefono);
    const numero = jid.split('@')[0];

    try {
      const [result] = await whatsappService.sock.onWhatsApp(numero);
      const existe = !!(result && result.exists);
      res.json({ success: true, existe, telefono, jid: result?.jid || jid });
    } catch (e) {
      res.json({ success: true, existe: false, telefono, error: e.message });
    }

  } catch (error) {
    console.error('[API] Error verificar-numero:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/verificar-lote
 * Verifica multiples numeros. Delay de 2s entre cada uno para no disparar alarmas.
 * Body: { "telefonos": ["5512345678", "5598765432", ...] }
 * Respuesta: { "success": true, "resultados": [{ "telefono": "...", "existe": true/false }, ...] }
 * Max 50 numeros por llamada para evitar timeout.
 */
app.post('/api/verificar-lote', async (req, res) => {
  try {
    const tokenEsperado = process.env.BOT_API_TOKEN;
    if (tokenEsperado) {
      const authHeader = req.headers.authorization || '';
      const tokenRecibido = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (tokenRecibido !== tokenEsperado) {
        return res.status(401).json({ success: false, error: 'Token invalido' });
      }
    }

    const { telefonos } = req.body;
    if (!telefonos || !Array.isArray(telefonos) || telefonos.length === 0) {
      return res.status(400).json({ success: false, error: 'telefonos (array) requerido' });
    }

    if (telefonos.length > 50) {
      return res.status(400).json({ success: false, error: 'Maximo 50 numeros por llamada' });
    }

    if (!whatsappService.isConnected()) {
      return res.status(503).json({ success: false, error: 'WhatsApp no conectado' });
    }

    const resultados = [];
    for (let i = 0; i < telefonos.length; i++) {
      const tel = telefonos[i];
      try {
        const jid = whatsappService.formatearNumero(tel);
        const numero = jid.split('@')[0];
        const [result] = await whatsappService.sock.onWhatsApp(numero);
        resultados.push({ telefono: tel, existe: !!(result && result.exists) });
      } catch (e) {
        resultados.push({ telefono: tel, existe: false, error: e.message });
      }

      // Delay 2s entre verificaciones para no disparar alarmas
      if (i < telefonos.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const conWhatsApp = resultados.filter(r => r.existe).length;
    const sinWhatsApp = resultados.filter(r => !r.existe).length;
    console.log(`[API] Verificacion lote: ${conWhatsApp} con WA, ${sinWhatsApp} sin WA (de ${telefonos.length})`);

    res.json({ success: true, resultados, conWhatsApp, sinWhatsApp, total: telefonos.length });

  } catch (error) {
    console.error('[API] Error verificar-lote:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    whatsapp: whatsappService.isConnected(),
    chatbot: chatbot.activo,
    envioMasivo: envioMasivoService.getProgreso(),
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => res.send('pong'));

// ═══════════════════════════════════════════════════════════
// INTERFAZ WEB — PANEL DE CONTROL
// ═══════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.send(getPanelHTML());
});

// ═══════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🚀 CELEXPRESS WHATSAPP + CHATBOT + ENVÍO MASIVO');
  console.log('   LMV CREDIA SA DE CV');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📡 Servidor: http://localhost:${PORT}`);
  console.log('🤖 ChatBot: Esperando conexión WhatsApp...');
  console.log('📤 Envío Masivo: Listo (anti-baneo activado)');
  console.log('👥 Gestores: Lic. Carlos, Lic. Gustavo');
  console.log('═══════════════════════════════════════════════════════════\n');
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Cerrando servidor...');
  envioMasivoService.cancelar();
  await whatsappService.cerrarSesion();
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════
// HTML DEL PANEL
// ═══════════════════════════════════════════════════════════

function getPanelHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <title>CelExpress - Panel de Control</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0B1120;
      --bg2: #111827;
      --card: #1A2332;
      --border: #2A3A4E;
      --text: #E2E8F0;
      --muted: #8896A6;
      --accent: #3B82F6;
      --green: #10B981;
      --green-bg: rgba(16,185,129,0.12);
      --red: #EF4444;
      --red-bg: rgba(239,68,68,0.12);
      --yellow: #F59E0B;
      --yellow-bg: rgba(245,158,11,0.12);
      --purple: #8B5CF6;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'DM Sans',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    
    .header { background:var(--bg2); border-bottom:1px solid var(--border); padding:16px 24px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:10; }
    .header h1 { font-size:1.1rem; font-weight:700; display:flex; align-items:center; gap:10px; }
    .header h1 span { color:var(--accent); }
    .conn-badge { padding:6px 14px; border-radius:20px; font-size:0.78rem; font-weight:600; }
    .conn-badge.on { background:var(--green-bg); color:var(--green); }
    .conn-badge.off { background:var(--red-bg); color:var(--red); }
    
    .container { max-width:1200px; margin:0 auto; padding:20px; }
    .grid { display:grid; gap:16px; }
    .grid-2 { grid-template-columns:1fr 1fr; }
    .grid-3 { grid-template-columns:1fr 1fr 1fr; }
    .grid-4 { grid-template-columns:repeat(4,1fr); }
    @media(max-width:900px) { .grid-2,.grid-3,.grid-4 { grid-template-columns:1fr; } }
    
    .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px; }
    .card h2 { font-size:0.85rem; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:14px; display:flex; align-items:center; gap:8px; }
    
    .stat-card { text-align:center; }
    .stat-card .num { font-size:2rem; font-weight:700; font-family:'JetBrains Mono',monospace; }
    .stat-card .label { font-size:0.78rem; color:var(--muted); margin-top:4px; }
    .num.green { color:var(--green); }
    .num.yellow { color:var(--yellow); }
    .num.red { color:var(--red); }
    .num.blue { color:var(--accent); }
    
    .btn { padding:10px 18px; border:none; border-radius:8px; cursor:pointer; font-family:inherit; font-weight:600; font-size:0.82rem; transition:all 0.15s; display:inline-flex; align-items:center; gap:6px; }
    .btn:hover { transform:translateY(-1px); filter:brightness(1.1); }
    .btn:active { transform:translateY(0); }
    .btn-primary { background:var(--accent); color:white; }
    .btn-green { background:var(--green); color:white; }
    .btn-red { background:var(--red); color:white; }
    .btn-yellow { background:var(--yellow); color:#1a1a1a; }
    .btn-outline { background:transparent; border:1px solid var(--border); color:var(--text); }
    .btn:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
    .btn-sm { padding:6px 12px; font-size:0.75rem; }
    
    .progress-bar { width:100%; height:8px; background:var(--bg); border-radius:4px; overflow:hidden; margin:12px 0; }
    .progress-fill { height:100%; background:linear-gradient(90deg,var(--accent),var(--green)); border-radius:4px; transition:width 0.5s ease; }
    
    textarea, input[type=text], input[type=number], select {
      width:100%; padding:10px 14px; background:var(--bg); border:1px solid var(--border);
      border-radius:8px; color:var(--text); font-family:inherit; font-size:0.85rem; resize:vertical;
    }
    textarea:focus, input:focus, select:focus { outline:none; border-color:var(--accent); }
    label { font-size:0.8rem; font-weight:500; color:var(--muted); margin-bottom:6px; display:block; }
    
    .file-drop { border:2px dashed var(--border); border-radius:12px; padding:24px; text-align:center; cursor:pointer; transition:all 0.2s; }
    .file-drop:hover { border-color:var(--accent); background:rgba(59,130,246,0.05); }
    .file-drop.active { border-color:var(--green); background:rgba(16,185,129,0.05); }
    .file-drop p { color:var(--muted); font-size:0.82rem; margin-top:6px; }
    
    .log-panel { background:var(--bg); border-radius:8px; padding:12px; max-height:280px; overflow-y:auto; font-family:'JetBrains Mono',monospace; font-size:0.73rem; }
    .log-line { padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.04); display:flex; gap:8px; align-items:flex-start; }
    .log-time { color:var(--muted); min-width:55px; flex-shrink:0; }
    .log-ok { color:var(--green); }
    .log-err { color:var(--red); }
    .log-info { color:var(--accent); }
    .log-tag { display:inline-block; padding:1px 6px; border-radius:3px; font-size:0.65rem; font-weight:600; margin-right:4px; }
    .log-tag.ok { background:var(--green-bg); color:var(--green); }
    .log-tag.err { background:var(--red-bg); color:var(--red); }
    .log-tag.in { background:rgba(59,130,246,0.15); color:var(--accent); }
    .log-tag.out { background:rgba(139,92,246,0.15); color:var(--purple); }
    
    .tag { display:inline-block; padding:3px 8px; border-radius:4px; font-size:0.7rem; font-weight:600; }
    .tag-ok { background:var(--green-bg); color:var(--green); }
    .tag-err { background:var(--red-bg); color:var(--red); }
    .tag-wait { background:var(--yellow-bg); color:var(--yellow); }
    .tag-info { background:rgba(59,130,246,0.12); color:var(--accent); }
    
    .controls { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    .gestor-row { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:var(--bg); border-radius:8px; margin-bottom:6px; }
    .vars-help { background:var(--bg); border-radius:8px; padding:10px 14px; font-size:0.78rem; color:var(--muted); margin-top:8px; }
    .vars-help code { background:var(--card); padding:2px 6px; border-radius:4px; color:var(--accent); font-family:'JetBrains Mono',monospace; }
    .hidden { display:none !important; }
    #qrArea img { max-width:220px; border-radius:8px; margin:12px auto; display:block; }
    
    .preview-table { width:100%; font-size:0.75rem; border-collapse:collapse; margin-top:10px; }
    .preview-table th { text-align:left; padding:5px 8px; color:var(--muted); border-bottom:1px solid var(--border); font-weight:600; }
    .preview-table td { padding:5px 8px; border-bottom:1px solid rgba(255,255,255,0.03); }
    
    /* Tabs */
    .tabs { display:flex; gap:0; border-bottom:1px solid var(--border); margin-bottom:14px; }
    .tab { padding:10px 18px; cursor:pointer; font-size:0.82rem; font-weight:500; color:var(--muted); border-bottom:2px solid transparent; transition:all 0.15s; }
    .tab:hover { color:var(--text); }
    .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
    .tab-content { display:none; }
    .tab-content.active { display:block; }
    
    /* Conversation viewer */
    .conv-list { max-height:300px; overflow-y:auto; }
    .conv-item { padding:10px 12px; background:var(--bg); border-radius:8px; margin-bottom:6px; cursor:pointer; transition:all 0.15s; display:flex; justify-content:space-between; align-items:center; }
    .conv-item:hover { background:rgba(59,130,246,0.08); border:1px solid var(--accent); margin:-1px; padding:9px 11px; }
    .conv-name { font-weight:600; font-size:0.85rem; }
    .conv-tel { color:var(--muted); font-size:0.75rem; font-family:'JetBrains Mono',monospace; }
    
    .chat-view { background:var(--bg); border-radius:8px; padding:14px; max-height:350px; overflow-y:auto; }
    .chat-msg { margin-bottom:10px; max-width:85%; }
    .chat-msg.sent { margin-left:auto; }
    .chat-msg .bubble { padding:10px 14px; border-radius:12px; font-size:0.82rem; line-height:1.4; }
    .chat-msg.received .bubble { background:var(--card); border:1px solid var(--border); border-bottom-left-radius:4px; }
    .chat-msg.sent .bubble { background:rgba(59,130,246,0.2); border:1px solid rgba(59,130,246,0.3); border-bottom-right-radius:4px; }
    .chat-msg .meta { font-size:0.65rem; color:var(--muted); margin-top:3px; padding:0 4px; }
    .chat-msg.sent .meta { text-align:right; }
    
    /* Queue table */
    .queue-table { width:100%; font-size:0.75rem; border-collapse:collapse; }
    .queue-table th { text-align:left; padding:8px; color:var(--muted); border-bottom:1px solid var(--border); font-weight:600; position:sticky; top:0; background:var(--card); }
    .queue-table td { padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.03); }
    .queue-scroll { max-height:350px; overflow-y:auto; }
  </style>
</head>
<body>

<div class="header">
  <h1>📡 <span>CelExpress</span> WhatsApp Bot</h1>
  <span class="conn-badge off" id="connBadge">● Desconectado</span>
</div>

<div class="container">

  <!-- Stats row -->
  <div class="grid grid-4" style="margin-bottom:16px;">
    <div class="card stat-card"><div class="num green" id="sEnviados">0</div><div class="label">Enviados hoy</div></div>
    <div class="card stat-card"><div class="num blue" id="sClientes">0</div><div class="label">Clientes cargados</div></div>
    <div class="card stat-card"><div class="num yellow" id="sConv">0</div><div class="label">Conversaciones</div></div>
    <div class="card stat-card"><div class="num" id="sBot" style="color:var(--muted)">—</div><div class="label">ChatBot</div></div>
  </div>

  <div class="grid grid-2">
    
    <!-- ═══ COLUMNA IZQUIERDA ═══ -->
    <div>
      <!-- Conexión -->
      <div class="card" style="margin-bottom:16px;">
        <h2>📱 Conexión WhatsApp</h2>
        <div id="qrArea"></div>
        <div class="controls">
          <button class="btn btn-primary" onclick="conectar()">Conectar</button>
          <button class="btn btn-outline" onclick="verificarQR()">Ver QR</button>
          <button class="btn btn-red btn-sm" onclick="desconectar()">Desconectar</button>
        </div>
      </div>
      
      <!-- Cargar Excel -->
      <div class="card" style="margin-bottom:16px;">
        <h2>📂 Cargar Cartera</h2>
        <div class="file-drop" id="fileDrop" onclick="document.getElementById('fileInput').click()">
          <div style="font-size:1.3rem;">📄</div>
          <p>Click o arrastra tu Excel/CSV</p>
          <p style="font-size:0.7rem;">Columnas: Cliente, Teléfono, Saldo, Días Atraso</p>
        </div>
        <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" style="display:none" onchange="subirArchivo(this)">
        <div id="fileResult" class="hidden" style="margin-top:12px;"></div>
      </div>
      
      <!-- Campaña -->
      <div class="card" style="margin-bottom:16px;">
        <h2>📤 Campaña Masiva</h2>
        <div style="margin-bottom:10px;">
          <label>Nombre</label>
          <input type="text" id="campNombre" placeholder="Cobranza Marzo 2026">
        </div>
        <div style="margin-bottom:10px;">
          <label>Mensaje (plantilla)</label>
          <textarea id="campPlantilla" rows="4" placeholder="Hola {nombre}, le recordamos su adeudo de {saldo}..."></textarea>
          <div class="vars-help">Variables (click para insertar): <code onclick="insertVar('{nombre}')" style="cursor:pointer">{nombre}</code> <code onclick="insertVar('{saldo}')" style="cursor:pointer">{saldo}</code> <code onclick="insertVar('{dias}')" style="cursor:pointer">{dias}</code> <code onclick="insertVar('{telefono}')" style="cursor:pointer">{telefono}</code></div>
        </div>
        <div style="margin-bottom:10px;">
          <label>Imagen estándar (opcional)</label>
          <input type="file" id="campImagen" accept="image/*">
        </div>
        <div class="grid grid-4" style="gap:6px; margin-bottom:10px;">
          <div><label>Delay mín (s)</label><input type="number" id="cfgDelayMin" value="25" min="10"></div>
          <div><label>Delay máx (s)</label><input type="number" id="cfgDelayMax" value="90" min="20"></div>
          <div><label>Lote</label><input type="number" id="cfgLote" value="8" min="3" max="15"></div>
          <div><label>Lím. diario</label><input type="number" id="cfgLimite" value="45" min="10"></div>
        </div>
        <div class="controls">
          <button class="btn btn-green" id="btnIniciar" onclick="iniciarCampana()" disabled>▶ Iniciar</button>
          <button class="btn btn-yellow btn-sm" id="btnPausar" onclick="pausarCampana()" disabled>⏸ Pausar</button>
          <button class="btn btn-red btn-sm" id="btnCancelar" onclick="cancelarCampana()" disabled>✕ Cancelar</button>
          <button class="btn btn-outline btn-sm" onclick="resetCampana()" title="Forzar reset si se traba">🔧 Reset</button>
        </div>
        <div id="progresoArea" class="hidden" style="margin-top:14px;">
          <div style="display:flex; justify-content:space-between; font-size:0.82rem;">
            <span id="progTexto">0/0</span>
            <span id="progPct" style="font-weight:700; color:var(--accent);">0%</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" id="progBar" style="width:0%"></div></div>
          <div style="display:flex; justify-content:space-between; font-size:0.72rem; color:var(--muted);">
            <span>⏱ <span id="progETA">—</span></span>
            <span>❌ <span id="progFail" style="color:var(--red);">0</span></span>
          </div>
        </div>
      </div>

      <!-- Gestores -->
      <div class="card">
        <h2>👥 Gestores</h2>
        <div id="gestoresArea"></div>
        <div class="controls" style="margin-top:8px;">
          <button class="btn btn-outline btn-sm" onclick="location.href='/api/exportar/reporte'">📊 Reporte Excel</button>
        </div>
      </div>
    </div>
    
    <!-- ═══ COLUMNA DERECHA — MONITOREO ═══ -->
    <div>
      <div class="card" style="min-height:600px;">
        <div class="tabs">
          <div class="tab active" onclick="switchTab('tabLive')">📡 Envío en Vivo</div>
          <div class="tab" onclick="switchTab('tabConv')">💬 Conversaciones</div>
          <div class="tab" onclick="switchTab('tabCola')">📋 Cola / Detalle</div>
        </div>
        
        <!-- TAB 1: Log en vivo -->
        <div class="tab-content active" id="tabLive">
          <div class="log-panel" id="liveLog" style="max-height:520px;">
            <div class="log-line"><span class="log-info">Esperando actividad...</span></div>
          </div>
        </div>
        
        <!-- TAB 2: Conversaciones -->
        <div class="tab-content" id="tabConv">
          <div id="convListView">
            <p style="font-size:0.8rem; color:var(--muted); margin-bottom:10px;">Clientes que han respondido:</p>
            <div class="conv-list" id="convList"></div>
          </div>
          <div id="convChatView" class="hidden">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
              <div>
                <span class="conv-name" id="chatNombre">—</span>
                <span class="conv-tel" id="chatTel" style="margin-left:8px;">—</span>
                <span class="tag tag-info" id="chatEstado" style="margin-left:8px;">—</span>
              </div>
              <button class="btn btn-outline btn-sm" onclick="cerrarChat()">← Volver</button>
            </div>
            <div class="chat-view" id="chatView"></div>
          </div>
        </div>
        
        <!-- TAB 3: Cola / Detalle -->
        <div class="tab-content" id="tabCola">
          <div class="queue-scroll" id="queueScroll">
            <table class="queue-table">
              <thead><tr><th>Nombre</th><th>Teléfono</th><th>Estado</th><th>Hora</th></tr></thead>
              <tbody id="queueBody"><tr><td colspan="4" style="color:var(--muted);">Sin datos</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
let contactosCargados = null;
let activeTab = 'tabLive';

// ═══════════════════════════════════
// TABS
// ═══════════════════════════════════
function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab').forEach((t,i) => {
    t.classList.toggle('active', ['tabLive','tabConv','tabCola'][i] === id);
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  
  if (id === 'tabConv') cargarConversaciones();
  if (id === 'tabCola') cargarCola();
}

// ═══════════════════════════════════
// ESTADO GENERAL
// ═══════════════════════════════════
async function cargarEstado() {
  try {
    const r = await fetch('/api/estado');
    const d = await r.json();
    const badge = document.getElementById('connBadge');
    
    if (d.conectado) {
      badge.className = 'conn-badge on';
      badge.textContent = '● Conectado' + (d.info?.nombre ? ' — ' + d.info.nombre : '');
      document.getElementById('qrArea').innerHTML = '';
    } else {
      badge.className = 'conn-badge off';
      badge.textContent = '● Desconectado';
    }
    
    if (d.chatbot) {
      document.getElementById('sClientes').textContent = d.chatbot.clientesRegistrados || 0;
      document.getElementById('sConv').textContent = d.chatbot.conversacionesActivas || 0;
      document.getElementById('sBot').textContent = d.chatbot.activo ? '✅ ON' : '⏸ OFF';
      document.getElementById('sBot').style.color = d.chatbot.activo ? 'var(--green)' : 'var(--muted)';
      document.getElementById('gestoresArea').innerHTML = (d.chatbot.gestores || []).map(g =>
        '<div class="gestor-row"><span>👤 ' + g.nombre + '</span><span style="color:var(--muted);font-size:0.82rem;">' + g.telefono + '</span></div>'
      ).join('');
    }
    
    if (d.progreso) {
      actualizarProgreso(d.progreso);
      document.getElementById('sEnviados').textContent = d.estadisticasEnvio?.config?.enviadosHoy || d.progreso.enviados || 0;
    }
    
    document.getElementById('btnIniciar').disabled = !(contactosCargados && d.conectado);
  } catch(e) { console.error(e); }
}

function actualizarProgreso(p) {
  const area = document.getElementById('progresoArea');
  const btnI = document.getElementById('btnIniciar');
  const btnP = document.getElementById('btnPausar');
  const btnC = document.getElementById('btnCancelar');
  
  if (p.enProgreso || p.enviados > 0 || p.fallidos > 0) {
    area.classList.remove('hidden');
    document.getElementById('progTexto').textContent = p.enviados + '/' + p.total + ' enviados';
    document.getElementById('progPct').textContent = p.porcentaje + '%';
    document.getElementById('progBar').style.width = p.porcentaje + '%';
    document.getElementById('progFail').textContent = p.fallidos;
    document.getElementById('progETA').textContent = p.tiempoEstimado > 0 ? '~' + p.tiempoEstimado + ' min' : '—';
  }
  
  if (p.enProgreso) {
    btnI.disabled = true;
    btnP.disabled = false;
    btnC.disabled = false;
    btnP.textContent = p.pausado ? '▶ Reanudar' : '⏸ Pausar';
    btnP.className = p.pausado ? 'btn btn-green btn-sm' : 'btn btn-yellow btn-sm';
    btnP.onclick = p.pausado ? reanudarCampana : pausarCampana;
  } else {
    btnP.disabled = true;
    btnC.disabled = true;
  }
}

// ═══════════════════════════════════
// LOG EN VIVO (ENVÍO MASIVO + CHATBOT)
// ═══════════════════════════════════
async function cargarLogVivo() {
  if (activeTab !== 'tabLive') return;
  try {
    // Logs del envío masivo
    const r1 = await fetch('/api/campana/logs?limite=30');
    const logsEnvio = await r1.json();
    
    // Interacciones del chatbot
    const r2 = await fetch('/api/chatbot/interacciones?limite=20');
    const logsChat = await r2.json();
    
    // Combinar y ordenar por timestamp
    const todos = [];
    
    logsEnvio.forEach(l => {
      todos.push({
        time: new Date(l.timestamp),
        html: '<span class="log-tag ' + (l.tipo === 'enviado' ? 'ok' : 'err') + '">' + 
          (l.tipo === 'enviado' ? '✅ ENVIADO' : '❌ FALLIDO') + '</span> ' +
          '<span style="color:var(--text);">' + (l.nombre||'') + '</span> ' +
          '<span style="color:var(--muted);">' + (l.telefono||'') + '</span>' +
          (l.error ? ' <span style="color:var(--red);font-size:0.65rem;">' + l.error + '</span>' : '') +
          ' <span style="color:var(--muted);font-size:0.65rem;">[' + l.progreso + ']</span>'
      });
    });
    
    logsChat.forEach(l => {
      const tag = l.tipo === 'recibido' ? 'in' : l.tipo === 'enviado' ? 'out' : 'ok';
      const label = l.tipo === 'recibido' ? '📩 RECIBIDO' : l.tipo === 'enviado' ? '🤖 BOT' : '🔄 ' + l.tipo.toUpperCase();
      todos.push({
        time: new Date(l.timestamp),
        html: '<span class="log-tag ' + tag + '">' + label + '</span> ' +
          '<span style="color:var(--muted);">' + l.telefono + '</span> ' +
          '<span style="color:var(--text);">' + (l.detalle||'').substring(0,55) + '</span>'
      });
    });
    
    todos.sort((a,b) => b.time - a.time);
    
    const panel = document.getElementById('liveLog');
    if (todos.length === 0) {
      panel.innerHTML = '<div class="log-line"><span class="log-info">Esperando actividad...</span></div>';
      return;
    }
    
    panel.innerHTML = todos.slice(0, 50).map(t => {
      const ts = t.time.toLocaleTimeString('es-MX', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return '<div class="log-line"><span class="log-time">' + ts + '</span><span>' + t.html + '</span></div>';
    }).join('');
    
  } catch(e) {}
}

// ═══════════════════════════════════
// CONVERSACIONES
// ═══════════════════════════════════
async function cargarConversaciones() {
  try {
    const r = await fetch('/api/chatbot/conversaciones');
    const data = await r.json();
    const list = document.getElementById('convList');
    
    if (!data.length) {
      list.innerHTML = '<p style="color:var(--muted); font-size:0.82rem; text-align:center; padding:20px;">Nadie ha respondido aún</p>';
      return;
    }
    
    list.innerHTML = data.map(c => {
      const estado = c.estado || 'inicial';
      const tagCls = estado === 'esperando_gestor' ? 'tag-wait' : estado === 'menu' ? 'tag-info' : 'tag-ok';
      return '<div class="conv-item" onclick="verConversacion(\\'' + c.telefono + '\\')">' +
        '<div><div class="conv-name">' + (c.telefono) + '</div>' +
        '<div style="font-size:0.72rem;color:var(--muted);">Estado: ' + estado + '</div></div>' +
        '<span class="tag ' + tagCls + '">' + estado + '</span></div>';
    }).join('');
  } catch(e) {}
}

async function verConversacion(tel) {
  document.getElementById('convListView').classList.add('hidden');
  document.getElementById('convChatView').classList.remove('hidden');
  
  try {
    const r = await fetch('/api/conversacion/' + encodeURIComponent(tel));
    const d = await r.json();
    
    document.getElementById('chatNombre').textContent = d.cliente?.nombre || tel;
    document.getElementById('chatTel').textContent = tel;
    document.getElementById('chatEstado').textContent = d.estado;
    
    const view = document.getElementById('chatView');
    
    if (!d.mensajes?.length) {
      view.innerHTML = '<p style="color:var(--muted);text-align:center;padding:20px;">Sin mensajes registrados</p>';
      return;
    }
    
    view.innerHTML = d.mensajes.map(m => {
      const isSent = m.tipo === 'enviado';
      const time = new Date(m.timestamp).toLocaleTimeString('es-MX', {hour:'2-digit',minute:'2-digit'});
      return '<div class="chat-msg ' + (isSent ? 'sent' : 'received') + '">' +
        '<div class="bubble">' + (m.detalle||'').replace(/\\n/g,'<br>') + '</div>' +
        '<div class="meta">' + time + ' · ' + m.tipo + '</div></div>';
    }).join('');
    
    view.scrollTop = view.scrollHeight;
  } catch(e) {
    document.getElementById('chatView').innerHTML = '<p style="color:var(--red);">Error cargando</p>';
  }
}

function cerrarChat() {
  document.getElementById('convChatView').classList.add('hidden');
  document.getElementById('convListView').classList.remove('hidden');
}

// ═══════════════════════════════════
// COLA / DETALLE
// ═══════════════════════════════════
async function cargarCola() {
  try {
    const r = await fetch('/api/campana/detalle');
    const data = await r.json();
    const body = document.getElementById('queueBody');
    
    if (!data.length) {
      body.innerHTML = '<tr><td colspan="4" style="color:var(--muted);">No hay campaña activa</td></tr>';
      return;
    }
    
    body.innerHTML = data.map(d => {
      let tagCls = 'tag-wait', icon = '⏳';
      if (d.estado === 'enviado') { tagCls = 'tag-ok'; icon = '✅'; }
      else if (d.estado === 'fallido') { tagCls = 'tag-err'; icon = '❌'; }
      else if (d.estado === 'saltado') { tagCls = 'tag-err'; icon = '⏭'; }
      
      const hora = d.enviadoEn ? new Date(d.enviadoEn).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
      
      return '<tr>' +
        '<td>' + (d.nombre||'—') + '</td>' +
        '<td style="font-family:\\'JetBrains Mono\\',monospace;font-size:0.72rem;">' + (d.telefono||'—') + '</td>' +
        '<td><span class="tag ' + tagCls + '">' + icon + ' ' + d.estado + '</span>' + 
          (d.error ? '<br><span style="font-size:0.65rem;color:var(--red);">' + d.error + '</span>' : '') + '</td>' +
        '<td style="color:var(--muted);font-size:0.72rem;">' + hora + '</td></tr>';
    }).join('');
  } catch(e) {}
}

// ═══════════════════════════════════
// CONEXIÓN
// ═══════════════════════════════════
async function conectar() {
  await fetch('/api/conectar', { method:'POST' });
  setTimeout(verificarQR, 2000);
}
async function verificarQR() {
  const r = await fetch('/api/qr');
  const d = await r.json();
  if (d.qr) {
    document.getElementById('qrArea').innerHTML = '<p style="text-align:center;font-size:0.82rem;color:var(--muted);">Escanea con WhatsApp:</p><img src="' + d.qr + '">';
  } else if (d.conectado) {
    document.getElementById('qrArea').innerHTML = '<p style="text-align:center;color:var(--green);font-size:0.82rem;">✅ Conectado</p>';
  }
  setTimeout(cargarEstado, 3000);
}
async function desconectar() {
  await fetch('/api/desconectar', { method:'POST' });
  cargarEstado();
}

// ═══════════════════════════════════
// CARGAR EXCEL
// ═══════════════════════════════════
async function subirArchivo(input) {
  const file = input.files[0];
  if (!file) return;
  const result = document.getElementById('fileResult');
  result.classList.remove('hidden');
  result.innerHTML = '<span class="tag tag-wait">Cargando...</span>';
  const fd = new FormData();
  fd.append('archivo', file);
  try {
    const r = await fetch('/api/subir-excel', { method:'POST', body:fd });
    const d = await r.json();
    if (d.exito) {
      contactosCargados = d.datos;
      let html = '<span class="tag tag-ok">✅ ' + d.totalRegistros + ' contactos</span>';
      html += '<table class="preview-table"><tr>';
      d.columnas.slice(0,5).forEach(c => html += '<th>' + c + '</th>');
      html += '</tr>';
      (d.preview || []).slice(0,3).forEach(row => {
        html += '<tr>';
        d.columnas.slice(0,5).forEach(c => html += '<td>' + (row[c]||'') + '</td>');
        html += '</tr>';
      });
      html += '</table>';
      result.innerHTML = html;
      document.getElementById('fileDrop').classList.add('active');
      cargarEstado();
    } else {
      result.innerHTML = '<span class="tag tag-err">❌ ' + d.mensaje + '</span>';
    }
  } catch(e) {
    result.innerHTML = '<span class="tag tag-err">❌ ' + e.message + '</span>';
  }
  input.value = '';
}

const drop = document.getElementById('fileDrop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor='var(--accent)'; });
drop.addEventListener('dragleave', () => { drop.style.borderColor=''; });
drop.addEventListener('drop', e => {
  e.preventDefault(); drop.style.borderColor='';
  const fi = document.getElementById('fileInput');
  fi.files = e.dataTransfer.files;
  subirArchivo(fi);
});

// ═══════════════════════════════════
// CAMPAÑA
// ═══════════════════════════════════
async function iniciarCampana() {
  if (!contactosCargados?.length) return alert('Primero carga un Excel');
  const plantilla = document.getElementById('campPlantilla').value.trim();
  const imgInput = document.getElementById('campImagen');
  if (!plantilla && !imgInput.files[0]) return alert('Escribe un mensaje o selecciona imagen');
  
  const fd = new FormData();
  fd.append('contactos', JSON.stringify(contactosCargados));
  fd.append('plantilla', plantilla);
  fd.append('nombreCampana', document.getElementById('campNombre').value || 'Campaña ' + new Date().toLocaleDateString('es-MX'));
  fd.append('config', JSON.stringify({
    delayMinimo: parseInt(document.getElementById('cfgDelayMin').value) * 1000,
    delayMaximo: parseInt(document.getElementById('cfgDelayMax').value) * 1000,
    tamanoLote: parseInt(document.getElementById('cfgLote').value),
    limiteDiario: parseInt(document.getElementById('cfgLimite').value),
  }));
  if (imgInput.files[0]) fd.append('imagen', imgInput.files[0]);
  
  try {
    const r = await fetch('/api/campana/iniciar', { method:'POST', body:fd });
    const d = await r.json();
    if (d.exito) { switchTab('tabLive'); }
    else { alert(d.mensaje); }
    cargarEstado();
  } catch(e) { alert('Error: ' + e.message); }
}
async function pausarCampana() { await fetch('/api/campana/pausar',{method:'POST'}); cargarEstado(); }
async function reanudarCampana() { await fetch('/api/campana/reanudar',{method:'POST'}); cargarEstado(); }
async function cancelarCampana() {
  if (!confirm('¿Cancelar envío?')) return;
  await fetch('/api/campana/cancelar',{method:'POST'});
  cargarEstado();
}
async function resetCampana() {
  if (!confirm('¿Forzar reset? Esto detiene todo y limpia la cola.')) return;
  await fetch('/api/campana/reset',{method:'POST'});
  cargarEstado();
}
function insertVar(v) {
  const ta = document.getElementById('campPlantilla');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = ta.value;
  ta.value = text.substring(0, start) + v + text.substring(end);
  ta.selectionStart = ta.selectionEnd = start + v.length;
  ta.focus();
}

// ═══════════════════════════════════
// INIT
// ═══════════════════════════════════
cargarEstado();
cargarLogVivo();
setInterval(cargarEstado, 4000);
setInterval(cargarLogVivo, 3000);
setInterval(() => { if (activeTab === 'tabCola') cargarCola(); }, 5000);
setInterval(() => { if (activeTab === 'tabConv') cargarConversaciones(); }, 6000);
</script>
</body>
</html>`;
}
