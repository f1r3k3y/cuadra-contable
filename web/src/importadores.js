// Lectura de archivos del SII y de bancos en el navegador (nada se sube sin que el usuario lo confirme).

const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Separa una línea CSV respetando comillas. */
export function partirLinea(linea, sep) {
  const out = [];
  let cur = '', dentro = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') { if (dentro && linea[i + 1] === '"') { cur += '"'; i++; } else dentro = !dentro; }
    else if (c === sep && !dentro) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export function leerCsv(texto) {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return { cabecera: [], filas: [] };
  const primera = lineas[0];
  const sep = [';', ',', '\t'].sort((a, b) => primera.split(b).length - primera.split(a).length)[0];
  return { sep, cabecera: partirLinea(primera, sep), filas: lineas.slice(1).map((l) => partirLinea(l, sep)) };
}

/** Número chileno: "1.234.567", "-5.950", "1234,5", "$ 10.000" */
export function numeroCl(v) {
  let s = String(v ?? '').replace(/[$\s]/g, '');
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/[.,]/g, '');
  const n = Number(s) || 0;
  return neg ? -n : n;
}

/** Fecha dd/mm/aaaa, dd-mm-aaaa, aaaa-mm-dd o dd/mm/aa → aaaa-mm-dd */
export function fechaIso(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const a = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return '';
}

const buscar = (cab, ...nombres) => {
  const c = cab.map(sinTildes);
  for (const n of nombres) { const i = c.findIndex((h) => h === sinTildes(n)); if (i >= 0) return i; }
  for (const n of nombres) { const i = c.findIndex((h) => h.includes(sinTildes(n))); if (i >= 0) return i; }
  return -1;
};

/** Detalle del Registro de Compras y Ventas descargado desde sii.cl (CSV separado por punto y coma). */
export function leerRcv(texto) {
  const { cabecera, filas } = leerCsv(texto);
  const col = {
    tipo: buscar(cabecera, 'Tipo Doc', 'Tipo Documento'),
    folio: buscar(cabecera, 'Folio'),
    rut: buscar(cabecera, 'RUT Proveedor', 'Rut cliente', 'RUT Cliente', 'Rut Proveedor', 'RUT Emisor', 'RUT Receptor'),
    razon: buscar(cabecera, 'Razon Social', 'Razón Social'),
    fecha: buscar(cabecera, 'Fecha Docto', 'Fecha Documento', 'Fecha Emision'),
    recep: buscar(cabecera, 'Fecha Recepcion'),
    exento: buscar(cabecera, 'Monto Exento'),
    neto: buscar(cabecera, 'Monto Neto'),
    iva: buscar(cabecera, 'Monto IVA Recuperable', 'Monto IVA'),
    ivaNr: buscar(cabecera, 'Monto Iva No Recuperable', 'Monto IVA No Recuperable'),
    total: buscar(cabecera, 'Monto Total', 'Monto total'),
  };
  if (col.tipo < 0 || col.folio < 0 || col.total < 0) {
    throw new Error('El archivo no tiene el formato del detalle del RCV de sii.cl (faltan las columnas Tipo Doc, Folio o Monto Total).');
  }
  const g = (f, i) => (i >= 0 ? f[i] ?? '' : '');
  return filas.map((f) => ({
    tipo: Number(g(f, col.tipo)) || 0,
    folio: Number(String(g(f, col.folio)).replace(/\D/g, '')) || 0,
    rut: g(f, col.rut),
    razonSocial: g(f, col.razon),
    fechaEmision: fechaIso(g(f, col.fecha)),
    fechaRecepcion: fechaIso(g(f, col.recep)),
    neto: numeroCl(g(f, col.neto)),
    exento: numeroCl(g(f, col.exento)),
    iva: numeroCl(g(f, col.iva)),
    ivaNoRecuperable: numeroCl(g(f, col.ivaNr)),
    total: numeroCl(g(f, col.total)),
  })).filter((r) => r.tipo > 0);
}

/** Propone qué columna es cada dato en una cartola (cada banco usa nombres distintos). */
export function columnasCartola(cabecera) {
  return {
    fecha: buscar(cabecera, 'Fecha', 'Fecha Movimiento', 'Fecha Operacion', 'Fecha Contable'),
    descripcion: buscar(cabecera, 'Descripcion', 'Descripción', 'Glosa', 'Detalle', 'Movimiento', 'Concepto'),
    referencia: buscar(cabecera, 'N° Documento', 'Documento', 'Nro Documento', 'Referencia', 'Serial', 'Numero Operacion'),
    cargo: buscar(cabecera, 'Cargo', 'Cargos', 'Debito', 'Débito', 'Giros', 'Egreso'),
    abono: buscar(cabecera, 'Abono', 'Abonos', 'Credito', 'Crédito', 'Depositos', 'Ingreso'),
    monto: buscar(cabecera, 'Monto', 'Importe', 'Valor'),
    saldo: buscar(cabecera, 'Saldo', 'Saldo Contable', 'Saldo Disponible'),
  };
}

async function sha(texto) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

/** Convierte las filas de la cartola en movimientos con signo (+ abono, − cargo) y una huella para no duplicar. */
export async function movimientosCartola(filas, col) {
  const out = [];
  const vistos = new Map();
  for (const f of filas) {
    const fechaMov = fechaIso(f[col.fecha]);
    if (!fechaMov) continue;
    let monto = 0;
    if (col.cargo >= 0 || col.abono >= 0) monto = Math.abs(numeroCl(f[col.abono])) - Math.abs(numeroCl(f[col.cargo]));
    if (!monto && col.monto >= 0) monto = numeroCl(f[col.monto]);
    if (!monto) continue;
    const descripcion = (f[col.descripcion] ?? '').slice(0, 300);
    const referencia = col.referencia >= 0 ? (f[col.referencia] ?? '').slice(0, 100) : '';
    const saldo = col.saldo >= 0 && f[col.saldo] !== '' ? numeroCl(f[col.saldo]) : null;
    // Movimientos idénticos el mismo día se distinguen por su orden de aparición
    const base = [fechaMov, monto, descripcion, referencia].join('|');
    const n = (vistos.get(base) ?? 0) + 1;
    vistos.set(base, n);
    out.push({ fecha: fechaMov, descripcion, referencia, monto: Math.round(monto), saldo, huella: await sha(base + '|' + n) });
  }
  return out;
}

/** Lee el archivo como texto: UTF-8 si es válido; si no, Latin-1 (habitual en exportaciones de bancos y del SII). */
export async function leerArchivo(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}
