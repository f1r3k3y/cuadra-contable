import { describe, it, expect, beforeAll } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import forge from 'node-forge';
import * as sii from '../supabase/functions/_shared/sii/mod.ts';
import { certificadoPrueba, cafPrueba } from './fixtures.ts';

const RUT_EMISOR = '76192083-9';
let cert: sii.Certificado;
let caf: sii.Caf;
let cafSiiPem: string;

const datos = (folio = 1): sii.DatosDte => ({
  tipo: 33,
  folio,
  fechaEmision: '2026-11-16',
  formaPago: 1,
  emisor: {
    rut: '76.192.083-9',
    razonSocial: 'Empresa de Prueba SpA',
    giro: 'Servicios informáticos',
    actecos: [620200],
    direccion: 'Av. Providencia 1234',
    comuna: 'Providencia',
    ciudad: 'Santiago',
  },
  receptor: { rut: '96.790.240-3', razonSocial: 'Cliente & Compañía Ltda.', giro: 'Comercio', direccion: 'Calle 1', comuna: 'Ñuñoa' },
  items: [
    { nombre: 'Servicio de soporte mensual', cantidad: 1, precio: 100000 },
    { nombre: 'Horas adicionales', cantidad: 2.5, precio: 15000, descuentoPct: 10 },
    { nombre: 'Capacitación exenta', cantidad: 1, precio: 50000, exento: true },
  ],
});

function verificarFirmaXml(xml: string, signatureIndex: number): boolean {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const firmas = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  const firma = firmas[signatureIndex];
  const x509 = firma.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')[0].textContent!;
  const pem = `-----BEGIN CERTIFICATE-----\n${x509.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
  const sx = new SignedXml({ publicCert: pem });
  sx.loadSignature(firma as never);
  try {
    return sx.checkSignature(xml);
  } catch {
    return false;
  }
}

beforeAll(() => {
  const c = certificadoPrueba();
  cert = sii.leerCertificado(c.pfx, c.clave);
  const f = cafPrueba({ rut: RUT_EMISOR, tipo: 33, desde: 1, hasta: 100 });
  caf = sii.leerCaf(f.xml);
  cafSiiPem = f.siiPublicPem;
});

describe('RUT', () => {
  it('valida y formatea', () => {
    expect(sii.validarRut('76.192.083-9')).toBe(true);
    expect(sii.validarRut('76.192.083-8')).toBe(false);
    expect(sii.validarRut('60803000-K')).toBe(true);
    expect(sii.rutSii('76.192.083-9')).toBe('76192083-9');
    expect(sii.formatearRut('761920839')).toBe('76.192.083-9');
    expect(sii.calcularDv(96790240)).toBe('3');
  });
});

describe('Certificado y CAF', () => {
  it('lee el PFX', () => {
    expect(cert.nombreTitular).toBe('Persona de Prueba');
    expect(cert.certB64.length).toBeGreaterThan(100);
  });
  it('lee el CAF y verifica la firma del SII', () => {
    expect(caf.tipoDte).toBe(33);
    expect(caf.hasta).toBe(100);
    expect(caf.bloqueCaf).not.toMatch(/>\s+</);
    expect(sii.verificarFirmaSii(caf, cafSiiPem)).toBe(true);
  });
});

describe('Totales', () => {
  it('calcula neto, exento e IVA con descuentos', () => {
    const t = sii.calcularTotales(datos());
    // 100000 + (37500 - 3750 = 33750) = 133750 neto
    expect(t.neto).toBe(133750);
    expect(t.exento).toBe(50000);
    expect(t.iva).toBe(25413); // 133750 * 0.19 = 25412.5 -> 25413
    expect(t.total).toBe(209163);
  });
  it('desglosa IVA en boletas', () => {
    const t = sii.calcularTotales({ tipo: 39, items: [{ nombre: 'Café', cantidad: 2, precio: 2500 }] });
    expect(t.total).toBe(5000);
    expect(t.neto + t.iva).toBe(5000);
    expect(t.neto).toBe(4202);
  });
});

describe('DTE', () => {
  it('genera un TED con firma válida del CAF', () => {
    const d = sii.firmarDte(datos(5), caf, cert);
    const dd = d.ted.match(/<DD>[\s\S]*<\/DD>/)![0];
    const frmt = d.ted.match(/<FRMT[^>]*>([^<]+)<\/FRMT>/)![1];
    expect(sii.verificarLatin1(caf.publicKey, sii.aLatin1(dd), frmt)).toBe(true);
    expect(dd).toContain('<RSR>Cliente &amp; Compañía Ltda.</RSR>');
    expect(dd).toContain('<MNT>209163</MNT>');
  });

  it('firma el DTE y la firma verifica con un validador XMLDSig independiente', () => {
    const d = sii.firmarDte(datos(6), caf, cert);
    expect(d.xml.startsWith('<DTE xmlns="http://www.sii.cl/SiiDte" version="1.0"><Documento ID="T33F6">')).toBe(true);
    expect(verificarFirmaXml(d.xml, 0)).toBe(true);
  });

  it('detecta una alteración del documento', () => {
    const d = sii.firmarDte(datos(7), caf, cert);
    const alterado = d.xml.replace('<MntTotal>209163</MntTotal>', '<MntTotal>1</MntTotal>');
    expect(verificarFirmaXml(alterado, 0)).toBe(false);
  });

  it('rechaza folios fuera de rango y NC sin referencia', () => {
    expect(() => sii.firmarDte(datos(500), caf, cert)).toThrow(/fuera del rango/);
    expect(() => sii.firmarDte({ ...datos(1), tipo: 61 }, caf, cert)).toThrow(/referencia|CAF/);
  });
});

describe('Sobre EnvioDTE', () => {
  it('firma el SetDTE en el contexto del sobre y ambas firmas verifican', () => {
    const d1 = sii.firmarDte(datos(10), caf, cert);
    const d2 = sii.firmarDte(datos(11), caf, cert);
    const sobre = sii.construirSobre([d1, d2], { rutEmisor: RUT_EMISOR, rutEnvia: '11111111-1', fechaResolucion: '2026-01-01', numeroResolucion: 0 }, cert, { idSet: 'SetDoc1' });
    expect(sobre.startsWith('<?xml version="1.0" encoding="ISO-8859-1"?>')).toBe(true);
    expect(sobre).toContain('<SubTotDTE><TpoDTE>33</TpoDTE><NroDTE>2</NroDTE></SubTotDTE>');
    const sinDecl = sobre.replace(/^<\?xml[^>]*>\n/, '');
    const n = new DOMParser().parseFromString(sinDecl, 'text/xml').getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature').length;
    expect(n).toBe(3);
    // firma del sobre (última)
    expect(verificarFirmaXml(sinDecl, 2)).toBe(true);
  });

  it('el receptor puede leer el sobre', () => {
    const d1 = sii.firmarDte(datos(12), caf, cert);
    const sobre = sii.construirSobre([d1], { rutEmisor: RUT_EMISOR, rutEnvia: '11111111-1', rutReceptor: '96790240-3', fechaResolucion: '2026-01-01', numeroResolucion: 0 }, cert);
    const leido = sii.leerSobre(sobre);
    expect(leido.rutReceptor).toBe('96790240-3');
    expect(leido.dtes).toHaveLength(1);
    expect(leido.dtes[0]).toMatchObject({ tipo: 33, folio: 12, total: 209163, iva: 25413, rutEmisor: RUT_EMISOR });
  });
});

describe('Token y respuestas de intercambio', () => {
  it('firma la solicitud de token (URI vacía, enveloped)', () => {
    const xml = sii.construirSolicitudToken('012345678901', cert);
    expect(xml).toContain('<Semilla>012345678901</Semilla>');
    expect(verificarFirmaXml(xml, 0)).toBe(true);
  });

  it('construye RespuestaDTE y EnvioRecibos firmados', () => {
    const dte = { tipo: 33, folio: 12, fechaEmision: '2026-11-16', rutEmisor: RUT_EMISOR, rutReceptor: '96790240-3', montoTotal: 209163 };
    const resp = sii.construirRespuestaDte({ rutResponde: '96790240-3', rutRecibe: RUT_EMISOR, idRespuesta: 1, resultados: [{ ...dte, estado: 0, glosa: 'ACEPTADO OK' }] }, cert);
    expect(verificarFirmaXml(resp.replace(/^<\?xml[^>]*>\n/, ''), 0)).toBe(true);
    const rec = sii.construirEnvioRecibos({ rutResponde: '96790240-3', rutRecibe: RUT_EMISOR, recinto: 'Bodega central', rutFirma: '11111111-1', dtes: [dte] }, cert);
    const recXml = rec.replace(/^<\?xml[^>]*>\n/, '');
    expect(verificarFirmaXml(recXml, 1)).toBe(true);
  });
});

describe('Cliente SII (con fetch simulado)', () => {
  it('obtiene semilla, token y sube el envío', async () => {
    const llamadas: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      llamadas.push(String(url));
      const esc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (String(url).includes('CrSeed'))
        return new Response(`<getSeedReturn>${esc('<SII:RESPUESTA><SII:RESP_BODY><SEMILLA>000123</SEMILLA></SII:RESP_BODY><SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR></SII:RESPUESTA>')}</getSeedReturn>`);
      if (String(url).includes('GetTokenFromSeed')) {
        expect(String(init.body)).toContain('&lt;Semilla>000123&lt;/Semilla>');
        return new Response(`<r>${esc('<SII:RESP_BODY><TOKEN>TKN42</TOKEN></SII:RESP_BODY><SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR>')}</r>`);
      }
      if (String(url).includes('DTEUpload')) {
        expect((init.headers as Record<string, string>).Cookie).toBe('TOKEN=TKN42');
        return new Response('<RECEPCIONDTE><STATUS>0</STATUS><TRACKID>987654</TRACKID></RECEPCIONDTE>');
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const cli = new sii.ClienteSii('certificacion', cert, fakeFetch);
    const track = await cli.enviarDte('<EnvioDTE/>', RUT_EMISOR, '11111111-1');
    expect(track).toBe('987654');
    expect(llamadas[0]).toBe('https://maullin.sii.cl/DTEWS/CrSeed.jws');
  });
});

describe('F29', () => {
  it('calcula débitos, créditos, remanente y PPM', () => {
    const r = sii.calcularF29({
      ventas: [
        { tipo: 33, cantidad: 10, neto: 1_000_000, exento: 0, iva: 190_000 },
        { tipo: 61, cantidad: 1, neto: 100_000, exento: 0, iva: 19_000 },
      ],
      compras: [{ tipo: 33, cantidad: 5, neto: 400_000, exento: 0, iva: 76_000 }],
      remanenteAnterior: 10_000,
      tasaPpm: 0.25,
    });
    const v = (c: number) => r.lineas.find((l) => l.codigo === c)?.valor;
    expect(v(538)).toBe(171_000);
    expect(v(537)).toBe(86_000);
    expect(v(89)).toBe(85_000);
    expect(v(563)).toBe(900_000);
    expect(v(62)).toBe(2_250);
    expect(r.totalAPagar).toBe(87_250);
  });
});

describe('RCV', () => {
  it('importa el CSV del SII y cuadra contra el libro', () => {
    const csv = 'Nro;Tipo Doc;Tipo Compra;RUT Proveedor;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Fecha Acuse;Monto Exento;Monto Neto;Monto IVA Recuperable;Monto Iva No Recuperable;Codigo IVA No Rec.;Monto Total\n1;33;Del Giro;96790240-3;PROVEEDOR UNO;100;05/11/2026;06/11/2026 10:00:00;;0;100000;19000;0;;119000\n2;33;Del Giro;76192083-9;PROVEEDOR DOS;55;07/11/2026;07/11/2026 11:00:00;;0;50000;9500;0;;59500';
    const rcv = sii.importarCsvRcv(csv, 'COMPRA');
    expect(rcv).toHaveLength(2);
    expect(rcv[0]).toMatchObject({ tipo: 33, folio: 100, fechaEmision: '2026-11-05', total: 119000 });
    const dif = sii.cuadrarRcv(rcv, [
      { tipo: 33, folio: 100, rutContraparte: '96790240-3', total: 119000, iva: 19000 },
      { tipo: 33, folio: 77, rutContraparte: '96790240-3', total: 1000, iva: 160 },
    ]);
    expect(dif.map((d) => d.motivo).sort()).toEqual(['solo_en_libro', 'solo_en_sii']);
  });
});

void forge;
