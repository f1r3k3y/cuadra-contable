// Emisión de DTE: reserva folio, timbra, firma, guarda y (opcionalmente) envía al SII.
import { HttpError, servir } from '../../_shared/http.ts';
import { caratula, cargarCaf, cargarCertificado, clienteSii, emisorDesdeEmpresa } from '../../_shared/contexto.ts';
import {
  construirSobre,
  type DatosDte,
  firmarDte,
  type ItemDte,
  type ReferenciaDte,
  rutSii,
  TIPOS_DTE,
  validarRut,
} from '../../_shared/sii/mod.ts';

interface Entrada {
  tipo: number;
  fechaEmision?: string;
  fechaVencimiento?: string;
  formaPago?: 1 | 2 | 3;
  indTraslado?: number;
  receptor: { rut: string; razonSocial: string; giro?: string; direccion?: string; comuna?: string; ciudad?: string; correo?: string };
  items: ItemDte[];
  referencias?: ReferenciaDte[];
}

function hoyChile() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
}

export default servir(['admin', 'contador', 'operador'], async ({ body, admin, empresa, userId }) => {
  const doc = body.documento as Entrada;
  const enviar = body.enviar !== false;
  if (!doc || !TIPOS_DTE[doc.tipo]) throw new HttpError(400, 'Tipo de documento inválido');
  if (!doc.receptor?.rut || !validarRut(doc.receptor.rut)) throw new HttpError(400, 'RUT del receptor inválido');
  if (![39, 41].includes(doc.tipo) && !doc.receptor.razonSocial) throw new HttpError(400, 'Falta la razón social del receptor');
  if (!Array.isArray(doc.items) || !doc.items.length) throw new HttpError(400, 'El documento no tiene ítems');

  const { cert, rutTitular } = await cargarCertificado(admin, empresa.id);
  const { data: reserva, error: er } = await admin.rpc('reservar_folio', { p_empresa: empresa.id, p_tipo: doc.tipo }).single();
  if (er) throw new HttpError(412, er.message);
  const { folio, secreto_id } = reserva as { folio: number; secreto_id: string };
  const caf = await cargarCaf(admin, empresa.id, secreto_id);

  const datos: DatosDte = {
    tipo: doc.tipo,
    folio,
    fechaEmision: doc.fechaEmision ?? hoyChile(),
    fechaVencimiento: doc.fechaVencimiento,
    formaPago: doc.formaPago,
    indTraslado: doc.indTraslado,
    emisor: emisorDesdeEmpresa(empresa),
    receptor: { ...doc.receptor, rut: rutSii(doc.receptor.rut) },
    items: doc.items.map((i) => ({
      ...i,
      cantidad: Number(i.cantidad),
      precio: Number(i.precio),
      descuentoPct: i.descuentoPct ? Number(i.descuentoPct) : undefined,
    })),
    referencias: doc.referencias,
  };

  let firmado;
  try {
    firmado = firmarDte(datos, caf, cert);
  } catch (e) {
    // El folio queda reservado pero sin usar: se registra para informarlo como anulado si corresponde.
    throw new HttpError(400, (e as Error).message);
  }

  const { data: dte, error } = await admin
    .from('dte_emitidos')
    .insert({
      empresa_id: empresa.id,
      tipo: datos.tipo,
      folio,
      fecha_emision: datos.fechaEmision,
      receptor_rut: datos.receptor.rut,
      receptor_razon: datos.receptor.razonSocial || 'Consumidor final',
      neto: firmado.totales.neto,
      exento: firmado.totales.exento,
      iva: firmado.totales.iva,
      total: firmado.totales.total,
      estado: 'firmado',
      ambiente: empresa.sii_ambiente,
      datos,
      xml: firmado.xml,
      ted: firmado.ted,
      creado_por: userId,
    })
    .select('id, tipo, folio, total, estado')
    .single();
  if (error) throw error;

  if (!enviar) return { ...dte, enviado: false };

  const boleta = [39, 41].includes(datos.tipo);
  const sobre = construirSobre([firmado], caratula(empresa, rutTitular), cert, { boleta, idSet: `SetDoc${folio}` });
  const cli = clienteSii(empresa, cert);
  try {
    const track = boleta
      ? await cli.enviarBoleta(sobre, empresa.rut, empresa.rut_envia ?? rutTitular)
      : await cli.enviarDte(sobre, empresa.rut, empresa.rut_envia ?? rutTitular, `${datos.tipo}_${folio}.xml`);
    await admin.from('envios_sii').insert({
      empresa_id: empresa.id,
      tipo: boleta ? 'boleta' : 'dte',
      ambiente: empresa.sii_ambiente,
      track_id: track,
      estado: 'recibido',
      documentos: [dte.id],
      creado_por: userId,
    });
    await admin.from('dte_emitidos').update({ estado: 'enviado', track_id: track, enviado_en: new Date().toISOString() }).eq('id', dte.id);
    return { ...dte, estado: 'enviado', trackId: track };
  } catch (e) {
    await admin.from('dte_emitidos').update({ sii_glosa: (e as Error).message, sii_respuesta: { detalle: (e as any).detalle ?? null } }).eq(
      'id',
      dte.id,
    );
    return { ...dte, enviado: false, errorEnvio: (e as Error).message, detalle: (e as any).detalle };
  }
});
