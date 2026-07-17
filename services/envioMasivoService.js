/**
 * ═══════════════════════════════════════════════════════════
 * SERVICIO DE ENVÍO MASIVO — v4.0
 * CelExpress / LeGaXi Asociados
 * ═══════════════════════════════════════════════════════════
 *
 * CAMBIOS CRÍTICOS vs v3.x:
 *
 *  1. TODO envío pasa por whatsapp.enviarMensaje() / enviarImagen().
 *     ANTES: _enviarItem() llamaba sock.sendMessage() directo y se
 *     saltaba el límite diario duro, la ventana horaria, el contador
 *     persistente y la lista NO CONTACTAR del servicio.
 *
 *  2. ELIMINADOS los caracteres invisibles (\u200B \u200C \u200D \uFEFF).
 *     Insertar zero-width chars para "variar" el mensaje es una firma
 *     de spam conocida. No evade la detección: LA DISPARA. Se sustituye
 *     por variación real de redacción (plantillas rotativas).
 *
 *  3. enHorarioPermitido() vuelve a funcionar. Antes era `return true`
 *     y toda la ventana horaria era decorativa.
 *
 *  4. enviadosHoy delegado al servicio (persistente en disco, timezone
 *     MX). Antes vivía en RAM y contaba en UTC: Render reiniciaba y el
 *     contador volvía a 0; el día rotaba a las 6 PM hora de México.
 *
 *  5. Filtro NO CONTACTAR + deduplicación de teléfonos al armar la cola.
 *
 *  6. Validación de config server-side (el panel solo tiene min= en HTML).
 *
 *  7. Errores consecutivos → ABORTA la campaña. Antes pausaba 5 min y
 *     seguía insistiendo contra un número ya restringido.
 */

const EMPRESA = require('../config/empresa');

// Límites duros. El panel NO puede bajar de aquí.
const LIMITES = {
  delayMinimo:        { min: 20000,  max: 600000 },
  delayMaximo:        { min: 45000,  max: 900000 },
  tamanoLote:         { min: 3,      max: 10 },
  pausaEntreLotes:    { min: 180000, max: 3600000 },
  pausaEntreLotesMax: { min: 300000, max: 7200000 },
  limiteDiario:       { min: 5,      max: 60 },
  horaInicio:         { min: 8,      max: 12 },
  horaFin:            { min: 17,     max: 21 },
};

class EnvioMasivoService {
  constructor(whatsappService, chatbot) {
    this.whatsapp = whatsappService;
    this.chatbot = chatbot || null;

    this.enviando = false;
    this.pausado = false;
    this.cancelado = false;
    this.campanaActiva = null;

    this.cola = [];
    this.colaIndex = 0;

    this.stats = this._statsVacias();

    this.config = {
      delayMinimo: 35000,
      delayMaximo: 120000,
      tamanoLote: 6,
      pausaEntreLotes: 420000,      // 7 min
      pausaEntreLotesMax: 900000,   // 15 min
      limiteDiario: 45,
      horaInicio: 9,
      horaFin: 19,
      sabadoHasta: 14,
      domingo: false,
      variarContenido: true,        // ahora = rotar redacción, NO zero-width
    };

    this.historial = [];
    this.logEventos = [];

    // Fallos consecutivos → abortar
    this.fallosConsecutivos = 0;
    this.maxFallosConsecutivos = 3;
  }

  _statsVacias() {
    return {
      totalContactos: 0,
      enviados: 0,
      fallidos: 0,
      omitidos: 0,
      pendientes: 0,
      enProgreso: false,
      pausado: false,
      inicioEnvio: null,
      ultimoEnvio: null,
      errores: [],
      campanaNombre: '',
      velocidadPromedio: 0,
      tiempoEstimado: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // DELAYS
  // ═══════════════════════════════════════════════════════════

  gaussianDelay(min, max) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const normal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const media = (min + max) / 2;
    const desviacion = (max - min) / 6;
    let delay = media + normal * desviacion;
    delay = Math.max(min, Math.min(max, delay));
    return Math.round(delay);
  }

  getDelayMensaje() {
    return this.gaussianDelay(this.config.delayMinimo, this.config.delayMaximo);
  }

  getDelayLote() {
    return this.gaussianDelay(this.config.pausaEntreLotes, this.config.pausaEntreLotesMax);
  }

  // ═══════════════════════════════════════════════════════════
  // VARIACIÓN DE CONTENIDO (v4.0 — SIN zero-width)
  // ═══════════════════════════════════════════════════════════

  /**
   * Variación REAL: cambia la redacción, no mete basura invisible.
   *
   * Si mandas la misma frase 45 veces, WhatsApp la agrupa aunque le
   * pegues un \u200B. Lo que sí ayuda es que el mensaje cambie de forma
   * de verdad. Si tu plantilla trae "||" separa variantes y rota:
   *
   *   "Hola {nombre}, le recuerdo su pago.||{nombre}, buen día. Un
   *    recordatorio de su pago pendiente.||Estimado {nombre}, le
   *    escribo sobre su pago."
   */
  elegirVariante(plantilla) {
    if (!plantilla) return '';
    if (!this.config.variarContenido) return plantilla;
    if (!plantilla.includes('||')) return plantilla;
    const variantes = plantilla.split('||').map(v => v.trim()).filter(Boolean);
    if (!variantes.length) return plantilla;
    return variantes[Math.floor(Math.random() * variantes.length)];
  }

  personalizarMensaje(plantilla, contacto) {
    let mensaje = this.elegirVariante(plantilla);

    mensaje = mensaje.replace(/\{nombre\}/gi, contacto.nombre || 'Cliente');
    mensaje = mensaje.replace(/\{saldo\}/gi,
      parseFloat(contacto.saldo || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })
    );
    mensaje = mensaje.replace(/\{dias\}/gi, contacto.diasAtraso || '0');
    mensaje = mensaje.replace(/\{telefono\}/gi, contacto.telefono || '');

    try {
      const cfg = EMPRESA.getConfig();
      mensaje = mensaje.replace(/\{convenio\}/gi, (cfg.convenio && cfg.convenio.urlConvenio) || '');
      mensaje = mensaje.replace(/\{despacho\}/gi, cfg.marca || '');
      mensaje = mensaje.replace(/\{acreedor\}/gi, cfg.empresaNombre || '');
    } catch (e) {}

    return mensaje;
  }

  // ═══════════════════════════════════════════════════════════
  // VERIFICACIONES
  // ═══════════════════════════════════════════════════════════

  /**
   * v4.0: RESTAURADA. En v3.x esto era literalmente `return true`,
   * con horaInicio/horaFin configurados, mostrados en el panel y
   * reportados en getEstadisticas() — puro adorno.
   */
  enHorarioPermitido() {
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    const h = ahora.getHours();
    const dow = ahora.getDay();

    if (dow === 0 && !this.config.domingo) return false;
    if (dow === 6) return h >= this.config.horaInicio && h < this.config.sabadoHasta;
    return h >= this.config.horaInicio && h < this.config.horaFin;
  }

  /**
   * v4.0: delega al servicio, que lo persiste en disco con timezone MX.
   */
  verificarLimiteDiario() {
    const salud = typeof this.whatsapp.estadoSalud === 'function'
      ? this.whatsapp.estadoSalud()
      : null;
    if (!salud) return true;
    const tope = Math.min(this.config.limiteDiario, salud.limiteDiario);
    return salud.enviadosHoy < tope;
  }

  getEnviadosHoy() {
    const salud = typeof this.whatsapp.estadoSalud === 'function'
      ? this.whatsapp.estadoSalud()
      : null;
    return salud ? salud.enviadosHoy : 0;
  }

  /**
   * Sanea la config que llega del panel. El HTML tiene min="10" pero
   * eso es client-side: un POST directo a /api/campana/config puede
   * mandar delayMinimo: 0.
   */
  _sanearConfig(nueva) {
    const out = {};
    for (const [k, v] of Object.entries(nueva || {})) {
      if (LIMITES[k]) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        const clamped = Math.max(LIMITES[k].min, Math.min(LIMITES[k].max, n));
        if (clamped !== n) {
          console.log(`⚠️  config.${k}=${n} fuera de rango → ajustado a ${clamped}`);
        }
        out[k] = clamped;
      } else if (k === 'variarContenido' || k === 'domingo') {
        out[k] = !!v;
      } else if (k === 'sabadoHasta') {
        out[k] = Math.max(10, Math.min(18, Number(v) || 14));
      }
    }
    if (out.delayMaximo != null && out.delayMinimo != null && out.delayMaximo <= out.delayMinimo) {
      out.delayMaximo = out.delayMinimo * 2;
      console.log(`⚠️  delayMaximo <= delayMinimo → ajustado a ${out.delayMaximo}`);
    }
    return out;
  }

  calcularTiempoEstimado() {
    const pendientes = this.stats.pendientes;
    if (pendientes === 0 || this.stats.enviados === 0) return 0;
    const transcurrido = Date.now() - this.stats.inicioEnvio;
    const promedioPorMsg = transcurrido / this.stats.enviados;
    const lotes = Math.ceil(pendientes / this.config.tamanoLote);
    return Math.round((pendientes * promedioPorMsg + lotes * this.config.pausaEntreLotes) / 60000);
  }

  // ═══════════════════════════════════════════════════════════
  // ENVÍO MASIVO PRINCIPAL
  // ═══════════════════════════════════════════════════════════

  async iniciarCampana(campana) {
    if (this.enviando && !this.pausado) {
      return { exito: false, mensaje: 'Ya hay un envío en progreso. Pausa o cancela primero.' };
    }

    if (!this.whatsapp.isConnected()) {
      return { exito: false, mensaje: 'WhatsApp no está conectado' };
    }

    // v4.0: si el servicio está en modo pánico, no arrancar nada.
    if (this.whatsapp.bloqueado) {
      return { exito: false, mensaje: `Bloqueado por anti-baneo: ${this.whatsapp.motivoBloqueo}` };
    }

    if (!campana.contactos?.length) {
      return { exito: false, mensaje: 'No hay contactos' };
    }

    if (!campana.plantilla && !campana.imagen) {
      return { exito: false, mensaje: 'Se requiere al menos un mensaje o imagen' };
    }

    if (campana.config) {
      Object.assign(this.config, this._sanearConfig(campana.config));
    }

    // ── Armar cola: normalizar → filtrar inválidos → dedup → NO CONTACTAR ──
    const vistos = new Set();
    let omitidosInvalidos = 0;
    let omitidosDuplicados = 0;
    let omitidosNoContactar = 0;

    this.cola = [];
    for (const contacto of campana.contactos) {
      const telRaw = (contacto.telefono || contacto['Teléfono'] || contacto.Telefono || contacto.TELEFONO || '').toString();
      const tel = telRaw.replace(/\D/g, '');
      const tel10 = tel.length >= 10 ? tel.slice(-10) : tel;

      if (!tel10 || tel10.length < 10) { omitidosInvalidos++; continue; }
      if (vistos.has(tel10)) { omitidosDuplicados++; continue; }
      if (typeof this.whatsapp.estaNoContactar === 'function' && this.whatsapp.estaNoContactar(tel10)) {
        omitidosNoContactar++;
        continue;
      }
      vistos.add(tel10);

      this.cola.push({
        index: this.cola.length,
        contacto: {
          nombre: contacto.nombre || contacto.Cliente || 'Cliente',
          telefono: tel10,
          saldo: parseFloat(contacto.saldo || contacto.Saldo || 0),
          diasAtraso: parseInt(contacto.diasAtraso || contacto['Días Atraso'] || contacto.dias || 0),
        },
        plantilla: campana.plantilla,
        imagen: campana.imagen || null,
        estado: 'pendiente',
        error: null,
        enviadoEn: null,
      });
    }

    if (!this.cola.length) {
      return { exito: false, mensaje: 'Ningún contacto quedó tras filtrar (inválidos/duplicados/no-contactar)' };
    }

    this.colaIndex = 0;
    this.enviando = true;
    this.pausado = false;
    this.cancelado = false;
    this.fallosConsecutivos = 0;

    this.campanaActiva = {
      nombre: campana.nombreCampana || `Campaña ${new Date().toLocaleDateString('es-MX')}`,
      inicio: new Date().toISOString(),
      totalContactos: this.cola.length,
      plantilla: campana.plantilla,
      tieneImagen: !!campana.imagen,
    };

    this.stats = this._statsVacias();
    this.stats.totalContactos = this.cola.length;
    this.stats.pendientes = this.cola.length;
    this.stats.omitidos = omitidosInvalidos + omitidosDuplicados + omitidosNoContactar;
    this.stats.enProgreso = true;
    this.stats.inicioEnvio = Date.now();
    this.stats.campanaNombre = this.campanaActiva.nombre;

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`📤 CAMPAÑA INICIADA: ${this.campanaActiva.nombre}`);
    console.log(`   📋 En cola: ${this.cola.length} (de ${campana.contactos.length} cargados)`);
    console.log(`   🚫 Omitidos: ${omitidosInvalidos} inválidos · ${omitidosDuplicados} duplicados · ${omitidosNoContactar} en NO CONTACTAR`);
    console.log(`   📊 Enviados hoy: ${this.getEnviadosHoy()} / ${this.config.limiteDiario}`);
    console.log(`   ⏱️  Delay: ${this.config.delayMinimo / 1000}s - ${this.config.delayMaximo / 1000}s`);
    console.log(`   📦 Lote: ${this.config.tamanoLote} msgs, pausa ${this.config.pausaEntreLotes / 1000}s`);
    console.log(`   🕐 Horario: ${this.config.horaInicio}-${this.config.horaFin}h (sáb hasta ${this.config.sabadoHasta}h, dom ${this.config.domingo ? 'sí' : 'no'})`);
    console.log('═══════════════════════════════════════════════════════════\n');

    this._procesarCola();

    return {
      exito: true,
      mensaje: `Campaña iniciada: ${this.cola.length} contactos`,
      campana: this.campanaActiva.nombre,
      omitidos: { invalidos: omitidosInvalidos, duplicados: omitidosDuplicados, noContactar: omitidosNoContactar },
      tiempoEstimado: `~${Math.round((this.cola.length * ((this.config.delayMinimo + this.config.delayMaximo) / 2) + Math.ceil(this.cola.length / this.config.tamanoLote) * this.config.pausaEntreLotes) / 60000)} minutos`,
    };
  }

  async _procesarCola() {
    let mensajesEnLote = 0;

    while (this.colaIndex < this.cola.length) {
      if (this.cancelado) {
        this._finalizarCampana('cancelada');
        return;
      }

      // v4.0: si el servicio entró en pánico (403/429), abortar YA.
      if (this.whatsapp.bloqueado) {
        console.log(`🛑 Servicio bloqueado (${this.whatsapp.motivoBloqueo}). Abortando campaña.`);
        this._addLog('abortado', '', '', this.whatsapp.motivoBloqueo);
        this._finalizarCampana('abortada_anti_baneo');
        return;
      }

      if (this.pausado) {
        console.log('⏸️  Campaña pausada. Esperando resume...');
        await this._esperarResume();
        if (this.cancelado) return;
        mensajesEnLote = 0;
      }

      if (!this.enHorarioPermitido()) {
        console.log(`🕐 Fuera de horario (${this.config.horaInicio}:00-${this.config.horaFin}:00 hora MX). Esperando...`);
        await this._esperarHorario();
        if (this.cancelado) return;
        mensajesEnLote = 0;
      }

      if (!this.verificarLimiteDiario()) {
        console.log(`📊 Límite diario alcanzado (${this.getEnviadosHoy()}/${this.config.limiteDiario}). Continúa mañana.`);
        await this._esperarNuevoDia();
        if (this.cancelado) return;
        mensajesEnLote = 0;
      }

      if (!this.whatsapp.isConnected()) {
        console.log('⚠️ WhatsApp desconectado. Esperando reconexión...');
        await this._esperarConexion();
        if (this.cancelado) return;
        if (!this.whatsapp.isConnected()) {
          console.log('🛑 No se recuperó la conexión. Abortando.');
          this._finalizarCampana('abortada_sin_conexion');
          return;
        }
      }

      if (mensajesEnLote >= this.config.tamanoLote) {
        const pausaLote = this.getDelayLote();
        console.log(`\n📦 Lote completado (${this.config.tamanoLote} msgs). Pausa de ${Math.round(pausaLote / 1000)}s...\n`);
        await this._sleep(pausaLote);
        mensajesEnLote = 0;
        if (this.cancelado || this.pausado) continue;
      }

      const item = this.cola[this.colaIndex];
      const abortar = await this._enviarItem(item);
      if (abortar) {
        this._finalizarCampana('abortada_fallos');
        return;
      }

      this.colaIndex++;
      mensajesEnLote++;

      if (this.colaIndex < this.cola.length) {
        const delay = this.getDelayMensaje();
        console.log(`   ⏱️  Esperando ${Math.round(delay / 1000)}s...`);
        await this._sleep(delay);
      }
    }

    this._finalizarCampana('completada');
  }

  /**
   * v4.0: enruta TODO por el servicio. Ya no toca sock.sendMessage.
   * @returns {Boolean} true si hay que abortar la campaña
   */
  async _enviarItem(item) {
    const { contacto, plantilla, imagen } = item;
    const telefono = contacto.telefono;

    try {
      const texto = plantilla ? this.personalizarMensaje(plantilla, contacto) : '';

      let res;
      if (imagen) {
        res = await this.whatsapp.enviarImagen(telefono, imagen, texto);
      } else {
        res = await this.whatsapp.enviarMensaje(telefono, texto);
      }

      // ── Casos que NO son fallo del número: son frenos del anti-baneo ──
      if (!res.exito && (res.limitado || res.fueraVentana)) {
        console.log(`   ⏸️  ${telefono}: ${res.error} — se reintenta después`);
        // No avanzar el índice: el loop volverá a evaluar las guardas.
        this.colaIndex--;
        await this._sleep(60000);
        return false;
      }

      if (!res.exito && res.noContactar) {
        item.estado = 'omitido';
        item.error = 'NO CONTACTAR';
        this.stats.omitidos++;
        this.stats.pendientes--;
        this._addLog('omitido', contacto.nombre, telefono, 'NO CONTACTAR');
        return false;
      }

      if (!res.exito) {
        throw new Error(res.error || 'Error desconocido');
      }

      // ── Éxito ──
      this.fallosConsecutivos = 0;
      item.estado = 'enviado';
      item.enviadoEn = new Date().toISOString();
      this.stats.enviados++;
      this.stats.pendientes--;
      this.stats.ultimoEnvio = Date.now();

      if (typeof this.onEnviado === 'function') {
        try {
          this.onEnviado({ telefono, nombre: contacto.nombre, saldo: contacto.saldo, diasAtraso: contacto.diasAtraso });
        } catch (e) {}
      }

      // Mapear LIDs al teléfono real
      if (this.chatbot && typeof this.chatbot.mapearLid === 'function') {
        if (res.remoteJid) {
          const clean = res.remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
          this.chatbot.mapearLid(clean, telefono);
          console.log(`   🔗 Mapeado: ${clean} → ${telefono}`);
        }
        if (res.participant) {
          const clean = res.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
          this.chatbot.mapearLid(clean, telefono);
        }
      }

      const transcurrido = (Date.now() - this.stats.inicioEnvio) / 3600000;
      this.stats.velocidadPromedio = transcurrido > 0 ? Math.round(this.stats.enviados / transcurrido) : 0;
      this.stats.tiempoEstimado = this.calcularTiempoEstimado();

      console.log(`   ✅ [${this.stats.enviados}/${this.stats.totalContactos}] ${contacto.nombre} (${telefono})`);
      this._addLog('enviado', contacto.nombre, telefono, null);
      return false;

    } catch (error) {
      item.estado = 'fallido';
      item.error = error.message;
      this.stats.fallidos++;
      this.stats.pendientes--;
      this.stats.errores.push({
        telefono, nombre: contacto.nombre, error: error.message, timestamp: new Date().toISOString(),
      });

      console.log(`   ❌ [${this.stats.enviados + this.stats.fallidos}/${this.stats.totalContactos}] ${contacto.nombre} (${telefono}): ${error.message}`);
      this._addLog('fallido', contacto.nombre, telefono, error.message);

      // "Número no tiene WhatsApp" no cuenta como señal de baneo.
      const esNumeroMalo = /no est[áa] en whatsapp|no tiene whatsapp/i.test(error.message);
      if (!esNumeroMalo) {
        this.fallosConsecutivos++;
      }

      // v4.0: ABORTA. Antes dormía 5 min y seguía insistiendo — que es
      // exactamente lo que convierte un problema en un baneo.
      if (this.fallosConsecutivos >= this.maxFallosConsecutivos) {
        console.log(`\n🚨 ${this.fallosConsecutivos} fallos consecutivos. ABORTANDO campaña.`);
        console.log('   Revisa el número en el celular antes de reanudar.\n');
        this._addLog('abortado', '', '', `${this.fallosConsecutivos} fallos consecutivos`);
        return true;
      }

      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONTROL DE CAMPAÑA
  // ═══════════════════════════════════════════════════════════

  pausar() {
    if (!this.enviando || this.pausado) return false;
    this.pausado = true;
    this.stats.pausado = true;
    console.log('⏸️  Envío masivo PAUSADO');
    return true;
  }

  reanudar() {
    if (!this.pausado) return false;
    this.pausado = false;
    this.stats.pausado = false;
    console.log('▶️  Envío masivo REANUDADO');
    return true;
  }

  cancelar() {
    this.cancelado = true;
    this.pausado = false;
    setTimeout(() => {
      if (this.enviando) {
        console.log('🔧 Force reset de campaña trabada');
        this.enviando = false;
        this.stats.enProgreso = false;
        this.stats.pausado = false;
      }
    }, 3000);
    console.log('🛑 Envío masivo CANCELADO');
    return true;
  }

  forceReset() {
    this.enviando = false;
    this.pausado = false;
    this.cancelado = true;
    this.stats.enProgreso = false;
    this.stats.pausado = false;
    this.cola = [];
    this.colaIndex = 0;
    this.fallosConsecutivos = 0;
    console.log('🔧 FORCE RESET completo');
    return true;
  }

  actualizarConfig(nuevaConfig) {
    Object.assign(this.config, this._sanearConfig(nuevaConfig));
    return this.config;
  }

  // ═══════════════════════════════════════════════════════════
  // ESPERAS
  // ═══════════════════════════════════════════════════════════

  _sleep(ms) {
    return new Promise(resolve => {
      let terminado = false;
      const fin = () => {
        if (terminado) return;
        terminado = true;
        clearInterval(check);
        clearTimeout(t);
        resolve();
      };
      const check = setInterval(() => { if (this.cancelado) fin(); }, 1000);
      const t = setTimeout(fin, ms);
    });
  }

  async _esperarResume() {
    while (this.pausado && !this.cancelado) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async _esperarHorario() {
    while (!this.enHorarioPermitido() && !this.cancelado) {
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  async _esperarNuevoDia() {
    while (!this.verificarLimiteDiario() && !this.cancelado) {
      await new Promise(r => setTimeout(r, 300000));
    }
  }

  async _esperarConexion() {
    let intentos = 0;
    while (!this.whatsapp.isConnected() && !this.cancelado && intentos < 30) {
      if (this.whatsapp.bloqueado) return;
      await new Promise(r => setTimeout(r, 10000));
      intentos++;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FINALIZACIÓN Y REPORTES
  // ═══════════════════════════════════════════════════════════

  _finalizarCampana(estado) {
    this.enviando = false;
    this.pausado = false;
    this.stats.enProgreso = false;

    const duracion = Date.now() - (this.stats.inicioEnvio || Date.now());

    const resumen = {
      campana: this.campanaActiva?.nombre,
      estado,
      totalContactos: this.stats.totalContactos,
      enviados: this.stats.enviados,
      fallidos: this.stats.fallidos,
      omitidos: this.stats.omitidos,
      pendientes: this.stats.pendientes,
      duracion: `${Math.round(duracion / 60000)} minutos`,
      inicio: this.campanaActiva?.inicio,
      fin: new Date().toISOString(),
    };

    this.historial.push(resumen);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`📊 CAMPAÑA ${estado.toUpperCase()}: ${resumen.campana}`);
    console.log(`   ✅ Enviados: ${resumen.enviados}`);
    console.log(`   ❌ Fallidos: ${resumen.fallidos}`);
    console.log(`   🚫 Omitidos: ${resumen.omitidos}`);
    console.log(`   ⏱️  Duración: ${resumen.duracion}`);
    console.log('═══════════════════════════════════════════════════════════\n');
  }

  _addLog(tipo, nombre, telefono, error) {
    this.logEventos.unshift({
      tipo, nombre, telefono, error,
      timestamp: new Date().toISOString(),
      progreso: `${this.stats.enviados + this.stats.fallidos}/${this.stats.totalContactos}`,
    });
    if (this.logEventos.length > 100) this.logEventos = this.logEventos.slice(0, 100);
  }

  getLogs(limite = 50) {
    return this.logEventos.slice(0, limite);
  }

  getEstadisticas() {
    return {
      ...this.stats,
      config: {
        delayMinimo: this.config.delayMinimo / 1000,
        delayMaximo: this.config.delayMaximo / 1000,
        tamanoLote: this.config.tamanoLote,
        limiteDiario: this.config.limiteDiario,
        enviadosHoy: this.getEnviadosHoy(),
        horaInicio: this.config.horaInicio,
        horaFin: this.config.horaFin,
        enHorario: this.enHorarioPermitido(),
      },
      salud: typeof this.whatsapp.estadoSalud === 'function' ? this.whatsapp.estadoSalud() : null,
      historial: this.historial.slice(-5),
    };
  }

  getDetalleCola() {
    return this.cola.map(item => ({
      nombre: item.contacto.nombre,
      telefono: item.contacto.telefono,
      estado: item.estado,
      error: item.error,
      enviadoEn: item.enviadoEn,
    }));
  }

  getProgreso() {
    const total = this.stats.totalContactos;
    const procesados = this.stats.enviados + this.stats.fallidos + this.stats.omitidos;
    return {
      porcentaje: total > 0 ? Math.round((procesados / total) * 100) : 0,
      enviados: this.stats.enviados,
      fallidos: this.stats.fallidos,
      omitidos: this.stats.omitidos,
      pendientes: this.stats.pendientes,
      total,
      enProgreso: this.stats.enProgreso,
      pausado: this.stats.pausado,
      tiempoEstimado: this.stats.tiempoEstimado,
      velocidad: this.stats.velocidadPromedio,
      bloqueado: !!this.whatsapp.bloqueado,
      motivoBloqueo: this.whatsapp.motivoBloqueo || null,
    };
  }

  async enviarMasivoFlexible(contactos, plantilla, columnaTelefono) {
    const contactosFormateados = contactos.map(c => ({
      nombre: c.Cliente || c.nombre || c.Nombre || 'Cliente',
      telefono: (c[columnaTelefono] || c.telefono || c['Teléfono'] || c.Telefono || c.TELEFONO || '').toString(),
      saldo: parseFloat(c.Saldo || c.saldo || c.monto || 0),
      diasAtraso: parseInt(c['Días Atraso'] || c.diasAtraso || c.dias || 0),
    }));

    return this.iniciarCampana({
      contactos: contactosFormateados,
      plantilla,
      nombreCampana: `Envío ${new Date().toLocaleString('es-MX')}`,
    });
  }
}

module.exports = EnvioMasivoService;
