// Carga del certificado digital (.pfx) y de los CAF de folios. Solo administradores.
import { HttpError, requerido, servir } from '../../_shared/http.ts';
import { cifrar } from '../../_shared/boveda.ts';
import { leerCaf, leerCertificado, rutSii, validarRut } from '../../_shared/sii/mod.ts';

export default servir(['admin'], async ({ body, admin, empresa, userId }) => {
  const accion = requerido(body.accion as string, 'accion');

  if (accion === 'certificado') {
    const pfx = requerido(body.pfxBase64 as string, 'pfxBase64');
    const clave = requerido(body.clave as string, 'clave');
    if (pfx.length > 200_000) throw new HttpError(413, 'Archivo demasiado grande');
    let cert;
    try {
      cert = leerCertificado(atob(pfx), clave);
    } catch {
      throw new HttpError(400, 'No se pudo abrir el certificado: revise el archivo y la clave');
    }
    if (cert.validoHasta < new Date()) throw new HttpError(400, 'El certificado está vencido');
    const rutTitular = (body.rutTitular as string) || cert.rutTitular;
    if (!rutTitular || !validarRut(rutTitular)) throw new HttpError(400, 'Indique el RUT del titular del certificado');
    const { data: s, error: es } = await admin
      .from('secretos')
      .insert({ empresa_id: empresa.id, tipo: 'certificado', cifrado: await cifrar(JSON.stringify({ pfx, clave }), empresa.id) })
      .select('id')
      .single();
    if (es) throw es;
    await admin.from('certificados').update({ activo: false }).eq('empresa_id', empresa.id);
    const { data: c, error } = await admin
      .from('certificados')
      .insert({
        empresa_id: empresa.id,
        titular_nombre: cert.nombreTitular,
        titular_rut: rutSii(rutTitular),
        valido_desde: cert.validoDesde.toISOString(),
        valido_hasta: cert.validoHasta.toISOString(),
        secreto_id: s.id,
        creado_por: userId,
      })
      .select('id, titular_nombre, titular_rut, valido_hasta')
      .single();
    if (error) throw error;
    if (!empresa.rut_envia) await admin.from('empresas').update({ rut_envia: rutSii(rutTitular) }).eq('id', empresa.id);
    return c;
  }

  if (accion === 'caf') {
    const xml = requerido(body.xml as string, 'xml');
    if (xml.length > 50_000) throw new HttpError(413, 'Archivo demasiado grande');
    let caf;
    try {
      caf = leerCaf(xml);
    } catch (e) {
      throw new HttpError(400, `CAF inválido: ${(e as Error).message}`);
    }
    if (rutSii(caf.rutEmisor) !== rutSii(empresa.rut)) throw new HttpError(400, `El CAF es de ${caf.rutEmisor}, no de ${empresa.rut}`);
    const { data: dup } = await admin
      .from('cafs')
      .select('id')
      .eq('empresa_id', empresa.id)
      .eq('tipo_dte', caf.tipoDte)
      .eq('folio_desde', caf.desde)
      .maybeSingle();
    if (dup) throw new HttpError(409, 'Ese CAF ya fue cargado');
    const { data: s, error: es } = await admin
      .from('secretos')
      .insert({ empresa_id: empresa.id, tipo: 'caf', cifrado: await cifrar(xml, empresa.id) })
      .select('id')
      .single();
    if (es) throw es;
    const { data: c, error } = await admin
      .from('cafs')
      .insert({
        empresa_id: empresa.id,
        tipo_dte: caf.tipoDte,
        folio_desde: caf.desde,
        folio_hasta: caf.hasta,
        folio_siguiente: caf.desde,
        fecha_autorizacion: caf.fechaAutorizacion,
        secreto_id: s.id,
      })
      .select('id, tipo_dte, folio_desde, folio_hasta, fecha_autorizacion')
      .single();
    if (error) throw error;
    return c;
  }

  if (accion === 'api_key') {
    const clave = requerido(body.apiKey as string, 'apiKey').trim();
    if (clave.length < 16 || clave.length > 512 || /\s/.test(clave)) throw new HttpError(400, 'La clave de API no tiene un formato válido');
    if (empresa.sii_conector !== 'proveedor') throw new HttpError(412, 'Primero elija conectarse vía proveedor');
    // Se reemplaza la clave anterior: solo existe una vigente por empresa
    await admin.from('secretos').delete().eq('empresa_id', empresa.id).eq('tipo', 'api_key');
    const { error } = await admin.from('secretos').insert({ empresa_id: empresa.id, tipo: 'api_key', cifrado: await cifrar(clave, empresa.id) });
    if (error) throw error;
    return { ok: true, termina: clave.slice(-4) };
  }

  throw new HttpError(400, 'Acción desconocida');
});
