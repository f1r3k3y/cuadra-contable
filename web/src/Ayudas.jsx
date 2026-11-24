import { useEffect, useRef, useState } from 'react';
import { AYUDAS, normalizar } from './ayudas';

// Elementos que pueden llevar ayuda automática según su texto visible
const SEL = 'label, th, h2, figcaption, dt, button, .kpi > span, .tramos span, .tabla.estado td:first-child';

// Texto propio del elemento (sin el de inputs/selects anidados)
function textoPropio(el) {
  if (el.tagName === 'LABEL') {
    return [...el.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName))).map((n) => n.textContent).join(' ');
  }
  return el.textContent || '';
}

function etiquetar() {
  for (const el of document.querySelectorAll(SEL)) {
    if (el.hasAttribute('data-ayuda') && !el.hasAttribute('data-ayuda-auto')) continue; // ayuda puesta a mano
    const clave = normalizar(textoPropio(el)).replace(/^\+\s*/, '');
    const texto = AYUDAS[clave];
    if (texto) {
      if (el.getAttribute('data-ayuda') !== texto) { el.setAttribute('data-ayuda', texto); el.setAttribute('data-ayuda-auto', ''); }
    } else if (el.hasAttribute('data-ayuda-auto')) {
      el.removeAttribute('data-ayuda'); el.removeAttribute('data-ayuda-auto');
    }
  }
}

export default function Ayudas() {
  const [tip, setTip] = useState(null);
  const caja = useRef(null);
  const temporizador = useRef(null);
  const actual = useRef(null);

  useEffect(() => {
    let pendiente = false;
    const programar = () => { if (pendiente) return; pendiente = true; requestAnimationFrame(() => { pendiente = false; etiquetar(); }); };
    const obs = new MutationObserver(programar);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    etiquetar();

    const mostrar = (el, demora) => {
      clearTimeout(temporizador.current);
      actual.current = el;
      temporizador.current = setTimeout(() => {
        if (actual.current !== el || !el.isConnected) return;
        setTip({ texto: el.getAttribute('data-ayuda'), r: el.getBoundingClientRect() });
      }, demora);
    };
    const ocultar = () => { clearTimeout(temporizador.current); actual.current = null; setTip(null); };

    const sobre = (e) => {
      const el = e.target.closest?.('[data-ayuda]');
      if (!el) return;
      if (el !== actual.current) mostrar(el, 350);
    };
    const fuera = (e) => {
      const el = actual.current;
      if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) ocultar();
    };
    const foco = (e) => {
      const el = e.target.closest?.('[data-ayuda]');
      if (el && e.target.matches(':focus-visible')) mostrar(el, 0);
    };
    const tecla = (e) => { if (e.key === 'Escape') ocultar(); };

    document.addEventListener('mouseover', sobre);
    document.addEventListener('mouseout', fuera);
    document.addEventListener('focusin', foco);
    document.addEventListener('focusout', ocultar);
    document.addEventListener('keydown', tecla);
    window.addEventListener('scroll', ocultar, true);
    window.addEventListener('mousedown', ocultar, true);
    return () => {
      obs.disconnect();
      clearTimeout(temporizador.current);
      document.removeEventListener('mouseover', sobre);
      document.removeEventListener('mouseout', fuera);
      document.removeEventListener('focusin', foco);
      document.removeEventListener('focusout', ocultar);
      document.removeEventListener('keydown', tecla);
      window.removeEventListener('scroll', ocultar, true);
      window.removeEventListener('mousedown', ocultar, true);
    };
  }, []);

  if (!tip) return null;
  const ancho = Math.min(320, window.innerWidth - 16);
  const izquierda = Math.max(8, Math.min(tip.r.left, window.innerWidth - ancho - 8));
  const arriba = tip.r.bottom + 140 > window.innerHeight;
  const estilo = { left: izquierda, width: 'max-content', maxWidth: ancho, ...(arriba ? { bottom: window.innerHeight - tip.r.top + 8 } : { top: tip.r.bottom + 8 }) };
  return <div ref={caja} className="ayuda-flotante" role="tooltip" style={estilo}>{tip.texto}</div>;
}
