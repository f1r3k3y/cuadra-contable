// Alertas por correo.
//  - Sin sesión (pg_cron cada mañana): envía el lote del día. Si alguien más la llama, solo puede
//    disparar el envío que igual ocurriría ese día (una ejecución por día).
//  - Con sesión y {"prueba": true}: envía al usuario un correo de prueba con sus avisos de hoy.
import { createClient } from '@supabase/supabase-js';
import { armarCorreo, correoConfigurado, enviarCorreo, type Destinatario } from '../_shared/correo.ts';

// El dominio publicado siempre se permite; CUADRA_ORIGENES agrega otros (p. ej. http://localhost:5173 o un dominio propio).
const ORIGENES = [...new Set(['https://cuadra-contable.pages.dev', ...(Deno.env.get('CUADRA_ORIGENES') ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean)])];
function cors(req: Request) {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGENES.includes(o) ? o : ORIGENES[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

Deno.serve(async (req) => {
  const h = cors(req);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...h, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const body = (await req.json().catch(() => ({}))) as { prueba?: boolean };

  if (body.prueba) {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'Sesión inválida' }, 401);
    if (!correoConfigurado()) return json({ error: 'El servicio de correo aún no está configurado (falta la clave de Resend en los secrets de Supabase)' }, 412);
    const { data, error } = await admin.rpc('alertas_pendientes', { p_user: u.user.id, p_todo: true });
    if (error) return json({ error: error.message }, 500);
    const d = (data?.destinatarios ?? [])[0] as Destinatario | undefined;
    if (!d) return json({ error: 'Activa primero las alertas por correo de alguna empresa' }, 412);
    const m = armarCorreo(d, true);
    try {
      await enviarCorreo(d.correo, m.subject, m.html, m.text);
    } catch (e) {
      await admin.rpc('registrar_envio_alerta', { p_user: d.userId, p_correo: d.correo, p_empresas: d.empresas.length, p_estado: 'error', p_error: (e as Error).message });
      return json({ error: (e as Error).message }, 502);
    }
    await admin.rpc('registrar_envio_alerta', { p_user: d.userId, p_correo: d.correo, p_empresas: d.empresas.length, p_estado: 'prueba' });
    return json({ ok: true, correo: d.correo });
  }

  if (!correoConfigurado()) return json({ omitido: 'Falta RESEND_API_KEY' });
  const { data: toca, error: e1 } = await admin.rpc('reclamar_ejecucion_alertas');
  if (e1) return json({ error: e1.message }, 500);
  if (!toca) return json({ omitido: 'Ya se ejecutó hoy' });
  const { data, error } = await admin.rpc('alertas_pendientes');
  if (error) return json({ error: error.message }, 500);
  let enviados = 0;
  let errores = 0;
  for (const d of (data?.destinatarios ?? []) as Destinatario[]) {
    const m = armarCorreo(d);
    try {
      await enviarCorreo(d.correo, m.subject, m.html, m.text);
      await admin.rpc('registrar_envio_alerta', { p_user: d.userId, p_correo: d.correo, p_empresas: d.empresas.length, p_estado: 'enviado' });
      enviados++;
    } catch (e) {
      await admin.rpc('registrar_envio_alerta', { p_user: d.userId, p_correo: d.correo, p_empresas: d.empresas.length, p_estado: 'error', p_error: (e as Error).message });
      errores++;
    }
  }
  return json({ fecha: data?.fecha, enviados, errores });
});
