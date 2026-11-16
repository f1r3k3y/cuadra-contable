// DTE firmado, sobres de envío (EnvioDTE / EnvioBOLETA) y documentos de intercambio.
import { el, opt, raw, c14n, textoSii, NS_SII, NS_XSI, DECL_LATIN1, type XNode } from './xml.ts';
import { firmar } from './firma.ts';
import { construirDocumento, timestampSii, type DatosDte, type Totales } from './dte.ts';
import { rutSii } from './rut.ts';
import type { Certificado } from './cripto.ts';
import type { Caf } from './caf.ts';

export const RUT_SII = '60803000-K';

export interface DteFirmado {
  id: string;
  tipo: number;
  folio: number;
  /** <DTE xmlns="http://www.sii.cl/SiiDte" ...> canónico, sin declaración XML. */
  xml: string;
  totales: Totales;
  ted: string;
}

export function firmarDte(d: DatosDte, caf: Caf, cert: Certificado, ahora = new Date()): DteFirmado {
  const doc = construirDocumento(d, caf, ahora);
  const signature = firmar(doc.documento, cert, { uri: doc.id, nsElemento: { '': NS_SII } });
  const dte = el('DTE', { xmlns: NS_SII, version: '1.0' }, doc.documento, signature);
  return { id: doc.id, tipo: d.tipo, folio: d.folio, xml: c14n(dte), totales: doc.totales, ted: doc.ted };
}

/** Quita la declaración de namespace redundante del <DTE> cuando va dentro de un sobre SII. */
function dteParaSobre(xml: string): string {
  return xml.replace(/^<DTE xmlns="http:\/\/www\.sii\.cl\/SiiDte" /, '<DTE ');
}

export interface DatosCaratula {
  rutEmisor: string;
  rutEnvia: string; // RUT de la persona titular del certificado
  rutReceptor?: string; // por defecto el SII
  fechaResolucion: string;
  numeroResolucion: number; // 0 en ambiente de certificación
}

export function construirSobre(
  dtes: { xml: string; tipo: number }[],
  car: DatosCaratula,
  cert: Certificado,
  opciones: { boleta?: boolean; idSet?: string; ahora?: Date } = {},
): string {
  const raiz = opciones.boleta ? 'EnvioBOLETA' : 'EnvioDTE';
  const xsd = opciones.boleta ? 'EnvioBOLETA_v11.xsd' : 'EnvioDTE_v10.xsd';
  const idSet = opciones.idSet ?? `SetDoc${Date.now()}`;
  const conteo = new Map<number, number>();
  for (const d of dtes) conteo.set(d.tipo, (conteo.get(d.tipo) ?? 0) + 1);
  const caratula = el(
    'Caratula',
    { version: '1.0' },
    el('RutEmisor', {}, rutSii(car.rutEmisor)),
    el('RutEnvia', {}, rutSii(car.rutEnvia)),
    el('RutReceptor', {}, rutSii(car.rutReceptor ?? RUT_SII)),
    el('FchResol', {}, car.fechaResolucion),
    el('NroResol', {}, car.numeroResolucion),
    el('TmstFirmaEnv', {}, timestampSii(opciones.ahora)),
    ...[...conteo.entries()]
      .sort(([a], [b]) => a - b)
      .map(([tipo, n]) => el('SubTotDTE', {}, el('TpoDTE', {}, tipo), el('NroDTE', {}, n))),
  );
  const setDte = el('SetDTE', { ID: idSet }, caratula, ...dtes.map((d) => raw(dteParaSobre(d.xml))));
  const nsRaiz = { '': NS_SII, xsi: NS_XSI };
  const signature = firmar(setDte, cert, { uri: idSet, nsElemento: nsRaiz, nsFirma: nsRaiz });
  const sobre = el(
    raiz,
    { xmlns: NS_SII, 'xmlns:xsi': NS_XSI, 'xsi:schemaLocation': `${NS_SII} ${xsd}`, version: '1.0' },
    setDte,
    signature,
  );
  return DECL_LATIN1 + c14n(sobre);
}

/** XML firmado para obtener el token del SII a partir de la semilla. */
export function construirSolicitudToken(semilla: string, cert: Certificado): string {
  const item = el('item', {}, el('Semilla', {}, semilla));
  const sinFirma = el('getToken', {}, item);
  const signature = firmar(sinFirma, cert, { uri: '' });
  return c14n(el('getToken', {}, item, signature));
}

// ---------------------------------------------------------------------------
// Intercambio entre contribuyentes (recepción de DTE de proveedores)

export interface DteRecibidoResumen {
  tipo: number;
  folio: number;
  fechaEmision: string;
  rutEmisor: string;
  rutReceptor: string;
  montoTotal: number;
}

export type EstadoRecepcion = 0 | 1 | 2 | 3; // 0 OK, 1 error schema, 2 error firma, 3 RUT receptor no corresponde

/** RespuestaDTE: acuse de recepción del envío y resultado comercial de cada DTE. */
export function construirRespuestaDte(
  p: {
    rutResponde: string;
    rutRecibe: string;
    idRespuesta: number;
    nombreContacto?: string;
    correoContacto?: string;
    recepcion?: { nombreArchivo: string; digestEnvio: string; rutEmisor: string; rutReceptor: string; estado: EstadoRecepcion; glosa: string; dtes: (DteRecibidoResumen & { estado: number; glosa: string })[] };
    resultados?: (DteRecibidoResumen & { estado: 0 | 1 | 2; glosa: string })[];
  },
  cert: Certificado,
  ahora = new Date(),
): string {
  const id = `RESP${p.idRespuesta}`;
  const caratula = el(
    'Caratula',
    { version: '1.0' },
    el('RutResponde', {}, rutSii(p.rutResponde)),
    el('RutRecibe', {}, rutSii(p.rutRecibe)),
    el('IdRespuesta', {}, p.idRespuesta),
    el('NroDetalles', {}, p.recepcion ? 1 : p.resultados?.length ?? 0),
    opt('NmbContacto', textoSii(p.nombreContacto, 40)),
    opt('MailContacto', textoSii(p.correoContacto, 80)),
    el('TmstFirmaResp', {}, timestampSii(ahora)),
  );
  const cuerpo: XNode[] = [];
  if (p.recepcion) {
    const r = p.recepcion;
    cuerpo.push(
      el(
        'RecepcionEnvio',
        {},
        el('NmbEnvio', {}, textoSii(r.nombreArchivo, 80)),
        el('FchRecep', {}, timestampSii(ahora)),
        el('CodEnvio', {}, p.idRespuesta),
        el('EnvioDTEID', {}, 'SetDoc'),
        el('Digest', {}, r.digestEnvio),
        el('RutEmisor', {}, rutSii(r.rutEmisor)),
        el('RutReceptor', {}, rutSii(r.rutReceptor)),
        el('EstadoRecepEnv', {}, r.estado),
        el('RecepEnvGlosa', {}, textoSii(r.glosa, 256)),
        el('NroDTE', {}, r.dtes.length),
        ...r.dtes.map((d) =>
          el(
            'RecepcionDTE',
            {},
            el('TipoDTE', {}, d.tipo),
            el('Folio', {}, d.folio),
            el('FchEmis', {}, d.fechaEmision),
            el('RUTEmisor', {}, rutSii(d.rutEmisor)),
            el('RUTRecep', {}, rutSii(d.rutReceptor)),
            el('MntTotal', {}, d.montoTotal),
            el('EstadoRecepDTE', {}, d.estado),
            el('RecepDTEGlosa', {}, textoSii(d.glosa, 256)),
          ),
        ),
      ),
    );
  }
  for (const [i, d] of (p.resultados ?? []).entries()) {
    cuerpo.push(
      el(
        'ResultadoDTE',
        {},
        el('TipoDTE', {}, d.tipo),
        el('Folio', {}, d.folio),
        el('FchEmis', {}, d.fechaEmision),
        el('RUTEmisor', {}, rutSii(d.rutEmisor)),
        el('RUTRecep', {}, rutSii(d.rutReceptor)),
        el('MntTotal', {}, d.montoTotal),
        el('CodEnvio', {}, p.idRespuesta * 100 + i + 1),
        el('EstadoDTE', {}, d.estado),
        el('EstadoDTEGlosa', {}, textoSii(d.glosa, 256)),
      ),
    );
  }
  const resultado = el('Resultado', { ID: id }, caratula, ...cuerpo);
  const nsRaiz = { '': NS_SII, xsi: NS_XSI };
  const signature = firmar(resultado, cert, { uri: id, nsElemento: nsRaiz, nsFirma: nsRaiz });
  return (
    DECL_LATIN1 +
    c14n(
      el(
        'RespuestaDTE',
        { xmlns: NS_SII, 'xmlns:xsi': NS_XSI, 'xsi:schemaLocation': `${NS_SII} RespuestaEnvioDTE_v10.xsd`, version: '1.0' },
        resultado,
        signature,
      ),
    )
  );
}

/** EnvioRecibos: acuse de recibo de mercaderías o servicios (Ley 19.983). */
export function construirEnvioRecibos(
  p: { rutResponde: string; rutRecibe: string; recinto: string; rutFirma: string; dtes: DteRecibidoResumen[] },
  cert: Certificado,
  ahora = new Date(),
): string {
  const DECLARACION =
    'El acuse de recibo que se declara en este acto, de acuerdo a lo dispuesto en la letra b) del Art. 4, y la letra c) del Art. 5 de la Ley 19.983, acredita que la entrega de mercaderias o servicio(s) prestado(s) ha(n) sido recibido(s).';
  const ts = timestampSii(ahora);
  const recibos = p.dtes.map((d, i) => {
    const id = `R${i + 1}T${d.tipo}F${d.folio}`;
    const doc = el(
      'DocumentoRecibo',
      { ID: id },
      el('TipoDoc', {}, d.tipo),
      el('Folio', {}, d.folio),
      el('FchEmis', {}, d.fechaEmision),
      el('RUTEmisor', {}, rutSii(d.rutEmisor)),
      el('RUTRecep', {}, rutSii(d.rutReceptor)),
      el('MntTotal', {}, d.montoTotal),
      el('Recinto', {}, textoSii(p.recinto, 80)),
      el('RutFirma', {}, rutSii(p.rutFirma)),
      el('Declaracion', {}, DECLARACION),
      el('TmstFirmaRecibo', {}, ts),
    );
    const sig = firmar(doc, cert, { uri: id, nsElemento: { '': NS_SII } });
    return raw(c14n(el('Recibo', { xmlns: NS_SII, version: '1.0' }, doc, sig)).replace(/^<Recibo xmlns="http:\/\/www\.sii\.cl\/SiiDte" /, '<Recibo '));
  });
  const caratula = el(
    'Caratula',
    { version: '1.0' },
    el('RutResponde', {}, rutSii(p.rutResponde)),
    el('RutRecibe', {}, rutSii(p.rutRecibe)),
    el('TmstFirmaEnv', {}, ts),
  );
  const set = el('SetRecibos', { ID: 'SetRecibos' }, caratula, ...recibos);
  const nsRaiz = { '': NS_SII, xsi: NS_XSI };
  const signature = firmar(set, cert, { uri: 'SetRecibos', nsElemento: nsRaiz, nsFirma: nsRaiz });
  return (
    DECL_LATIN1 +
    c14n(
      el(
        'EnvioRecibos',
        { xmlns: NS_SII, 'xmlns:xsi': NS_XSI, 'xsi:schemaLocation': `${NS_SII} EnvioRecibos_v10.xsd`, version: '1.0' },
        set,
        signature,
      ),
    )
  );
}
