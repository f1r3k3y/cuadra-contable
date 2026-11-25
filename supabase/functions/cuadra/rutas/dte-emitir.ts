// Emisión de DTE con el conector configurado por la empresa (directo al SII o vía proveedor).
// Después de emitir, registra el documento en el libro de ventas con el folio asignado, usando la sesión
// del usuario: así se aplican los mismos permisos y la misma aprobación que un registro manual.
import { HttpError, servir } from '../../_shared/http.ts';
import { caratula, cargarApiKey, cargarCaf, cargarCertificado, clienteSii, emisorDesdeEmpresa } from '../../_shared/contexto.ts';
import {
  type Caf,
  type ConectorDte,
  ConectorDirecto,
  construirSobre,
  crearConectorProveedor,
  ErrorConector,
  firmarDte,
  type ItemDte,
  type ReferenciaDte,
  rutSii,
  type SolicitudDte,
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
  /** Para notas de crédito/débito: documento del libro que modifican. */
  referenciaDocumentoId?: string;
}

const TIPOS_EMISIBLES = [33, 34, 39, 41, 56, 61];

function hoyChile() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
}

export default servir(['admin', 'contador', 'asistente'], async ({ body, admin, db, empresa, userId }) => {
  const doc = body.documento as Entrada;
  const enviar = body.enviar !== false;
  if (!doc || !TIPOS_DTE[doc.tipo] || !TIPOS_EMISIBLES.includes(doc.tipo)) throw new HttpError(400, 'Tipo de documento inválido');
  if (!doc.receptor?.rut || !validarRut(doc.receptor.rut)) throw new HttpError(400, 'RUT del receptor inválido');
  if (![39, 41].includes(doc.tipo) && !doc.receptor.razonSocial) throw new HttpError(400, 'Falta la razón social del receptor');
  if (!Array.isArray(doc.items) || !doc.items.length || doc.items.length > 60) throw new HttpError(400, 'El documento debe tener entre 1 y 60 ítems');
  for (const i of doc.items) {
    if (!i.nombre?.trim() || !(Number(i.cantidad) > 0) || !(Number(i.precio) >= 0)) throw new HttpError(400, 'Revise nombre, cantidad y precio de los ítems');
  }
  if (empresa.sii_conector === 'ninguno') throw new HttpError(412, 'La empresa no tiene configurada la conexión con el SII');

  // Notas: la referencia sale del documento del libro
  let refDoc: Record<string, any> | null = null;
  if ([56, 61].includes(doc.tipo)) {
    if (!doc.referenciaDocumentoId) throw new HttpError(400, 'Indique el documento que modifica la nota');
    const { data } = await admin.from('documentos').select('id, tipo, folio, fecha, rut, operacion, estado')
      .eq('id', doc.referenciaDocumentoId).eq('empresa_id', empresa.id).maybeSingle();
    if (!data || data.operacion !== 'venta' || data.estado !== 'vigente') throw new HttpError(400, 'Documento de referencia inválido');
    if (rutSii(data.rut) !== rutSii(doc.receptor.rut)) throw new HttpError(400, 'La nota debe ser para el mismo cliente del documento');
    refDoc = data;
  }

  const solicitud: SolicitudDte = {
    tipo: doc.tipo,
    fechaEmision: doc.fechaEmision ?? hoyChile(),
    fechaVencimiento: doc.fechaVencimiento,
    formaPago: doc.formaPago,
    indTraslado: doc.indTraslado,
    emisor: emisorDesdeEmpresa(empresa),
    receptor: { ...doc.receptor, rut: rutSii(doc.receptor.rut) },
    items: doc.items.map((i) => ({
      ...i,
      nombre: i.nombre.trim(),
      cantidad: Number(i.cantidad),
      precio: Number(i.precio),
      descuentoPct: i.descuentoPct ? Number(i.descuentoPct) : undefined,
    })),
    referencias: refDoc
      ? [{ tipoDoc: refDoc.tipo, folio: refDoc.folio, fecha: refDoc.fecha, codigo: 3, razon: doc.referencias?.[0]?.razon ?? 'Corrige montos' }]
      : doc.referencias,
  };

  // Conector según configuración
  let conector: ConectorDte;
  let rutTitular = empresa.rut_envia;
  if (empresa.sii_conector === 'directo') {
    const c = await cargarCertificado(admin, empresa.id);
    rutTitular = c.rutTitular;
    let caf: Caf;
    conector = new ConectorDirecto({
      reservarFolio: async (tipo) => {
        const { data, error } = await admin.rpc('reservar_folio', { p_empresa: empresa.id, p_tipo: tipo }).single();
        if (error) throw new HttpError(412, error.message);
        const r = data as { folio: number; secreto_id: string };
        caf = await cargarCaf(admin, empresa.id, r.secreto_id);
        return r.folio;
      },
      firmar: (d) => firmarDte(d, caf, c.cert),
      enviar: async (f) => {
        const boleta = [39, 41].includes(f.tipo);
        const sobre = construirSobre([f], caratula(empresa, c.rutTitular), c.cert, { boleta, idSet: `SetDoc${f.folio}` });
        const cli = clienteSii(empresa, c.cert);
        return boleta
          ? await cli.enviarBoleta(sobre, empresa.rut, empresa.rut_envia ?? c.rutTitular)
          : await cli.enviarDte(sobre, empresa.rut, empresa.rut_envia ?? c.rutTitular, `${f.tipo}_${f.folio}.xml`);
      },
    });
  } else {
    const apiKey = await cargarApiKey(admin, empresa.id);
    conector = crearConectorProveedor(empresa.sii_proveedor, apiKey, { url: empresa.sii_proveedor_url, ambiente: empresa.sii_ambiente });
  }

  let res;
  try {
    res = await conector.emitir(solicitud, { enviar });
  } catch (e) {
    if (e instanceof ErrorConector) throw new HttpError(502, e.message, e.detalle);
    throw e;
  }

  const { data: dte, error } = await admin
    .from('dte_emitidos')
    .insert({
      empresa_id: empresa.id,
      tipo: solicitud.tipo,
      folio: res.folio,
      fecha_emision: solicitud.fechaEmision,
      receptor_rut: solicitud.receptor.rut,
      receptor_razon: solicitud.receptor.razonSocial || 'Consumidor final',
      neto: res.totales.neto,
      exento: res.totales.exento,
      iva: res.totales.iva,
      total: res.totales.total,
      estado: res.estado,
      ambiente: empresa.sii_ambiente,
      track_id: res.trackId ?? null,
      enviado_en: res.estado === 'enviado' ? new Date().toISOString() : null,
      datos: { ...solicitud, folio: res.folio, conector: conector.nombre, idExterno: res.idExterno ?? null },
      xml: res.xml ?? '',
      ted: res.ted ?? null,
      creado_por: userId,
    })
    .select('id, tipo, folio, total, estado, track_id')
    .single();
  if (error) throw error;
  if (res.trackId) {
    await admin.from('envios_sii').insert({
      empresa_id: empresa.id, tipo: [39, 41].includes(solicitud.tipo) ? 'boleta' : 'dte', ambiente: empresa.sii_ambiente,
      track_id: res.trackId, estado: 'recibido', documentos: [dte.id], creado_por: userId,
    });
  }

  // Registro en el libro con la sesión del usuario (permisos y aprobación normales)
  const r = solicitud.receptor;
  const { data: libro, error: el } = await db.rpc('registrar_documento', {
    p_empresa: empresa.id, p_operacion: 'venta', p_tipo: solicitud.tipo, p_folio: res.folio, p_fecha: solicitud.fechaEmision,
    p_rut: [39, 41].includes(solicitud.tipo) && !r.razonSocial ? '66666666-6' : r.rut,
    p_razon: r.razonSocial || 'Consumidor final', p_neto: res.totales.neto, p_exento: res.totales.exento,
    p_glosa: solicitud.items.map((i) => i.nombre).join(', ').slice(0, 300),
    p_referencia: refDoc?.id ?? null, p_vencimiento: solicitud.fechaVencimiento ?? null,
  });
  if (el) {
    // El DTE ya existe en el SII: se informa para registrarlo a mano, sin perder el folio
    return { dte, libro: null, avisoLibro: `El DTE se emitió con folio ${res.folio}, pero no se pudo registrar en el libro: ${el.message}` };
  }
  await admin.from('documentos').update({ origen: 'dte', dte_emitido_id: dte.id }).eq('id', (libro as any).id);
  await admin.from('dte_emitidos').update({ asiento_id: (libro as any).asiento_id }).eq('id', dte.id);
  return { dte, libro };
});
