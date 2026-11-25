// Descarga el detalle del Registro de Compras y Ventas desde el SII (solo producción, con certificado)
// y lo carga con importar_rcv usando la sesión del usuario (mismos permisos y misma cuadratura que el CSV).
import { HttpError, requerido, servir } from '../../_shared/http.ts';
import { cargarCertificado, clienteSii } from '../../_shared/contexto.ts';
import { normalizarRcvJson, type RegistroRcv } from '../../_shared/sii/mod.ts';

const TIPOS_COMPRA = [33, 34, 43, 46, 56, 61];
const TIPOS_VENTA = [33, 34, 39, 41, 43, 46, 56, 61];

export default servir(['admin', 'contador'], async ({ body, admin, db, empresa }) => {
  const periodo = requerido(body.periodo as string, 'periodo');
  if (!/^\d{6}$/.test(periodo)) throw new HttpError(400, 'Período inválido (AAAAMM)');
  const operacion = (body.operacion as 'COMPRA' | 'VENTA') ?? 'COMPRA';
  if (!['COMPRA', 'VENTA'].includes(operacion)) throw new HttpError(400, 'Operación inválida');
  if (empresa.sii_ambiente !== 'produccion') {
    throw new HttpError(412, 'La descarga automática del RCV solo existe en producción; mientras tanto importe el CSV de sii.cl');
  }
  const { cert } = await cargarCertificado(admin, empresa.id);
  const cli = clienteSii(empresa, cert);
  const registros: RegistroRcv[] = [];
  const fallos: string[] = [];
  for (const estado of ['REGISTRO', 'PENDIENTE'] as const) {
    for (const tipo of operacion === 'COMPRA' ? TIPOS_COMPRA : TIPOS_VENTA) {
      try {
        registros.push(...normalizarRcvJson(await cli.rcvDetalle(empresa.rut, periodo, operacion, tipo, estado), operacion, estado));
      } catch (e) {
        fallos.push(`${tipo}/${estado}: ${(e as Error).message}`);
      }
    }
  }
  if (fallos.length && !registros.length) throw new HttpError(502, 'No se pudo leer el RCV desde el SII', fallos);
  const { data, error } = await db.rpc('importar_rcv', {
    p_empresa: empresa.id, p_periodo: periodo, p_operacion: operacion, p_fuente: 'sii',
    p_filas: registros.map((r) => ({
      tipo: r.tipo, folio: r.folio, rut: r.rutContraparte, razonSocial: r.razonSocial, fechaEmision: r.fechaEmision,
      fechaRecepcion: r.fechaRecepcion ?? null, neto: r.neto, exento: r.exento, iva: r.iva, ivaNoRecuperable: r.ivaNoRecuperable,
      total: r.total, estado: r.estado,
    })),
  });
  if (error) throw new HttpError(400, error.message);
  return { ...(data as Record<string, unknown>), fallos };
});
