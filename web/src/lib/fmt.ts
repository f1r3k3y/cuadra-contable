const clp = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 });

export const pesos = (n: number | string | null | undefined) => (n === null || n === undefined || n === '' ? '—' : clp.format(Number(n)));
export const numero = (n: number | string | null | undefined) => (n === null || n === undefined || n === '' ? '—' : num.format(Number(n)));
export const pesosCortos = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${num.format(+(n / 1e9).toFixed(1))} mil M`;
  if (a >= 1e6) return `$${num.format(+(n / 1e6).toFixed(1))} M`;
  if (a >= 1e3) return `$${num.format(Math.round(n / 1e3))} mil`;
  return clp.format(n);
};
export const fecha = (s: string | null | undefined) => (s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('es-CL') : '—');
export const fechaHora = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('es-CL') : '—');

export const hoy = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
export const periodoActual = () => hoy().slice(0, 7).replace('-', '');
export const inicioAnio = () => `${hoy().slice(0, 4)}-01-01`;

export const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export const NOMBRE_DTE: Record<number, string> = {
  33: 'Factura',
  34: 'Factura exenta',
  39: 'Boleta',
  41: 'Boleta exenta',
  46: 'Factura de compra',
  52: 'Guía de despacho',
  56: 'Nota de débito',
  61: 'Nota de crédito',
};

export function descargar(nombre: string, contenido: string, tipo = 'application/xml') {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csv(nombre: string, filas: Record<string, unknown>[]) {
  if (!filas.length) return;
  const cols = Object.keys(filas[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Evita inyección de fórmulas al abrir en Excel
    const seguro = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[;"\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
  };
  const txt = [cols.join(';'), ...filas.map((f) => cols.map((c) => esc(f[c])).join(';'))].join('\n');
  descargar(nombre, '﻿' + txt, 'text/csv;charset=utf-8');
}

export function leerArchivo(f: File, modo: 'texto' | 'latin1' | 'base64'): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(r.error);
    if (modo === 'base64') {
      r.onload = () => res(String(r.result).split(',')[1] ?? '');
      r.readAsDataURL(f);
    } else {
      r.onload = () => res(String(r.result));
      r.readAsText(f, modo === 'latin1' ? 'ISO-8859-1' : 'UTF-8');
    }
  });
}
