import { useEffect, useRef } from 'react';

// Clave PÚBLICA del widget Turnstile (la secreta vive solo en Supabase Auth).
export const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY ?? '0x4AAAAAAGP_501u0zCFlWS-';

let cargando;
function cargarScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  cargando ??= new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => ok(window.turnstile);
    s.onerror = () => { cargando = undefined; mal(new Error('No se pudo cargar la verificación anti-bots.')); };
    document.head.appendChild(s);
  });
  return cargando;
}

/**
 * Widget de verificación anti-bots. Llama a alToken(token) cuando el visitante
 * pasa la verificación y alToken(null) cuando el token vence o falla.
 * Cambia `reinicio` para pedir un token nuevo (cada token sirve una sola vez).
 */
export default function Turnstile({ accion, alToken, reinicio = 0 }) {
  const caja = useRef(null);
  const id = useRef(null);
  const cb = useRef(alToken);
  cb.current = alToken;

  useEffect(() => {
    if (!TURNSTILE_SITEKEY) { cb.current('sin-captcha'); return undefined; }
    let vivo = true;
    cargarScript().then((ts) => {
      if (!vivo || !caja.current) return;
      id.current = ts.render(caja.current, {
        sitekey: TURNSTILE_SITEKEY,
        action: accion,
        language: 'es',
        theme: 'light',
        callback: (t) => cb.current(t),
        'expired-callback': () => cb.current(null),
        'error-callback': () => { cb.current(null); },
      });
    }).catch(() => cb.current(null));
    return () => {
      vivo = false;
      if (id.current != null && window.turnstile) window.turnstile.remove(id.current);
      id.current = null;
    };
  }, [accion]);

  useEffect(() => {
    if (reinicio && id.current != null && window.turnstile) {
      cb.current(null);
      window.turnstile.reset(id.current);
    }
  }, [reinicio]);

  return <div ref={caja} className="turnstile" data-ayuda="Verificación automática de Cloudflare para frenar robots. Normalmente se completa sola en un segundo." />;
}
