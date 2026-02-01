/**
 * Servicio de Envío Masivo Controlado
 * Anti-baneo con delays inteligentes
 */

class EnvioMasivoService {
  constructor(whatsappService) {
    this.whatsapp = whatsappService;
    this.estadisticas = {
      total: 0,
      exitosos: 0,
      fallidos: 0,
      enCola: 0,
      enviandoActualmente: false,
      ultimoResultado: null
    };
    
    // Configuración anti-baneo
    this.config = {
      delayEntreMensajes: parseInt(process.env.DELAY_ENTRE_MENSAJES) || 10000,
      mensajesPorLote: parseInt(process.env.MENSAJES_POR_LOTE) || 15,
      pausaEntreLotes: parseInt(process.env.PAUSA_ENTRE_LOTES) || 120000,
      horaInicio: parseInt(process.env.HORA_INICIO) || 9,
      horaFin: parseInt(process.env.HORA_FIN) || 20
    };
  }

  estaEnHorario() {
    const hora = new Date().getHours();
    return hora >= this.config.horaInicio && hora < this.config.horaFin;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  reemplazarVariables(plantilla, datos) {
    let mensaje = plantilla;
    Object.keys(datos).forEach(key => {
      const regex = new RegExp(`\\{${key}\\}`, 'gi');
      mensaje = mensaje.replace(regex, datos[key] || '');
    });
    return mensaje;
  }

  async enviarMasivoFlexible(contactos, plantilla, columnaTeléfono = 'telefono') {
    if (this.estadisticas.enviandoActualmente) {
      throw new Error('Ya hay un envío en proceso');
    }

    this.estadisticas = {
      total: contactos.length,
      exitosos: 0,
      fallidos: 0,
      enCola: contactos.length,
      enviandoActualmente: true,
      ultimoResultado: null
    };

    console.log(`\n📤 Iniciando envío masivo a ${contactos.length} contactos`);
    console.log(`⏱️ Delay: ${this.config.delayEntreMensajes}ms | Lote: ${this.config.mensajesPorLote}\n`);

    let enviados = 0;

    for (const contacto of contactos) {
      // Verificar horario
      if (!this.estaEnHorario()) {
        console.log('⏰ Fuera de horario. Pausando envío...');
        await this.esperarHorario();
      }

      const telefono = contacto[columnaTeléfono] || contacto.telefono || contacto.Teléfono;
      if (!telefono) {
        this.estadisticas.fallidos++;
        this.estadisticas.enCola--;
        continue;
      }

      const mensaje = this.reemplazarVariables(plantilla, contacto);

      try {
        const resultado = await this.whatsapp.enviarMensaje(telefono, mensaje);
        
        if (resultado.exito) {
          this.estadisticas.exitosos++;
        } else {
          this.estadisticas.fallidos++;
        }
        
        this.estadisticas.ultimoResultado = { 
          telefono, 
          exito: resultado.exito, 
          error: resultado.error 
        };
        
      } catch (error) {
        this.estadisticas.fallidos++;
        this.estadisticas.ultimoResultado = { 
          telefono, 
          exito: false, 
          error: error.message 
        };
      }

      this.estadisticas.enCola--;
      enviados++;

      // Pausa entre lotes
      if (enviados % this.config.mensajesPorLote === 0 && enviados < contactos.length) {
        console.log(`\n⏸️ Pausa de ${this.config.pausaEntreLotes / 1000}s después de ${enviados} mensajes...\n`);
        await this.delay(this.config.pausaEntreLotes);
      } else {
        await this.delay(this.config.delayEntreMensajes);
      }
    }

    this.estadisticas.enviandoActualmente = false;
    console.log(`\n✅ Envío completado: ${this.estadisticas.exitosos}/${this.estadisticas.total} exitosos\n`);
    
    return this.estadisticas;
  }

  async esperarHorario() {
    while (!this.estaEnHorario()) {
      console.log('💤 Esperando horario permitido...');
      await this.delay(60000); // Revisar cada minuto
    }
  }

  getEstadisticas() {
    return { ...this.estadisticas };
  }

  resetEstadisticas() {
    this.estadisticas = {
      total: 0,
      exitosos: 0,
      fallidos: 0,
      enCola: 0,
      enviandoActualmente: false,
      ultimoResultado: null
    };
  }
}

module.exports = EnvioMasivoService;
