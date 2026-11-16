// Cifrado de secretos (certificado digital y claves de CAF) con AES-256-GCM.
// La clave maestra vive solo en los secrets de Edge Functions (CUADRA_MASTER_KEY, 32 bytes en base64)
// y nunca en la base de datos. El id de la empresa se usa como dato asociado (AAD),
// de modo que un secreto copiado a otra empresa no se puede descifrar.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function claveMaestra(): Promise<CryptoKey> {
  const raw = Deno.env.get('CUADRA_MASTER_KEY');
  if (!raw) throw new Error('Falta CUADRA_MASTER_KEY en los secrets de la función');
  const bytes = unb64(raw);
  if (bytes.length !== 32) throw new Error('CUADRA_MASTER_KEY debe ser de 32 bytes (base64)');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function cifrar(texto: string, empresaId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(empresaId) }, await claveMaestra(), enc.encode(texto)),
  );
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function descifrar(sobre: string, empresaId: string): Promise<string> {
  const [v, iv, ct] = sobre.split(':');
  if (v !== 'v1') throw new Error('Formato de secreto desconocido');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(empresaId) },
    await claveMaestra(),
    unb64(ct),
  );
  return dec.decode(pt);
}
