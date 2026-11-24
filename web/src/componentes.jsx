import { useEffect, useRef } from 'react';
import { MESES_LARGOS } from './util';

// Diálogo modal nativo: atrapa el foco, cierra con Esc y devuelve el foco al elemento que lo abrió.
export function Dialogo({ alCerrar, ancho, titulo, children, ...resto }) {
  const ref = useRef(null);
  useEffect(() => {
    const previo = document.activeElement;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (previo && typeof previo.focus === 'function') previo.focus(); };
  }, []);
  return (
    <dialog
      ref={ref}
      className={'dialogo' + (ancho ? ' ancho-detalle' : '')}
      aria-label={titulo}
      onCancel={(e) => { e.preventDefault(); alCerrar(); }}
      onClick={(e) => { if (e.target === ref.current) alCerrar(); }}
      {...resto}
    >
      {children}
    </dialog>
  );
}

// Selector de mes compatible con todos los navegadores (input type=month no funciona en Firefox).
export function SelectorMes({ valor, alCambiar, etiqueta = 'Mes', desde = 2020 }) {
  const [anio, mes] = valor.split('-');
  const hasta = new Date().getFullYear() + 1;
  const anios = [];
  for (let a = hasta; a >= desde; a--) anios.push(String(a));
  return (
    <fieldset className="selector-mes">
      <legend>{etiqueta}</legend>
      <select aria-label={`${etiqueta}: mes`} value={mes} onChange={(e) => alCambiar(`${anio}-${e.target.value}`)}>
        {MESES_LARGOS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
      </select>
      <select aria-label={`${etiqueta}: año`} value={anio} onChange={(e) => alCambiar(`${e.target.value}-${mes}`)}>
        {anios.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
    </fieldset>
  );
}

// Campo de monto en pesos: muestra $ y separador de miles; entrega solo dígitos (string).
export function CampoMonto({ valor, alCambiar, max, ...resto }) {
  const texto = valor === '' || valor == null ? '' : Number(valor).toLocaleString('es-CL');
  return (
    <span className="campo-monto">
      <span aria-hidden="true">$</span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={texto}
        onChange={(e) => {
          const limpio = e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
          if (max != null && limpio !== '' && Number(limpio) > Number(max)) return alCambiar(String(max));
          alCambiar(limpio);
        }}
        {...resto}
      />
    </span>
  );
}

// Props para que una fila de tabla clicable también se abra con teclado
export const filaAccionable = (accion, etiqueta) => ({
  tabIndex: 0,
  title: etiqueta,
  onClick: accion,
  onKeyDown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); accion(); } },
});

// Aviso de éxito o error anunciado por lectores de pantalla
export function Aviso({ msg }) {
  if (!msg) return null;
  return <p className={msg.ok ? 'aviso ok' : msg.ok === false ? 'aviso error' : 'aviso'} role={msg.ok === false ? 'alert' : 'status'}>{msg.t}</p>;
}
