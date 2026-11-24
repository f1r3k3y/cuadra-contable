// Utilidades comunes de las Edge Functions: CORS, autenticación, autorización por rol y errores.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const ORIGENES = (Deno.env.get('CUADRA_ORIGENES') ?? 'http://localhost:5173').split(',').map((s) => s.trim());

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGENES.includes(origin) ? origin : ORIGENES[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export class HttpError extends Error {
  constructor(public status: number, msg: string, public detalle?: unknown) {
    super(msg);
  }
}

export type Rol = 'admin' | 'contador' | 'asistente' | 'auditor' | 'lector';

export interface Contexto {
  req: Request;
  userId: string;
  /** Cliente con la identidad del usuario (respeta RLS). */
  db: SupabaseClient;
  /** Cliente de servicio (salta RLS): usar solo después de autorizar. */
  admin: SupabaseClient;
  body: Record<string, unknown>;
  empresa: Record<string, any>;
  rol: Rol;
}

function decodificarJwt(token: string): Record<string, unknown> {
  const p = token.split('.')[1] ?? '';
  return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(p.length / 4) * 4, '=')));
}

// Límite simple por usuario y por instancia (mitiga abuso accidental o scripts).
const ventana = new Map<string, number[]>();
function limitar(clave: string, max = 60, ms = 60_000) {
  const ahora = Date.now();
  const xs = (ventana.get(clave) ?? []).filter((t) => ahora - t < ms);
  if (xs.length >= max) throw new HttpError(429, 'Demasiadas solicitudes; intente en un minuto');
  xs.push(ahora);
  ventana.set(clave, xs);
}

/**
 * Envuelve un handler: valida JWT, exige MFA (aal2), carga la empresa y comprueba el rol.
 */
export function servir(roles: Rol[], handler: (ctx: Contexto) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido');
      const auth = req.headers.get('Authorization') ?? '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!token) throw new HttpError(401, 'No autenticado');
      const url = Deno.env.get('SUPABASE_URL')!;
      const db = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false },
      });
      const { data: u, error: eu } = await db.auth.getUser(token);
      if (eu || !u.user) throw new HttpError(401, 'Sesión inválida');
      const claims = decodificarJwt(token);
      if (Deno.env.get('CUADRA_EXIGIR_MFA') !== 'off' && claims.aal !== 'aal2')
        throw new HttpError(403, 'Esta operación requiere verificación en dos pasos (MFA)');
      limitar(u.user.id);

      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const empresaId = String(body.empresaId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(empresaId)) throw new HttpError(400, 'empresaId inválido');
      const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const { data: m } = await admin.from('miembros').select('rol').eq('empresa_id', empresaId).eq('user_id', u.user.id).maybeSingle();
      if (!m) throw new HttpError(403, 'No pertenece a la empresa');
      if (!roles.includes(m.rol)) throw new HttpError(403, `Su rol (${m.rol}) no permite esta operación`);
      const { data: empresa } = await admin.from('empresas').select('*').eq('id', empresaId).single();

      const res = await handler({ req, userId: u.user.id, db, admin, body, empresa, rol: m.rol });
      return new Response(JSON.stringify(res ?? { ok: true }), { headers: { ...h, 'Content-Type': 'application/json' } });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const msg = e instanceof Error ? e.message : 'Error interno';
      // Los detalles técnicos (respuestas del SII) se devuelven, pero nunca secretos ni stack traces.
      const detalle = (e as { detalle?: unknown }).detalle;
      if (status === 500) console.error(e);
      return new Response(JSON.stringify({ error: msg, detalle }), { status, headers: { ...h, 'Content-Type': 'application/json' } });
    }
  };
}

export function requerido<T>(v: T | undefined | null, nombre: string): T {
  if (v === undefined || v === null || v === '') throw new HttpError(400, `Falta ${nombre}`);
  return v;
}
