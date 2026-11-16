// Cliente de servicios web del SII. Agnóstico de runtime (usa fetch).
// Ambientes: "certificacion" (maullin) y "produccion" (palena).
import { construirSolicitudToken } from './envio.ts';
import { partesRut } from './rut.ts';
import { bytesLatin1 } from './xml.ts';
import type { Certificado } from './cripto.ts';

export type Ambiente = 'certificacion' | 'produccion';

export const ENDPOINTS = {
  certificacion: {
    host: 'https://maullin.sii.cl',
    reclamo: 'https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice',
    boletaApi: 'https://apicert.sii.cl/recursos/v1',
    boletaEnvio: 'https://pangal.sii.cl/recursos/v1/boleta.electronica.envio',
  },
  produccion: {
    host: 'https://palena.sii.cl',
    reclamo: 'https://ws1.sii.cl/WSREGISTRORECLAMODTE/registroreclamodteservice',
    boletaApi: 'https://api.sii.cl/recursos/v1',
    boletaEnvio: 'https://rahue.sii.cl/recursos/v1/boleta.electronica.envio',
  },
} as const;

export const RCV_URL = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';

const UA = 'Mozilla/4.0 (compatible; PROG 1.0; Windows NT 5.0; YComp 5.0.2.4)';

function soap(metodo: string, params: Record<string, string>): string {
  const cuerpo = Object.entries(params)
    .map(([k, v]) => `<${k}>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${k}>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><${metodo}>${cuerpo}</${metodo}></soapenv:Body></soapenv:Envelope>`;
}

function desescapar(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function campo(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
  return m?.[1]?.trim();
}

export class SiiError extends Error {
  constructor(msg: string, public detalle?: string) {
    super(msg);
  }
}

export class ClienteSii {
  private token?: { valor: string; obtenido: number };

  constructor(
    public ambiente: Ambiente,
    private cert: Certificado,
    private fetchFn: typeof fetch = fetch,
  ) {}

  get host() {
    return ENDPOINTS[this.ambiente].host;
  }

  private async llamarSoap(ruta: string, metodo: string, params: Record<string, string>): Promise<string> {
    const r = await this.fetchFn(`${this.host}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: soap(metodo, params),
    });
    const txt = await r.text();
    if (!r.ok) throw new SiiError(`SII respondió HTTP ${r.status} en ${metodo}`, txt.slice(0, 500));
    return desescapar(txt);
  }

  async obtenerSemilla(): Promise<string> {
    const xml = await this.llamarSoap('/DTEWS/CrSeed.jws', 'getSeed', {});
    const estado = campo(xml, 'ESTADO');
    const semilla = campo(xml, 'SEMILLA');
    if (estado !== '00' || !semilla) throw new SiiError('No se pudo obtener la semilla del SII', xml.slice(0, 500));
    return semilla;
  }

  /** Token de sesión (válido ~1 hora; se renueva a los 50 minutos). */
  async obtenerToken(): Promise<string> {
    if (this.token && Date.now() - this.token.obtenido < 50 * 60 * 1000) return this.token.valor;
    const semilla = await this.obtenerSemilla();
    const firmado = construirSolicitudToken(semilla, this.cert);
    const xml = await this.llamarSoap('/DTEWS/GetTokenFromSeed.jws', 'getToken', { pszXml: firmado });
    const estado = campo(xml, 'ESTADO');
    const token = campo(xml, 'TOKEN');
    if (estado !== '00' || !token) throw new SiiError(`El SII rechazó la autenticación (estado ${estado})`, xml.slice(0, 500));
    this.token = { valor: token, obtenido: Date.now() };
    return token;
  }

  /** Sube un EnvioDTE. Devuelve el Track ID. */
  async enviarDte(sobreXml: string, rutEmisor: string, rutEnvia: string, nombreArchivo = 'envio.xml'): Promise<string> {
    const token = await this.obtenerToken();
    const e = partesRut(rutEmisor);
    const s = partesRut(rutEnvia);
    const form = new FormData();
    form.append('rutSender', s.cuerpo);
    form.append('dvSender', s.dv);
    form.append('rutCompany', e.cuerpo);
    form.append('dvCompany', e.dv);
    form.append('archivo', new Blob([bytesLatin1(sobreXml)], { type: 'text/xml' }), nombreArchivo);
    const r = await this.fetchFn(`${this.host}/cgi_dte/UPL/DTEUpload`, {
      method: 'POST',
      headers: { Cookie: `TOKEN=${token}`, 'User-Agent': UA, Accept: '*/*' },
      body: form,
    });
    const txt = await r.text();
    const status = campo(txt, 'STATUS');
    const track = campo(txt, 'TRACKID');
    if (status !== '0' || !track) throw new SiiError(`Envío rechazado por el SII (STATUS ${status ?? '?'})`, txt.slice(0, 800));
    return track;
  }

  /** Boletas (39/41): API REST del SII, con su propio token. Devuelve el Track ID. */
  async enviarBoleta(sobreXml: string, rutEmisor: string, rutEnvia: string): Promise<string> {
    const ep = ENDPOINTS[this.ambiente];
    const rs = await this.fetchFn(`${ep.boletaApi}/boleta.electronica.semilla`, { headers: { Accept: 'application/xml' } });
    const semilla = campo(await rs.text(), 'SEMILLA');
    if (!semilla) throw new SiiError('No se pudo obtener la semilla de boletas');
    const rt = await this.fetchFn(`${ep.boletaApi}/boleta.electronica.token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body: `<?xml version="1.0" encoding="UTF-8"?>${construirSolicitudToken(semilla, this.cert)}`,
    });
    const token = campo(await rt.text(), 'TOKEN');
    if (!token) throw new SiiError('El SII rechazó la autenticación de boletas');
    const e = partesRut(rutEmisor);
    const s = partesRut(rutEnvia);
    const form = new FormData();
    form.append('rutSender', s.cuerpo);
    form.append('dvSender', s.dv);
    form.append('rutCompany', e.cuerpo);
    form.append('dvCompany', e.dv);
    form.append('archivo', new Blob([bytesLatin1(sobreXml)], { type: 'text/xml' }), 'boletas.xml');
    const r = await this.fetchFn(ep.boletaEnvio, {
      method: 'POST',
      headers: { Cookie: `TOKEN=${token}`, 'User-Agent': UA, Accept: 'application/json' },
      body: form,
    });
    const json = await r.json().catch(() => ({}));
    if (!json?.trackid) throw new SiiError('Envío de boletas rechazado', JSON.stringify(json).slice(0, 800));
    return String(json.trackid);
  }

  async estadoEnvio(rutEmisor: string, trackId: string): Promise<{ estado: string; glosa: string; aceptados?: number; rechazados?: number; reparos?: number; raw: string }> {
    const token = await this.obtenerToken();
    const e = partesRut(rutEmisor);
    const xml = await this.llamarSoap('/DTEWS/QueryEstUp.jws', 'getEstUp', {
      RutCompania: e.cuerpo,
      DvCompania: e.dv,
      TrackId: trackId,
      Token: token,
    });
    return {
      estado: campo(xml, 'ESTADO') ?? '?',
      glosa: campo(xml, 'GLOSA') ?? '',
      aceptados: Number(campo(xml, 'ACEPTADOS') ?? NaN) || undefined,
      rechazados: Number(campo(xml, 'RECHAZADOS') ?? NaN) || undefined,
      reparos: Number(campo(xml, 'REPAROS') ?? NaN) || undefined,
      raw: xml.slice(0, 4000),
    };
  }

  async estadoDte(p: { rutConsultante: string; rutEmisor: string; rutReceptor: string; tipo: number; folio: number; fechaEmision: string; monto: number }) {
    const token = await this.obtenerToken();
    const c = partesRut(p.rutConsultante);
    const e = partesRut(p.rutEmisor);
    const r = partesRut(p.rutReceptor);
    const [a, m, d] = p.fechaEmision.split('-');
    const xml = await this.llamarSoap('/DTEWS/QueryEstDte.jws', 'getEstDte', {
      RutConsultante: c.cuerpo,
      DvConsultante: c.dv,
      RutCompania: e.cuerpo,
      DvCompania: e.dv,
      RutReceptor: r.cuerpo,
      DvReceptor: r.dv,
      TipoDte: String(p.tipo),
      FolioDte: String(p.folio),
      FechaEmisionDte: `${d}${m}${a}`,
      MontoDte: String(p.monto),
      Token: token,
    });
    return { estado: campo(xml, 'ESTADO') ?? '?', glosa: campo(xml, 'GLOSA_ESTADO') ?? campo(xml, 'GLOSA') ?? '', raw: xml.slice(0, 4000) };
  }

  /**
   * Registro de aceptación o reclamo (Ley 19.983).
   * ACD acepta contenido, RCD reclamo al contenido, ERM otorga recibo de mercaderías,
   * RFP reclamo por falta parcial, RFT reclamo por falta total.
   */
  async registrarAceptacionReclamo(rutEmisor: string, tipo: number, folio: number, accion: 'ACD' | 'RCD' | 'ERM' | 'RFP' | 'RFT') {
    const token = await this.obtenerToken();
    const e = partesRut(rutEmisor);
    const url = ENDPOINTS[this.ambiente].reclamo;
    const body = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://ws.registroreclamodte.diii.sdi.sii.cl"><soapenv:Body><ws:ingresarAceptacionReclamoDoc><rutEmisor>${e.cuerpo}</rutEmisor><dvEmisor>${e.dv}</dvEmisor><tipoDoc>${tipo}</tipoDoc><folio>${folio}</folio><accionDoc>${accion}</accionDoc></ws:ingresarAceptacionReclamoDoc></soapenv:Body></soapenv:Envelope>`;
    const r = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '', Cookie: `TOKEN=${token}` },
      body,
    });
    const txt = await r.text();
    return { codigo: campo(txt, 'codResp') ?? '?', descripcion: campo(txt, 'descResp') ?? '', raw: txt.slice(0, 2000) };
  }

  /**
   * Detalle del Registro de Compras y Ventas. Solo existe en producción y usa el mismo
   * servicio que la consulta web del SII; si falla, la app permite importar el CSV.
   */
  async rcvDetalle(rutEmpresa: string, periodo: string, operacion: 'COMPRA' | 'VENTA', codTipoDoc: number, estado: 'REGISTRO' | 'PENDIENTE' | 'NO_INCLUIR' | 'RECLAMADO' = 'REGISTRO') {
    const token = await this.obtenerToken();
    const e = partesRut(rutEmpresa);
    const metodo = operacion === 'COMPRA' ? 'getDetalleCompra' : 'getDetalleVenta';
    const r = await this.fetchFn(`${RCV_URL}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `TOKEN=${token}` },
      body: JSON.stringify({
        metaData: { namespace: `cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/${metodo}`, conversationId: token, transactionId: crypto.randomUUID(), page: null },
        data: { rutEmisor: e.cuerpo, dvEmisor: e.dv, ptributario: periodo, codTipoDoc: String(codTipoDoc), operacion, estadoContab: estado },
      }),
    });
    if (!r.ok) throw new SiiError(`RCV respondió HTTP ${r.status}`);
    const json = await r.json();
    return (json?.data ?? []) as Record<string, unknown>[];
  }
}
