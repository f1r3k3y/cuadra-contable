// Certificado y CAF de prueba generados al vuelo (NO son del SII).
import forge from 'node-forge';

export function certificadoPrueba(clave = 'prueba123') {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'Persona de Prueba' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 1, value: '11111111-1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], clave, { algorithm: '3des' });
  return { pfx: forge.asn1.toDer(p12).getBytes(), clave };
}

export function cafPrueba(opts: { rut: string; tipo: number; desde: number; hasta: number }) {
  const sii = forge.pki.rsa.generateKeyPair(1024);
  const k = forge.pki.rsa.generateKeyPair(1024);
  const b64 = (n: forge.jsbn.BigInteger) => {
    let h = n.toString(16);
    if (h.length % 2) h = '0' + h;
    return forge.util.encode64(forge.util.hexToBytes(h));
  };
  const da = `<DA><RE>${opts.rut}</RE><RS>EMPRESA DE PRUEBA SPA</RS><TD>${opts.tipo}</TD><RNG><D>${opts.desde}</D><H>${opts.hasta}</H></RNG><FA>2026-01-15</FA><RSAPK><M>${b64(k.publicKey.n)}</M><E>${b64(k.publicKey.e)}</E></RSAPK><IDK>100</IDK></DA>`;
  const md = forge.md.sha1.create();
  md.update(da);
  const frma = forge.util.encode64(sii.privateKey.sign(md));
  const xml = `<?xml version="1.0"?>
<AUTORIZACION>
<CAF version="1.0">
${da}
<FRMA algoritmo="SHA1withRSA">${frma}</FRMA>
</CAF>
<RSASK>${forge.pki.privateKeyToPem(k.privateKey)}</RSASK>
<RSAPUBK>${forge.pki.publicKeyToPem(k.publicKey)}</RSAPUBK>
</AUTORIZACION>`;
  return { xml, siiPublicPem: forge.pki.publicKeyToPem(sii.publicKey) };
}
