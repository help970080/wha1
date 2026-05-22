/**
 * ═══════════════════════════════════════════════════════════
 * ChatBot de Cobranza - LeGaXi Asesores  (v2 - FIX IDENTIFICACIÓN)
 * Cobranza Mercantil Especializada
 * ═══════════════════════════════════════════════════════════
 *
 * Cambios vs versión anterior:
 *  - resolverTelefono(): elimina fallback "primer cliente sin LID".
 *    Match por pushName ahora exige score 3+ y diferencia con segundo.
 *  - obtenerCliente(): ya no inventa "Cliente" genérico, marca como
 *    desconocido para que el bot pida identificación.
 *  - generarRespuesta(): nuevo flujo de IDENTIFICACION para cuando
 *    el cliente no se puede resolver automáticamente.
 *  - cargarCartera(): limpia clientes, lidMap y conversaciones antes
 *    de cargar nueva base.
 *  - identificarManual(): nueva función para matchear cuando el
 *    cliente envía su nombre o número de crédito.
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

    // ═══════════════════════════════════════
    // CONFIGURACIÓN DE CONVENIOS v3 (2026-05)
    // ═══════════════════════════════════════
    this.CONVENIO = {
      // 2 planes por PISO MÍNIMO de pago semanal.
      // El pago real puede ser >= al piso; se calcula buscando el máximo
      // de semanas posibles sin que el pago caiga por debajo del piso.
      planA_monto: 1000,   // Plan rápido (piso $1,000/sem)
      planB_monto: 500,    // Plan accesible (piso $500/sem)
      // Recargo si el plazo supera 4 semanas
      semanasSinRecargo: 4,
      recargo: 0.15,
      // Si el saldo cabe en 4 semanas o menos con $1,000/sem -> pago único
      umbralPagoUnico: 4000,
      // URL pública del convenio prellenado (CAMBIAR cuando se confirme hosting)
      urlConvenio: process.env.CONVENIO_URL || 'https://convenios.celexpress.org/LGX_Convenios.html'
    };

    // Datos en memoria
    this.clientes = new Map();
    this.conversaciones = new Map();
    this.lidMap = new Map(); // LID → teléfono real
    this.interacciones = [];

    // Estados
    this.ESTADOS = {
      INICIAL: 'inicial',
      MENU: 'menu',
      OPCIONES_PAGO: 'opciones_pago',
      CONVENIO: 'convenio',
      ESPERANDO_GESTOR: 'esperando_gestor',
      CONFIRMACION_PAGO: 'confirmacion_pago',
      EXCUSAS: 'excusas',
      IDENTIFICACION: 'identificacion',
      // v3: nuevos estados para flujo de cierre directo
      PROPUESTA_CONVENIO: 'propuesta_convenio',     // Bot propuso A/B, espera elección
      ESPERA_CONFIRMACION: 'espera_confirmacion',   // Bot mandó link, espera "CONFIRMO"
      CONVENIO_ACTIVO: 'convenio_activo',           // Cliente confirmó, espera comprobante
      PAGO_UNICO: 'pago_unico'                      // Saldo bajo, no convenio
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
    console.log('   LeGaXi Asesores - CME (v2)');
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

  fmt(cantidad) {
    return '$' + Math.round(cantidad).toLocaleString('es-MX');
  }

  // ═══════════════════════════════════════
  // v3: HELPERS DE CONVENIO
  // ═══════════════════════════════════════

  /**
   * Calcula los 2 planes para un saldo dado:
   *   Plan A: pago semanal alto (piso $1,000), menos semanas
   *   Plan B: pago semanal bajo (piso $500), más semanas
   * 
   * REGLA CLAVE (2026-05): el pago semanal debe ser >= al piso del plan,
   * pero NO se fuerza a ser exactamente el piso. Se busca el MÁXIMO de
   * semanas posibles tal que pago ≥ piso. Ejemplo:
   *   Saldo $9,775 ÷ 19 = $515 ✅ (válido, pago ≥ $500)
   *   Saldo $9,775 ÷ 20 = $489 ❌ (inválido, pago < $500)
   *   → Plan B = 19 semanas de $515
   *
   * Aplica 15% de recargo si el plazo supera 4 semanas.
   * Retorna pago único si el saldo es bajo.
   */
  calcularPlanes(saldo) {
    const c = this.CONVENIO;

    // ¿Cabe en pago único? -> Saldo bajo
    if (saldo <= c.umbralPagoUnico) {
      return {
        pagoUnico: true,
        montoTotal: saldo,
        fechaPago: this.proximoDiaHabil()
      };
    }

    // Helper: calcula plan óptimo dado un pago mínimo (piso)
    // Devuelve {semanas, monto, saldoConRecargo, conRecargo}
    const calcularPlanOptimo = (pisoMonto) => {
      // Primer paso: estimar semanas SIN recargo
      const semanasSinRecargo = Math.floor(saldo / pisoMonto);
      
      let saldoFinal, conRecargo;
      if (semanasSinRecargo <= c.semanasSinRecargo) {
        // Cabe en ≤4 semanas sin recargo
        saldoFinal = saldo;
        conRecargo = false;
      } else {
        // Pasa de 4 semanas → aplica 15%
        saldoFinal = saldo * (1 + c.recargo);
        conRecargo = true;
      }
      
      // Máximo de semanas tal que (saldoFinal / semanas) >= pisoMonto
      // Equivale a: semanas <= saldoFinal / pisoMonto
      const semanas = Math.floor(saldoFinal / pisoMonto);
      
      // Pago real = saldoFinal / semanas (redondeado hacia arriba al peso)
      const montoReal = Math.ceil(saldoFinal / semanas);
      
      return {
        monto: montoReal,
        semanas: semanas,
        saldoConRecargo: Math.round(saldoFinal),
        conRecargo: conRecargo,
        fechaInicio: this.proximoDiaHabil(),
        fechaFin: this.fechaFinal(semanas)
      };
    };

    return {
      pagoUnico: false,
      planA: calcularPlanOptimo(c.planA_monto),  // piso $1,000
      planB: calcularPlanOptimo(c.planB_monto)   // piso $500
    };
  }

  /**
   * Devuelve el próximo día hábil (L-V) desde hoy.
   * Si hoy es L-V, regresa hoy. Si es sábado/domingo, regresa lunes.
   */
  proximoDiaHabil(fecha = new Date()) {
    const d = new Date(fecha);
    const dia = d.getDay(); // 0=domingo, 6=sábado
    if (dia === 0) d.setDate(d.getDate() + 1);      // domingo -> lunes
    else if (dia === 6) d.setDate(d.getDate() + 2); // sábado -> lunes
    return d;
  }

  /** Suma N semanas a la fecha inicial para obtener la fecha final del convenio. */
  fechaFinal(semanas, desde = null) {
    const inicio = desde || this.proximoDiaHabil();
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + (semanas - 1) * 7);
    return fin;
  }

  /** Formatea fecha tipo "VIERNES 22 MAY" */
  fmtFecha(fecha) {
    // Aceptar string ISO o Date
    const f = (fecha instanceof Date) ? fecha : new Date(fecha);
    const dias = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const meses = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
    return `${dias[f.getDay()]} ${f.getDate()} ${meses[f.getMonth()]}`;
  }

  /** Formato corto para URL: 2026-05-22 */
  fmtFechaISO(fecha) {
    const f = (fecha instanceof Date) ? fecha : new Date(fecha);
    return f.toISOString().slice(0, 10);
  }

  /**
   * Construye URL del convenio con todos los datos prellenados.
   * El HTML LGX_Convenios.html debe leer estos query params.
   */
  buildUrlConvenio(cliente, plan, datos) {
    const params = new URLSearchParams({
      cliente: cliente.nombre || '',
      tel: cliente.telefono || '',
      saldo: cliente.saldo || 0,
      plan: plan,  // 'A' o 'B'
      semanas: datos.semanas,
      monto: datos.monto,
      saldoTotal: datos.saldoConRecargo,
      fechaInicio: this.fmtFechaISO(datos.fechaInicio),
      fechaFin: this.fmtFechaISO(datos.fechaFin),
      recargo: datos.conRecargo ? 1 : 0
    });
    return `${this.CONVENIO.urlConvenio}?${params.toString()}`;
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

      let telefono = this.extraerTelefono(jid);
      const texto = this.extraerTexto(msg);

      if (!jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) {
        return;
      }

      // === RESOLVER TELÉFONO REAL ===
      let telParaConv = this.resolverTelefono(telefono, msg);

      if (!texto) {
        if (msg.message?.imageMessage) {
          await this.manejarImagen(jid, telParaConv);
        }
        return;
      }

      const mapped = telParaConv !== telefono;
      console.log(`📨 [${telParaConv}${mapped ? ' ←LID:'+telefono : ''}] ${texto.substring(0, 50)}`);
      this.registrarInteraccion(telParaConv, 'recibido', texto, jid);

      const respuesta = this.generarRespuesta(telParaConv, texto);

      if (respuesta) {
        await this.whatsapp.sock.sendMessage(jid, { text: respuesta });
        this.registrarInteraccion(telParaConv, 'enviado', respuesta.substring(0, 50), jid);
      }
    } catch (error) {
      console.error('❌ Error en chatbot:', error.message);
    }
  }

  // ═══════════════════════════════════════
  // RESOLVER TELÉFONO  (FIX PRINCIPAL)
  // ═══════════════════════════════════════

  /**
   * Resuelve un teléfono/LID al teléfono real del cliente.
   * NUNCA inventa: si no hay match confiable, devuelve el original
   * y el bot pedirá identificación al cliente.
   */
  resolverTelefono(telefono, msg) {
    // 1. Match directo
    if (this.clientes.has(telefono)) return telefono;

    // 2. LID ya mapeado previamente
    if (this.lidMap.has(telefono)) return this.lidMap.get(telefono);

    // 3. Últimos 10 dígitos
    const tel10 = telefono.replace(/\D/g, '').slice(-10);
    if (tel10.length === 10 && this.clientes.has(tel10)) {
      this.lidMap.set(telefono, tel10);
      return tel10;
    }

    // 4. Con prefijo 52
    if (this.clientes.has('52' + tel10)) {
      this.lidMap.set(telefono, '52' + tel10);
      return '52' + tel10;
    }

    // 5. Si solo hay 1 cliente, ES ESE (asignación segura)
    if (this.clientes.size === 1) {
      const unicoTel = [...this.clientes.keys()][0];
      this.lidMap.set(telefono, unicoTel);
      console.log(`🔗 Auto: único cliente ${telefono} → ${unicoTel}`);
      return unicoTel;
    }

    // 6. Match ESTRICTO por pushName: requiere score 3+
    //    y diferencia clara con el segundo lugar.
    //    Esto evita matches por apellidos comunes (Martínez, López, García).
    const pushName = (msg?.pushName || '').trim().toLowerCase();
    if (pushName.length >= 5) {
      const pushParts = pushName.split(/\s+/).filter(p => p.length >= 3);
      let mejorMatch = null;
      let mejorScore = 0;
      let segundoScore = 0;

      for (const [tel, cli] of this.clientes) {
        const nombreParts = (cli.nombre || '').toLowerCase().split(/\s+/).filter(p => p.length >= 3);
        let score = 0;
        for (const np of nombreParts) {
          for (const pp of pushParts) {
            if (np === pp) score += 2;        // match exacto vale más
            else if (np.startsWith(pp) || pp.startsWith(np)) score += 1;
          }
        }
        if (score > mejorScore) {
          segundoScore = mejorScore;
          mejorScore = score;
          mejorMatch = tel;
        } else if (score > segundoScore) {
          segundoScore = score;
        }
      }

      if (mejorMatch && mejorScore >= 3 && mejorScore > segundoScore) {
        this.lidMap.set(telefono, mejorMatch);
        console.log(`🔗 Match pushName "${pushName}" → ${mejorMatch} (score ${mejorScore})`);
        return mejorMatch;
      }
    }

    // 7. SIN MATCH CONFIABLE: devolver original.
    //    El bot detectará que es desconocido y pedirá identificación.
    //    NO inventamos nada para evitar dirigirnos al cliente equivocado.
    console.log(`⚠️ Sin match confiable: LID=${telefono} pushName="${pushName}" clientes=${this.clientes.size}`);
    return telefono;
  }

  /**
   * Match manual cuando el cliente envía su nombre o número de crédito
   * después de que el bot le pidió identificarse.
   */
  identificarManual(telefonoOLid, datoIdentificacion) {
    const dato = (datoIdentificacion || '').trim().toLowerCase();
    if (dato.length < 3) return null;

    // Si manda 10 dígitos, intentar matchear como teléfono
    const soloDigitos = dato.replace(/\D/g, '');
    if (soloDigitos.length === 10 && this.clientes.has(soloDigitos)) {
      this.lidMap.set(telefonoOLid, soloDigitos);
      console.log(`🔗 Identificación manual por teléfono: ${telefonoOLid} → ${soloDigitos}`);
      return soloDigitos;
    }

    // Match por nombre (estricto)
    const palabras = dato.split(/\s+/).filter(p => p.length >= 3);
    let mejor = null, mejorScore = 0;
    for (const [tel, cli] of this.clientes) {
      const nombreParts = (cli.nombre || '').toLowerCase().split(/\s+/);
      let score = 0;
      for (const p of palabras) {
        for (const np of nombreParts) {
          if (np === p) score += 2;
          else if (np.startsWith(p) || p.startsWith(np)) score += 1;
        }
      }
      if (score > mejorScore) { mejorScore = score; mejor = tel; }
    }
    if (mejor && mejorScore >= 3) {
      this.lidMap.set(telefonoOLid, mejor);
      console.log(`🔗 Identificación manual por nombre: ${telefonoOLid} → ${mejor}`);
      return mejor;
    }
    return null;
  }

  // ═══════════════════════════════════════
  // GENERAR RESPUESTA  (FIX: maneja desconocidos)
  // ═══════════════════════════════════════

  generarRespuesta(telefono, texto) {
    const textoLimpio = texto.trim().toLowerCase();
    const cliente = this.obtenerCliente(telefono);
    const conv = this.obtenerConversacion(telefono);

    // FIX: si no identificamos al cliente, pedir identificación
    // en lugar de saludarlo con un nombre equivocado
    if (cliente.desconocido) {
      // Si ya estaba en estado de identificación, intentar matchear
      if (conv.estado === this.ESTADOS.IDENTIFICACION) {
        const telReal = this.identificarManual(telefono, texto);
        if (telReal) {
          // v3: pasar directo a propuesta de convenio, no al menú
          this.guardarConversacion(telReal, this.ESTADOS.PROPUESTA_CONVENIO);
          const clienteReal = this.obtenerCliente(telReal);
          const nivelReal = this.getNivelMorosidad(clienteReal.diasAtraso || 0);
          return this.msgBienvenida(clienteReal, nivelReal);
        }
        return `❌ No logré identificarlo con esos datos.

Por favor envíe su *nombre completo* tal como aparece en su contrato, o su *número de crédito / teléfono registrado*.`;
      }
      // Primer mensaje sin identificar → pedir datos
      this.guardarConversacion(telefono, this.ESTADOS.IDENTIFICACION);
      return `👋 Hola, le saluda *LeGaXi Asesores* — Cobranza Mercantil Especializada.

No logro identificarlo en nuestro sistema. ¿Me podría confirmar su *nombre completo* o su *número de crédito* para atenderlo correctamente?

_Esto nos ayuda a evitar errores y proteger su información._`;
    }

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

    // v3: saludo -> ir directo a propuesta de convenio
    if (['hola', 'hi', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches'].some(cmd => textoLimpio.includes(cmd))) {
      this.guardarConversacion(telefono, this.ESTADOS.PROPUESTA_CONVENIO);
      return this.msgBienvenida(cliente, nivel);
    }

    switch (conv.estado) {
      // v3: nuevos estados
      case this.ESTADOS.PROPUESTA_CONVENIO:
        return this.procesarPropuestaConvenio(telefono, textoLimpio, cliente, nivel);
      case this.ESTADOS.ESPERA_CONFIRMACION:
        return this.procesarEsperaConfirmacion(telefono, textoLimpio, cliente, nivel);
      case this.ESTADOS.CONVENIO_ACTIVO:
        return this.procesarConvenioActivo(telefono, textoLimpio, cliente, nivel);
      // Estados legacy (mantener por compatibilidad)
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
        // v3: por defecto, propuesta de convenio (no menú)
        this.guardarConversacion(telefono, this.ESTADOS.PROPUESTA_CONVENIO);
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

  /**
   * v3.1: detecta despedidas y agradecimientos para cerrar conversación
   * sin volver a ofrecer convenio (evita el ciclo).
   * Solo detecta cuando el mensaje es CORTO y se parece a una despedida —
   * "muchas gracias por todo me comunico mañana" cuenta, pero "gracias y
   * cuándo es el siguiente pago" NO porque tiene una pregunta.
   */
  esDespedida(texto) {
    const t = texto.toLowerCase().trim();
    // Limitar a mensajes cortos (< 60 chars) para no confundir con preguntas
    if (t.length > 60) return false;
    // Si el mensaje contiene signo de pregunta o palabras de duda, no es despedida
    if (/[?¿]|cuando|cuánto|cómo|donde|dónde|porque|por que|qué hago|que hago/i.test(t)) return false;
    
    const despedidas = [
      'gracias', 'muchas gracias', 'mil gracias', 'ok gracias',
      'okay gracias', 'va gracias', 'bien gracias',
      'hasta luego', 'hasta pronto', 'nos vemos', 'bye',
      'adios', 'adiós', 'hasta mañana', 'que tenga buen dia',
      'que tenga buena tarde', 'que tenga buena noche',
      'buen día', 'buena tarde', 'buena noche',
      'me comunico', 'le aviso', 'te aviso', 'aviso', 'cualquier cosa aviso',
      'le marco', 'te marco', 'te llamo', 'le llamo',
      'esta bien', 'está bien', 'entendido', 'comprendido',
      'ok', 'okay', 'okey', 'oki', 'vale', 'va', 'sale', 'listo',
      'perfecto', 'excelente', 'genial'
    ];
    // Match exacto o casi exacto (toda la cadena ES la despedida)
    return despedidas.some(d => t === d || t === d + '.' || t === d + '!');
  }

  // ═══════════════════════════════════════
  // DATOS BANCARIOS
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
    const saldo = cliente.saldo ?? 0;
    const dias = cliente.diasAtraso || 0;
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';

    if (texto.includes('ya pagué') || texto.includes('ya pague') || texto.includes('está pagado')) {
      return `⚠️ *VERIFICACIÓN DE PAGO*

${nombre}, no encontramos registro de su pago en nuestro sistema.

Si ya realizó el depósito, envíe su comprobante *ahora mismo* para validarlo.

💰 Deuda registrada: *${this.fmt(saldo)}*

Sin comprobante, la deuda sigue vigente y las acciones de cobranza continúan.

📸 *Envíe foto del comprobante*`;
    }

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
    const saldo = cliente.saldo ?? 0;
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

  // ═══════════════════════════════════════════════════════════════════
  // v3: NUEVOS PROCESADORES — FLUJO DE CIERRE DIRECTO
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Cliente está en estado PROPUESTA_CONVENIO. Espera "A" o "B" para
   * aceptar uno de los 2 planes, "3" para hablar con asesor, o pago
   * único si el saldo es bajo.
   */
  procesarPropuestaConvenio(telefono, texto, cliente, nivel) {
    const saldo = cliente.saldo ?? 0;
    const planes = this.calcularPlanes(saldo);
    const t = texto.toLowerCase().trim();

    // CASO PAGO ÚNICO: cualquier respuesta afirmativa o "1" lo activa
    if (planes.pagoUnico) {
      if (/^(si|sí|s|ok|va|acepto|confirmo|1|listo)$/i.test(t) || t.includes('acepto') || t.includes('confirmo')) {
        this.guardarConversacion(telefono, this.ESTADOS.CONVENIO_ACTIVO);
        return this.msgPagoUnicoConfirmado(cliente, planes);
      }
      if (t === '3' || t.includes('asesor') || t.includes('humano')) {
        return this.conectarGestor(telefono, cliente, 'Cliente con pago único pide asesor');
      }
      // Reenvía propuesta
      return this.msgBienvenida(cliente, nivel);
    }

    // CASO CONVENIO: aceptar Plan A o Plan B
    if (t === 'a' || t === '1' || t.includes('plan a') || t.includes('rapido') || t.includes('rápido')) {
      return this.aceptarPlan(telefono, cliente, 'A', planes.planA);
    }
    if (t === 'b' || t === '2' || t.includes('plan b') || t.includes('accesible')) {
      return this.aceptarPlan(telefono, cliente, 'B', planes.planB);
    }
    if (t === '3' || t.includes('asesor') || t.includes('humano') || t.includes('persona')) {
      return this.conectarGestor(telefono, cliente, 'Solicita asesor en propuesta de convenio');
    }

    // No entendí → reenviar propuesta con aclaración
    return `🤔 No identifiqué su respuesta.

Por favor responda con la *letra* del plan:

  *A* → Plan Rápido ${this.fmt(planes.planA.monto)}/sem
  *B* → Plan Accesible ${this.fmt(planes.planB.monto)}/sem
  *3* → Hablar con asesor`;
  }

  /**
   * Cliente eligió plan A o B.
   * v3.1 (2026-05): Genera PDF del convenio formal en background y lo
   * manda al cliente. El bot responde inmediato con un mensaje breve
   * indicando que el convenio viene en camino.
   * El cliente debe responder "ACEPTO Y FIRMO" para sellar la firma electrónica.
   */
  aceptarPlan(telefono, cliente, planLetra, datos) {
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';

    // Guardar plan elegido. El folio y hash se asignan al generar el PDF
    // y luego se actualizan en la conversación.
    this.guardarConversacion(telefono, this.ESTADOS.ESPERA_CONFIRMACION, {
      planElegido: planLetra,
      planDatos: {
        monto: datos.monto,
        semanas: datos.semanas,
        saldoConRecargo: datos.saldoConRecargo,
        fechaInicio: datos.fechaInicio,
        fechaFin: datos.fechaFin,
        conRecargo: datos.conRecargo
      }
    });

    // FIRE-AND-FORGET: generar y enviar PDF sin bloquear la respuesta
    this.enviarPDFConvenioAsync(telefono, cliente, planLetra, datos)
      .catch(e => console.error('❌ Error en envío de PDF async:', e.message));

    const tipoPlan = planLetra === 'A' ? '🅰️ PLAN RÁPIDO' : '🅱️ PLAN ACCESIBLE';

    return `✅ *${tipoPlan} SELECCIONADO*

Sr(a). *${nombre}*, le estoy generando su:

📋 *CONVENIO DE RECONOCIMIENTO DE ADEUDO Y PLAN DE PAGOS*

con sus datos personalizados:

┌─────────────────────────
│ 💵 *${this.fmt(datos.monto)}* semanales
│ 📦 *${datos.semanas} pagos*
│ 💰 Total: *${this.fmt(datos.saldoConRecargo)}*${datos.conRecargo ? ' (incl. 15%)' : ''}
│ 📅 Inicia: *${this.fmtFecha(datos.fechaInicio)}*
└─────────────────────────

📎 _Su convenio en PDF llegará en unos segundos..._

━━━━━━━━━━━━━━━━━━━━━
_LeGaXi Asesores · Cobranza Mercantil_`;
  }

  /**
   * v3.1: Genera el PDF del convenio y lo envía como adjunto.
   * Tras enviarlo, manda un segundo mensaje pidiendo la firma electrónica
   * mediante el texto "ACEPTO Y FIRMO".
   * 
   * Esta función es asíncrona y NO bloquea generarRespuesta().
   */
  async enviarPDFConvenioAsync(telefono, cliente, planLetra, datos) {
    try {
      // Lazy-load del módulo PDF para no impactar startup si no se usa
      const { generarPDFConvenio } = require('./pdfConvenio');

      console.log(`📄 Generando PDF de convenio para ${telefono}...`);
      const { buffer, folio, hash, fechaGeneracion } = await generarPDFConvenio(cliente, planLetra, datos);
      
      // Persistir folio y hash en la conversación
      const conv = this.obtenerConversacion(telefono);
      this.guardarConversacion(telefono, conv.estado, {
        ...conv,
        folioConvenio: folio,
        hashConvenio: hash,
        fechaGeneracion: fechaGeneracion?.toISOString()
      });

      // Construir JID para Baileys
      const jid = telefono.includes('@') ? telefono :
        (telefono.startsWith('521') ? `${telefono}@s.whatsapp.net` :
         telefono.startsWith('52') ? `521${telefono.slice(2)}@s.whatsapp.net` :
         `521${telefono}@s.whatsapp.net`);

      const fileName = `Convenio_${folio}.pdf`;
      // Caption simple, sin formato markdown (WhatsApp puede rechazar caption
      // largo o con asteriscos en documentos en algunas versiones).
      const caption = `Convenio Folio: ${folio}`;

      // Enviar PDF
      const resultadoPDF = await this.whatsapp.enviarDocumento(
        telefono,
        buffer,
        fileName,
        'application/pdf',
        caption
      );

      if (!resultadoPDF.exito) {
        console.error(`❌ Falló envío de PDF a ${telefono}: ${resultadoPDF.error}`);
        // Fallback: avisar al cliente que no llegó
        await this.whatsapp.enviarMensaje(telefono,
          `⚠️ Tuvimos un problema enviando su PDF. Un asesor le contactará en breve.\n\nFolio: ${folio}`
        );
        return;
      }

      this.registrarInteraccion(telefono, 'pdf_enviado', `${fileName} (${folio})`, jid);

      // Pequeña pausa para que el PDF se vea primero
      await new Promise(r => setTimeout(r, 2500));

      // Segundo mensaje: pedir firma electrónica
      const msgFirma = `⚖️ *FIRMA ELECTRÓNICA REQUERIDA*

Sr(a). *${cliente.nombre?.split(' ')[0] || 'Cliente'}*, ya revisó su convenio.

Para que quede *LEGALMENTE FIRMADO* conforme al *Art. 89-bis del Código de Comercio* y la *NOM-151-SCFI-2016*, responda *exactamente* con:

       ✍️ *ACEPTO Y FIRMO*

Su respuesta quedará registrada con:
  ✓ Folio único: *${folio}*
  ✓ Fecha y hora exacta
  ✓ Hash de validación
  ✓ Identificación por número celular

📌 _Esta respuesta constituye su consentimiento expreso y tiene plena validez jurídica._`;

      await this.whatsapp.enviarMensaje(telefono, msgFirma);
      this.registrarInteraccion(telefono, 'enviado', 'Solicitud firma electrónica', jid);

    } catch (error) {
      console.error(`❌ Error generando/enviando PDF a ${telefono}:`, error.message);
      try {
        await this.whatsapp.enviarMensaje(telefono,
          `⚠️ Tuvimos un problema generando su convenio. Un asesor le contactará en breve.`
        );
      } catch(e) {}
    }
  }

  /**
   * Cliente debe responder "CONFIRMO" tras firmar el convenio.
   * Si confirma, pasamos a CONVENIO_ACTIVO y mandamos datos bancarios.
   */
  procesarEsperaConfirmacion(telefono, texto, cliente, nivel) {
    const t = texto.toLowerCase().trim();
    const conv = this.obtenerConversacion(telefono);
    const planDatos = conv.planDatos;
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    const folio = conv.folioConvenio || '';

    if (!planDatos) {
      // Algo se rompió, regresar a propuesta
      this.guardarConversacion(telefono, this.ESTADOS.PROPUESTA_CONVENIO);
      return this.msgBienvenida(cliente, nivel);
    }

    // v3.1: Aceptación válida = palabras claras de firma/aceptación.
    // YA NO aceptamos "ok" solo, porque podría ser despedida y causaba ciclos.
    const aceptoYFirmo = /acepto\s*y\s*firmo|acepto\s*firmo|firmo\s*y\s*acepto/i.test(t);
    const aceptacionFuerte = /^(confirmo|confirmado|si confirmo|acepto|si acepto|firmado|firme|ya firme|ya firmé|si acepto y firmo)$/i.test(t)
        || t.includes('confirmo') || t.includes('firmé') || (t.includes('firme') && t.length < 30) || (t.includes('acepto') && t.length < 30);

    if (aceptoYFirmo || aceptacionFuerte) {
      this.guardarConversacion(telefono, this.ESTADOS.CONVENIO_ACTIVO, {
        ...conv,
        planDatos,
        firmadoEn: new Date().toISOString(),
        textoFirma: texto.trim()
      });
      return this.msgConvenioActivado(cliente, planDatos, conv);
    }

    // v3.1: Si dice despedida/agradecimiento ANTES de firmar, recordarle firma
    // sin reciclar el flujo (no volver a mandar el PDF).
    if (this.esDespedida(t)) {
      return `⏳ ${nombre}, antes de despedirnos necesito su firma.

Por favor revise el PDF que le envié${folio ? ` (Folio ${folio})` : ''} y responda:

       ✍️ *ACEPTO Y FIRMO*

Sin la firma, el convenio no queda registrado.`;
    }

    // Cliente pide reenvío del PDF
    if (t.includes('enviar') || t.includes('reenviar') || t.includes('no recibi') || t.includes('no llego') || t.includes('mandalo') || t.includes('manda')) {
      // Reenvío async del PDF
      const planLetra = conv.planElegido || 'B';
      this.enviarPDFConvenioAsync(telefono, cliente, planLetra, planDatos)
        .catch(e => console.error('Error reenvío PDF:', e.message));
      return `📎 Reenviándole su convenio PDF en unos segundos...`;
    }

    // Cliente quiere cambiar de plan
    if (t === 'a' || t === 'b' || t.includes('cambiar') || t.includes('otro plan')) {
      this.guardarConversacion(telefono, this.ESTADOS.PROPUESTA_CONVENIO);
      return this.msgBienvenida(cliente, nivel);
    }

    // No entendí
    return `⏳ ${nombre}, estoy esperando su firma electrónica.

Revise el PDF del convenio${folio ? ` (Folio ${folio})` : ''} y responda con:

       ✍️ *ACEPTO Y FIRMO*

Si no recibió el PDF, responda *enviar* para reenviárselo.

_Si no firma hoy, la oferta se cancela automáticamente._`;
  }

  /**
   * Cliente confirmó el convenio. Está esperando que mande comprobante.
   * Si manda imagen -> ya se procesa en manejarImagen() del flujo existente.
   * Si manda texto -> recordatorio.
   */
  procesarConvenioActivo(telefono, texto, cliente, nivel) {
    const t = texto.toLowerCase().trim();
    const conv = this.obtenerConversacion(telefono);
    const planDatos = conv.planDatos;
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    const folio = conv.folioConvenio || '';

    // v3.1: PRIMERO revisar si la conversación ya fue cerrada por despedida.
    // Si es así, solo respondemos a: (a) "hola" para reabrir, (b) preguntas
    // explícitas, o (c) palabras clave de cuenta/pago. Todo lo demás → null.
    if (conv.conversacionCerrada) {
      // Reabrir con saludo
      if (/^(hola|hi|buenas|buenos dias|buen dia|que tal)/i.test(t)) {
        this.guardarConversacion(telefono, this.ESTADOS.CONVENIO_ACTIVO, {
          ...conv, conversacionCerrada: false
        });
        return `👋 ${nombre}, su convenio sigue activo.

${planDatos ? `Su próximo paso es enviar el comprobante del primer pago de *${this.fmt(planDatos.monto)}* programado para *${this.fmtFecha(planDatos.fechaInicio)}*.` : ''}

📸 Envíe foto del comprobante aquí.`;
      }
      // Pregunta o palabra clave relevante → reabrir y responder
      if (/[?¿]|cuando|cuánto|cómo|donde|dónde|cuenta|banco|clabe|datos|comprobante|pagué|pague|deposit|transfer/i.test(t)) {
        this.guardarConversacion(telefono, this.ESTADOS.CONVENIO_ACTIVO, {
          ...conv, conversacionCerrada: false
        });
        // continúa con la lógica normal abajo
      } else {
        // Mensaje irrelevante después de despedida → no responder (evita ciclo)
        return null;
      }
    }

    // v3.1: Si es despedida/agradecimiento, despedirse y cerrar.
    if (this.esDespedida(t)) {
      this.guardarConversacion(telefono, this.ESTADOS.CONVENIO_ACTIVO, {
        ...conv,
        conversacionCerrada: true,
        despedidaEn: new Date().toISOString()
      });
      return `🙏 Gracias a usted, *${nombre}*.

Le esperamos con su primer pago el *${this.fmtFecha(planDatos?.fechaInicio || new Date())}*.${folio ? `\n\n📋 Folio: *${folio}*` : ''}

Que tenga excelente día.

_LeGaXi Asesores_`;
    }

    // Cliente quiere ver datos bancarios otra vez
    if (t.includes('cuenta') || t.includes('clabe') || t.includes('banco') || t.includes('donde pago') || t.includes('dónde pago') || t.includes('datos')) {
      return `📱 *Datos para su primer pago:*

${this.getDatosBancarios(nombre)}

📸 Envíe comprobante aquí cuando lo realice.`;
    }

    // Cliente reporta que ya pagó (sin comprobante todavía)
    if (t.includes('ya pagué') || t.includes('ya pague') || t.includes('depositado') || t.includes('hecho')) {
      return `📸 *Esperando su comprobante.*

${nombre}, por favor envíe la *foto del comprobante* aquí mismo para activar definitivamente su convenio.`;
    }

    // Default: recordatorio de comprobante
    if (planDatos) {
      return `📋 ${nombre}, su convenio quedó registrado:

  💵 ${this.fmt(planDatos.monto)} semanales
  📅 Primer pago: *${this.fmtFecha(planDatos.fechaInicio)}*

📸 *Envíe comprobante* del primer pago aquí.

Sin el comprobante, el convenio no se activa.`;
    }

    return `📸 Espero su comprobante de pago, ${nombre}.`;
  }

  /**
   * Mensaje cuando el convenio queda activo (después del ACEPTO Y FIRMO).
   * v3.1: incluye Constancia de Aceptación con folio + hash de validación.
   */
  msgConvenioActivado(cliente, planDatos, conv = {}) {
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    const folio = conv.folioConvenio || 'PENDIENTE';
    const hash = conv.hashConvenio || 'PENDIENTE';
    const ahora = new Date();
    const fechaFirma = ahora.toLocaleString('es-MX', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    return `🎉 *CONVENIO FIRMADO Y REGISTRADO*

━━━━━━━━━━━━━━━━━━━━━
📋 *CONSTANCIA DE ACEPTACIÓN*
━━━━━━━━━━━━━━━━━━━━━

📋 Folio:      *${folio}*
👤 Deudor:     ${cliente.nombre || nombre}
📱 Tel:        ${cliente.telefono || '—'}
📅 Firmado:    ${fechaFirma}
🔐 Hash:       ${hash}

━━━━━━━━━━━━━━━━━━━━━

✅ Su convenio queda *LEGALMENTE CELEBRADO* y obliga a las partes conforme al *Código de Comercio* y la *NOM-151-SCFI-2016*.

⚠️ El *incumplimiento* de cualquier pago facultará al acreedor para ejercer las acciones judiciales correspondientes *sin necesidad de previo requerimiento*.

━━━━━━━━━━━━━━━━━━━━━
💳 *DATOS PARA SU PRIMER PAGO*
━━━━━━━━━━━━━━━━━━━━━

  💵 *${this.fmt(planDatos.monto)}*
  📅 A más tardar: *${this.fmtFecha(planDatos.fechaInicio)}*

${this.getDatosBancarios(nombre)}

📸 *Envíe foto del comprobante aquí* para activar definitivamente su convenio.

🙏 *Gracias por su compromiso.*

━━━━━━━━━━━━━━━━━━━━━
_LeGaXi Asesores · Cobranza Mercantil_`;
  }

  /**
   * Mensaje cuando cliente acepta pago único (saldo bajo).
   */
  msgPagoUnicoConfirmado(cliente, planes) {
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    const saldo = cliente.saldo ?? 0;
    return `✅ *PAGO ÚNICO CONFIRMADO*

Sr(a). *${nombre}*, su compromiso de pago:

┌─────────────────────────
│ 💰 *${this.fmt(saldo)}*
│ 📅 A más tardar: *${this.fmtFecha(planes.fechaPago)}*
└─────────────────────────

${this.getDatosBancarios(nombre)}

📸 *Envíe foto del comprobante aquí* para cerrar su cuenta.

🙏 _Confiamos en su palabra._

━━━━━━━━━━━━━━━━━━━━━
_Cobranza Mercantil Especializada_`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // FIN BLOQUE v3
  // ═══════════════════════════════════════════════════════════════════

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
    const saldo = cliente.saldo ?? 0;

    switch (texto) {
      case '1': {
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
│ 💰 ${this.fmt(cliente.saldo ?? 0)}
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

    // FIX: si es desconocido, no transferir a gestor; pedir identificación
    if (cliente.desconocido) {
      this.guardarConversacion(telefono, this.ESTADOS.IDENTIFICACION);
      await this.whatsapp.sock.sendMessage(jid, {
        text: `📷 Recibimos su imagen, pero aún no lo identificamos en el sistema.

Por favor envíe su *nombre completo* o *número de crédito* para poder validar su pago correctamente.

_Cobranza Mercantil Especializada_`
      });
      return;
    }

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

  // ═══════════════════════════════════════
  // v3: BIENVENIDA DIRECTA A CONVENIO
  // ═══════════════════════════════════════
  msgBienvenida(cliente, nivel) {
    const nombre = cliente.nombre?.split(' ')[0] || 'Cliente';
    const saldo = cliente.saldo ?? 0;
    const dias = cliente.diasAtraso || 0;
    const planes = this.calcularPlanes(saldo);

    // Header según nivel de morosidad
    let header;
    switch (nivel) {
      case 'CRITICO':
        header = `🚨 *COBRANZA JUDICIAL EN PROCESO*`;
        break;
      case 'GRAVE':
        header = `⚠️ *AVISO URGENTE — ÚLTIMA OPORTUNIDAD*`;
        break;
      case 'MODERADO':
        header = `📋 *RECORDATORIO DE PAGO PENDIENTE*`;
        break;
      default:
        header = `📞 *LeGaXi Asesores — Cobranza*`;
    }

    // CASO 1: Saldo bajo -> pago único directo
    if (planes.pagoUnico) {
      return `${header}

Sr(a). *${nombre}* 👋

┌─────────────────────────
│ 💰 Saldo: *${this.fmt(saldo)}*
│ 📅 Atraso: *${dias} días*
└─────────────────────────

Para regularizar su cuenta, *liquide HOY*:

  💵 *${this.fmt(saldo)}* en pago único
  📅 A más tardar: *${this.fmtFecha(planes.fechaPago)}*

${this.getDatosBancarios(cliente.telefono || nombre)}

📸 *Envíe foto del comprobante aquí.*

⚠️ De no pagar, su cuenta escala a cobranza legal.

━━━━━━━━━━━━━━━━━━━━━
_Cobranza Mercantil Especializada_`;
    }

    // CASO 2: Convenio en 2 planes (A=$1000/sem, B=$500/sem)
    const a = planes.planA;
    const b = planes.planB;

    const accion = nivel === 'CRITICO'
      ? 'Para detener el proceso legal, le ofrezco DOS opciones de convenio:'
      : 'Le ofrezco DOS opciones de convenio para regularizar su cuenta:';

    return `${header}

Sr(a). *${nombre}* 👋

┌─────────────────────────
│ 💰 Saldo: *${this.fmt(saldo)}*
│ 📅 Atraso: *${dias} días*
└─────────────────────────

${accion}

━━━━━━━━━━━━━━━━━━━━━
🅰️  *PLAN RÁPIDO*
    💵 *${this.fmt(a.monto)}* semanales
    📦 *${a.semanas} pagos*${a.conRecargo ? ' (incluye 15%)' : ''}
━━━━━━━━━━━━━━━━━━━━━
🅱️  *PLAN ACCESIBLE*
    💵 *${this.fmt(b.monto)}* semanales
    📦 *${b.semanas} pagos*${b.conRecargo ? ' (incluye 15%)' : ''}
━━━━━━━━━━━━━━━━━━━━━

📅 *Primer pago:* ${this.fmtFecha(a.fechaInicio)}

Responda:
  *A* → Acepto Plan Rápido
  *B* → Acepto Plan Accesible
  *3* → Hablar con un asesor

⏰ _Esta oferta vence en 24 hrs._

━━━━━━━━━━━━━━━━━━━━━
_Cobranza Mercantil Especializada_`;
  }

  msgOpcionesPago(cliente, nivel) {
    const saldo = cliente.saldo ?? 0;

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
    const saldo = cliente.saldo ?? 0;
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
    const saldo = cliente.saldo ?? 0;
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
    const saldo = cliente.saldo ?? 0;
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
    const saldo = cliente.saldo ?? 0;
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

  // FIX: marca clientes desconocidos en vez de inventar "Cliente" genérico
  obtenerCliente(telefono) {
    // 1. Buscar directo
    let cliente = this.clientes.get(telefono);
    if (cliente) return cliente;

    // 2. Buscar por mapeo LID → teléfono real
    const telReal = this.lidMap.get(telefono);
    if (telReal) {
      cliente = this.clientes.get(telReal);
      if (cliente) return cliente;
    }

    // 3. Buscar con últimos 10 dígitos
    const tel10 = telefono.replace(/\D/g, '').slice(-10);
    cliente = this.clientes.get(tel10);
    if (cliente) return cliente;

    // 4. Buscar con 52 + teléfono
    cliente = this.clientes.get('52' + tel10);
    if (cliente) return cliente;

    // 5. Buscar recorriendo todos por últimos 10 dígitos
    for (const [key, val] of this.clientes) {
      const keyClean = key.replace(/\D/g, '').slice(-10);
      if (keyClean === tel10 && tel10.length === 10) return val;
    }

    // No encontrado: devolver desconocido (NO inventar)
    console.log(`⚠️ Cliente no encontrado: ${telefono}`);
    return { telefono, nombre: null, saldo: 0, diasAtraso: 0, desconocido: true };
  }

  mapearLid(lid, telefonoReal) {
    const tel10 = telefonoReal.replace(/\D/g, '').slice(-10);
    this.lidMap.set(lid, tel10);
    console.log(`🔗 Mapeado LID ${lid} → ${tel10}`);
  }

  obtenerConversacion(telefono) {
    return this.conversaciones.get(telefono) || { estado: this.ESTADOS.INICIAL };
  }

  guardarConversacion(telefono, estado, datos = {}) {
    // FIX 2026-05 v3.1: si datos contiene 'estado', NO debe sobrescribir el
    // parámetro estado. Eliminamos cualquier estado del payload antes del spread.
    const { estado: _ignorar, ...resto } = datos;
    this.conversaciones.set(telefono, { ...resto, estado, timestamp: Date.now() });
  }

  registrarInteraccion(telefono, tipo, detalle, jidOriginal = null) {
    this.interacciones.push({
      telefono, jid: jidOriginal, tipo, detalle,
      timestamp: new Date().toISOString()
    });
    if (this.interacciones.length > 500) this.interacciones = this.interacciones.slice(-250);
  }

  // FIX: limpia cache vieja antes de cargar nueva base
  cargarCartera(clientes, reemplazar = true) {
    if (reemplazar) {
      this.clientes.clear();
      this.lidMap.clear();
      this.conversaciones.clear();
      console.log('🧹 Cache limpiada antes de cargar nueva cartera');
    }

    clientes.forEach(c => {
      const tel = (c.telefono || c.Telefono || c.Teléfono || c.TELEFONO || '').toString().replace(/\D/g, '').slice(-10);
      if (tel) {
        const saldoRaw = c.saldo ?? c.Saldo ?? c.SALDO ?? 0;
        const diasRaw = c.diasAtraso ?? c.DiasAtraso ?? c.DIASATRASO ?? c['Días Atraso'] ?? c['dias_atraso'] ?? 0;

        this.clientes.set(tel, {
          telefono: tel,
          nombre: c.nombre || c.Nombre || c.NOMBRE || c.Cliente || c.cliente || 'Cliente',
          saldo: parseFloat(saldoRaw) || 0,
          diasAtraso: parseInt(diasRaw) || 0,
        });
      }
    });
    this.guardarDatos();
    console.log(`✅ ${clientes.length} clientes cargados en chatbot`);
    for (const [tel, cli] of this.clientes) {
      console.log(`   📋 ${cli.nombre} | tel:${tel} | saldo:${cli.saldo} | dias:${cli.diasAtraso}`);
    }

    // Pre-mapear LIDs usando onWhatsApp (async, en background)
    this._premapearLids();

    return this.clientes.size;
  }

  /**
   * v3.1: Registra (o actualiza) UN SOLO cliente sin afectar la cartera
   * existente. Pensado para envíos individuales desde Fantasma o flujos
   * uno-a-uno donde no se carga lista completa.
   */
  registrarCliente(datosCliente) {
    if (!datosCliente) return null;
    const c = datosCliente;
    const tel = (c.telefono || c.Telefono || c.Teléfono || c.TELEFONO || '').toString().replace(/\D/g, '').slice(-10);
    if (!tel) {
      console.warn('⚠️ registrarCliente: teléfono inválido', datosCliente);
      return null;
    }

    const saldoRaw = c.saldo ?? c.Saldo ?? c.SALDO ?? 0;
    const diasRaw  = c.diasAtraso ?? c.DiasAtraso ?? c.DIASATRASO ?? c['Días Atraso'] ?? c['dias_atraso'] ?? 0;

    const ya = this.clientes.get(tel);
    const cliente = {
      telefono: tel,
      nombre: c.nombre || c.Nombre || c.NOMBRE || c.Cliente || c.cliente || ya?.nombre || 'Cliente',
      saldo: parseFloat(saldoRaw) || ya?.saldo || 0,
      diasAtraso: parseInt(diasRaw) || ya?.diasAtraso || 0,
    };

    this.clientes.set(tel, cliente);
    console.log(`👤 Cliente ${ya ? 'actualizado' : 'registrado'}: ${cliente.nombre} | tel:${tel} | saldo:${cliente.saldo} | dias:${cliente.diasAtraso}`);
    return cliente;
  }

  async _premapearLids() {
    if (!this.whatsapp?.sock || !this.whatsapp.isConnected()) return;

    console.log('🔗 Pre-mapeando LIDs...');
    for (const [tel, cli] of this.clientes) {
      try {
        const num = tel.length === 10 ? '52' + tel : tel;
        const [resultado] = await this.whatsapp.sock.onWhatsApp(num);
        if (resultado?.exists && resultado.jid) {
          const lid = resultado.jid.replace('@s.whatsapp.net', '').replace('@lid', '');
          this.lidMap.set(lid, tel);
          console.log(`   🔗 ${cli.nombre}: ${lid} → ${tel}`);
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`🔗 LIDs mapeados: ${this.lidMap.size}`);
  }

  cargarDatos() {
    try {
      if (fs.existsSync('chatbot_clientes.json')) {
        const data = JSON.parse(fs.readFileSync('chatbot_clientes.json', 'utf8'));
        data.forEach(c => {
          const tel = (c.telefono || '').toString().replace(/\D/g, '').slice(-10);
          if (tel) {
            this.clientes.set(tel, {
              telefono: tel,
              nombre: c.nombre || 'Cliente',
              saldo: parseFloat(c.saldo) || 0,
              diasAtraso: parseInt(c.diasAtraso) || 0,
            });
          }
        });
      }
    } catch (e) {}
  }

  guardarDatos() {
    try {
      fs.writeFileSync('chatbot_clientes.json', JSON.stringify([...this.clientes.values()], null, 2));
    } catch (e) {}
  }

  // Reset manual del lidMap (útil si queda mal mapeado sin recargar cartera)
  resetLidMap() {
    const cantidad = this.lidMap.size;
    this.lidMap.clear();
    console.log(`🧹 LidMap reseteado (${cantidad} entradas eliminadas)`);
    return cantidad;
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
