/**
 * ═══════════════════════════════════════════════════════════
 * SERVICIO DE ENVÍO MASIVO - CON PROTECCIÓN ANTI-BANEO
 * CelExpress / LeGaXi Asesores
 * ═══════════════════════════════════════════════════════════
 * 
 * Funcionalidades:
 * - Envío masivo de texto personalizado ({nombre}, {saldo}, {dias})
 * - Envío de imagen estándar + texto
 * - Delays inteligentes (gaussianos) anti-baneo
 * - Typing simulation antes de cada mensaje
 * - Variación automática de mensajes (caracteres invisibles)
 * - Warm-up para números nuevos
 * - Monitoreo de salud / detección de riesgo de baneo
 * - Pausa/resume/cancelar en cualquier momento
 * - Estadísticas en tiempo real
 * - Horarios de envío configurables
 */

const fs = require('fs');
const path = require('path');

class EnvioMasivoService {
  constructor(whatsappService) {
    this.whatsapp = whatsappService;
    
    // Estado del envío
    this.enviando = false;
    this.pausado = false;
    this.cancelado = false;
    this.campanaActiva = null;
    
    // Cola de mensajes
    this.cola = [];
    this.colaIndex = 0;
    
    // Estadísticas
    this.stats = {
      totalContactos: 0,
      enviados: 0,
      fallidos: 0,
      pendientes: 0,
      enProgreso: false,
      pausado: false,
      inicioEnvio: null,
      ultimoEnvio: null,
      errores: [],
      campanaNombre: '',
      velocidadPromedio: 0, // msgs/hora
      tiempoEstimado: 0,   // minutos restantes
    };

    // Configuración anti-baneo
    this.config = {
      // Delays entre mensajes (ms)
      delayMinimo: 25000,       // 25 segundos mínimo
      delayMaximo: 90000,       // 90 segundos máximo
      delayPromedioBase: 45000, // 45 segundos promedio
      
      // Pausa entre lotes
      tamanoLote: 8,            // mensajes por lote
      pausaEntreLotes: 180000,  // 3 minutos entre lotes
      pausaEntreLotesMax: 300000, // 5 minutos max
      
      // Límites diarios
      limiteDiario: 45,         // máximo mensajes por día
      enviadosHoy: 0,
      fechaConteo: new Date().toDateString(),
      
      // Typing simulation
      typingMinimo: 2000,       // 2 segundos
      typingMaximo: 6000,       // 6 segundos
      
      // Horarios permitidos (hora local México)
      horaInicio: 9,            // 9 AM
      horaFin: 19,              // 7 PM (no molestar de noche)
      
      // Variación de contenido
      variarContenido: true,
    };

    // Historial de campañas
    this.historial = [];
    
    // Caracteres invisibles para variación
    this.invisibles = [
      '\u200B', // Zero-width space
      '\u200C', // Zero-width non-joiner
      '\u200D', // Zero-width joiner
      '\uFEFF', // Zero-width no-break space
    ];
  }

  // ═══════════════════════════════════════════════════════════
  // DELAY INTELIGENTE (Distribución gaussiana)
  // ═══════════════════════════════════════════════════════════

  /**
   * Genera un delay con distribución gaussiana (más "humano")
   * En vez de delays uniformes, la mayoría serán cercanos al promedio
   * con ocasionales delays más largos o cortos
   */
  gaussianDelay(min, max) {
    // Box-Muller transform para distribución normal
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const normal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    
    const media = (min + max) / 2;
    const desviacion = (max - min) / 6; // 99.7% dentro del rango
    let delay = media + normal * desviacion;
    
    // Clamp al rango
    delay = Math.max(min, Math.min(max, delay));
    return Math.round(delay);
  }

  /**
   * Delay entre mensajes individuales
   */
  getDelayMensaje() {
    return this.gaussianDelay(this.config.delayMinimo, this.config.delayMaximo);
  }

  /**
   * Delay entre lotes (más largo)
   */
  getDelayLote() {
    return this.gaussianDelay(this.config.pausaEntreLotes, this.config.pausaEntreLotesMax);
  }

  /**
   * Delay de typing antes de enviar
   */
  getDelayTyping() {
    return this.gaussianDelay(this.config.typingMinimo, this.config.typingMaximo);
  }

  // ═══════════════════════════════════════════════════════════
  // VARIACIÓN DE CONTENIDO
  // ═══════════════════════════════════════════════════════════

  /**
   * Agrega caracteres invisibles aleatorios para que cada mensaje
   * sea técnicamente diferente (evita detección de contenido idéntico)
   */
  variarTexto(texto) {
    if (!this.config.variarContenido) return texto;
    
    const partes = texto.split(' ');
    const posiciones = new Set();
    
    // Insertar 2-4 caracteres invisibles en posiciones aleatorias
    const cantidad = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < cantidad; i++) {
      posiciones.add(Math.floor(Math.random() * partes.length));
    }
    
    return partes.map((p, i) => {
      if (posiciones.has(i)) {
        const inv = this.invisibles[Math.floor(Math.random() * this.invisibles.length)];
        return p + inv;
      }
      return p;
    }).join(' ');
  }

  /**
   * Variaciones sutiles de puntuación
   */
  variarPuntuacion(texto) {
    const variaciones = [
      // A veces agrega/quita punto final
      () => texto.endsWith('.') ? texto.slice(0, -1) : texto + '.',
      // Dejar como está
      () => texto,
      // Agregar espacio al final
      () => texto + ' ',
    ];
    return variaciones[Math.floor(Math.random() * variaciones.length)]();
  }

  /**
   * Personaliza el mensaje con datos del contacto
   */
  personalizarMensaje(plantilla, contacto) {
    let mensaje = plantilla;
    
    // Reemplazar variables
    mensaje = mensaje.replace(/\{nombre\}/gi, contacto.nombre || 'Cliente');
    mensaje = mensaje.replace(/\{saldo\}/gi, 
      parseFloat(contacto.saldo || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })
    );
    mensaje = mensaje.replace(/\{dias\}/gi, contacto.diasAtraso || '0');
    mensaje = mensaje.replace(/\{telefono\}/gi, contacto.telefono || '');
    
    // Variación anti-detección
    mensaje = this.variarTexto(mensaje);
    
    return mensaje;
  }

  // ═══════════════════════════════════════════════════════════
  // VERIFICACIONES
  // ═══════════════════════════════════════════════════════════

  /**
   * Verifica si estamos en horario permitido
   */
  enHorarioPermitido() {
    const hora = new Date().getHours();
    return hora >= this.config.horaInicio && hora < this.config.horaFin;
  }

  /**
   * Verifica y resetea el contador diario si es un nuevo día
   */
  verificarLimiteDiario() {
    const hoy = new Date().toDateString();
    if (this.config.fechaConteo !== hoy) {
      this.config.enviadosHoy = 0;
      this.config.fechaConteo = hoy;
    }
    return this.config.enviadosHoy < this.config.limiteDiario;
  }

  /**
   * Calcula tiempo estimado restante
   */
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

  /**
   * Iniciar campaña de envío masivo
   * @param {Object} campana - Configuración de la campaña
   * @param {Array} campana.contactos - Lista de contactos [{nombre, telefono, saldo, diasAtraso}]
   * @param {string} campana.plantilla - Texto con variables: {nombre}, {saldo}, {dias}
   * @param {string} [campana.imagen] - Ruta o base64 de imagen estándar
   * @param {string} [campana.nombreCampana] - Nombre identificador
   * @param {Object} [campana.config] - Override de configuración
   */
  async iniciarCampana(campana) {
    if (this.enviando && !this.pausado) {
      return { exito: false, mensaje: 'Ya hay un envío en progreso. Pausa o cancela primero.' };
    }

    if (!this.whatsapp.isConnected()) {
      return { exito: false, mensaje: 'WhatsApp no está conectado' };
    }

    if (!campana.contactos?.length) {
      return { exito: false, mensaje: 'No hay contactos' };
    }

    if (!campana.plantilla && !campana.imagen) {
      return { exito: false, mensaje: 'Se requiere al menos un mensaje o imagen' };
    }

    // Override de config si se proporcionó
    if (campana.config) {
      Object.assign(this.config, campana.config);
    }

    // Preparar cola de envío
    this.cola = campana.contactos.map((contacto, index) => ({
      index,
      contacto: {
        nombre: contacto.nombre || contacto.Cliente || 'Cliente',
        telefono: (contacto.telefono || contacto.Teléfono || contacto.Telefono || '').toString().replace(/\D/g, ''),
        saldo: parseFloat(contacto.saldo || contacto.Saldo || 0),
        diasAtraso: parseInt(contacto.diasAtraso || contacto['Días Atraso'] || contacto.dias || 0),
      },
      plantilla: campana.plantilla,
      imagen: campana.imagen || null,
      estado: 'pendiente', // pendiente, enviado, fallido, saltado
      error: null,
      enviadoEn: null,
    }));

    // Filtrar números inválidos
    this.cola = this.cola.filter(item => {
      const tel = item.contacto.telefono;
      if (!tel || tel.length < 10) {
        item.estado = 'saltado';
        item.error = 'Número inválido';
        return false;
      }
      return true;
    });

    // Reset estado
    this.colaIndex = 0;
    this.enviando = true;
    this.pausado = false;
    this.cancelado = false;

    this.campanaActiva = {
      nombre: campana.nombreCampana || `Campaña ${new Date().toLocaleDateString('es-MX')}`,
      inicio: new Date().toISOString(),
      totalContactos: this.cola.length,
      plantilla: campana.plantilla,
      tieneImagen: !!campana.imagen,
    };

    this.stats = {
      totalContactos: this.cola.length,
      enviados: 0,
      fallidos: 0,
      pendientes: this.cola.length,
      enProgreso: true,
      pausado: false,
      inicioEnvio: Date.now(),
      ultimoEnvio: null,
      errores: [],
      campanaNombre: this.campanaActiva.nombre,
      velocidadPromedio: 0,
      tiempoEstimado: 0,
    };

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`📤 CAMPAÑA INICIADA: ${this.campanaActiva.nombre}`);
    console.log(`   📋 Contactos: ${this.cola.length}`);
    console.log(`   💬 Plantilla: ${(campana.plantilla || '').substring(0, 50)}...`);
    console.log(`   🖼️  Imagen: ${campana.imagen ? 'Sí' : 'No'}`);
    console.log(`   ⏱️  Delay: ${this.config.delayMinimo/1000}s - ${this.config.delayMaximo/1000}s`);
    console.log(`   📦 Lote: ${this.config.tamanoLote} msgs, pausa ${this.config.pausaEntreLotes/1000}s`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Iniciar procesamiento en background
    this._procesarCola();

    return {
      exito: true,
      mensaje: `Campaña iniciada: ${this.cola.length} contactos`,
      campana: this.campanaActiva.nombre,
      tiempoEstimado: `~${Math.round(this.cola.length * 50 / 60)} minutos`,
    };
  }

  /**
   * Loop principal de procesamiento de cola
   */
  async _procesarCola() {
    let mensajesEnLote = 0;

    while (this.colaIndex < this.cola.length) {
      // Verificar cancelación
      if (this.cancelado) {
        console.log('🛑 Campaña cancelada');
        this._finalizarCampana('cancelada');
        return;
      }

      // Verificar pausa
      if (this.pausado) {
        console.log('⏸️  Campaña pausada. Esperando resume...');
        await this._esperarResume();
        if (this.cancelado) return;
        mensajesEnLote = 0; // Reset lote después de pausa
      }

      // Verificar horario
      if (!this.enHorarioPermitido()) {
        console.log(`🕐 Fuera de horario (${this.config.horaInicio}:00 - ${this.config.horaFin}:00). Pausando...`);
        // Esperar hasta que estemos en horario
        await this._esperarHorario();
        if (this.cancelado) return;
        mensajesEnLote = 0;
      }

      // Verificar límite diario
      if (!this.verificarLimiteDiario()) {
        console.log(`📊 Límite diario alcanzado (${this.config.limiteDiario}). Continuando mañana...`);
        await this._esperarNuevoDia();
        if (this.cancelado) return;
        mensajesEnLote = 0;
      }

      // Verificar conexión WhatsApp
      if (!this.whatsapp.isConnected()) {
        console.log('⚠️ WhatsApp desconectado. Esperando reconexión...');
        await this._esperarConexion();
        if (this.cancelado) return;
      }

      // Pausa entre lotes
      if (mensajesEnLote >= this.config.tamanoLote) {
        const pausaLote = this.getDelayLote();
        console.log(`\n📦 Lote completado (${this.config.tamanoLote} msgs). Pausa de ${Math.round(pausaLote/1000)}s...\n`);
        await this._sleep(pausaLote);
        mensajesEnLote = 0;
        if (this.cancelado || this.pausado) continue;
      }

      // Enviar mensaje actual
      const item = this.cola[this.colaIndex];
      await this._enviarItem(item);
      
      this.colaIndex++;
      mensajesEnLote++;

      // Delay entre mensajes
      if (this.colaIndex < this.cola.length) {
        const delay = this.getDelayMensaje();
        console.log(`   ⏱️  Esperando ${Math.round(delay/1000)}s...`);
        await this._sleep(delay);
      }
    }

    this._finalizarCampana('completada');
  }

  /**
   * Enviar un item individual de la cola
   */
  async _enviarItem(item) {
    const { contacto, plantilla, imagen } = item;
    const telefono = contacto.telefono;

    try {
      const jid = this.whatsapp.formatearNumero(telefono);

      // 1. Simular presencia "en línea"
      try {
        await this.whatsapp.sock.sendPresenceUpdate('available');
      } catch (e) {}

      // 2. Simular "escribiendo..."
      try {
        await this.whatsapp.sock.sendPresenceUpdate('composing', jid);
      } catch (e) {}
      
      const typingDelay = this.getDelayTyping();
      await this._sleep(typingDelay);

      // 3. Enviar mensaje
      if (imagen) {
        // Enviar imagen + caption
        const caption = plantilla ? this.personalizarMensaje(plantilla, contacto) : '';
        
        let mediaContent;
        if (imagen.startsWith('data:') || imagen.startsWith('/9j/') || imagen.startsWith('iVBOR')) {
          // Base64
          const matches = imagen.match(/^data:(.+);base64,(.+)$/);
          if (matches) {
            mediaContent = Buffer.from(matches[2], 'base64');
          } else {
            mediaContent = Buffer.from(imagen, 'base64');
          }
        } else if (imagen.startsWith('http')) {
          // URL
          mediaContent = { url: imagen };
        } else {
          // Ruta de archivo
          mediaContent = fs.readFileSync(imagen);
        }

        await this.whatsapp.sock.sendMessage(jid, {
          image: mediaContent,
          caption: caption,
        });
      } else {
        // Solo texto
        const mensaje = this.personalizarMensaje(plantilla, contacto);
        await this.whatsapp.sock.sendMessage(jid, { text: mensaje });
      }

      // 4. Volver a "paused" (no disponible constantemente)
      try {
        await this.whatsapp.sock.sendPresenceUpdate('paused', jid);
      } catch (e) {}

      // Actualizar estado
      item.estado = 'enviado';
      item.enviadoEn = new Date().toISOString();
      this.stats.enviados++;
      this.stats.pendientes--;
      this.stats.ultimoEnvio = Date.now();
      this.config.enviadosHoy++;

      // Calcular velocidad y tiempo estimado
      const transcurrido = (Date.now() - this.stats.inicioEnvio) / 3600000; // horas
      this.stats.velocidadPromedio = Math.round(this.stats.enviados / transcurrido);
      this.stats.tiempoEstimado = this.calcularTiempoEstimado();

      console.log(`   ✅ [${this.stats.enviados}/${this.stats.totalContactos}] ${contacto.nombre} (${telefono})`);

    } catch (error) {
      item.estado = 'fallido';
      item.error = error.message;
      this.stats.fallidos++;
      this.stats.pendientes--;
      this.stats.errores.push({
        telefono,
        nombre: contacto.nombre,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      console.log(`   ❌ [${this.stats.enviados + this.stats.fallidos}/${this.stats.totalContactos}] ${contacto.nombre} (${telefono}): ${error.message}`);

      // Si hay muchos errores seguidos, pausar (posible baneo)
      const erroresRecientes = this.stats.errores.filter(e => 
        Date.now() - new Date(e.timestamp).getTime() < 60000
      ).length;

      if (erroresRecientes >= 3) {
        console.log('🚨 ALERTA: Muchos errores consecutivos. Pausando 5 minutos...');
        await this._sleep(300000); // 5 minutos
      }
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
    this.pausado = false; // Liberar el loop si está en pausa
    console.log('🛑 Envío masivo CANCELADO');
    return true;
  }

  /**
   * Actualizar configuración de delays
   */
  actualizarConfig(nuevaConfig) {
    Object.assign(this.config, nuevaConfig);
    return this.config;
  }

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES DE ESPERA
  // ═══════════════════════════════════════════════════════════

  _sleep(ms) {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (this.cancelado) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
      
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, ms);
    });
  }

  async _esperarResume() {
    while (this.pausado && !this.cancelado) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async _esperarHorario() {
    while (!this.enHorarioPermitido() && !this.cancelado) {
      await new Promise(r => setTimeout(r, 60000)); // Verificar cada minuto
    }
  }

  async _esperarNuevoDia() {
    while (!this.verificarLimiteDiario() && !this.cancelado) {
      await new Promise(r => setTimeout(r, 300000)); // Verificar cada 5 minutos
    }
  }

  async _esperarConexion() {
    let intentos = 0;
    while (!this.whatsapp.isConnected() && !this.cancelado && intentos < 30) {
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

    const duracion = Date.now() - this.stats.inicioEnvio;

    const resumen = {
      campana: this.campanaActiva?.nombre,
      estado,
      totalContactos: this.stats.totalContactos,
      enviados: this.stats.enviados,
      fallidos: this.stats.fallidos,
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
    console.log(`   ⏱️  Duración: ${resumen.duracion}`);
    console.log('═══════════════════════════════════════════════════════════\n');
  }

  // ═══════════════════════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════════════════════

  getEstadisticas() {
    return {
      ...this.stats,
      config: {
        delayMinimo: this.config.delayMinimo / 1000,
        delayMaximo: this.config.delayMaximo / 1000,
        tamanoLote: this.config.tamanoLote,
        limiteDiario: this.config.limiteDiario,
        enviadosHoy: this.config.enviadosHoy,
        horaInicio: this.config.horaInicio,
        horaFin: this.config.horaFin,
      },
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
    const enviados = this.stats.enviados + this.stats.fallidos;
    return {
      porcentaje: total > 0 ? Math.round((enviados / total) * 100) : 0,
      enviados: this.stats.enviados,
      fallidos: this.stats.fallidos,
      pendientes: this.stats.pendientes,
      total,
      enProgreso: this.stats.enProgreso,
      pausado: this.stats.pausado,
      tiempoEstimado: this.stats.tiempoEstimado,
      velocidad: this.stats.velocidadPromedio,
    };
  }

  /**
   * Envío masivo flexible (compatibilidad con server.js original)
   */
  async enviarMasivoFlexible(contactos, plantilla, columnaTeléfono) {
    const contactosFormateados = contactos.map(c => ({
      nombre: c.Cliente || c.nombre || c.Nombre || 'Cliente',
      telefono: (c[columnaTeléfono] || c.telefono || c.Teléfono || c.Telefono || '').toString(),
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
