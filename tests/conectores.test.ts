import { describe, it, expect } from 'vitest';
import * as sii from '../supabase/functions/_shared/sii/mod.ts';

const solicitud = (tipo = 33): sii.SolicitudDte => ({
  tipo,
  fechaEmision: '2026-11-25',
  formaPago: 2,
  fechaVencimiento: '2026-12-25',
  emisor: { rut: '76.192.083-9', razonSocial: 'Empresa SpA', giro: 'Servicios', actecos: [620200], direccion: 'Calle 1', comuna: 'Santiago' },
  receptor: { rut: '96.790.240-3', razonSocial: 'Cliente Ltda', giro: 'Comercio', direccion: 'Calle 2', comuna: 'Ñuñoa' },
  items: [
    { nombre: 'Servicio', cantidad: 1, precio: 100000 },
    { nombre: 'Horas', cantidad: 2, precio: 15000, descuentoPct: 10 },
  ],
});

function falsoFetch(respuestas: { status?: number; body: unknown }[]) {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    const r = respuestas.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, llamadas };
}

describe('estructura SII para proveedores', () => {
  it('arma encabezado, totales y detalle de una factura', () => {
    const { dte, totales } = sii.estructuraSii(solicitud());
    expect(totales).toEqual({ neto: 127000, exento: 0, iva: 24130, total: 151130 });
    expect(dte.Encabezado.IdDoc).toMatchObject({ TipoDTE: 33, FmaPago: 2, FchVenc: '2026-12-25' });
    expect(dte.Encabezado.Emisor).toMatchObject({ RUTEmisor: '76192083-9', Acteco: [620200] });
    expect(dte.Encabezado.Receptor).toMatchObject({ RUTRecep: '96790240-3', RznSocRecep: 'Cliente Ltda' });
    expect(dte.Encabezado.Totales).toEqual({ MntNeto: 127000, TasaIVA: 19, IVA: 24130, MntTotal: 151130 });
    expect(dte.Detalle[1]).toMatchObject({ NroLinDet: 2, MontoItem: 27000, DescuentoMonto: 3000 });
  });

  it('una factura exenta no lleva IVA', () => {
    const { dte, totales } = sii.estructuraSii({ ...solicitud(34), items: [{ nombre: 'Curso', cantidad: 1, precio: 50000 }] });
    expect(totales.iva).toBe(0);
    expect(dte.Encabezado.Totales).toEqual({ MntExe: 50000, MntTotal: 50000 });
  });
});

describe('conectores', () => {
  it('OpenFactura envía la clave en la cabecera y devuelve el folio', async () => {
    const { fn, llamadas } = falsoFetch([{ body: { TOKEN: 'abc', FOLIO: 1234, TIMBRE: '<TED/>', XML: btoa('<DTE/>') } }]);
    const c = sii.crearConectorProveedor('openfactura', 'clave-de-prueba-1234567890', { ambiente: 'certificacion', fetchFn: fn });
    const r = await c.emitir(solicitud());
    expect(r).toMatchObject({ folio: 1234, estado: 'enviado', xml: '<DTE/>', idExterno: 'abc' });
    expect(llamadas[0].url).toBe('https://dev-api.haulmer.com/v2/dte/document');
    expect((llamadas[0].init.headers as Record<string, string>).apikey).toBe('clave-de-prueba-1234567890');
    expect(JSON.parse(String(llamadas[0].init.body)).dte.Encabezado.IdDoc.TipoDTE).toBe(33);
  });

  it('OpenFactura informa el rechazo con su detalle', async () => {
    const { fn } = falsoFetch([{ status: 400, body: { error: { message: 'RUT receptor inválido' } } }]);
    const c = sii.crearConectorProveedor('openfactura', 'x'.repeat(20), { fetchFn: fn });
    await expect(c.emitir(solicitud())).rejects.toBeInstanceOf(sii.ErrorConector);
  });

  it('LibreDTE emite un temporal y luego lo genera', async () => {
    const { fn, llamadas } = falsoFetch([
      { body: { emisor: 76192083, receptor: 96790240, dte: 33, codigo: 'tmp1' } },
      { body: { emisor: 76192083, dte: 33, folio: 88, track_id: 999, xml: btoa('<DTE/>') } },
    ]);
    const c = sii.crearConectorProveedor('libredte', 'hash-de-usuario-123456', { fetchFn: fn });
    const r = await c.emitir(solicitud());
    expect(r).toMatchObject({ folio: 88, estado: 'enviado', trackId: '999' });
    expect(llamadas[0].url).toContain('/api/dte/documentos/emitir');
    expect(llamadas[1].url).toContain('/api/dte/documentos/generar');
    expect(JSON.parse(String(llamadas[1].init.body)).codigo).toBe('tmp1');
    expect((llamadas[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('hash-de-usuario-123456:X')}`);
  });

  it('el conector directo reserva folio, firma y envía', async () => {
    const pasos: string[] = [];
    const c = new sii.ConectorDirecto({
      reservarFolio: async (t) => (pasos.push(`folio ${t}`), 41),
      firmar: (d) => (pasos.push(`firmar ${d.folio}`), { xml: '<DTE/>', ted: '<TED/>', totales: { neto: 1, exento: 0, iva: 0, total: 1 } }),
      enviar: async (f) => (pasos.push(`enviar ${f.folio}`), 'T123'),
    });
    expect(await c.emitir(solicitud())).toMatchObject({ folio: 41, estado: 'enviado', trackId: 'T123' });
    expect(pasos).toEqual(['folio 33', 'firmar 41', 'enviar 41']);
    expect((await c.emitir(solicitud(), { enviar: false })).estado).toBe('firmado');
  });
});
