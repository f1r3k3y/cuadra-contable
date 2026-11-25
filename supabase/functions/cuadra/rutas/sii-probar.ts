// Prueba la conexión con el SII sin emitir nada: con el certificado pide una semilla y un token.
// Con proveedor, la primera emisión en ambiente de certificación es la prueba (cada proveedor valida su clave al emitir).
import { HttpError, servir } from '../../_shared/http.ts';
import { cargarApiKey, cargarCertificado, clienteSii } from '../../_shared/contexto.ts';

export default servir(['admin', 'contador'], async ({ admin, empresa }) => {
  if (empresa.sii_conector === 'directo') {
    const { cert, rutTitular } = await cargarCertificado(admin, empresa.id);
    try {
      await clienteSii(empresa, cert).obtenerToken();
    } catch (e) {
      throw new HttpError(502, `El SII no aceptó la autenticación: ${(e as Error).message}`, (e as { detalle?: unknown }).detalle);
    }
    return { ok: true, mensaje: `El SII (${empresa.sii_ambiente}) aceptó el certificado de ${rutTitular}` };
  }
  if (empresa.sii_conector === 'proveedor') {
    const k = await cargarApiKey(admin, empresa.id);
    return { ok: true, mensaje: `Clave de ${empresa.sii_proveedor} cargada (termina en ${k.slice(-4)}); se valida en la primera emisión de prueba` };
  }
  throw new HttpError(412, 'Elija primero la forma de conexión');
});
