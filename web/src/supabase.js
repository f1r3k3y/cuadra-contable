import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;
if (!url || !key) throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_KEY en .env.local');

// La sesión vive en sessionStorage: se borra al cerrar la pestaña (menos exposición en equipos compartidos).
export const sb = createClient(url, key, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Llama una RPC y lanza un Error con mensaje legible si falla.
export async function rpc(nombre, args) {
  const { data, error } = await sb.rpc(nombre, args);
  if (error) throw new Error(traducir(error));
  return data;
}

export async function q(promesa) {
  const { data, error } = await promesa;
  if (error) throw new Error(traducir(error));
  return data;
}

function traducir(e) {
  const m = e.message || String(e);
  if (/row-level security|permission denied/i.test(m)) return 'No tienes permiso para esta acción (revisa tu rol y la verificación en dos pasos).';
  if (/duplicate key.*documentos/i.test(m)) return 'Ese documento ya está registrado (mismo tipo, RUT y folio).';
  if (/duplicate key/i.test(m)) return 'Ya existe un registro con esos datos.';
  return m;
}

// Llama una ruta de la Edge Function "cuadra" (operaciones con el SII o con secretos cifrados).
export async function funcion(ruta, body) {
  const { data, error } = await sb.functions.invoke(`cuadra/${ruta}`, { body });
  if (error) {
    let detalle = null;
    try { detalle = await error.context.json(); } catch { /* sin cuerpo */ }
    const e = new Error(detalle?.error ?? 'No se pudo conectar con el servicio');
    e.detalle = detalle?.detalle;
    throw e;
  }
  return data;
}
