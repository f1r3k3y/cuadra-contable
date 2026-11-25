// Conectores de emisión de DTE: una interfaz común con dos caminos.
//   - "directo": Cuadra timbra con el CAF, firma con el certificado y sube el sobre al SII.
//   - "proveedor": un servicio de facturación certificado (OpenFactura, LibreDTE) timbra, firma y envía.
// Las rutas de la Edge Function solo conocen la interfaz; la empresa elige el conector en su configuración.
import { calcularTotales, esBoleta, esExenta, TASA_IVA } from './totales.ts';
import { rutSii } from './rut.ts';
import type { DatosDte, Emisor, ReferenciaDte } from './dte.ts';

/** Lo que el usuario pide emitir (el folio lo asigna el conector). */
export type SolicitudDte = Omit<DatosDte, 'folio'>;

export interface ResultadoEmision {
  folio: number;
  estado: 'firmado' | 'enviado';
  trackId?: string;
  xml?: string;
  ted?: string;
  /** Identificador del documento en el proveedor, si lo hay. */
  idExterno?: string;
  totales: { neto: number; exento: number; iva: number; total: number };
}

export interface ConectorDte {
  readonly nombre: string;
  emitir(s: SolicitudDte, opciones?: { enviar?: boolean }): Promise<ResultadoEmision>;
}

export class ErrorConector extends Error {
  constructor(msg: string, public detalle?: unknown) {
    super(msg);
  }
}

// ---------------------------------------------------------------------------
// Estructura JSON equivalente al XML del SII (la usan los proveedores)

export function estructuraSii(s: SolicitudDte, folio?: number) {
  const t = calcularTotales(s);
  const boleta = esBoleta(s.tipo);
  const e: Emisor = s.emisor;
  const IdDoc: Record<string, unknown> = { TipoDTE: s.tipo, FchEmis: s.fechaEmision };
  if (folio) IdDoc.Folio = folio;
  if (boleta) IdDoc.IndServicio = 3;
  if (!boleta && s.formaPago) IdDoc.FmaPago = s.formaPago;
  if (!boleta && s.fechaVencimiento) IdDoc.FchVenc = s.fechaVencimiento;
  if (s.tipo === 52) IdDoc.IndTraslado = s.indTraslado ?? 1;

  const Emisor = boleta
    ? { RUTEmisor: rutSii(e.rut), RznSocEmisor: e.razonSocial, GiroEmisor: e.giro, DirOrigen: e.direccion, CmnaOrigen: e.comuna }
    : {
      RUTEmisor: rutSii(e.rut),
      RznSoc: e.razonSocial,
      GiroEmis: e.giro,
      Acteco: e.actecos.slice(0, 4),
      DirOrigen: e.direccion,
      CmnaOrigen: e.comuna,
      ...(e.ciudad ? { CiudadOrigen: e.ciudad } : {}),
      ...(e.codigoSucursal ? { CdgSIISucur: e.codigoSucursal } : {}),
    };
  const r = s.receptor;
  const Receptor: Record<string, unknown> = { RUTRecep: rutSii(r.rut), RznSocRecep: r.razonSocial || 'Consumidor final' };
  if (r.giro) Receptor.GiroRecep = r.giro;
  if (r.direccion) Receptor.DirRecep = r.direccion;
  if (r.comuna) Receptor.CmnaRecep = r.comuna;
  if (r.ciudad) Receptor.CiudadRecep = r.ciudad;
  if (r.correo) Receptor.CorreoRecep = r.correo;

  const Totales: Record<string, number> = { MntTotal: t.total };
  if (t.neto) Totales.MntNeto = t.neto;
  if (t.exento) Totales.MntExe = t.exento;
  if (t.neto && !esExenta(s.tipo)) {
    Totales.IVA = t.iva;
    if (!boleta) Totales.TasaIVA = TASA_IVA;
  }

  const Detalle = s.items.map((it, i) => {
    const d: Record<string, unknown> = {
      NroLinDet: i + 1,
      NmbItem: it.nombre.slice(0, 80),
      QtyItem: it.cantidad,
      PrcItem: it.precio,
      MontoItem: t.lineas[i].montoItem,
    };
    if (it.descripcion) d.DscItem = it.descripcion.slice(0, 1000);
    if (it.unidad) d.UnmdItem = it.unidad.slice(0, 4);
    if (it.exento && !esExenta(s.tipo)) d.IndExe = 1;
    if (it.descuentoPct) {
      d.DescuentoPct = it.descuentoPct;
      d.DescuentoMonto = t.lineas[i].descuentoMonto;
    }
    return d;
  });

  const Referencia = (s.referencias ?? []).map((ref: ReferenciaDte, i: number) => ({
    NroLinRef: i + 1,
    TpoDocRef: String(ref.tipoDoc),
    FolioRef: String(ref.folio),
    FchRef: ref.fecha,
    ...(ref.codigo ? { CodRef: ref.codigo } : {}),
    ...(ref.razon ? { RazonRef: ref.razon.slice(0, 90) } : {}),
  }));

  return {
    totales: { neto: t.neto, exento: t.exento, iva: t.iva, total: t.total },
    dte: { Encabezado: { IdDoc, Emisor, Receptor, Totales }, Detalle, ...(Referencia.length ? { Referencia } : {}) },
  };
}

async function leerJson(r: Response) {
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    return { texto: txt.slice(0, 800) };
  }
}

// ---------------------------------------------------------------------------
// OpenFactura (Haulmer): POST /v2/dte/document con la clave en la cabecera "apikey"

export class ConectorOpenFactura implements ConectorDte {
  readonly nombre = 'openfactura';
  constructor(
    private apiKey: string,
    private base = 'https://api.haulmer.com',
    private fetchFn: typeof fetch = fetch,
  ) {}

  async emitir(s: SolicitudDte): Promise<ResultadoEmision> {
    const { dte, totales } = estructuraSii(s);
    const r = await this.fetchFn(`${this.base.replace(/\/$/, '')}/v2/dte/document`, {
      method: 'POST',
      headers: { apikey: this.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ response: ['FOLIO', 'TIMBRE', 'XML'], dte }),
    });
    const j = await leerJson(r);
    if (!r.ok || !j?.FOLIO) {
      throw new ErrorConector(`OpenFactura rechazó el documento (HTTP ${r.status})`, j?.error ?? j);
    }
    return {
      folio: Number(j.FOLIO),
      estado: 'enviado',
      xml: j.XML ? atob(j.XML) : undefined,
      ted: j.TIMBRE,
      idExterno: j.TOKEN,
      totales,
    };
  }
}

// ---------------------------------------------------------------------------
// LibreDTE: emite un temporal y luego lo genera (folio, firma y envío al SII). Autenticación básica con el hash del usuario.

export class ConectorLibreDte implements ConectorDte {
  readonly nombre = 'libredte';
  constructor(
    private hash: string,
    private base = 'https://libredte.cl',
    private fetchFn: typeof fetch = fetch,
  ) {}

  private headers() {
    return { Authorization: `Basic ${btoa(`${this.hash}:X`)}`, 'Content-Type': 'application/json' };
  }

  async emitir(s: SolicitudDte): Promise<ResultadoEmision> {
    const { dte, totales } = estructuraSii(s);
    const base = this.base.replace(/\/$/, '');
    const r1 = await this.fetchFn(`${base}/api/dte/documentos/emitir?normalizar=1&formato=json&links=0&email=0`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(dte),
    });
    const tmp = await leerJson(r1);
    if (!r1.ok || !tmp?.codigo) throw new ErrorConector(`LibreDTE rechazó el documento (HTTP ${r1.status})`, tmp);
    const r2 = await this.fetchFn(`${base}/api/dte/documentos/generar?getXML=1&links=0&email=0`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ emisor: tmp.emisor, receptor: tmp.receptor, dte: tmp.dte, codigo: tmp.codigo }),
    });
    const real = await leerJson(r2);
    if (!r2.ok || !real?.folio) throw new ErrorConector(`LibreDTE no pudo generar el documento (HTTP ${r2.status})`, real);
    return {
      folio: Number(real.folio),
      estado: real.track_id ? 'enviado' : 'firmado',
      trackId: real.track_id ? String(real.track_id) : undefined,
      xml: real.xml ? atob(real.xml) : undefined,
      idExterno: `${real.dte}-${real.folio}`,
      totales,
    };
  }
}

// ---------------------------------------------------------------------------
// Directo al SII: el folio, el timbre y la firma se resuelven con funciones inyectadas (ver rutas/dte-emitir.ts)

export interface DependenciasDirecto {
  reservarFolio(tipo: number): Promise<number>;
  firmar(d: DatosDte): { xml: string; ted: string; totales: { neto: number; exento: number; iva: number; total: number } };
  enviar(firmado: { xml: string; tipo: number; folio: number }): Promise<string>;
}

export class ConectorDirecto implements ConectorDte {
  readonly nombre = 'directo';
  constructor(private deps: DependenciasDirecto) {}

  async emitir(s: SolicitudDte, opciones: { enviar?: boolean } = {}): Promise<ResultadoEmision> {
    const folio = await this.deps.reservarFolio(s.tipo);
    const firmado = this.deps.firmar({ ...s, folio });
    const base = { folio, xml: firmado.xml, ted: firmado.ted, totales: firmado.totales };
    if (opciones.enviar === false) return { ...base, estado: 'firmado' };
    const trackId = await this.deps.enviar({ xml: firmado.xml, tipo: s.tipo, folio });
    return { ...base, estado: 'enviado', trackId };
  }
}

export const PROVEEDORES = {
  openfactura: { nombre: 'OpenFactura', base: 'https://api.haulmer.com', baseCertificacion: 'https://dev-api.haulmer.com' },
  libredte: { nombre: 'LibreDTE', base: 'https://libredte.cl', baseCertificacion: 'https://libredte.cl' },
} as const;

export function crearConectorProveedor(
  proveedor: keyof typeof PROVEEDORES,
  apiKey: string,
  opciones: { url?: string | null; ambiente?: 'certificacion' | 'produccion'; fetchFn?: typeof fetch } = {},
): ConectorDte {
  const p = PROVEEDORES[proveedor];
  if (!p) throw new ErrorConector(`Proveedor desconocido: ${proveedor}`);
  const base = opciones.url || (opciones.ambiente === 'produccion' ? p.base : p.baseCertificacion);
  return proveedor === 'openfactura'
    ? new ConectorOpenFactura(apiKey, base, opciones.fetchFn)
    : new ConectorLibreDte(apiKey, base, opciones.fetchFn);
}
