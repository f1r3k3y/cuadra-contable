import { useEffect, useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type ButtonHTMLAttributes } from 'react';

export function Pagina({ titulo, sub, acciones, children }: { titulo: string; sub?: string; acciones?: ReactNode; children: ReactNode }) {
  return (
    <div className="pagina">
      <header className="pagina-cab">
        <div>
          <h1>{titulo}</h1>
          {sub && <p className="sub">{sub}</p>}
        </div>
        {acciones && <div className="acciones">{acciones}</div>}
      </header>
      {children}
    </div>
  );
}

export function Tarjeta({ titulo, children, extra, className = '' }: { titulo?: ReactNode; children: ReactNode; extra?: ReactNode; className?: string }) {
  return (
    <section className={`tarjeta ${className}`}>
      {(titulo || extra) && (
        <div className="tarjeta-cab">
          {titulo && <h2>{titulo}</h2>}
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function Boton({ variante = 'primario', cargando, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variante?: 'primario' | 'secundario' | 'peligro' | 'fantasma'; cargando?: boolean }) {
  return (
    <button {...p} className={`btn btn-${variante} ${p.className ?? ''}`} disabled={p.disabled || cargando}>
      {cargando ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Campo({ etiqueta, ayuda, children }: { etiqueta: string; ayuda?: string; children: ReactNode }) {
  return (
    <label className="campo">
      <span className="campo-et">{etiqueta}</span>
      {children}
      {ayuda && <span className="campo-ayuda">{ayuda}</span>}
    </label>
  );
}

export const Entrada = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`entrada ${p.className ?? ''}`} />;
export const Selector = ({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={`entrada ${p.className ?? ''}`}>
    {children}
  </select>
);

const TONOS: Record<string, string> = {
  aceptado: 'ok', contabilizado: 'ok', recibo_mercaderias: 'ok', abierto: 'ok', EPR: 'ok',
  enviado: 'info', firmado: 'info', borrador: 'neutro', pendiente: 'alerta', aceptado_reparos: 'alerta',
  rechazado: 'error', reclamado: 'error', anulado: 'neutro', cerrado: 'neutro',
};
const ETIQUETAS: Record<string, string> = { aceptado_reparos: 'con reparos', recibo_mercaderias: 'recibo mercaderías' };
export function Estado({ valor }: { valor: string }) {
  const tono = TONOS[valor] ?? 'neutro';
  const icono = { ok: '✓', info: '→', alerta: '!', error: '✕', neutro: '·' }[tono];
  return (
    <span className={`estado estado-${tono}`}>
      <span aria-hidden>{icono}</span> {ETIQUETAS[valor] ?? valor}
    </span>
  );
}

export function Aviso({ tipo = 'info', children }: { tipo?: 'info' | 'error' | 'ok' | 'alerta'; children: ReactNode }) {
  if (!children) return null;
  return <div className={`aviso aviso-${tipo}`} role={tipo === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({ abierto, titulo, onCerrar, children, ancho = 560 }: { abierto: boolean; titulo: string; onCerrar: () => void; children: ReactNode; ancho?: number }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    if (abierto) window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [abierto, onCerrar]);
  if (!abierto) return null;
  return (
    <div className="modal-fondo" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="modal" role="dialog" aria-modal aria-label={titulo} style={{ maxWidth: ancho }}>
        <div className="modal-cab">
          <h2>{titulo}</h2>
          <button className="btn btn-fantasma" onClick={onCerrar} aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Vacio({ children }: { children: ReactNode }) {
  return <div className="vacio">{children}</div>;
}

/** Hook genérico de carga asíncrona con recarga. */
export function useCarga<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError(null);
    fn()
      .then((d) => vivo && setDatos(d))
      .catch((e) => vivo && setError(e.message ?? String(e)))
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { datos, error, cargando, recargar: () => setN((x) => x + 1), setDatos };
}

export function Cargando() {
  return <div className="cargando"><span className="spinner" /> Cargando…</div>;
}
