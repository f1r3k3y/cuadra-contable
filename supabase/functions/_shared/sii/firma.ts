// Firma XMLDSig (enveloped, RSA-SHA1, C14N inclusiva) como la exige el SII.
import { el, c14n, NS_DSIG, type XNode } from './xml.ts';
import { sha1B64Utf8, firmarUtf8, type Certificado } from './cripto.ts';

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export interface OpcionesFirma {
  /** ID del elemento referenciado; '' firma el documento completo (getToken). */
  uri: string;
  /** Namespaces declarados en los ancestros del elemento firmado. */
  nsElemento?: Record<string, string>;
  /** Namespaces con prefijo declarados en los ancestros de <Signature>. */
  nsFirma?: Record<string, string>;
}

/** Devuelve el nodo <Signature> listo para insertarse como hermano (o hijo, si uri='') del firmado. */
export function firmar(nodo: XNode, cert: Certificado, op: OpcionesFirma): XNode {
  const digest = sha1B64Utf8(c14n(nodo, op.nsElemento ?? {}));
  const signedInfo = el(
    'SignedInfo',
    {},
    el('CanonicalizationMethod', { Algorithm: C14N }),
    el('SignatureMethod', { Algorithm: RSA_SHA1 }),
    el(
      'Reference',
      { URI: op.uri ? `#${op.uri}` : '' },
      op.uri ? null : el('Transforms', {}, el('Transform', { Algorithm: ENVELOPED })),
      el('DigestMethod', { Algorithm: SHA1 }),
      el('DigestValue', {}, digest),
    ),
  );
  const prefijados = Object.fromEntries(Object.entries(op.nsFirma ?? {}).filter(([p]) => p !== ''));
  const canonSignedInfo = c14n(signedInfo, { ...prefijados, '': NS_DSIG });
  const valor = firmarUtf8(cert.privateKey, canonSignedInfo);
  return el(
    'Signature',
    { xmlns: NS_DSIG },
    signedInfo,
    el('SignatureValue', {}, valor),
    el(
      'KeyInfo',
      {},
      el(
        'KeyValue',
        {},
        el('RSAKeyValue', {}, el('Modulus', {}, cert.modulusB64), el('Exponent', {}, cert.exponentB64)),
      ),
      el('X509Data', {}, el('X509Certificate', {}, cert.certB64)),
    ),
  );
}
