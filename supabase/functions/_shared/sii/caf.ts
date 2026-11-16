// Código de Autorización de Folios (CAF) que entrega el SII por tipo de documento.
import { clavePrivadaDesdePem, clavePublicaDesdeModulo, verificarLatin1, forge } from './cripto.ts';
import { aLatin1 } from './xml.ts';

export interface Caf {
  rutEmisor: string;
  razonSocial: string;
  tipoDte: number;
  desde: number;
  hasta: number;
  fechaAutorizacion: string;
  idk: number;
  /** Bloque <CAF>...</CAF> sin espacios entre etiquetas, tal como va dentro del DD. */
  bloqueCaf: string;
  privateKeyPem: string;
  privateKey: forge.pki.rsa.PrivateKey;
  publicKey: forge.pki.rsa.PublicKey;
}

function tag(xml: string, nombre: string): string {
  const m = xml.match(new RegExp(`<${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</${nombre}>`));
  if (!m) throw new Error(`CAF inválido: falta <${nombre}>`);
  return m[1].trim();
}

export function leerCaf(xmlCaf: string): Caf {
  const bloque = xmlCaf.match(/<CAF[\s>][\s\S]*?<\/CAF>/);
  if (!bloque) throw new Error('CAF inválido: falta el bloque <CAF>');
  const bloqueCaf = bloque[0].replace(/>\s+</g, '><').trim();
  const da = tag(bloqueCaf, 'DA');
  const rng = tag(da, 'RNG');
  const pem = tag(xmlCaf, 'RSASK');
  const caf: Caf = {
    rutEmisor: tag(da, 'RE'),
    razonSocial: tag(da, 'RS'),
    tipoDte: Number(tag(da, 'TD')),
    desde: Number(tag(rng, 'D')),
    hasta: Number(tag(rng, 'H')),
    fechaAutorizacion: tag(da, 'FA'),
    idk: Number(tag(da, 'IDK')),
    bloqueCaf,
    privateKeyPem: pem,
    privateKey: clavePrivadaDesdePem(pem),
    publicKey: clavePublicaDesdeModulo(tag(tag(da, 'RSAPK'), 'M'), tag(tag(da, 'RSAPK'), 'E')),
  };
  // La clave privada del CAF debe corresponder a la pública autorizada.
  if (!caf.privateKey.n.equals(caf.publicKey.n)) throw new Error('CAF inválido: la clave privada no calza con RSAPK');
  return caf;
}

/** Verifica la firma del SII sobre el DA, con la clave pública del SII (IDK). */
export function verificarFirmaSii(caf: Caf, siiPublicKeyPem: string): boolean {
  const da = caf.bloqueCaf.match(/<DA>[\s\S]*<\/DA>/)![0];
  const frma = tag(caf.bloqueCaf, 'FRMA');
  const pub = forge.pki.publicKeyFromPem(siiPublicKeyPem) as forge.pki.rsa.PublicKey;
  return verificarLatin1(pub, aLatin1(da), frma);
}
