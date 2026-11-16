// Recepción de DTE de proveedores (archivo EnvioDTE recibido por correo de intercambio)
// y registro de aceptación o reclamo en el SII (Ley 19.983).
import { HttpError, requerido, servir } from '../../_shared/http.ts';
import { cargarCertificado, clienteSii } from '../../_shared/contexto.ts';
import { construirEnvioRecibos, construirRespuestaDte, leerSobre, rutSii } from '../../_shared/sii/mod.ts';

export default servir(['admin', 'contador', 'operador'], async ({ body, admin, empresa, userId, rol }) => {
  const accion = requerido(body.accion as string, 'accion');

  if (accion === 'importar') {
    const xml = requerido(body.xml as string, 'xml');
    if (xml.length > 5_000_000) throw new HttpError(413, 'Archivo demasiado grande');
    let sobre;
    try {
      sobre = leerSobre(xml);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const propios = sobre.dtes.filter((d) => rutSii(d.rutReceptor) === rutSii(empresa.rut));
    if (!propios.length) throw new HttpError(400, `Los documentos no están emitidos a ${empresa.rut}`);
    const filas = propios.map((d) => ({
      empresa_id: empresa.id,
      tipo: d.tipo,
      folio: d.folio,
      fecha_emision: d.fechaEmision,
      emisor_rut: d.rutEmisor,
      emisor_razon: d.razonSocialEmisor,
      neto: d.neto,
      exento: d.exento,
      iva: d.iva,
      iva_no_recuperable: d.ivaNoRecuperable,
      total: d.total,
      xml: d.xml,
      origen: 'intercambio',
    }));
    const { data, error } = await admin.from('dte_recibidos').upsert(filas, {
      onConflict: 'empresa_id,emisor_rut,tipo,folio',
      ignoreDuplicates: true,
    }).select('id, tipo, folio, emisor_razon, total');
    if (error) throw error;

    // Acuse de recepción del envío, para devolver al emisor por correo.
    let respuesta: string | undefined;
    try {
      const { cert } = await cargarCertificado(admin, empresa.id);
      respuesta = construirRespuestaDte(
        {
          rutResponde: empresa.rut,
          rutRecibe: sobre.rutEmisor,
          idRespuesta: Math.floor(Date.now() / 1000) % 1_000_000_000,
          nombreContacto: empresa.razon_social,
          correoContacto: empresa.correo,
          recepcion: {
            nombreArchivo: String(body.nombreArchivo ?? 'envio.xml'),
            digestEnvio: sobre.digest,
            rutEmisor: sobre.rutEmisor,
            rutReceptor: empresa.rut,
            estado: 0,
            glosa: 'Envio recibido conforme',
            dtes: propios.map((d) => ({
              tipo: d.tipo,
              folio: d.folio,
              fechaEmision: d.fechaEmision,
              rutEmisor: d.rutEmisor,
              rutReceptor: d.rutReceptor,
              montoTotal: d.total,
              estado: 0,
              glosa: 'DTE recibido',
            })),
          },
        },
        cert,
      );
    } catch {
      respuesta = undefined; // sin certificado se importa igual
    }
    return { importados: data?.length ?? 0, duplicados: propios.length - (data?.length ?? 0), documentos: data, respuestaXml: respuesta };
  }

  if (accion === 'aceptar' || accion === 'reclamar' || accion === 'recibo') {
    if (rol === 'operador') throw new HttpError(403, 'Solo administradores o contadores pueden aceptar o reclamar');
    const id = requerido(body.recibidoId as string, 'recibidoId');
    const { data: d } = await admin.from('dte_recibidos').select('*').eq('id', id).eq('empresa_id', empresa.id).single();
    if (!d) throw new HttpError(404, 'Documento no encontrado');
    if (d.estado !== 'pendiente' && !(accion === 'recibo' && d.estado === 'aceptado')) {
      throw new HttpError(409, `El documento ya está ${d.estado}`);
    }
    const codigo = accion === 'aceptar' ? 'ACD' : accion === 'recibo' ? 'ERM' : ((body.tipoReclamo as string) ?? 'RCD');
    if (!['ACD', 'RCD', 'ERM', 'RFP', 'RFT'].includes(codigo)) throw new HttpError(400, 'Tipo de reclamo inválido');
    const { cert, rutTitular } = await cargarCertificado(admin, empresa.id);
    const res = await clienteSii(empresa, cert).registrarAceptacionReclamo(d.emisor_rut, d.tipo, Number(d.folio), codigo as never);
    const ok = res.codigo === '0';
    let recibos: string | undefined;
    if (ok && codigo === 'ERM') {
      recibos = construirEnvioRecibos(
        {
          rutResponde: empresa.rut,
          rutRecibe: d.emisor_rut,
          recinto: String(body.recinto ?? empresa.direccion),
          rutFirma: rutTitular,
          dtes: [{
            tipo: d.tipo,
            folio: Number(d.folio),
            fechaEmision: d.fecha_emision,
            rutEmisor: d.emisor_rut,
            rutReceptor: empresa.rut,
            montoTotal: Number(d.total),
          }],
        },
        cert,
      );
    }
    await admin
      .from('dte_recibidos')
      .update({
        estado: ok ? (codigo === 'ACD' ? 'aceptado' : codigo === 'ERM' ? 'recibo_mercaderias' : 'reclamado') : d.estado,
        accion_sii: codigo,
        accion_respuesta: res,
        accion_en: new Date().toISOString(),
        accion_por: userId,
      })
      .eq('id', id);
    if (!ok) throw new HttpError(502, `El SII respondió: ${res.descripcion || res.codigo}`, res);
    return { ok, codigo, respuesta: res.descripcion, recibosXml: recibos };
  }

  throw new HttpError(400, 'Acción desconocida');
});
