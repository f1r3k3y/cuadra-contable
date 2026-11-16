import { supabase } from './supabase';

export interface Cuenta {
  id: string;
  codigo: string;
  nombre: string;
  tipo: string;
  clasificacion: string | null;
  imputable: boolean;
  requiere_auxiliar: boolean;
  requiere_centro_costo: boolean;
  es_efectivo: boolean;
  activa: boolean;
  nivel: number;
  padre_id: string | null;
}

export interface Auxiliar {
  id: string;
  rut: string;
  razon_social: string;
  giro: string | null;
  direccion: string | null;
  comuna: string | null;
  ciudad: string | null;
  correo: string | null;
  correo_dte: string | null;
  es_cliente: boolean;
  es_proveedor: boolean;
}

export async function cuentas(empresaId: string): Promise<Cuenta[]> {
  const { data, error } = await supabase.from('cuentas').select('*').eq('empresa_id', empresaId).order('codigo');
  if (error) throw new Error(error.message);
  return data as Cuenta[];
}

export async function auxiliares(empresaId: string): Promise<Auxiliar[]> {
  const { data, error } = await supabase.from('auxiliares').select('*').eq('empresa_id', empresaId).order('razon_social');
  if (error) throw new Error(error.message);
  return data as Auxiliar[];
}

export async function centrosCosto(empresaId: string) {
  const { data, error } = await supabase.from('centros_costo').select('*').eq('empresa_id', empresaId).eq('activo', true).order('codigo');
  if (error) throw new Error(error.message);
  return data as { id: string; codigo: string; nombre: string }[];
}
