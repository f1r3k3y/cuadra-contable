// Lectura de sobres EnvioDTE recibidos de proveedores.
import { DOMParser, type Element } from '@xmldom/xmldom';
import { rutSii } from './rut.ts';
import { sha1B64Utf8 } from './cripto.ts';

export interface DteLeido {
  tipo: number;
  folio: number;
  fechaEmision: string;
  rutEmisor: string;
  razonSocialEmisor: string;
  rutReceptor: string;
  neto: number;
  exento: number;
  iva: number;
  total: number;
  ivaNoRecuperable: number;
  items: { nombre: string; cantidad: number; precio: number; monto: number }[];
  xml: string;
}

export interface SobreLeido {
  rutEmisor: string;
  rutEnvia: string;
  rutReceptor: string;
  idSet: string;
  digest: string;
  dtes: DteLeido[];
}

const texto = (n: Element | null | undefined, tag: string): string =>
  (n?.getElementsByTagName(tag)[0]?.textContent ?? '').trim();
const num = (n: Element | null | undefined, tag: string): number => Number(texto(n, tag) || 0);

export function leerSobre(xml: string): SobreLeido {
  const errores: string[] = [];
  const doc = new DOMParser({
    onError: (_lvl: unknown, msg: string) => errores.push(msg),
  }).parseFromString(xml, 'text/xml');
  if (errores.length) throw new Error('XML mal formado: ' + errores[0]);
  const raiz = doc.documentElement;
  if (!raiz) throw new Error('XML vacío');
  if (!['EnvioDTE', 'EnvioBOLETA'].includes(raiz.localName ?? raiz.nodeName))
    throw new Error('El archivo no es un EnvioDTE');
  const caratula = raiz.getElementsByTagName('Caratula')[0];
  const set = raiz.getElementsByTagName('SetDTE')[0];
  const firmaSet = Array.from(raiz.getElementsByTagName('DigestValue')).pop()?.textContent ?? '';
  const dtes: DteLeido[] = [];
  const nodos = raiz.getElementsByTagName('DTE');
  for (let i = 0; i < nodos.length; i++) {
    const d = nodos[i] as Element;
    const idDoc = d.getElementsByTagName('IdDoc')[0];
    const emisor = d.getElementsByTagName('Emisor')[0];
    const receptor = d.getElementsByTagName('Receptor')[0];
    const tot = d.getElementsByTagName('Totales')[0];
    const items = Array.from(d.getElementsByTagName('Detalle')).map((det) => ({
      nombre: texto(det, 'NmbItem'),
      cantidad: num(det, 'QtyItem') || 1,
      precio: num(det, 'PrcItem'),
      monto: num(det, 'MontoItem'),
    }));
    dtes.push({
      tipo: num(idDoc, 'TipoDTE'),
      folio: num(idDoc, 'Folio'),
      fechaEmision: texto(idDoc, 'FchEmis'),
      rutEmisor: rutSii(texto(emisor, 'RUTEmisor')),
      razonSocialEmisor: texto(emisor, 'RznSoc') || texto(emisor, 'RznSocEmisor'),
      rutReceptor: rutSii(texto(receptor, 'RUTRecep')),
      neto: num(tot, 'MntNeto'),
      exento: num(tot, 'MntExe'),
      iva: num(tot, 'IVA'),
      total: num(tot, 'MntTotal'),
      ivaNoRecuperable: num(tot, 'MontoImp'),
      items,
      xml: d.toString(),
    });
  }
  return {
    rutEmisor: rutSii(texto(caratula, 'RutEmisor')),
    rutEnvia: rutSii(texto(caratula, 'RutEnvia')),
    rutReceptor: rutSii(texto(caratula, 'RutReceptor')),
    idSet: set?.getAttribute('ID') ?? '',
    digest: firmaSet || sha1B64Utf8(xml),
    dtes,
  };
}
