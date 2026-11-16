// Registro de Compras y Ventas (RCV): normalización de datos del SII y cuadratura.
import { rutSii } from './rut.ts';

export interface RegistroRcv {
  operacion: 'COMPRA' | 'VENTA';
  tipo: number;
  folio: number;
  rutContraparte: string;
  razonSocial: string;
  fechaEmision: string; // AAAA-MM-DD
  fechaRecepcion?: string;
  neto: number;
  exento: number;
  iva: number;
  ivaNoRecuperable: number;
  total: number;
  estado: string;
}

const n = (v: unknown) => Number(String(v ?? '0').replace(/\./g, '').replace(',', '.')) || 0;

function fecha(v: string): string {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s.slice(0, 10);
}

/**
 * Importa el CSV que se descarga desde "Registro de Compras y Ventas" en sii.cl
 * (separado por punto y coma). Detecta columnas por nombre de cabecera.
 */
export function importarCsvRcv(csv: string, operacion: 'COMPRA' | 'VENTA', estado = 'REGISTRO'): RegistroRcv[] {
  const lineas = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 2) return [];
  const cab = lineas[0].split(';').map((h) => h.trim().toLowerCase());
  const idx = (...nombres: string[]) => cab.findIndex((h) => nombres.some((x) => h === x.toLowerCase()));
  const col = {
    tipo: idx('Tipo Doc', 'Tipo Documento'),
    folio: idx('Folio'),
    rut: idx('RUT Proveedor', 'Rut cliente', 'RUT Cliente', 'Rut Proveedor'),
    razon: idx('Razon Social', 'Razón Social'),
    fecha: idx('Fecha Docto', 'Fecha Documento'),
    recep: idx('Fecha Recepcion', 'Fecha Recepción'),
    exento: idx('Monto Exento'),
    neto: idx('Monto Neto'),
    iva: idx('Monto IVA Recuperable', 'Monto IVA'),
    ivaNr: idx('Monto Iva No Recuperable', 'Monto IVA No Recuperable'),
    total: idx('Monto Total'),
  };
  if (col.tipo < 0 || col.folio < 0 || col.total < 0) throw new Error('El CSV no tiene el formato del RCV del SII');
  return lineas.slice(1).map((l) => {
    const c = l.split(';');
    const g = (i: number) => (i >= 0 ? c[i]?.trim() ?? '' : '');
    return {
      operacion,
      tipo: n(g(col.tipo)),
      folio: n(g(col.folio)),
      rutContraparte: g(col.rut) ? rutSii(g(col.rut)) : '',
      razonSocial: g(col.razon),
      fechaEmision: fecha(g(col.fecha)),
      fechaRecepcion: g(col.recep) ? fecha(g(col.recep)) : undefined,
      neto: n(g(col.neto)),
      exento: n(g(col.exento)),
      iva: n(g(col.iva)),
      ivaNoRecuperable: n(g(col.ivaNr)),
      total: n(g(col.total)),
      estado,
    };
  });
}

/** Normaliza la respuesta JSON del servicio RCV del SII. */
export function normalizarRcvJson(filas: Record<string, unknown>[], operacion: 'COMPRA' | 'VENTA', estado: string): RegistroRcv[] {
  return filas.map((f) => ({
    operacion,
    tipo: n(f.detTipoDoc),
    folio: n(f.detNroDoc),
    rutContraparte: f.detRutDoc ? rutSii(`${f.detRutDoc}-${f.detDvDoc}`) : '',
    razonSocial: String(f.detRznSoc ?? ''),
    fechaEmision: fecha(String(f.detFchDoc ?? '')),
    fechaRecepcion: f.detFecRecepcion ? fecha(String(f.detFecRecepcion)) : undefined,
    neto: n(f.detMntNeto),
    exento: n(f.detMntExe),
    iva: n(f.detMntIVA),
    ivaNoRecuperable: n(f.detMntIVANoRec ?? 0),
    total: n(f.detMntTotal),
    estado,
  }));
}

export interface DiferenciaRcv {
  clave: string;
  tipo: number;
  folio: number;
  rutContraparte: string;
  enRcv?: RegistroRcv;
  enLibro?: { total: number; iva: number };
  motivo: 'solo_en_sii' | 'solo_en_libro' | 'monto_distinto';
}

/** Compara el RCV del SII contra los documentos registrados en la contabilidad. */
export function cuadrarRcv(
  rcv: RegistroRcv[],
  libro: { tipo: number; folio: number; rutContraparte: string; total: number; iva: number }[],
): DiferenciaRcv[] {
  const clave = (t: number, f: number, r: string) => `${t}-${f}-${rutSii(r)}`;
  const mapaLibro = new Map(libro.map((l) => [clave(l.tipo, l.folio, l.rutContraparte), l]));
  const vistos = new Set<string>();
  const out: DiferenciaRcv[] = [];
  for (const r of rcv) {
    const k = clave(r.tipo, r.folio, r.rutContraparte);
    vistos.add(k);
    const l = mapaLibro.get(k);
    if (!l) out.push({ clave: k, tipo: r.tipo, folio: r.folio, rutContraparte: r.rutContraparte, enRcv: r, motivo: 'solo_en_sii' });
    else if (Math.abs(l.total - r.total) > 1 || Math.abs(l.iva - r.iva) > 1)
      out.push({ clave: k, tipo: r.tipo, folio: r.folio, rutContraparte: r.rutContraparte, enRcv: r, enLibro: l, motivo: 'monto_distinto' });
  }
  for (const [k, l] of mapaLibro)
    if (!vistos.has(k)) out.push({ clave: k, tipo: l.tipo, folio: l.folio, rutContraparte: l.rutContraparte, enLibro: l, motivo: 'solo_en_libro' });
  return out;
}
