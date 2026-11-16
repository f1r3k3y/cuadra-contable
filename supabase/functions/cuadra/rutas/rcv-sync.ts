// Registro de Compras y Ventas: sincroniza desde el SII (producción) o importa el CSV descargado de sii.cl.
import { HttpError, requerido, servir } from '../../_shared/http.ts';
import { cargarCertificado, clienteSii } from '../../_shared/contexto.ts';
import { cuadrarRcv, importarCsvRcv, normalizarRcvJson, type RegistroRcv } from '../../_shared/sii/mod.ts';

const TIPOS_COMPRA = [33, 34, 43, 46, 56, 61];
const TIPOS_VENTA = [33, 34, 39, 41, 43, 46, 56, 61];

export default servir(['admin', 'contador'], async ({ body, admin, empresa }) => {
  const periodo = requerido(body.periodo as string, 'periodo');
  if (!/^\d{6}$/.test(periodo)) throw new HttpError(400, 'Período inválido (AAAAMM)');
  const operacion = (body.operacion as 'COMPRA' | 'VENTA') ?? 'COMPRA';
  if (!['COMPRA', 'VENTA'].includes(operacion)) throw new HttpError(400, 'Operación inválida');

  let registros: RegistroRcv[] = [];
  let fuente: 'csv' | 'sii' = 'csv';
  if (body.csv) {
    registros = importarCsvRcv(String(body.csv), operacion, String(body.estado ?? 'REGISTRO'));
  } else {
    if (empresa.sii_ambiente !== 'produccion') {
      throw new HttpError(412, 'El RCV solo está disponible con la empresa en ambiente de producción; mientras tanto importe el CSV');
    }
    fuente = 'sii';
    const { cert } = await cargarCertificado(admin, empresa.id);
    const cli = clienteSii(empresa, cert);
    for (const estado of ['REGISTRO', 'PENDIENTE'] as const) {
      for (const tipo of operacion === 'COMPRA' ? TIPOS_COMPRA : TIPOS_VENTA) {
        try {
          const filas = await cli.rcvDetalle(empresa.rut, periodo, operacion, tipo, estado);
          registros.push(...normalizarRcvJson(filas, operacion, estado));
        } catch (e) {
          console.warn(`RCV ${operacion} ${tipo} ${estado}:`, (e as Error).message);
        }
      }
    }
  }

  if (registros.length) {
    const { error } = await admin.from('rcv_registros').upsert(
      registros.map((r) => ({
        empresa_id: empresa.id,
        periodo,
        operacion: r.operacion,
        tipo: r.tipo,
        folio: r.folio,
        rut_contraparte: r.rutContraparte,
        razon_social: r.razonSocial,
        fecha_emision: r.fechaEmision || null,
        fecha_recepcion: r.fechaRecepcion || null,
        neto: r.neto,
        exento: r.exento,
        iva: r.iva,
        iva_no_recuperable: r.ivaNoRecuperable,
        total: r.total,
        estado: r.estado,
        fuente,
        importado_en: new Date().toISOString(),
      })),
      { onConflict: 'empresa_id,periodo,operacion,tipo,folio,rut_contraparte' },
    );
    if (error) throw error;
  }

  // Documentos de compra que están en el RCV pero no fueron recibidos por intercambio: se crean como pendientes.
  if (operacion === 'COMPRA') {
    const nuevos = registros.filter((r) => r.estado === 'REGISTRO' || r.estado === 'PENDIENTE');
    if (nuevos.length) {
      await admin.from('dte_recibidos').upsert(
        nuevos.map((r) => ({
          empresa_id: empresa.id,
          tipo: r.tipo,
          folio: r.folio,
          fecha_emision: r.fechaEmision,
          emisor_rut: r.rutContraparte,
          emisor_razon: r.razonSocial,
          neto: r.neto,
          exento: r.exento,
          iva: r.iva,
          iva_no_recuperable: r.ivaNoRecuperable,
          total: r.total,
          estado: r.estado === 'REGISTRO' ? 'aceptado' : 'pendiente',
          origen: 'rcv',
        })),
        { onConflict: 'empresa_id,emisor_rut,tipo,folio', ignoreDuplicates: true },
      );
    }
  }

  // Cuadratura contra la contabilidad
  const desde = `${periodo.slice(0, 4)}-${periodo.slice(4)}-01`;
  const ultimoDia = new Date(Date.UTC(Number(periodo.slice(0, 4)), Number(periodo.slice(4)), 0)).getUTCDate();
  const hasta = `${periodo.slice(0, 4)}-${periodo.slice(4)}-${String(ultimoDia).padStart(2, '0')}`;
  const tabla = operacion === 'COMPRA' ? 'dte_recibidos' : 'dte_emitidos';
  const rutCol = operacion === 'COMPRA' ? 'emisor_rut' : 'receptor_rut';
  const { data: libro } = await admin.from(tabla).select(`tipo, folio, total, iva, ${rutCol}, asiento_id`).eq('empresa_id', empresa.id).gte(
    'fecha_emision',
    desde,
  ).lte('fecha_emision', hasta).not('asiento_id', 'is', null);
  const { data: rcv } = await admin.from('rcv_registros').select('*').eq('empresa_id', empresa.id).eq('periodo', periodo).eq(
    'operacion',
    operacion,
  ).eq('estado', 'REGISTRO');
  const diferencias = cuadrarRcv(
    (rcv ?? []).map((r) => ({
      operacion,
      tipo: r.tipo,
      folio: Number(r.folio),
      rutContraparte: r.rut_contraparte,
      razonSocial: r.razon_social,
      fechaEmision: r.fecha_emision,
      neto: Number(r.neto),
      exento: Number(r.exento),
      iva: Number(r.iva),
      ivaNoRecuperable: Number(r.iva_no_recuperable),
      total: Number(r.total),
      estado: r.estado,
    })),
    (libro ?? []).map((l: any) => ({
      tipo: l.tipo,
      folio: Number(l.folio),
      rutContraparte: l[rutCol],
      total: Number(l.total),
      iva: Number(l.iva),
    })),
  );
  return { importados: registros.length, fuente, diferencias };
});
