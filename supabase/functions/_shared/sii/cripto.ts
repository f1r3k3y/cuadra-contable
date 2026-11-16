// Criptografía para el SII: certificado digital (PFX/P12), RSA-SHA1 y SHA-1.
// El SII sigue exigiendo RSA-SHA1 en firma de DTE y timbre (TED).
import forge from 'node-forge';

export interface Certificado {
  privateKey: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  /** Certificado en DER base64 (para X509Certificate). */
  certB64: string;
  modulusB64: string;
  exponentB64: string;
  /** RUT del titular, leído del certificado si viene (OID 1.3.6.1.4.1.8321.1). */
  rutTitular?: string;
  nombreTitular: string;
  validoDesde: Date;
  validoHasta: Date;
}

function bigIntB64(n: forge.jsbn.BigInteger): string {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return forge.util.encode64(forge.util.hexToBytes(hex));
}

/** Lee un .pfx/.p12. `pfx` es binary string (1 char = 1 byte) o Uint8Array. */
export function leerCertificado(pfx: string | Uint8Array, clave: string): Certificado {
  let bin: string;
  if (typeof pfx === 'string') bin = pfx;
  else {
    bin = '';
    for (let i = 0; i < pfx.length; i++) bin += String.fromCharCode(pfx[i]);
  }
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bin), false, clave);
  const keyBags = {
    ...p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag }),
  };
  let key = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  if (!key) key = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key;
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  if (!key) throw new Error('El certificado no contiene clave privada');
  const rsaKey = key as forge.pki.rsa.PrivateKey;
  // Elegir el certificado cuya clave pública calza con la privada.
  const cert = certBags
    .map((b: { cert?: forge.pki.Certificate }) => b.cert!)
    .find((c: forge.pki.Certificate) => (c.publicKey as forge.pki.rsa.PublicKey).n.equals(rsaKey.n));
  if (!cert) throw new Error('No se encontró el certificado asociado a la clave privada');
  const pub = cert.publicKey as forge.pki.rsa.PublicKey;
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const cn = cert.subject.getField('CN')?.value ?? '';
  let rutTitular: string | undefined;
  const ext = cert.extensions.find((e: { name: string }) => e.name === 'subjectAltName') as
    | { altNames?: { type: number; value: string }[] }
    | undefined;
  const m = JSON.stringify(ext?.altNames ?? []).match(/(\d{7,8}-[\dkK])/);
  if (m) rutTitular = m[1].toUpperCase();
  return {
    privateKey: rsaKey,
    cert,
    certB64: forge.util.encode64(der),
    modulusB64: bigIntB64(pub.n),
    exponentB64: bigIntB64(pub.e),
    rutTitular,
    nombreTitular: cn,
    validoDesde: cert.validity.notBefore,
    validoHasta: cert.validity.notAfter,
  };
}

export function sha1B64Utf8(s: string): string {
  const md = forge.md.sha1.create();
  md.update(s, 'utf8');
  return forge.util.encode64(md.digest().getBytes());
}

/** RSA-SHA1 sobre los bytes UTF-8 de `s`. */
export function firmarUtf8(key: forge.pki.rsa.PrivateKey, s: string): string {
  const md = forge.md.sha1.create();
  md.update(s, 'utf8');
  return forge.util.encode64(key.sign(md));
}

/** RSA-SHA1 sobre los bytes ISO-8859-1 de `s` (lo que pide el SII para el TED). */
export function firmarLatin1(key: forge.pki.rsa.PrivateKey, latin1: string): string {
  const md = forge.md.sha1.create();
  md.update(latin1); // binary string
  return forge.util.encode64(key.sign(md));
}

export function verificarLatin1(pub: forge.pki.rsa.PublicKey, latin1: string, firmaB64: string): boolean {
  const md = forge.md.sha1.create();
  md.update(latin1);
  return pub.verify(md.digest().getBytes(), forge.util.decode64(firmaB64));
}

export function clavePrivadaDesdePem(pem: string): forge.pki.rsa.PrivateKey {
  return forge.pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey;
}

export function clavePublicaDesdeModulo(mB64: string, eB64: string): forge.pki.rsa.PublicKey {
  const n = new forge.jsbn.BigInteger(forge.util.bytesToHex(forge.util.decode64(mB64)), 16);
  const e = new forge.jsbn.BigInteger(forge.util.bytesToHex(forge.util.decode64(eB64)), 16);
  return forge.pki.setRsaPublicKey(n, e);
}

export { forge };
