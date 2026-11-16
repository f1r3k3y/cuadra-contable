// Carga de credenciales SII de una empresa (descifradas solo en memoria).
import type { SupabaseClient } from '@supabase/supabase-js';
import { descifrar } from './boveda.ts';
import { HttpError } from './http.ts';
import { leerCertificado, leerCaf, ClienteSii, type Certificado, type Caf, type Emisor } from './sii/mod.ts';

export async function cargarCertificado(admin: SupabaseClient, empresaId: string): Promise<{ cert: Certificado; rutTitular: string }> {
  const { data: c } = await admin
    .from('certificados')
    .select('titular_rut, valido_hasta, secretos(cifrado)')
    .eq('empresa_id', empresaId)
    .eq('activo', true)
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!c) throw new HttpError(412, 'La empresa no tiene certificado digital cargado');
  if (new Date(c.valido_hasta) < new Date()) throw new HttpError(412, 'El certificado digital está vencido');
  const sec = JSON.parse(await descifrar((c as any).secretos.cifrado, empresaId));
  const bin = atob(sec.pfx);
  return { cert: leerCertificado(bin, sec.clave), rutTitular: c.titular_rut };
}

export async function cargarCaf(admin: SupabaseClient, empresaId: string, secretoId: string): Promise<Caf> {
  const { data: s } = await admin.from('secretos').select('cifrado').eq('id', secretoId).eq('empresa_id', empresaId).single();
  if (!s) throw new HttpError(500, 'No se encontró el CAF');
  return leerCaf(await descifrar(s.cifrado, empresaId));
}

export function emisorDesdeEmpresa(e: Record<string, any>): Emisor {
  return {
    rut: e.rut,
    razonSocial: e.razon_social,
    giro: e.giro,
    actecos: e.actecos ?? [],
    direccion: e.direccion,
    comuna: e.comuna,
    ciudad: e.ciudad ?? undefined,
    codigoSucursal: e.codigo_sucursal ?? undefined,
    telefono: e.telefono ?? undefined,
    correo: e.correo ?? undefined,
  };
}

export function clienteSii(empresa: Record<string, any>, cert: Certificado) {
  return new ClienteSii(empresa.sii_ambiente, cert);
}

export function caratula(empresa: Record<string, any>, rutEnvia: string, rutReceptor?: string) {
  if (!empresa.sii_resolucion_fecha) throw new HttpError(412, 'Configure la fecha de resolución SII de la empresa');
  return {
    rutEmisor: empresa.rut,
    rutEnvia: empresa.rut_envia ?? rutEnvia,
    rutReceptor,
    fechaResolucion: empresa.sii_resolucion_fecha,
    numeroResolucion: empresa.sii_ambiente === 'certificacion' ? 0 : empresa.sii_resolucion_numero,
  };
}
