const clp = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
export const peso = (n) => (n == null || n === '' ? '' : '$' + clp.format(Number(n)));
export const num = (n) => (n == null ? '' : clp.format(Number(n)));

export function rutValido(rut) {
  const l = String(rut || '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (l.length < 2) return false;
  const cuerpo = l.slice(0, -1), dv = l.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return false;
  let s = 0, m = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { s += Number(cuerpo[i]) * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (s % 11);
  return (r === 11 ? '0' : r === 10 ? 'K' : String(r)) === dv;
}

export function rutFormato(rut) {
  const l = String(rut || '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (l.length < 2) return l;
  return l.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + l.slice(-1);
}

export const hoy = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const inicioAnio = () => hoy().slice(0, 4) + '-01-01';
export const inicioMes = () => hoy().slice(0, 8) + '01';
export const periodoActual = () => hoy().slice(0, 7).replace('-', '');

export const TIPOS_DOC = {
  33: 'Factura electrónica',
  34: 'Factura exenta',
  39: 'Boleta electrónica',
  41: 'Boleta exenta',
  46: 'Factura de compra',
  56: 'Nota de débito',
  61: 'Nota de crédito',
};

export const ROLES = {
  admin: 'Administrador',
  contador: 'Contador',
  operador: 'Operador',
  auditor: 'Auditor',
  lector: 'Solo lectura',
};

export const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Exporta filas a CSV (separador ; para Excel en español).
export function csv(nombre, filas) {
  if (!filas.length) return;
  const cols = Object.keys(filas[0]);
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; // evita inyección de fórmulas en Excel
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const texto = [cols.join(';'), ...filas.map((f) => cols.map((c) => esc(f[c])).join(';'))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + texto], { type: 'text/csv;charset=utf-8' }));
  a.download = nombre + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
