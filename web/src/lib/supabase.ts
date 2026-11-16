import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anon) console.error('Configure VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en web/.env');

export const supabase = createClient(url ?? 'http://localhost', anon ?? 'x', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Llama a una Edge Function y lanza un Error legible si falla. */
export async function llamarFuncion<T = any>(nombre: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`cuadra/${nombre}`, { body });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as any).context as Response | undefined;
      const j = ctx ? await ctx.json() : null;
      if (j?.error) msg = j.error;
    } catch {
      /* respuesta no JSON */
    }
    throw new Error(msg);
  }
  return data as T;
}

/** Ejecuta una función RPC de Postgres. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
