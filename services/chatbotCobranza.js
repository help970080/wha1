/**
 * ChatBot de Cobranza - LeGaXi Asesores
 * ==========================================
 * Responde automáticamente a clientes
 * Notifica a gestores cuando es necesario
 * VERSIÓN: Cobranza Firme
 */

const fs = require('fs');

class ChatBotCobranza {
  constructor(whatsappService) {
    this.whatsapp = whatsappService;
    
    // Gestores configurados
    this.gestores = [
      { nombre: 'Lic. Alfonso', telefono: '5564304984', activo: true },
      { nombre: 'Lic. Gisella', telefono: '5548049622', activo: true }
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
      ESPERANDO_GESTOR: 'esperando_gestor',
      CONFIRMACION_PAGO: 'confirmacion_pago',
      EXCUSAS: 'excusas'
    };

    // Niveles de morosidad (días de atraso)
    this.NIVELES = {
      LEVE: 15,      // 1-15 días
      MODERADO: 30,  // 16-30 días
      GRAVE: 60,     // 31-60 días
      CRITICO: 90    // 61+ días
    };
    
    this.activo = false;
    this.cargarDatos();
  }

  iniciar() {
    if (this.activo) return;
    
    console.log('\n🤖 ════════════════════════════════════');
    console.log('   CHATBOT DE COBRANZA INICIADO');
    console.log('   LeGaXi Asesores');
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

  // Obtener nivel de morosidad
  getNivelMorosidad(diasAtraso) {
    if (diasAtraso <= this.NIVELES.LEVE) return 'LEVE';
    if (diasAtraso <= this.NIVELES.MODERADO) return 'MODERADO';
    if (diasAtraso <= this.NIVELES.GRAVE) return 'GRAVE';
    return 'CRITICO';
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
    
    // Detectar excusas comunes
    if (this.esExcusa(textoLimpio)) {
      return this.manejarExcusa(telefono, textoLimpio, cliente, nivel);
    }

    // Detectar negativas o evasiones
    if (this.esNegativa(textoLimpio)) {
      return this.manejarNegativa(telefono, cliente, nivel);
    }

    // Detectar agresiones o groserías
    if (this.esAgresion(textoLimpio)) {
      return this.manejarAgresion(telefono, cliente);
    }
    
    // Comandos globales
    if (['hola', 'hi', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches'].some(cmd => textoLimpio.includes(cmd))) {
      this.guardarConversacion(telefono, this.ESTADOS.MENU);
      return this.msgBienvenida(cliente, nivel);
    }
    
    // Procesar según estado
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
  // MANEJO DE SITUACIONES ESPECIALES
  // ═══════════════════════════════════════

  manejarExcusa(telefono, texto, cliente, nivel) {
    this.guardarConversacion(telefono, this.ESTADOS.EXCUSAS);
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;

    // Excusa: "Ya pagué"
    if (texto.includes('ya pagué') || texto.includes('ya pague') || texto.includes('está pagado')) {
      return `⚠️ *IMPORTANTE*

No tenemos registro de su pago.

Si ya realizó el pago, envíe su comprobante *AHORA* para aclararlo.

Sin comprobante, su deuda de *$${saldo.toLocaleString('es-MX')}* sigue vigente y las acciones de cobranza continuarán.

📸 Envíe foto del comprobante`;
    }

    // Excusa: "No es mi deuda"
    if (texto.includes('no es mío') || texto.includes('no reconozco') || texto.includes('yo no saqué')) {
      return `⚠️ *AVISO LEGAL*

El crédito está registrado a su nombre con los siguientes datos verificados:
• Teléfono: ${telefono}
• Identificación oficial
• Comprobante de domicilio

Si es víctima de *fraude de identidad*, tiene 24 horas para presentar:
1️⃣ Denuncia ante el MP
2️⃣ Reporte a CONDUSEF

De lo contrario, usted es *legalmente responsable* de esta deuda.

¿Desea hablar con un asesor legal?
Responda *SI* o *NO*`;
    }

    // Excusa temporal: "Después", "Mañana", "Quincena"
    if (texto.includes('después') || texto.includes('mañana') || texto.includes('quincena') || texto.includes('fin de mes')) {
      if (nivel === 'CRITICO' || nivel === 'GRAVE') {
        return `🚫 *YA NO HAY MÁS TIEMPO*

Sr(a). ${cliente.nombre || 'Cliente'}:

Su cuenta tiene *${dias} DÍAS DE ATRASO*.
Ya se agotaron todas las prórrogas.

⚖️ *CONSECUENCIAS INMEDIATAS:*
• Reporte a Buró de Crédito (ya activo)
• Incremento de intereses moratorios
• Inicio de proceso de cobranza judicial

💰 Pague HOY mínimo *$${Math.round(saldo * 0.3).toLocaleString('es-MX')}* para detener acciones.

¿Va a pagar ahora?
1️⃣ SÍ, voy a pagar
2️⃣ Necesito hablar con un asesor`;
      } else {
        return `📅 *COMPROMISO DE PAGO*

Entiendo su situación, pero su deuda no puede esperar más.

Deuda actual: *$${saldo.toLocaleString('es-MX')}*
Días de atraso: *${dias}*

¿Cuándo exactamente puede pagar?
1️⃣ Hoy mismo
2️⃣ Mañana sin falta
3️⃣ Esta semana (máximo viernes)
4️⃣ Necesito un convenio formal

⚠️ Sin compromiso concreto, su caso escala a cobranza externa.`;
      }
    }

    // Excusa económica: "No tengo dinero"
    if (texto.includes('no tengo') || texto.includes('no me alcanza') || texto.includes('sin dinero')) {
      return `💡 *SOLUCIONES DISPONIBLES*

Entendemos la situación económica, PERO la deuda existe y debe resolverse.

*OPCIONES REALISTAS:*

1️⃣ *Pago mínimo HOY* - $${Math.round(saldo * 0.1).toLocaleString('es-MX')} (10%)
   Detiene llamadas por 7 días

2️⃣ *Convenio de pagos* - Desde $${Math.round(saldo / 8).toLocaleString('es-MX')}/semana
   Plan a 8 semanas

3️⃣ *Liquidación total* - $${saldo.toLocaleString('es-MX')}
   Libérese de la deuda hoy

4️⃣ Hablar con asesor para negociar

❌ "No tengo" no es opción. Todos tienen *algo*.
   ¿Vende algo? ¿Pide prestado? ¿Empeña?

Responda con el número de su opción:`;
    }

    // Excusa genérica
    return `⚠️ *AVISO IMPORTANTE*

Sr(a). ${cliente.nombre || 'Cliente'}:

Las excusas NO eliminan su deuda de *$${saldo.toLocaleString('es-MX')}*.

Cada día que pasa:
❌ Aumentan los intereses
❌ Se afecta más su historial crediticio
❌ Se acerca la acción legal

*ACTÚE AHORA:*
1️⃣ Pagar hoy (con descuento)
2️⃣ Hacer un convenio
3️⃣ Hablar con asesor

No responder = Aceptar consecuencias legales`;
  }

  manejarNegativa(telefono, cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;

    this.conectarGestor(telefono, cliente, '🚨 CLIENTE NEGADO A PAGAR - Requiere atención especial');

    return `⚖️ *NOTIFICACIÓN LEGAL*

Su negativa a pagar ha quedado registrada.

*DATOS DEL ADEUDO:*
• Deudor: ${cliente.nombre || 'Titular'}
• Monto: $${saldo.toLocaleString('es-MX')}
• Atraso: ${dias} días
• Fecha: ${new Date().toLocaleDateString('es-MX')}

*CONSECUENCIAS DE NO PAGAR:*

1️⃣ *BURÓ DE CRÉDITO*
   Su historial quedará manchado por 6 AÑOS
   No podrá obtener: créditos, tarjetas, hipotecas, auto

2️⃣ *COBRANZA JUDICIAL*
   Demanda civil por la cantidad adeudada
   Gastos y costas legales a su cargo
   Embargo de bienes

3️⃣ *COBRANZA EN DOMICILIO*
   Visitas a su domicilio registrado
   Notificación a referencias personales

⏰ Tiene *24 HORAS* para reconsiderar.

Un asesor legal se comunicará con usted.`;
  }

  manejarAgresion(telefono, cliente) {
    this.conectarGestor(telefono, cliente, '⚠️ CLIENTE AGRESIVO - Posible caso legal');

    return `⚠️ *ADVERTENCIA*

Su mensaje ha sido registrado y guardado.

Las agresiones verbales no eliminan su deuda ni intimidan a esta institución.

Este chat puede ser usado como *evidencia* en procedimientos legales.

Un supervisor revisará su caso.

_LeGaXi Asesores_`;
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
    switch (texto) {
      case '1':
        return this.conectarGestor(telefono, cliente, 'Solicita llamada para convenio');
      case '2':
        return this.conectarGestor(telefono, cliente, 'Solicita WhatsApp para convenio');
      case '3':
        if (nivel === 'CRITICO' || nivel === 'GRAVE') {
          return `⚠️ *NO DISPONIBLE*

Debido a su nivel de atraso (*${cliente.diasAtraso} días*), ya no puede posponer.

Debe hablar con un asesor AHORA para evitar acciones legales.

1️⃣ Que me llamen
2️⃣ Por WhatsApp`;
        }
        this.guardarConversacion(telefono, this.ESTADOS.MENU);
        return `Tiene *48 horas* para comunicarse, después su caso escala.\n\nEscriba *HOLA* cuando esté listo.\n\n_LeGaXi Asesores_`;
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

👤 *Cliente:* ${cliente.nombre || 'No registrado'}
📱 *Tel:* ${telefono}
💰 *Saldo:* $${(cliente.saldo || 0).toLocaleString('es-MX')}
📅 *Atraso:* ${cliente.diasAtraso || 'N/A'} días
⚠️ *Nivel:* ${nivel}

📋 *Motivo:* ${motivo}

⏰ ${new Date().toLocaleString('es-MX')}`;

    const jidGestor = '52' + gestor.telefono + '@s.whatsapp.net';
    this.whatsapp.sock.sendMessage(jidGestor, { text: notif }).catch(e => {
      console.error('Error notificando gestor:', e.message);
    });
    
    console.log(`📤 Notificación enviada a ${gestor.nombre} [${prioridad}]`);
    
    return `👤 *CONECTANDO CON ASESOR*

Su caso ha sido asignado a *${gestor.nombre}*.

${nivel === 'CRITICO' || nivel === 'GRAVE' ? 
'⚠️ *CASO PRIORITARIO* - Será contactado en minutos.' :
'Será contactado pronto.'}

📞 Urgente: ${gestor.telefono}

⏰ Horario: Lunes a Viernes 9:00-18:00
   Sábado: 9:00-14:00`;
  }

  async manejarImagen(jid, telefono) {
    const cliente = this.obtenerCliente(telefono);
    this.registrarInteraccion(telefono, 'imagen', 'Posible comprobante');
    
    this.conectarGestor(telefono, cliente, '📷 Envió imagen (posible comprobante)');
    
    await this.whatsapp.sock.sendMessage(jid, { 
      text: `📷 *COMPROBANTE RECIBIDO*

Estamos verificando su pago.

⏱️ Tiempo de validación: 30 minutos a 2 horas

📌 Si su pago es válido, recibirá confirmación.
📌 Si hay algún problema, le notificaremos.

Gracias por su pago.
_LeGaXi Asesores_` 
    });
  }

  msgEsperandoGestor(conv, nivel) {
    if (nivel === 'CRITICO') {
      return `⏳ Su caso URGENTE ya está siendo atendido.\n\nSi no recibe llamada en 10 minutos:\n📞 ${conv.gestor?.telefono || this.gestores[0].telefono}`;
    }
    return `Su solicitud ya fue registrada.\n\nUn asesor lo contactará pronto.\n\n📞 Urgente: ${conv.gestor?.telefono || this.gestores[0].telefono}`;
  }

  // ═══════════════════════════════════════
  // MENSAJES SEGÚN NIVEL DE MOROSIDAD
  // ═══════════════════════════════════════

  msgBienvenida(cliente, nivel) {
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;

    let header = '';
    let urgencia = '';

    switch (nivel) {
      case 'CRITICO':
        header = `🚨 *ALERTA DE COBRANZA JUDICIAL*`;
        urgencia = `\n⚠️ *${dias} DÍAS DE ATRASO*\n💰 Deuda: *$${saldo.toLocaleString('es-MX')}*\n⚖️ Su caso está por turnarse al área legal.\n`;
        break;
      case 'GRAVE':
        header = `⚠️ *AVISO URGENTE DE COBRANZA*`;
        urgencia = `\n📅 *${dias} días de atraso*\n💰 Deuda: *$${saldo.toLocaleString('es-MX')}*\n❌ Su historial crediticio está siendo afectado.\n`;
        break;
      case 'MODERADO':
        header = `📋 *RECORDATORIO DE PAGO*`;
        urgencia = `\n📅 Atraso: ${dias} días\n💰 Saldo: $${saldo.toLocaleString('es-MX')}\n`;
        break;
      default:
        header = `📞 *LeGaXi Asesores*`;
        urgencia = saldo > 0 ? `\n💰 Saldo pendiente: $${saldo.toLocaleString('es-MX')}\n` : '';
    }

    return `${header}

Hola *${nombre}*${urgencia}
¿Qué desea hacer?

1️⃣ *PAGAR* mi adeudo
2️⃣ *CONVENIO* de pago
3️⃣ *CONSULTAR* mi saldo
4️⃣ *HABLAR* con asesor

_Responda con el número_`;
  }

  msgOpcionesPago(cliente, nivel) {
    const saldo = cliente.saldo || 0;

    return `💰 *OPCIONES DE PAGO*

Saldo actual: *$${saldo.toLocaleString('es-MX')}*

1️⃣ *Pago total* - Liquide su deuda
2️⃣ *Pago parcial* - Abone lo que pueda
3️⃣ *Plan de pagos* - Parcialidades
4️⃣ *Hablar con asesor*

_Responda con el número_`;
  }

  msgPagoTotal(cliente, nivel) {
    const saldo = cliente.saldo || 0;

    return `🎉 *¡EXCELENTE DECISIÓN!*

*TOTAL A PAGAR: $${saldo.toLocaleString('es-MX')}*

📱 *DATOS PARA PAGO:*

🏦 Banco: BBVA
📋 CLABE: 012345678901234567
👤 A nombre de: LeGaXi Asesores
📝 Referencia: ${cliente.telefono || 'Su número'}

📸 Envíe foto de su comprobante aquí para confirmar.`;
  }

  msgPagoParcial(cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const minimo = nivel === 'CRITICO' ? Math.round(saldo * 0.3) : nivel === 'GRAVE' ? Math.round(saldo * 0.25) : Math.round(saldo * 0.15);

    return `💵 *PAGO PARCIAL*

${nivel === 'CRITICO' || nivel === 'GRAVE' ? 
`⚠️ Debido a su atraso, el pago mínimo es:\n*$${minimo.toLocaleString('es-MX')}*` :
`Puede abonar desde *$${minimo.toLocaleString('es-MX')}*`}

📱 *DATOS:*
🏦 Banco: BBVA
📋 CLABE: 012345678901234567
👤 LeGaXi Asesores

✅ Cada pago reduce su deuda
✅ Detiene acciones de cobranza temporalmente
✅ Mejora su situación

📸 Envíe su comprobante aquí.`;
  }

  msgConvenio(cliente, nivel) {
    const saldo = cliente.saldo || 0;

    if (nivel === 'CRITICO') {
      return `📋 *CONVENIO DE ÚLTIMA OPORTUNIDAD*

⚠️ Por su nivel de atraso, solo disponible:

✅ *Plan 4 semanas* - $${Math.round(saldo / 4).toLocaleString('es-MX')}/semana
✅ *Plan 8 semanas* - $${Math.round(saldo / 8).toLocaleString('es-MX')}/semana

❌ Requiere *primer pago HOY* para activar convenio
❌ Un solo pago faltante = Cancelación y acción legal

1️⃣ Acepto, quiero convenio
2️⃣ Hablar con asesor`;
    }

    return `📋 *OPCIONES DE CONVENIO*

✅ *Plan 4 semanas* - $${Math.round(saldo / 4).toLocaleString('es-MX')}/semana
✅ *Plan 8 semanas* - $${Math.round(saldo / 8).toLocaleString('es-MX')}/semana
✅ *Plan personalizado* - Según su capacidad

¿Desea que lo contacten?

1️⃣ Sí, que me llamen
2️⃣ Prefiero WhatsApp
3️⃣ Yo me comunico después`;
  }

  msgSaldo(cliente, nivel) {
    const saldo = cliente.saldo || 0;
    const dias = cliente.diasAtraso || 0;

    let advertencia = '';
    if (nivel === 'CRITICO') {
      advertencia = '\n\n🚨 *CUENTA EN COBRANZA JUDICIAL*\nPague hoy para evitar demanda.';
    } else if (nivel === 'GRAVE') {
      advertencia = '\n\n⚠️ *CUENTA EN RIESGO*\nYa fue reportado a Buró de Crédito.';
    }

    return `📊 *ESTADO DE CUENTA*

*Cliente:* ${cliente.nombre || 'Titular'}
*Saldo:* $${saldo.toLocaleString('es-MX')}
*Días de atraso:* ${dias}
*Nivel:* ${nivel}${advertencia}

¿Qué desea hacer?
1️⃣ Pagar ahora
4️⃣ Hablar con asesor`;
  }

  msgNoEntendido(nivel) {
    const urgente = nivel === 'CRITICO' || nivel === 'GRAVE';
    
    return `${urgente ? '⚠️' : '🤔'} No entendí su respuesta.

Responda con el *número*:

1️⃣ Pagar
2️⃣ Convenio
3️⃣ Saldo
4️⃣ Asesor

${urgente ? '⏰ *Su caso es urgente, no demore.*' : 'O escriba *HOLA*'}`;
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
    
    if (telefono.length > 12) {
      return telefono;
    }
    
    return telefono;
  }

  formatearTelefonoDisplay(telefono) {
    if (telefono.length === 10) {
      return telefono.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
    }
    if (telefono.length > 10) {
      return '...' + telefono.slice(-10);
    }
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
      telefono, 
      jid: jidOriginal,
      tipo, 
      detalle, 
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
