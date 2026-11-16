// Constructor de XML que emite directamente la forma canónica (C14N inclusiva 1.0,
// sin comentarios). Así el texto que se firma es idéntico al que se guarda y se envía,
// y se evita depender de un canonicalizador externo dentro de Deno.

export const NS_SII = 'http://www.sii.cl/SiiDte';
export const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
export const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';

export type Attrs = Record<string, string | number | undefined | null>;
export type Child = XNode | Raw | string | number | null | undefined | false;

export interface XNode {
  kind: 'el';
  name: string;
  ns: Record<string, string>; // '' = namespace por defecto
  attrs: Attrs;
  children: Child[];
}
export interface Raw {
  kind: 'raw';
  xml: string;
}

/** Elemento. Los atributos que empiezan con "xmlns" se tratan como declaraciones de namespace. */
export function el(name: string, attrs: Attrs = {}, ...children: Child[]): XNode {
  const ns: Record<string, string> = {};
  const plain: Attrs = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'xmlns') ns[''] = String(v);
    else if (k.startsWith('xmlns:')) ns[k.slice(6)] = String(v);
    else plain[k] = v;
  }
  return { kind: 'el', name, ns, attrs: plain, children: children.flat() as Child[] };
}

/** Elemento opcional: si el valor es vacío no se emite. */
export function opt(name: string, value: string | number | undefined | null): XNode | null {
  if (value === undefined || value === null || value === '') return null;
  return el(name, {}, value);
}

/** XML ya serializado en forma canónica (p. ej. el bloque CAF o un DTE firmado). */
export function raw(xml: string): Raw {
  return { kind: 'raw', xml };
}

export function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

export function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

function sortNs(entries: [string, string][]): [string, string][] {
  return entries.sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

function sortAttrs(attrs: Attrs): [string, string][] {
  // Los atributos sin prefijo no tienen namespace y van primero; los con prefijo
  // (xsi:schemaLocation) se ordenan por URI de namespace. Para el uso que damos aquí
  // basta con poner primero los sin prefijo y luego los con prefijo.
  const e = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null) as [string, string | number][];
  const sinPrefijo = e.filter(([k]) => !k.includes(':')).sort(([a], [b]) => (a < b ? -1 : 1));
  const conPrefijo = e.filter(([k]) => k.includes(':')).sort(([a], [b]) => (a < b ? -1 : 1));
  return [...sinPrefijo, ...conPrefijo].map(([k, v]) => [k, String(v)]);
}

/**
 * Serializa en forma canónica.
 * @param inScope namespaces declarados en los ancestros (para C14N inclusiva del ápice).
 */
export function c14n(node: XNode, inScope: Record<string, string> = {}): string {
  return render(node, {}, { ...inScope }, true);
}

function render(node: XNode, rendered: Record<string, string>, scope: Record<string, string>, apex: boolean): string {
  const newScope = { ...scope, ...node.ns };
  let toEmit: [string, string][];
  if (apex) {
    toEmit = Object.entries(newScope).filter(([p, uri]) => !(p === '' && uri === ''));
  } else {
    toEmit = Object.entries(newScope).filter(([p, uri]) => rendered[p] !== uri && !(p === '' && uri === '' && rendered[''] === undefined));
  }
  const nowRendered = { ...rendered };
  for (const [p, u] of toEmit) nowRendered[p] = u;

  let out = '<' + node.name;
  for (const [p, u] of sortNs(toEmit)) out += p === '' ? ` xmlns="${escAttr(u)}"` : ` xmlns:${p}="${escAttr(u)}"`;
  for (const [k, v] of sortAttrs(node.attrs)) out += ` ${k}="${escAttr(v)}"`;
  out += '>';
  for (const c of node.children) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') out += escText(String(c));
    else if (c.kind === 'raw') out += c.xml;
    else out += render(c, nowRendered, newScope, false);
  }
  return out + '</' + node.name + '>';
}

/** Convierte un string JS a "binary string" ISO-8859-1 (1 char = 1 byte). */
export function aLatin1(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    out += code <= 0xff ? ch : '?';
  }
  return out;
}

/** Bytes ISO-8859-1 listos para escribir en archivo o enviar por HTTP. */
export function bytesLatin1(s: string): Uint8Array<ArrayBuffer> {
  const l = aLatin1(s);
  const b = new Uint8Array(l.length);
  for (let i = 0; i < l.length; i++) b[i] = l.charCodeAt(i);
  return b;
}

/** Normaliza texto libre para el SII: recorta y quita caracteres de control. */
export function textoSii(s: string | undefined | null, max: number): string {
  return aLatin1(String(s ?? ''))
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const DECL_LATIN1 = '<?xml version="1.0" encoding="ISO-8859-1"?>\n';
