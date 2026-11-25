// Correo de alertas: arma el mensaje y lo envía con Resend (https://resend.com).
// Secrets: RESEND_API_KEY (obligatorio), CUADRA_CORREO_REMITENTE (opcional, requiere dominio verificado en Resend),
// CUADRA_APP_URL (opcional).

export interface Aviso { nivel: 'urgente' | 'aviso'; ruta: string; texto: string }
export interface Destinatario { userId: string; correo: string; nombre: string; empresas: { empresa: string; id: string; avisos: Aviso[] }[] }

const APP = (Deno.env.get('CUADRA_APP_URL') ?? 'https://cuadra-contable.pages.dev').replace(/\/$/, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function armarCorreo(d: Destinatario, prueba = false) {
  const total = d.empresas.reduce((s, e) => s + e.avisos.length, 0);
  const urgentes = d.empresas.reduce((s, e) => s + e.avisos.filter((a) => a.nivel === 'urgente').length, 0);
  const subject = prueba
    ? 'Cuadra: correo de prueba de alertas'
    : `Cuadra: ${total} ${total === 1 ? 'pendiente' : 'pendientes'}${urgentes ? ` (${urgentes} ${urgentes === 1 ? 'urgente' : 'urgentes'})` : ''}`;
  const bloques = d.empresas.map((e) => `
    <h2 style="font-size:16px;margin:20px 0 6px">${esc(e.empresa)}</h2>
    <ul style="margin:0;padding-left:18px">${e.avisos.map((a) =>
      `<li style="margin:4px 0">${a.nivel === 'urgente' ? '<b style="color:#c8371e">Urgente:</b> ' : ''}${esc(a.texto)} <a href="${APP}${a.ruta}" style="color:#c8371e">Abrir</a></li>`).join('')}</ul>`).join('');
  const vacio = '<p>Hoy no hay avisos para tus empresas. Así se verán los avisos cuando haya plazos o pagos por atender.</p>';
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#171513;max-width:560px;margin:auto;padding:16px">
    <p style="font-weight:700;font-size:18px;margin:0 0 4px">Cuadra Contable</p>
    <p style="margin:0 0 12px">Hola ${esc(d.nombre)}, ${prueba ? 'este es un correo de prueba con lo que hoy tendrías pendiente:' : 'esto requiere tu atención:'}</p>
    ${d.empresas.length ? bloques : vacio}
    <p style="font-size:12px;color:#5f5a53;margin-top:24px">Recibes este correo porque activaste las alertas en Cuadra (Empresa y roles › Alertas por correo). Puedes desactivarlas ahí mismo.</p>
  </body></html>`;
  const text = [`Cuadra Contable — ${prueba ? 'correo de prueba' : 'pendientes'}`, '',
    ...(d.empresas.length ? d.empresas.flatMap((e) => [e.empresa, ...e.avisos.map((a) => `- ${a.nivel === 'urgente' ? 'URGENTE: ' : ''}${a.texto} ${APP}${a.ruta}`), '']) : ['Hoy no hay avisos.']),
    'Desactiva las alertas en Empresa y roles › Alertas por correo.'].join('\n');
  return { subject, html, text };
}

export function correoConfigurado() {
  return !!Deno.env.get('RESEND_API_KEY');
}

export async function enviarCorreo(to: string, subject: string, html: string, text: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('El servicio de correo no está configurado (falta RESEND_API_KEY)');
  const from = Deno.env.get('CUADRA_CORREO_REMITENTE') ?? 'Cuadra Contable <onboarding@resend.dev>';
  const r = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.id) throw new Error(`Resend respondió ${r.status}: ${String(j?.message ?? j?.error ?? '').slice(0, 300)}`);
  return String(j.id);
}
