/**
 * ═══════════════════════════════════════════════════════════
 * ChatBot de Cobranza - LeGaXi Asesores
 * Cobranza Mercantil Especializada
 * ═══════════════════════════════════════════════════════════
 * 
 * ✅ Respuestas automáticas a clientes
 * ✅ Convenios en 4, 8 y 12 pagos
 * ✅ Datos bancarios reales (SPIN-OXXO / BBVA)
 * ✅ Notificación a gestores
 * ✅ Detección de excusas/negativas/agresiones
 * 
 * Lic. Francisco Gabriel García Sánchez
 * ═══════════════════════════════════════════════════════════
 */

const fs = require('fs');

class ChatBotCobranza {
  constructor(whatsappService) {
    this.whatsapp = whatsappService;
    
    // Gestores configurados
    this.gestores = [
      { nombre: 'Lic. Carlos', telefono: '7352588215', activo: true },
      { nombre: 'Lic. Gustavo', telefono: '5548039744', activo: true }
    ];
    this.gestorActual = 0;
    
    // Datos bancarios reales
    this.datosBancarios = {
      spinOxxo: {
        nombre: 'SPIN - OXXO',
        clabe: '7289 6900 0166 6769 82',
        tarjeta: '4217 4702 1177 5578',
      },
      bbva: {
        nombre: 'BBVA - BANCOMER',
        clabe: '0121 8001 5055 5747 30',
        tarjeta: '4152 3143 7377 5678',
      },
      titular: 'Lic. Francisco Gabriel García Sánchez',
    };
    
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
      ESPERANDO_GESTOR: 'esperando_gestor',
      CONFIRMACION_PAGO: 'confirmacion_pago',
      EXCUSAS: 'excusas'
    };

    this.NIVELES = {
      LEVE: 15,
      MODERADO: 30,
      GRAVE: 60,
      CRITICO: 90
    };
    
    this.activo = false;
    this.cargarDatos();
  }

  iniciar() {
    if (this.activo) return;
    
    console.log('\n🤖 ════════════════════════════════════');
    console.log('   CHATBOT DE COBRANZA INICIADO');
    console.log('   LeGaXi Asesores - CME');
    console.log('   MODO: COBRANZA FIRME');
    console.log('════════════════════════════════════\n');
    
    this.whatsapp.onMessage(async (msg) => {
      await this.procesarMensaje(msg);
    });
    
    this.activo = true;
    console.log('✅ Escuchando mensajes entrantes...');
    console.log(`👥 Gestores: ${this.gestores.map(g => g.nombre).join(', ')}`);
    console.log(`📊 Clientes cargados: ${this.clientes.size}\n`);
  }

  getNivelMorosidad(diasAtraso) {
    if (diasAtraso <= this.NIVELES.LEVE) return 'LEVE';
    if (diasAtraso <= this.NIVELES.MODERADO) return 'MODERADO';
    if (diasAtraso <= this.NIVELES.GRAVE) return 'GRAVE';
    return 'CRITICO';
  }

  // Formato de dinero bonito
  fmt(cantidad) {
    return '$' + Math.round(cantidad).toLocaleString('es-MX');
  }

  async procesarMensaje(msg) {
    try {
      const jid = msg.key.remoteJid;
      
      if (!jid) return;
      if (jid.includes('@g.us')) return;
      if (jid.includes('@broadcast') || jid === 'status@broadcast') return;
      if (msg.key.fromMe) return;
      if (msg.message?.protocolMessage) return;
      if (msg.message?.reactionMessage) return;
      
      const telefono = this.extraerTelefono(jid);
      const texto = this.extraerTexto(msg);
      
      if (!jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) {
        return;
      }
      
      if (!texto) {
        if (msg.message?.imageMessage && jid.includes('@s.whatsapp.net')) {
          await this.manejarImagen(jid, telefono);
        }
        return;
      }
      
      console.log(`📨 [${telefono}] ${texto.substring(0, 50)}`);
      this.registrarInteraccion(telefono, 'recibido', texto, jid);
      
      const respuesta = this.generarRespuesta(telefono, texto);
      
      if (respuesta) {
        await this.whatsapp.sock.sendMessage(jid, { text: respuesta });
        this.registrarInteraccion(telefono, 'enviado', respuesta.substring(0, 50), jid);
      }
    } catch (error) {
      console.error('❌ Error en chatbot:', error.message);
    }
  }

  generarRespuesta(telefono, texto) {
    const textoLimpio = texto.trim().toLowerCase();
    const cliente = this.obtenerCliente(telefono);
    const conv = this.obtenerConversacion(telefono);
    const nivel = this.getNivelMorosidad(cliente.diasAtraso || 0);
    
    if (this.esExcusa(textoLimpio)) {
      return this.manejarExcusa(telefono, textoLimpio, cliente, nivel);
    }

    if (this.esNegativa(textoLimpio)) {
      return this.manejarNegativa(telefono, cliente, nivel);
    }

    if (this.esAgresion(textoLimpio)) {
      return this.manejarAgresion(telefono, cliente);
    }
    
    if (['hola', 'hi', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches'].some(cmd => textoLimpio.includes(cmd))) {
      this.guardarConversacion(telefono, this.ESTADOS.MENU);
      return this.msgBienvenida(cliente, nivel);
    }
    
    switch (conv.estado) {
      case this.ESTADOS.MENU:
        return this.procesarMenu(telefono, textoLimpio, cliente, nivel);
      case this.ESTADOS.OPCIONES_PAGO:
        return this.procesarOpcionesPago(telefono, textoLimpio, cliente, nivel);
      case this.ESTADOS.CONVENIO:
        return this.procesarConvenio(telefono, textoLimpio, cliente, nivel);
      case this.ESTADOS.ESPERANDO_GESTOR:
        return this.msgEsperandoGestor(conv, nivel);
      case this.ESTADOS.EXCUSAS:
        return this.procesarExcusa(telefono, textoLimpio, cliente, nivel);
      default:
        this.guardarConversacion(telefono, this.ESTADOS.MENU);
        return this.msgBienvenida(cliente, nivel);
    }
  }

  // ═══════════════════════════════════════
  // DETECCIÓN DE COMPORTAMIENTOS
  // ═══════════════════════════════════════

  esExcusa(texto) {
    const excusas = [
      'no tengo', 'no puedo', 'ahorita no', 'después', 'luego', 'mañana',
      'la próxima', 'proxima semana', 'fin de mes', 'quincena', 'cuando pueda',
      'no me alcanza', 'estoy sin dinero', 'no hay dinero', 'crisis', 'difícil',
      'me robaron', 'perdí trabajo', 'estoy enfermo', 'hospital', 'emergencia',
      'ya pagué', 'ya pague', 'no debo', 'está pagado', 'esta pagado',
      'no es mío', 'no es mio', 'yo no saqué', 'yo no saque', 'no reconozco',
      'déjame en paz', 'dejame en paz', 'no molesten', 'ya no llamen'
    ];
    return excusas.some(e => texto.includes(e));
  }

  esNegativa(texto) {
    const negativas = [
      'no voy a pagar', 'no pago', 'no quiero', 'no me interesa',
      'demándame', 'demandame', 'demanden', 'no tengo miedo',
      'hagan lo que quieran', 'me vale', 'no me importa',
      'bloquear', 'los voy a bloquear', 'reportar'
    ];
    return negativas.some(n => texto.includes(n));
  }

  esAgresion(texto) {
    const agresiones = [
      'chinga', 'puta', 'pendejo', 'idiota', 'estúpido', 'estupido',
      'imbécil', 'imbecil', 'cabron', 'cabrón', 'mierda', 'verga',
      'joder', 'fuck', 'shit'
    ];
    return agresiones.some(a => texto.includes(a));
  }

  // ═══════════════════════════════════════
  // DATOS BANCARIOS (mensaje reutilizable)
  // ═══════════════════════════════════════

  getDatosBancarios(referencia) {
    const b = this.datosBancarios;
    return `━━━━━━━━━━━━━━━━━━━━━
🏪 *${b.spinOxxo.nombre}*
━━━━━━━━━━━━━━━━━━━━━
📋 CLABE: *${b.spinOxxo.clabe}*
💳 Tarjeta: *${b.spinOxxo.tarjeta}*

━━━━━━━━━━━━━━━━━━━━━
🏦 *${b.bbva.nombre}*
━━━━━━━━━━━━━━━━━━━━━
📋 CLABE: *${b.bbva.clabe}*
💳 Tarjeta: *${b.bbva.tarjeta}*

👤 A nombre de: *${b.titular}*
📝 Referencia: *${referencia}*`;
  }

  // ═══════════════════════════════════════
  // MANEJO DE SITUACIONES ESPECIALES
  // ═══════════════════════════════════════

  manejarExcusa(telefono, texto, cliente, nivel) {
    this.guardarConversacion(telefono, this.ESTADOS.EXCUSAS);
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';

    // "Ya pagué"
    if (texto.includes('ya pagué') || texto.includes('ya pague') || texto.includes('está pagado')) {
      return `⚠️ *VERIFICACIÓN DE PAGO*

${nombre}, no encontramos registro de su pago en nuestro sistema.

Si ya realizó el depósito, envíe su comprobante *ahora mismo* para validarlo.

💰 Deuda registrada: *${this.fmt(saldo)}*

Sin comprobante, la deuda sigue vigente y las acciones de cobranza continúan.

📸 *Envíe foto del comprobante*`;
    }

    // "No es mi deuda"
    if (texto.includes('no es mío') || texto.includes('no reconozco') || texto.includes('yo no saqué')) {
      return `⚖️ *AVISO LEGAL*

El crédito está registrado con datos verificados:
• Teléfono confirmado
• Identificación oficial
• Comprobante de domicilio

Si es víctima de fraude de identidad, tiene *24 horas* para presentar:

1️⃣ Denuncia ante el Ministerio Público
2️⃣ Reporte a CONDUSEF

De lo contrario, usted es legalmente responsable.

¿Desea hablar con un asesor?
Responda *SI* o *NO*`;
    }

    // "Después", "Mañana", "Quincena"
    if (texto.includes('después') || texto.includes('mañana') || texto.includes('quincena') || texto.includes('fin de mes')) {
      if (nivel === 'CRITICO' || nivel === 'GRAVE') {
        return `🚫 *SIN PRÓRROGAS DISPONIBLES*

${nombre}, su cuenta tiene *${dias} días de atraso*.

⚖️ Consecuencias activas:
  ▸ Buró de Crédito (reportado)
  ▸ Intereses moratorios acumulándose
  ▸ Cobranza judicial en proceso

Pague hoy mínimo *${this.fmt(saldo * 0.3)}* para detener acciones.

1️⃣ Voy a pagar ahora
2️⃣ Necesito hablar con asesor`;
      } else {
        return `📅 *COMPROMISO DE PAGO*

Entendemos, pero su deuda no puede esperar.

💰 Deuda: *${this.fmt(saldo)}*
📅 Atraso: *${dias} días*

¿Cuándo puede pagar?

1️⃣ Hoy mismo
2️⃣ Mañana sin falta
3️⃣ Esta semana
4️⃣ Necesito un convenio

⚠️ Sin compromiso, su caso escala a cobranza externa.`;
      }
    }

    // "No tengo dinero"
    if (texto.includes('no tengo') || texto.includes('no me alcanza') || texto.includes('sin dinero')) {
      return `💡 *OPCIONES DE SOLUCIÓN*

La deuda existe y debe resolverse. Tenemos opciones:

1️⃣ *Pago mínimo hoy* — ${this.fmt(saldo * 0.1)}
   Detiene llamadas 7 días

2️⃣ *Convenio semanal* — Desde ${this.fmt(saldo / 12)}/semana
   Plan hasta 12 semanas

3️⃣ *Liquidar todo* — ${this.fmt(saldo)}
   Cierre su deuda de una vez

4️⃣ Hablar con asesor para negociar

Responda con el *número*:`;
    }

    // Excusa genérica
    return `⚠️ *AVISO*

${nombre}, las excusas no eliminan su deuda de *${this.fmt(saldo)}*.

Cada día que pasa:
  ▸ Aumentan intereses
  ▸ Se afecta su historial crediticio
  ▸ Se acerca la acción legal

1️⃣ Pagar hoy
2️⃣ Hacer un convenio
3️⃣ Hablar con asesor

_No responder = Aceptar consecuencias_`;
  }

  manejarNegativa(telefono, cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;

    this.conectarGestor(telefono, cliente, '🚨 CLIENTE NEGADO A PAGAR');

    return `⚖️ *NOTIFICACIÓN LEGAL*

Su negativa ha quedado registrada.

┌─────────────────────────
│ 👤 ${cliente.nombre || 'Titular'}
│ 💰 ${this.fmt(saldo)}
│ 📅 ${dias} días de atraso
│ 🗓️ ${new Date().toLocaleDateString('es-MX')}
└─────────────────────────

*Consecuencias:*

▸ *Buró de Crédito* — Historial manchado 6 años
▸ *Demanda civil* — Gastos legales a su cargo
▸ *Cobranza domiciliaria* — Visitas y notificación a referencias

⏰ Tiene *24 horas* para reconsiderar.
Un asesor legal se comunicará con usted.

_Cobranza Mercantil Especializada_`;
  }

  manejarAgresion(telefono, cliente) {
    this.conectarGestor(telefono, cliente, '⚠️ CLIENTE AGRESIVO');

    return `⚠️ *ADVERTENCIA*

Su mensaje fue registrado y almacenado.

Las agresiones no eliminan su deuda ni intimidan a esta institución. Este chat puede usarse como *evidencia legal*.

Un supervisor revisará su caso.

_Cobranza Mercantil Especializada_`;
  }

  procesarExcusa(telefono, texto, cliente, nivel) {
    if (texto === '1' || texto.includes('si') || texto.includes('pagar')) {
      this.guardarConversacion(telefono, this.ESTADOS.OPCIONES_PAGO);
      return this.msgOpcionesPago(cliente, nivel);
    }
    if (texto === '2' || texto.includes('convenio')) {
      this.guardarConversacion(telefono, this.ESTADOS.CONVENIO);
      return this.msgConvenio(cliente, nivel);
    }
    if (texto === '3' || texto === '4' || texto.includes('asesor')) {
      return this.conectarGestor(telefono, cliente, 'Cliente con excusas solicita asesor');
    }
    return this.manejarExcusa(telefono, texto, cliente, nivel);
  }

  // ═══════════════════════════════════════
  // PROCESAMIENTO NORMAL
  // ═══════════════════════════════════════

  procesarMenu(telefono, texto, cliente, nivel) {
    switch (texto) {
      case '1':
        this.guardarConversacion(telefono, this.ESTADOS.OPCIONES_PAGO);
        return this.msgOpcionesPago(cliente, nivel);
      case '2':
        this.guardarConversacion(telefono, this.ESTADOS.CONVENIO);
        return this.msgConvenio(cliente, nivel);
      case '3':
        return this.msgSaldo(cliente, nivel);
      case '4':
        return this.conectarGestor(telefono, cliente, 'Solicita hablar con asesor');
      default:
        return this.msgNoEntendido(nivel);
    }
  }

  procesarOpcionesPago(telefono, texto, cliente, nivel) {
    switch (texto) {
      case '1':
        return this.msgPagoTotal(cliente, nivel);
      case '2':
        return this.msgPagoParcial(cliente, nivel);
      case '3':
        this.guardarConversacion(telefono, this.ESTADOS.CONVENIO);
        return this.msgConvenio(cliente, nivel);
      case '4':
        return this.conectarGestor(telefono, cliente, 'Quiere negociar pago');
      default:
        return this.msgNoEntendido(nivel);
    }
  }

  procesarConvenio(telefono, texto, cliente, nivel) {
    const saldo = cliente.saldo || 0;
    
    switch (texto) {
      case '1': {
        // Convenio 4 pagos — mostrar datos bancarios
        const monto = Math.round(saldo / 4);
        return `✅ *CONVENIO 4 PAGOS SELECCIONADO*

${cliente.nombre?.split(' ')[0] || 'Cliente'}, su plan queda así:

┌─────────────────────────
│ 💰 Deuda total: *${this.fmt(saldo)}*
│ 📦 Pagos: *4 semanales*
│ 💵 Monto c/pago: *${this.fmt(monto)}*
└─────────────────────────

Realice su *primer pago hoy* para activar:

${this.getDatosBancarios(telefono)}

📸 Envíe foto del comprobante aquí.

⚠️ _Un pago faltante cancela el convenio._

_Cobranza Mercantil Especializada_`;
      }
      case '2': {
        // Convenio 8 pagos
        const monto = Math.round(saldo / 8);
        return `✅ *CONVENIO 8 PAGOS SELECCIONADO*

${cliente.nombre?.split(' ')[0] || 'Cliente'}, su plan queda así:

┌─────────────────────────
│ 💰 Deuda total: *${this.fmt(saldo)}*
│ 📦 Pagos: *8 semanales*
│ 💵 Monto c/pago: *${this.fmt(monto)}*
└─────────────────────────

Realice su *primer pago hoy* para activar:

${this.getDatosBancarios(telefono)}

📸 Envíe foto del comprobante aquí.

⚠️ _Un pago faltante cancela el convenio._

_Cobranza Mercantil Especializada_`;
      }
      case '3': {
        // Convenio 12 pagos
        if (nivel === 'CRITICO') {
          return `⚠️ *NO DISPONIBLE*

Por su nivel de atraso (*${cliente.diasAtraso} días*), el plan a 12 pagos no está disponible.

Opciones vigentes:
1️⃣ Plan 4 pagos — *${this.fmt(saldo / 4)}*/semana
2️⃣ Plan 8 pagos — *${this.fmt(saldo / 8)}*/semana
4️⃣ Hablar con asesor`;
        }
        const monto = Math.round(saldo / 12);
        return `✅ *CONVENIO 12 PAGOS SELECCIONADO*

${cliente.nombre?.split(' ')[0] || 'Cliente'}, su plan queda así:

┌─────────────────────────
│ 💰 Deuda total: *${this.fmt(saldo)}*
│ 📦 Pagos: *12 semanales*
│ 💵 Monto c/pago: *${this.fmt(monto)}*
└─────────────────────────

Realice su *primer pago hoy* para activar:

${this.getDatosBancarios(telefono)}

📸 Envíe foto del comprobante aquí.

_Cobranza Mercantil Especializada_`;
      }
      case '4':
        return this.conectarGestor(telefono, cliente, 'Solicita asesor para convenio');
      default:
        return this.msgNoEntendido(nivel);
    }
  }

  conectarGestor(telefono, cliente, motivo) {
    const gestor = this.obtenerGestor();
    const nivel = this.getNivelMorosidad(cliente.diasAtraso || 0);
    this.guardarConversacion(telefono, this.ESTADOS.ESPERANDO_GESTOR, { gestor });
    this.registrarInteraccion(telefono, 'transferencia', `${gestor.nombre}: ${motivo}`);
    
    const prioridad = (nivel === 'CRITICO' || nivel === 'GRAVE') ? '🔴 ALTA' : '🟡 MEDIA';
    
    const notif = `🔔 *NUEVA SOLICITUD* ${prioridad}

┌─────────────────────────
│ 👤 *${cliente.nombre || 'No registrado'}*
│ 📱 ${telefono}
│ 💰 ${this.fmt(cliente.saldo || 0)}
│ 📅 ${cliente.diasAtraso || 'N/A'} días — ${nivel}
└─────────────────────────

📋 *${motivo}*
⏰ ${new Date().toLocaleString('es-MX')}`;

    const jidGestor = '52' + gestor.telefono + '@s.whatsapp.net';
    this.whatsapp.sock.sendMessage(jidGestor, { text: notif }).catch(e => {
      console.error('Error notificando gestor:', e.message);
    });
    
    console.log(`📤 Notificación → ${gestor.nombre} [${prioridad}]`);
    
    return `👤 *ASESOR ASIGNADO*

Su caso fue asignado a *${gestor.nombre}*.

${nivel === 'CRITICO' || nivel === 'GRAVE' ? 
'⚠️ *Caso prioritario* — Será contactado en minutos.' :
'Le contactarán pronto.'}

📞 Línea directa: ${gestor.telefono}

🕐 Lun-Vie 9:00 a 18:00
🕐 Sáb 9:00 a 14:00

_Cobranza Mercantil Especializada_`;
  }

  async manejarImagen(jid, telefono) {
    const cliente = this.obtenerCliente(telefono);
    this.registrarInteraccion(telefono, 'imagen', 'Posible comprobante');
    this.conectarGestor(telefono, cliente, '📷 Envió imagen (posible comprobante)');
    
    await this.whatsapp.sock.sendMessage(jid, { 
      text: `📷 *COMPROBANTE RECIBIDO*

Estamos verificando su pago.

⏱️ Validación: 30 min a 2 horas

✅ Si es válido, recibirá confirmación
❌ Si hay error, le notificaremos

Gracias por su pago.
_Cobranza Mercantil Especializada_` 
    });
  }

  msgEsperandoGestor(conv, nivel) {
    const tel = conv.gestor?.telefono || this.gestores[0].telefono;
    if (nivel === 'CRITICO') {
      return `⏳ Su caso *urgente* ya está siendo atendido.\n\nSi no recibe llamada en 10 min:\n📞 ${tel}`;
    }
    return `Su solicitud ya fue registrada.\nUn asesor lo contactará pronto.\n\n📞 Línea directa: ${tel}`;
  }

  // ═══════════════════════════════════════
  // MENSAJES PRINCIPALES
  // ═══════════════════════════════════════

  msgBienvenida(cliente, nivel) {
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;

    let header, info;

    switch (nivel) {
      case 'CRITICO':
        header = `🚨 *ALERTA — COBRANZA JUDICIAL*`;
        info = `\n⚠️ *${dias} días de atraso*\n💰 Deuda: *${this.fmt(saldo)}*\n⚖️ Su caso está por turnarse al área legal.\n`;
        break;
      case 'GRAVE':
        header = `⚠️ *AVISO URGENTE*`;
        info = `\n📅 *${dias} días de atraso*\n💰 Deuda: *${this.fmt(saldo)}*\n❌ Su historial crediticio está siendo afectado.\n`;
        break;
      case 'MODERADO':
        header = `📋 *RECORDATORIO DE PAGO*`;
        info = `\n📅 Atraso: ${dias} días\n💰 Saldo: ${this.fmt(saldo)}\n`;
        break;
      default:
        header = `📞 *LeGaXi Asesores*`;
        info = saldo > 0 ? `\n💰 Saldo pendiente: ${this.fmt(saldo)}\n` : '';
    }

    return `${header}

Hola *${nombre}* 👋${info}
Seleccione una opción:

1️⃣  💳  *Pagar* mi adeudo
2️⃣  📋  *Convenio* de pagos
3️⃣  🔍  *Consultar* mi saldo
4️⃣  👤  *Hablar* con asesor

_Responda con el número_

━━━━━━━━━━━━━━━━━━━━━
_Cobranza Mercantil Especializada_`;
  }

  msgOpcionesPago(cliente, nivel) {
    const saldo = cliente.saldo || 0;

    return `💳 *OPCIONES DE PAGO*

┌─────────────────────────
│ Saldo actual: *${this.fmt(saldo)}*
└─────────────────────────

1️⃣  💰  *Pago total* — Liquide su deuda
2️⃣  💵  *Pago parcial* — Abone lo que pueda
3️⃣  📋  *Plan de pagos* — Parcialidades
4️⃣  👤  *Hablar con asesor*

_Responda con el número_`;
  }

  msgPagoTotal(cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';

    return `🎉 *¡EXCELENTE DECISIÓN, ${nombre}!*

┌─────────────────────────
│ 💰 TOTAL A PAGAR: *${this.fmt(saldo)}*
└─────────────────────────

Deposite en cualquiera de estas cuentas:

${this.getDatosBancarios(cliente.telefono || 'Su número')}

📸 *Envíe foto del comprobante aquí* para confirmar su pago y liberar su cuenta.

_Cobranza Mercantil Especializada_`;
  }

  msgPagoParcial(cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const minimo = nivel === 'CRITICO' ? Math.round(saldo * 0.3) : nivel === 'GRAVE' ? Math.round(saldo * 0.25) : Math.round(saldo * 0.15);

    return `💵 *PAGO PARCIAL*

${nivel === 'CRITICO' || nivel === 'GRAVE' ? 
`⚠️ Por su nivel de atraso, el mínimo es:\n*${this.fmt(minimo)}*` :
`Puede abonar desde *${this.fmt(minimo)}*`}

${this.getDatosBancarios(cliente.telefono || 'Su número')}

✅ Cada pago reduce su deuda
✅ Detiene acciones temporalmente

📸 *Envíe comprobante aquí*

_Cobranza Mercantil Especializada_`;
  }

  msgConvenio(cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';

    if (nivel === 'CRITICO') {
      return `📋 *CONVENIO — ÚLTIMA OPORTUNIDAD*

${nombre}, por su nivel de atraso:

┌─────────────────────────
│ 💰 Deuda: *${this.fmt(saldo)}*
│ 📅 Atraso: *${cliente.diasAtraso} días*
└─────────────────────────

Planes disponibles:

1️⃣  *4 pagos* — *${this.fmt(saldo / 4)}*/semana
2️⃣  *8 pagos* — *${this.fmt(saldo / 8)}*/semana

⚠️ Requiere *primer pago HOY*
⚠️ Un pago faltante = Cancelación + acción legal

4️⃣  Hablar con asesor

_Responda con el número_`;
    }

    return `📋 *CONVENIO DE PAGOS*

${nombre}, elija el plan que mejor se ajuste:

┌─────────────────────────
│ 💰 Deuda total: *${this.fmt(saldo)}*
└─────────────────────────

1️⃣  *4 pagos*  →  *${this.fmt(saldo / 4)}*/semana
2️⃣  *8 pagos*  →  *${this.fmt(saldo / 8)}*/semana
3️⃣  *12 pagos*  →  *${this.fmt(saldo / 12)}*/semana
4️⃣  Hablar con asesor

_Responda con el número del plan_

_Cobranza Mercantil Especializada_`;
  }

  msgSaldo(cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;

    let alerta = '';
    if (nivel === 'CRITICO') {
      alerta = '\n🚨 *CUENTA EN COBRANZA JUDICIAL*\nPague hoy para evitar demanda.';
    } else if (nivel === 'GRAVE') {
      alerta = '\n⚠️ *CUENTA EN RIESGO*\nReportado a Buró de Crédito.';
    }

    return `🔍 *ESTADO DE CUENTA*

┌─────────────────────────
│ 👤 ${cliente.nombre || 'Titular'}
│ 💰 Saldo: *${this.fmt(saldo)}*
│ 📅 Atraso: *${dias} días*
│ ⚠️ Nivel: *${nivel}*
└─────────────────────────${alerta}

¿Qué desea hacer?
1️⃣ Pagar ahora
2️⃣ Hacer convenio
4️⃣ Hablar con asesor`;
  }

  msgNoEntendido(nivel) {
    const urgente = nivel === 'CRITICO' || nivel === 'GRAVE';
    
    return `${urgente ? '⚠️' : '🤔'} No entendí su respuesta.

Responda con el *número*:

1️⃣  Pagar
2️⃣  Convenio
3️⃣  Saldo
4️⃣  Asesor

${urgente ? '⏰ *Su caso es urgente, no demore.*' : 'O escriba *HOLA* para reiniciar'}`;
  }

  // ═══════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════

  extraerTelefono(jid) {
    let telefono = jid
      .replace('@s.whatsapp.net', '')
      .replace('@lid', '');
    if (telefono.startsWith('52') && telefono.length === 12) {
      telefono = telefono.substring(2);
    }
    if (telefono.length > 12) return telefono;
    return telefono;
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

  registrarInteraccion(telefono, tipo, detalle, jidOriginal = null) {
    this.interacciones.push({ 
      telefono, jid: jidOriginal, tipo, detalle, 
      timestamp: new Date().toISOString() 
    });
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
