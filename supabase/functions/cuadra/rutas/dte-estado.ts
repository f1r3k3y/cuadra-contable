// Consulta el estado de envíos en el SII, reenvía DTE firmados y contabiliza los aceptados.
import { HttpError, requerido, servir } from '../../_shared/http.ts';
import { caratula, cargarCertificado, clienteSii } from '../../_shared/contexto.ts';
import { construirSobre } from '../../_shared/sii/mod.ts';

export default servir(['admin', 'contador', 'operador'], async ({ body, admin, empresa, userId }) => {
  const accion = (body.accion as string) ?? 'consultar';
  const { cert, rutTitular } = await cargarCertificado(admin, empresa.id);
  const cli = clienteSii(empresa, cert);

  if (accion === 'reenviar') {
    const ids = requerido(body.dteIds as string[], 'dteIds');
    const { data: dtes } = await admin
      .from('dte_emitidos')
      .select('id, tipo, folio, xml, estado')
      .eq('empresa_id', empresa.id)
      .in('id', ids)
      .in('estado', ['firmado', 'rechazado']);
    if (!dtes?.length) throw new HttpError(400, 'No hay documentos para reenviar');
    const boleta = dtes.every((d) => [39, 41].includes(d.tipo));
    if (!boleta && dtes.some((d) => [39, 41].includes(d.tipo))) throw new HttpError(400, 'No mezcle boletas con otros documentos');
    const sobre = construirSobre(dtes, caratula(empresa, rutTitular), cert, { boleta });
    const track = boleta
      ? await cli.enviarBoleta(sobre, empresa.rut, empresa.rut_envia ?? rutTitular)
      : await cli.enviarDte(sobre, empresa.rut, empresa.rut_envia ?? rutTitular);
    await admin.from('envios_sii').insert({
      empresa_id: empresa.id,
      tipo: boleta ? 'boleta' : 'dte',
      ambiente: empresa.sii_ambiente,
      track_id: track,
      estado: 'recibido',
      documentos: dtes.map((d) => d.id),
      creado_por: userId,
    });
    await admin.from('dte_emitidos').update({ estado: 'enviado', track_id: track, enviado_en: new Date().toISOString() }).in(
      'id',
      dtes.map((d) => d.id),
    );
    return { trackId: track, documentos: dtes.length };
  }

  // consultar: todos los envíos pendientes de la empresa, o uno específico
  let q = admin.from('envios_sii').select('*').eq('empresa_id', empresa.id).eq('tipo', 'dte');
  q = body.envioId ? q.eq('id', body.envioId as string) : q.not('estado', 'in', '(EPR,RCT,RFR,RSC,RCS)').limit(20);
  const { data: envios } = await q;
  const resultados = [];
  for (const env of envios ?? []) {
    const st = await cli.estadoEnvio(empresa.rut, env.track_id);
    await admin.from('envios_sii').update({ estado: st.estado, glosa: st.glosa, respuesta: st, actualizado_en: new Date().toISOString() })
      .eq('id', env.id);
    if (st.estado === 'EPR') {
      // Procesado: si el envío tiene un único documento, el resultado es directo; si no, se consulta cada DTE.
      const { data: dtes } = await admin.from('dte_emitidos').select('*').in('id', env.documentos);
      for (const d of dtes ?? []) {
        let estado: string;
        if ((dtes?.length ?? 0) === 1) {
          estado = st.rechazados ? 'rechazado' : st.reparos ? 'aceptado_reparos' : 'aceptado';
        } else {
          const ed = await cli.estadoDte({
            rutConsultante: empresa.rut_envia ?? rutTitular,
            rutEmisor: empresa.rut,
            rutReceptor: d.receptor_rut,
            tipo: d.tipo,
            folio: d.folio,
            fechaEmision: d.fecha_emision,
            monto: Number(d.total),
          });
          estado = ed.estado === 'DOK'
            ? 'aceptado'
            : ['DNK', 'FAU', 'FNA', 'FAN', 'EMP', 'TMD', 'TMC', 'MMD', 'MMC'].includes(ed.estado)
            ? 'rechazado'
            : 'enviado';
        }
        await admin.from('dte_emitidos').update({ estado, sii_estado: st.estado, sii_glosa: st.glosa }).eq('id', d.id);
        if ((estado === 'aceptado' || estado === 'aceptado_reparos') && !d.asiento_id && d.tipo !== 52) {
          const { error } = await admin.rpc('contabilizar_dte_emitido', { p_dte: d.id });
          if (error) console.warn('No se pudo contabilizar', d.id, error.message);
        }
      }
    } else if (['RCT', 'RFR', 'RSC', 'RCS', 'RPR', 'RCH', 'RDC'].includes(st.estado)) {
      await admin.from('dte_emitidos').update({ estado: 'rechazado', sii_estado: st.estado, sii_glosa: st.glosa }).in('id', env.documentos);
    }
    resultados.push({ envioId: env.id, trackId: env.track_id, estado: st.estado, glosa: st.glosa });
  }
  return { resultados };
});
