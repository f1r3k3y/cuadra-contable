// Construcción del Documento Tributario Electrónico (formato SII v1.0) y su timbre (TED).
import { el, opt, raw, c14n, textoSii, aLatin1, NS_SII, type XNode } from './xml.ts';
import { rutSii } from './rut.ts';
import { firmarLatin1 } from './cripto.ts';
import type { Caf } from './caf.ts';
import { calcularTotales, esBoleta, esExenta, TASA_IVA, type ItemDte, type Totales } from './totales.ts';
export * from './totales.ts';

export const TIPOS_DTE: Record<number, string> = {
  33: 'Factura electrónica',
  34: 'Factura no afecta o exenta electrónica',
  39: 'Boleta electrónica',
  41: 'Boleta exenta electrónica',
  46: 'Factura de compra electrónica',
  52: 'Guía de despacho electrónica',
  56: 'Nota de débito electrónica',
  61: 'Nota de crédito electrónica',
};


export interface Emisor {
  rut: string;
  razonSocial: string;
  giro: string;
  actecos: number[];
  direccion: string;
  comuna: string;
  ciudad?: string;
  codigoSucursal?: number;
  telefono?: string;
  correo?: string;
}

export interface Receptor {
  rut: string;
  razonSocial: string;
  giro?: string;
  direccion?: string;
  comuna?: string;
  ciudad?: string;
  correo?: string;
}

export interface ReferenciaDte {
  tipoDoc: string | number; // 33, 801 (OC), 'SET' en certificación...
  folio: string | number;
  fecha: string;
  codigo?: 1 | 2 | 3; // 1 anula, 2 corrige texto, 3 corrige montos
  razon?: string;
}

export interface DatosDte {
  tipo: number;
  folio: number;
  fechaEmision: string; // AAAA-MM-DD
  fechaVencimiento?: string;
  formaPago?: 1 | 2 | 3; // contado, crédito, sin costo
  indTraslado?: number; // obligatorio en guía 52
  emisor: Emisor;
  receptor: Receptor;
  items: ItemDte[];
  referencias?: ReferenciaDte[];
}

export function idDocumento(tipo: number, folio: number) {
  return `T${tipo}F${folio}`;
}

function encabezado(d: DatosDte, t: Totales): XNode {
  const boleta = esBoleta(d.tipo);
  const idDoc = el(
    'IdDoc',
    {},
    el('TipoDTE', {}, d.tipo),
    el('Folio', {}, d.folio),
    el('FchEmis', {}, d.fechaEmision),
    d.tipo === 52 ? el('IndTraslado', {}, d.indTraslado ?? 1) : null,
    boleta ? el('IndServicio', {}, 3) : null,
    !boleta ? opt('FmaPago', d.formaPago) : null,
    !boleta ? opt('FchVenc', d.fechaVencimiento) : null,
  );
  const e = d.emisor;
  const emisor = boleta
    ? el(
        'Emisor',
        {},
        el('RUTEmisor', {}, rutSii(e.rut)),
        el('RznSocEmisor', {}, textoSii(e.razonSocial, 100)),
        el('GiroEmisor', {}, textoSii(e.giro, 80)),
        opt('CdgSIISucur', e.codigoSucursal),
        el('DirOrigen', {}, textoSii(e.direccion, 70)),
        el('CmnaOrigen', {}, textoSii(e.comuna, 20)),
        opt('CiudadOrigen', textoSii(e.ciudad, 20)),
      )
    : el(
        'Emisor',
        {},
        el('RUTEmisor', {}, rutSii(e.rut)),
        el('RznSoc', {}, textoSii(e.razonSocial, 100)),
        el('GiroEmis', {}, textoSii(e.giro, 80)),
        opt('Telefono', textoSii(e.telefono, 20)),
        opt('CorreoEmisor', textoSii(e.correo, 80)),
        ...e.actecos.slice(0, 4).map((a) => el('Acteco', {}, a)),
        opt('CdgSIISucur', e.codigoSucursal),
        el('DirOrigen', {}, textoSii(e.direccion, 70)),
        el('CmnaOrigen', {}, textoSii(e.comuna, 20)),
        opt('CiudadOrigen', textoSii(e.ciudad, 20)),
      );
  const r = d.receptor;
  const receptor = el(
    'Receptor',
    {},
    el('RUTRecep', {}, rutSii(r.rut)),
    el('RznSocRecep', {}, textoSii(r.razonSocial, 100)),
    !boleta ? opt('GiroRecep', textoSii(r.giro, 40)) : null,
    !boleta ? opt('CorreoRecep', textoSii(r.correo, 80)) : null,
    opt('DirRecep', textoSii(r.direccion, 70)),
    opt('CmnaRecep', textoSii(r.comuna, 20)),
    opt('CiudadRecep', textoSii(r.ciudad, 20)),
  );
  const totales = esExenta(d.tipo)
    ? el('Totales', {}, el('MntExe', {}, t.exento), el('MntTotal', {}, t.total))
    : el(
        'Totales',
        {},
        t.neto ? el('MntNeto', {}, t.neto) : null,
        t.exento ? el('MntExe', {}, t.exento) : null,
        !boleta && t.neto ? el('TasaIVA', {}, TASA_IVA) : null,
        t.neto ? el('IVA', {}, t.iva) : null,
        el('MntTotal', {}, t.total),
      );
  return el('Encabezado', {}, idDoc, emisor, receptor, totales);
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function detalle(d: DatosDte, t: Totales): XNode[] {
  return d.items.map((it, i) =>
    el(
      'Detalle',
      {},
      el('NroLinDet', {}, i + 1),
      it.codigo ? el('CdgItem', {}, el('TpoCodigo', {}, 'INT1'), el('VlrCodigo', {}, textoSii(it.codigo, 35))) : null,
      it.exento && !esExenta(d.tipo) ? el('IndExe', {}, 1) : null,
      el('NmbItem', {}, textoSii(it.nombre, 80)),
      opt('DscItem', textoSii(it.descripcion, 1000)),
      el('QtyItem', {}, fmtNum(it.cantidad)),
      opt('UnmdItem', textoSii(it.unidad, 4)),
      el('PrcItem', {}, fmtNum(it.precio)),
      it.descuentoPct ? el('DescuentoPct', {}, fmtNum(it.descuentoPct)) : null,
      it.descuentoPct ? el('DescuentoMonto', {}, t.lineas[i].descuentoMonto) : null,
      el('MontoItem', {}, t.lineas[i].montoItem),
    ),
  );
}

function referencias(d: DatosDte): XNode[] {
  return (d.referencias ?? []).slice(0, 40).map((r, i) =>
    el(
      'Referencia',
      {},
      el('NroLinRef', {}, i + 1),
      el('TpoDocRef', {}, r.tipoDoc),
      el('FolioRef', {}, r.folio),
      el('FchRef', {}, r.fecha),
      opt('CodRef', r.codigo),
      opt('RazonRef', textoSii(r.razon, 90)),
    ),
  );
}

export function timestampSii(fecha = new Date()): string {
  // Hora local de Chile, formato AAAA-MM-DDTHH:MM:SS
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(fecha);
  return f.replace(' ', 'T');
}

/** Construye el TED (timbre electrónico) firmado con la clave privada del CAF. */
export function construirTed(d: DatosDte, t: Totales, caf: Caf, tsted: string): string {
  if (caf.tipoDte !== d.tipo) throw new Error(`El CAF es para tipo ${caf.tipoDte}, no ${d.tipo}`);
  if (d.folio < caf.desde || d.folio > caf.hasta) throw new Error(`Folio ${d.folio} fuera del rango del CAF`);
  if (rutSii(caf.rutEmisor) !== rutSii(d.emisor.rut)) throw new Error('El CAF no corresponde al emisor');
  const dd = c14n(
    el(
      'DD',
      {},
      el('RE', {}, rutSii(d.emisor.rut)),
      el('TD', {}, d.tipo),
      el('F', {}, d.folio),
      el('FE', {}, d.fechaEmision),
      el('RR', {}, rutSii(d.receptor.rut)),
      el('RSR', {}, textoSii(d.receptor.razonSocial, 40)),
      el('MNT', {}, t.total),
      el('IT1', {}, textoSii(d.items[0]?.nombre, 40)),
      raw(caf.bloqueCaf),
      el('TSTED', {}, tsted),
    ),
  );
  const frmt = firmarLatin1(caf.privateKey, aLatin1(dd));
  return `<TED version="1.0">${dd}<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT></TED>`;
}

export interface DocumentoConstruido {
  id: string;
  /** <Documento ...> canónico, en el contexto de <DTE xmlns="http://www.sii.cl/SiiDte">. */
  documento: XNode;
  totales: Totales;
  ted: string;
}

export function construirDocumento(d: DatosDte, caf: Caf, ahora = new Date()): DocumentoConstruido {
  validarDatos(d);
  const t = calcularTotales(d);
  const ts = timestampSii(ahora);
  const ted = construirTed(d, t, caf, ts);
  const id = idDocumento(d.tipo, d.folio);
  const documento = el(
    'Documento',
    { ID: id },
    encabezado(d, t),
    ...detalle(d, t),
    ...referencias(d),
    raw(ted),
    el('TmstFirma', {}, ts),
  );
  return { id, documento, totales: t, ted };
}

export function validarDatos(d: DatosDte) {
  if (!TIPOS_DTE[d.tipo]) throw new Error(`Tipo de DTE no soportado: ${d.tipo}`);
  if (!d.items.length) throw new Error('El documento debe tener al menos un ítem');
  if (d.items.length > 60) throw new Error('Máximo 60 líneas de detalle');
  if ((d.tipo === 56 || d.tipo === 61) && !d.referencias?.length)
    throw new Error('Las notas de crédito/débito requieren una referencia al documento original');
  for (const it of d.items) {
    if (!(it.cantidad > 0)) throw new Error(`Cantidad inválida en "${it.nombre}"`);
    if (!(it.precio >= 0)) throw new Error(`Precio inválido en "${it.nombre}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fechaEmision)) throw new Error('Fecha de emisión inválida');
}

export { NS_SII };
