/**
 * ChatBot de Cobranza - LMV CREDIA SA DE CV
 * ==========================================
 * Responde automáticamente a clientes
 * Notifica a gestores cuando es necesario
 */

const fs = require('fs');

class ChatBotCobranza {
  constructor(whatsappService) {
    this.whatsapp = whatsappService;
    
    // Gestores configurados
    this.gestores = [
      { nombre: 'Lic. Alfonso', telefono: '5564304984', activo: true },
      { nombre: 'Lic. Gisella', telefono: '5526889735', activo: true }
    ];
    this.gestorActual = 0;
    
    // Datos en memoria
    this.clientes = new Map();
    this.conversaciones = new Map();
    this.interacciones = [];
    
    // Estados
    this.ESTADOS = {
      INICIAL: 'inicial',
      MENU: 'menu',
      OPCIONES_PAGO: 'opciones_pago',
      CONVENIO: 'convenio',
      ESPERANDO_GESTOR: 'esperando_gestor'
    };
    
    this.activo = false;
    this.cargarDatos();
  }

  iniciar() {
    if (this.activo) return;
    
    console.log('\n🤖 ════════════════════════════════════');
    console.log('   CHATBOT DE COBRANZA INICIADO');
    console.log('   LMV CREDIA SA DE CV');
    console.log('════════════════════════════════════\n');
    
    // Registrar callback para mensajes
    this.whatsapp.onMessage(async (msg) => {
      await this.procesarMensaje(msg);
    });
    
    this.activo = true;
    console.log('✅ Escuchando mensajes entrantes...');
    console.log(`👥 Gestores: ${this.gestores.map(g => g.nombre).join(', ')}`);
    console.log(`📊 Clientes cargados: ${this.clientes.size}\n`);
  }

  async procesarMensaje(msg) {
    try {
      const jid = msg.key.remoteJid;
      const telefono = this.extraerTelefono(jid);
      const texto = this.extraerTexto(msg);
      
      if (!texto) {
        if (msg.message?.imageMessage) {
          await this.manejarImagen(jid, telefono);
        }
        return;
      }
      
      console.log(`📨 [${telefono}] ${texto.substring(0, 50)}`);
      this.registrarInteraccion(telefono, 'recibido', texto);
      
      const respuesta = this.generarRespuesta(telefono, texto);
      
      if (respuesta) {
        await this.whatsapp.sock.sendMessage(jid, { text: respuesta });
        this.registrarInteraccion(telefono, 'enviado', respuesta.substring(0, 50));
      }
    } catch (error) {
      console.error('❌ Error en chatbot:', error.message);
    }
  }

  generarRespuesta(telefono, texto) {
    const textoLimpio = texto.trim().toLowerCase();
    const cliente = this.obtenerCliente(telefono);
    const conv = this.obtenerConversacion(telefono);
    
    // Comandos globales
    if (['hola', 'hi', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches'].some(cmd => textoLimpio.includes(cmd))) {
      this.guardarConversacion(telefono, this.ESTADOS.MENU);
      return this.msgBienvenida(cliente);
    }
    
    // Procesar según estado
    switch (conv.estado) {
      case this.ESTADOS.MENU:
        return this.procesarMenu(telefono, textoLimpio, cliente);
      case this.ESTADOS.OPCIONES_PAGO:
        return this.procesarOpcionesPago(telefono, textoLimpio, cliente);
      case this.ESTADOS.CONVENIO:
        return this.procesarConvenio(telefono, textoLimpio, cliente);
      case this.ESTADOS.ESPERANDO_GESTOR:
        return `Su solicitud ya fue registrada.\n\nUn asesor lo contactará pronto.\n\n📞 Urgente: ${conv.gestor?.telefono || this.gestores[0].telefono}`;
      default:
        this.guardarConversacion(telefono, this.ESTADOS.MENU);
        return this.msgBienvenida(cliente);
    }
  }

  procesarMenu(telefono, texto, cliente) {
    switch (texto) {
      case '1':
        this.guardarConversacion(telefono, this.ESTADOS.OPCIONES_PAGO);
        return this.msgOpcionesPago(cliente);
      case '2':
        this.guardarConversacion(telefono, this.ESTADOS.CONVENIO);
        return this.msgConvenio();
      case '3':
        return this.msgSaldo(cliente);
      case '4':
        return this.conectarGestor(telefono, cliente, 'Solicita hablar con asesor');
      default:
        return this.msgNoEntendido();
    }
  }

  procesarOpcionesPago(telefono, texto, cliente) {
    switch (texto) {
      case '1':
        return this.msgPagoTotal(cliente.saldo || 5000);
      case '2':
        return this.msgPagoParcial();
      case '3':
        this.guardarConversacion(telefono, this.ESTADOS.CONVENIO);
        return this.msgConvenio();
      case '4':
        return this.conectarGestor(telefono, cliente, 'Quiere negociar pago');
      default:
        return this.msgNoEntendido();
    }
  }

  procesarConvenio(telefono, texto, cliente) {
    switch (texto) {
      case '1':
        return this.conectarGestor(telefono, cliente, 'Solicita llamada para convenio');
      case '2':
        return this.conectarGestor(telefono, cliente, 'Solicita WhatsApp para convenio');
      case '3':
        this.guardarConversacion(telefono, this.ESTADOS.MENU);
        return `Perfecto, cuando esté listo escríbanos *HOLA*.\n\n_LMV CREDIA SA DE CV_`;
      default:
        return this.msgNoEntendido();
    }
  }

  conectarGestor(telefono, cliente, motivo) {
    const gestor = this.obtenerGestor();
    this.guardarConversacion(telefono, this.ESTADOS.ESPERANDO_GESTOR, { gestor });
    this.registrarInteraccion(telefono, 'transferencia', `${gestor.nombre}: ${motivo}`);
    
    // Notificar al gestor
    const notif = `🔔 *NUEVA SOLICITUD*

👤 *Cliente:* ${cliente.nombre || 'No registrado'}
📱 *Tel:* ${telefono}
💰 *Saldo:* $${(cliente.saldo || 0).toLocaleString('es-MX')}
📅 *Atraso:* ${cliente.diasAtraso || 'N/A'} días

📋 *Motivo:* ${motivo}

⏰ ${new Date().toLocaleString('es-MX')}`;

    const jidGestor = '52' + gestor.telefono + '@s.whatsapp.net';
    this.whatsapp.sock.sendMessage(jidGestor, { text: notif }).catch(e => {
      console.error('Error notificando gestor:', e.message);
    });
    
    console.log(`📤 Notificación enviada a ${gestor.nombre}`);
    
    return `👤 *CONECTANDO CON ASESOR*

Su solicitud ha sido registrada.

*${gestor.nombre}* lo contactará en minutos.

📞 Si es urgente: ${gestor.telefono}

⏰ Horario: Lunes a Viernes 9:00-18:00`;
  }

  async manejarImagen(jid, telefono) {
    const cliente = this.obtenerCliente(telefono);
    this.registrarInteraccion(telefono, 'imagen', 'Posible comprobante');
    
    this.conectarGestor(telefono, cliente, '📷 Envió imagen (posible comprobante)');
    
    await this.whatsapp.sock.sendMessage(jid, { 
      text: '📷 *Imagen recibida*\n\nUn asesor verificará su comprobante.\n\nGracias.' 
    });
  }

  // ═══════════════════════════════════════
  // MENSAJES
  // ═══════════════════════════════════════

  msgBienvenida(cliente) {
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    return `Hola *${nombre}*, gracias por comunicarse con *LMV CREDIA SA DE CV* 📞

¿En qué podemos ayudarle?

1️⃣ Quiero pagar mi adeudo
2️⃣ Necesito un convenio de pago
3️⃣ Consultar mi saldo
4️⃣ Hablar con un asesor

_Responda con el número_`;
  }

  msgOpcionesPago(cliente) {
    return `💰 *OPCIONES DE PAGO*

Saldo actual: *$${(cliente.saldo || 0).toLocaleString('es-MX')}*

1️⃣ *Pago total* - 10% descuento
2️⃣ *Pago parcial* - Abone lo que pueda
3️⃣ *Plan de pagos* - Parcialidades
4️⃣ *Hablar con asesor*

_Responda con el número_`;
  }

  msgPagoTotal(saldo) {
    const desc = Math.round(saldo * 0.9);
    return `🎉 *¡EXCELENTE DECISIÓN!*

Saldo: $${saldo.toLocaleString('es-MX')}
*Con 10% desc: $${desc.toLocaleString('es-MX')}*

📱 *DATOS PARA PAGO:*

Banco: BBVA
CLABE: 012345678901234567
A nombre de: LMV CREDIA SA DE CV

📸 Envíe foto de su comprobante por aquí.`;
  }

  msgPagoParcial() {
    return `💵 *PAGO PARCIAL*

Puede abonar cualquier cantidad.

📱 *DATOS:*
Banco: BBVA
CLABE: 012345678901234567
LMV CREDIA SA DE CV

📸 Envíe su comprobante por aquí.`;
  }

  msgConvenio() {
    return `📋 *OPCIONES DE CONVENIO*

✅ Plan 4 semanas
✅ Plan 8 semanas
✅ Plan personalizado

¿Desea que lo contacten?

1️⃣ Sí, que me llamen
2️⃣ Prefiero WhatsApp
3️⃣ Yo me comunico después`;
  }

  msgSaldo(cliente) {
    return `📊 *SU SALDO*

*Cliente:* ${cliente.nombre || 'No registrado'}
*Saldo:* $${(cliente.saldo || 0).toLocaleString('es-MX')}
*Atraso:* ${cliente.diasAtraso || 0} días

Escriba *1* para pagar o *4* para hablar con asesor.`;
  }

  msgNoEntendido() {
    return `🤔 No entendí su respuesta.

Responda con el *número*:

1️⃣ Pagar
2️⃣ Convenio
3️⃣ Saldo
4️⃣ Asesor

O escriba *HOLA*`;
  }

  // ═══════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════

  extraerTelefono(jid) {
    return jid.replace('@s.whatsapp.net', '').replace('52', '');
  }

  extraerTexto(msg) {
    return msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  }

  obtenerGestor() {
    const activos = this.gestores.filter(g => g.activo);
    const gestor = activos[this.gestorActual % activos.length];
    this.gestorActual++;
    return gestor;
  }

  obtenerCliente(telefono) {
    return this.clientes.get(telefono) || { telefono, nombre: 'Cliente', saldo: 0, diasAtraso: 0 };
  }

  obtenerConversacion(telefono) {
    return this.conversaciones.get(telefono) || { estado: this.ESTADOS.INICIAL };
  }

  guardarConversacion(telefono, estado, datos = {}) {
    this.conversaciones.set(telefono, { estado, ...datos, timestamp: Date.now() });
  }

  registrarInteraccion(telefono, tipo, detalle) {
    this.interacciones.push({ telefono, tipo, detalle, timestamp: new Date().toISOString() });
    if (this.interacciones.length > 500) this.interacciones = this.interacciones.slice(-250);
  }

  cargarCartera(clientes) {
    clientes.forEach(c => {
      const tel = c.telefono?.toString().replace(/\D/g, '').slice(-10);
      if (tel) this.clientes.set(tel, c);
    });
    this.guardarDatos();
    console.log(`✅ ${clientes.length} clientes cargados en chatbot`);
    return this.clientes.size;
  }

  cargarDatos() {
    try {
      if (fs.existsSync('chatbot_clientes.json')) {
        const data = JSON.parse(fs.readFileSync('chatbot_clientes.json', 'utf8'));
        data.forEach(c => {
          const tel = c.telefono?.toString().replace(/\D/g, '').slice(-10);
          if (tel) this.clientes.set(tel, c);
        });
      }
    } catch (e) {}
  }

  guardarDatos() {
    try {
      fs.writeFileSync('chatbot_clientes.json', JSON.stringify([...this.clientes.values()], null, 2));
    } catch (e) {}
  }

  getEstadisticas() {
    return {
      clientesRegistrados: this.clientes.size,
      conversacionesActivas: this.conversaciones.size,
      interaccionesHoy: this.interacciones.filter(i => 
        new Date(i.timestamp).toDateString() === new Date().toDateString()
      ).length,
      gestores: this.gestores,
      activo: this.activo
    };
  }

  getInteracciones(limite = 50, telefono = null) {
    let data = this.interacciones;
    if (telefono) data = data.filter(i => i.telefono.includes(telefono));
    return data.slice(-limite);
  }

  getConversaciones() {
    const arr = [];
    this.conversaciones.forEach((v, k) => arr.push({ telefono: k, ...v }));
    return arr;
  }
}

module.exports = ChatBotCobranza;
