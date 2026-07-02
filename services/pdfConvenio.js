/**
 * ═══════════════════════════════════════════════════════════
 * GENERADOR DE PDF DE CONVENIO - MULTI-EMPRESA (config/empresa.js)
 * Genera un PDF formal de Convenio de Reconocimiento de Adeudo
 * y Plan de Pagos, en memoria (Buffer).
 * ═══════════════════════════════════════════════════════════
 */

const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const EMPRESA = require('../config/empresa');

/**
 * Genera el folio del convenio: LGX-{plan}-{YYYYMMDD}-{hash6}
 * Ejemplo: LGX-B-20260521-A3F492
 */
function generarFolio(cliente, plan) {
  const fecha = new Date();
  const ymd = fecha.toISOString().slice(0, 10).replace(/-/g, '');
  const semilla = `${cliente.telefono || ''}-${cliente.saldo || 0}-${plan}-${Date.now()}`;
  const hash = crypto.createHash('sha256').update(semilla).digest('hex').slice(0, 6).toUpperCase();
  return `${EMPRESA.folioPrefijo}-${plan}-${ymd}-${hash}`;
}

/**
 * Genera un hash de validación corto para la "firma electrónica"
 * Formato: A3F4-92B1-C8D7-E4F2
 */
function generarHashFirma(folio, telefono, timestamp) {
  const semilla = `${folio}-${telefono}-${timestamp}`;
  const hex = crypto.createHash('sha256').update(semilla).digest('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/**
 * Formatea moneda mexicana
 */
function fmt(n) {
  return '$' + Math.round(n).toLocaleString('es-MX');
}

/**
 * Formatea fecha tipo "21 de mayo de 2026"
 */
function fmtFechaLarga(f) {
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const d = (f instanceof Date) ? f : new Date(f);
  return `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

/**
 * Genera la tabla de pagos: array de {n, fecha, monto}
 */
function generarTablaPagos(fechaInicio, semanas, monto, saldoTotal) {
  const tabla = [];
  const inicio = (fechaInicio instanceof Date) ? new Date(fechaInicio) : new Date(fechaInicio);
  let acumulado = 0;
  for (let i = 1; i <= semanas; i++) {
    const fecha = new Date(inicio);
    fecha.setDate(fecha.getDate() + (i - 1) * 7);
    // Último pago: ajustar para que cierre exactamente el saldo
    const montoEste = (i === semanas) ? Math.max(0, saldoTotal - acumulado) : monto;
    acumulado += montoEste;
    tabla.push({ n: i, fecha, monto: montoEste });
  }
  return tabla;
}

/**
 * GENERA EL PDF DEL CONVENIO
 * @param {Object} cliente - {nombre, telefono, saldo, diasAtraso}
 * @param {String} plan - 'A' o 'B'
 * @param {Object} planDatos - {monto, semanas, saldoConRecargo, conRecargo, fechaInicio, fechaFin}
 * @returns {Promise<{buffer: Buffer, folio: string, hash: string}>}
 */
function generarPDFConvenio(cliente, plan, planDatos) {
  return new Promise((resolve, reject) => {
    try {
      const folio = generarFolio(cliente, plan);
      const ahora = new Date();
      const hashFirma = generarHashFirma(folio, cliente.telefono || '', ahora.getTime());

      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 50, bottom: 50, left: 60, right: 60 },
        info: {
          Title: `Convenio ${folio}`,
          Author: EMPRESA.pdfAuthor,
          Subject: 'Convenio de Reconocimiento de Adeudo'
        }
      });

      // Capturar el PDF en buffer
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        resolve({
          buffer: Buffer.concat(buffers),
          folio,
          hash: hashFirma,
          fechaGeneracion: ahora
        });
      });
      doc.on('error', reject);

      // ═══════════════════════════════════════
      // CABECERA
      // ═══════════════════════════════════════
      doc.fillColor('#0f1a2b')
         .fontSize(18)
         .font('Helvetica-Bold')
         .text('CONVENIO DE RECONOCIMIENTO', { align: 'center' });
      doc.text('DE ADEUDO Y PLAN DE PAGOS', { align: 'center' });

      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#666').font('Helvetica')
         .text(`${EMPRESA.marca} — ${EMPRESA.lema}`, { align: 'center' });

      // Folio destacado
      doc.moveDown(0.5);
      doc.rect(60, doc.y, doc.page.width - 120, 28).fillAndStroke('#b8932f', '#b8932f');
      doc.fillColor('#fff').fontSize(11).font('Helvetica-Bold')
         .text(`FOLIO: ${folio}`, 60, doc.y - 22, { align: 'center', width: doc.page.width - 120 });
      doc.fillColor('#000').font('Helvetica').fontSize(10);
      doc.moveDown(1.2);

      // ═══════════════════════════════════════
      // PROEMIO
      // ═══════════════════════════════════════
      doc.fontSize(9.5).font('Helvetica');
      doc.text(
        `En la Ciudad de México, a los ${fmtFechaLarga(ahora)}, comparecen por una parte ` +
        `${EMPRESA.acreedorLegal} (en adelante "EL ACREEDOR"), representada por ${EMPRESA.representadaPor} ` +
        `para efectos de cobranza, y por otra parte el(la) C. ${cliente.nombre || '[NOMBRE DEL DEUDOR]'} ` +
        `(en adelante "EL DEUDOR"), identificado(a) mediante el número de teléfono celular ` +
        `${cliente.telefono || '[TELÉFONO]'}, quienes celebran el presente CONVENIO al tenor de las siguientes:`,
        { align: 'justify' }
      );
      doc.moveDown(0.6);

      // ═══════════════════════════════════════
      // DECLARACIONES
      // ═══════════════════════════════════════
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f1a2b').text('DECLARACIONES');
      doc.moveDown(0.3);
      doc.fontSize(9.5).font('Helvetica').fillColor('#000');

      doc.font('Helvetica-Bold').text('PRIMERA. ', { continued: true })
         .font('Helvetica').text(
           `EL DEUDOR reconoce de manera libre, expresa y voluntaria que adeuda a EL ACREEDOR ` +
           `la cantidad de ${fmt(cliente.saldo || 0)} (${cliente.saldo} pesos M.N.), ` +
           `derivado de un crédito previamente otorgado.`,
           { align: 'justify' }
         );
      doc.moveDown(0.3);

      doc.font('Helvetica-Bold').text('SEGUNDA. ', { continued: true })
         .font('Helvetica').text(
           `EL DEUDOR manifiesta encontrarse al corriente de sus obligaciones civiles y mercantiles, ` +
           `y que celebra el presente convenio con pleno conocimiento de las consecuencias jurídicas que de él derivan.`,
           { align: 'justify' }
         );
      doc.moveDown(0.6);

      // ═══════════════════════════════════════
      // CLÁUSULAS
      // ═══════════════════════════════════════
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f1a2b').text('CLÁUSULAS');
      doc.moveDown(0.3);
      doc.fontSize(9.5).font('Helvetica').fillColor('#000');

      const totalConvenio = planDatos.saldoConRecargo;
      const recargoTexto = planDatos.conRecargo
        ? `, monto que incluye un 15% adicional por concepto de gastos de cobranza y administración`
        : '';

      doc.font('Helvetica-Bold').text('PRIMERA — OBJETO. ', { continued: true })
         .font('Helvetica').text(
           `EL DEUDOR se obliga a pagar a EL ACREEDOR la cantidad total de ${fmt(totalConvenio)}${recargoTexto}, ` +
           `mediante ${planDatos.semanas} pagos semanales de ${fmt(planDatos.monto)} cada uno.`,
           { align: 'justify' }
         );
      doc.moveDown(0.3);

      doc.font('Helvetica-Bold').text('SEGUNDA — FECHA DE PAGOS. ', { continued: true })
         .font('Helvetica').text(
           `El primer pago deberá realizarse el día ${fmtFechaLarga(planDatos.fechaInicio)}, ` +
           `y los subsecuentes en la misma fecha de cada semana, concluyendo el día ${fmtFechaLarga(planDatos.fechaFin)}. ` +
           `Los pagos deberán realizarse mediante transferencia electrónica o depósito en las cuentas que EL ACREEDOR designe.`,
           { align: 'justify' }
         );
      doc.moveDown(0.3);

      doc.font('Helvetica-Bold').text('TERCERA — INCUMPLIMIENTO. ', { continued: true })
         .font('Helvetica').text(
           `La falta de pago oportuno de cualquiera de las parcialidades acordadas dará lugar al ` +
           `VENCIMIENTO ANTICIPADO de la totalidad del adeudo, facultando a EL ACREEDOR para ejercer ` +
           `las acciones legales y mercantiles que en derecho correspondan, sin necesidad de previo requerimiento.`,
           { align: 'justify' }
         );
      doc.moveDown(0.3);

      doc.font('Helvetica-Bold').text('CUARTA — FIRMA ELECTRÓNICA. ', { continued: true })
         .font('Helvetica').text(
           `Las partes reconocen y aceptan que el presente convenio se celebra por medios electrónicos ` +
           `(WhatsApp), y que la manifestación expresa de aceptación por parte de EL DEUDOR mediante el ` +
           `mensaje "ACEPTO Y FIRMO" constituye su FIRMA ELECTRÓNICA conforme a los artículos 89, 89-bis ` +
           `y 90 del Código de Comercio, así como a la NOM-151-SCFI-2016, otorgando plena validez y ` +
           `eficacia jurídica al presente instrumento.`,
           { align: 'justify' }
         );
      doc.moveDown(0.3);

      doc.font('Helvetica-Bold').text('QUINTA — JURISDICCIÓN. ', { continued: true })
         .font('Helvetica').text(
           `Para la interpretación, cumplimiento y ejecución del presente convenio, las partes se someten ` +
           `expresamente a la jurisdicción de los tribunales competentes del Estado de México, renunciando ` +
           `a cualquier otro fuero que por razón de su domicilio presente o futuro pudiera corresponderles.`,
           { align: 'justify' }
         );
      doc.moveDown(0.8);

      // ═══════════════════════════════════════
      // TABLA DE PAGOS (resumen)
      // ═══════════════════════════════════════
      // Verificar si hay espacio, si no, nueva página
      if (doc.y > 600) doc.addPage();

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f1a2b').text('CALENDARIO DE PAGOS');
      doc.moveDown(0.3);

      const tabla = generarTablaPagos(planDatos.fechaInicio, planDatos.semanas, planDatos.monto, totalConvenio);
      
      // Encabezado de tabla
      const startY = doc.y;
      doc.rect(60, startY, doc.page.width - 120, 18).fillAndStroke('#0f1a2b', '#0f1a2b');
      doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
      doc.text('#', 70, startY + 5, { width: 30 });
      doc.text('FECHA DE PAGO', 110, startY + 5, { width: 200 });
      doc.text('MONTO', 350, startY + 5, { width: 100, align: 'right' });
      doc.fillColor('#000').font('Helvetica').fontSize(8.5);
      
      let y = startY + 22;
      const pagosMostrar = tabla.length > 20 ? [...tabla.slice(0, 10), null, ...tabla.slice(-2)] : tabla;
      
      for (const pago of pagosMostrar) {
        if (y > 720) {
          doc.addPage();
          y = 60;
        }
        if (pago === null) {
          doc.fillColor('#999').text('. . .', 110, y, { width: 200, align: 'center' });
          doc.fillColor('#000');
          y += 14;
          continue;
        }
        // Línea alterna
        if (pago.n % 2 === 0) {
          doc.rect(60, y - 2, doc.page.width - 120, 14).fill('#f5f5f5');
          doc.fillColor('#000');
        }
        doc.text(`${pago.n}`, 70, y, { width: 30 });
        doc.text(fmtFechaLarga(pago.fecha), 110, y, { width: 200 });
        doc.text(fmt(pago.monto), 350, y, { width: 100, align: 'right' });
        y += 14;
      }
      
      // Total
      doc.rect(60, y + 2, doc.page.width - 120, 18).fillAndStroke('#b8932f', '#b8932f');
      doc.fillColor('#fff').fontSize(10).font('Helvetica-Bold');
      doc.text('TOTAL A CUBRIR:', 110, y + 7, { width: 200 });
      doc.text(fmt(totalConvenio), 350, y + 7, { width: 100, align: 'right' });
      doc.fillColor('#000').font('Helvetica');
      
      doc.y = y + 28;
      doc.moveDown(1);

      // ═══════════════════════════════════════
      // FIRMA ELECTRÓNICA (placeholder antes de firmar)
      // ═══════════════════════════════════════
      if (doc.y > 650) doc.addPage();

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f1a2b')
         .text('ACEPTACIÓN Y FIRMA ELECTRÓNICA', { align: 'center' });
      doc.moveDown(0.5);

      doc.fontSize(9).font('Helvetica').fillColor('#000');
      doc.text(
        `Para perfeccionar el presente convenio, EL DEUDOR deberá responder por WhatsApp con el mensaje:`,
        { align: 'center' }
      );
      doc.moveDown(0.3);

      // Caja del "ACEPTO Y FIRMO"
      doc.rect(150, doc.y, doc.page.width - 300, 30).fillAndStroke('#fff8e1', '#b8932f');
      doc.fillColor('#b8932f').fontSize(14).font('Helvetica-Bold')
         .text('"ACEPTO Y FIRMO"', 150, doc.y - 22, { align: 'center', width: doc.page.width - 300 });
      doc.fillColor('#000').font('Helvetica').fontSize(9);
      doc.moveDown(1.5);

      // Datos de identificación del firmante
      doc.fontSize(8.5).fillColor('#444');
      const boxY = doc.y;
      doc.rect(60, boxY, doc.page.width - 120, 80).stroke('#ccc');
      doc.text(`Deudor:        ${cliente.nombre || '[NOMBRE]'}`, 70, boxY + 8);
      doc.text(`Teléfono:      ${cliente.telefono || '[TEL]'}`, 70, boxY + 22);
      doc.text(`Folio:         ${folio}`, 70, boxY + 36);
      doc.text(`Hash:          ${hashFirma}`, 70, boxY + 50);
      doc.text(`Generado:      ${ahora.toLocaleString('es-MX')}`, 70, boxY + 64);
      doc.fillColor('#000');
      doc.y = boxY + 92;

      // ═══════════════════════════════════════
      // FOOTER LEGAL
      // ═══════════════════════════════════════
      const footerY = doc.page.height - 70;
      doc.fontSize(7).fillColor('#888').font('Helvetica');
      doc.text(
        'Documento generado electrónicamente con validez conforme al Código de Comercio (Arts. 89, 89-bis, 90) ' +
        'y la NOM-151-SCFI-2016. La conservación del presente documento y la trazabilidad del mensaje de aceptación ' +
        'a través de la plataforma WhatsApp constituyen prueba plena de su otorgamiento.',
        60, footerY, { width: doc.page.width - 120, align: 'center' }
      );
      doc.fontSize(7).fillColor('#b8932f').font('Helvetica-Bold');
      doc.text(`${EMPRESA.marca} · ${EMPRESA.lema} · ` + folio,
               60, footerY + 35, { width: doc.page.width - 120, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { generarPDFConvenio, generarFolio, generarHashFirma };
