// Cálculo de totales de un DTE (sin dependencias: se usa también en el navegador).

export const TASA_IVA = 19;

export interface ItemDte {
  nombre: string;
  descripcion?: string;
  cantidad: number;
  unidad?: string;
  precio: number; // neto en facturas; bruto (IVA incluido) en boletas 39
  descuentoPct?: number;
  exento?: boolean;
  codigo?: string;
}

export interface Totales {
  neto: number;
  exento: number;
  iva: number;
  total: number;
  lineas: { montoItem: number; descuentoMonto: number }[];
}

export const esBoleta = (t: number) => t === 39 || t === 41;
export const esExenta = (t: number) => t === 34 || t === 41;

/** Redondeo SII: al entero más cercano, mitades hacia arriba. */
export const redondear = (n: number) => Math.round(n + Number.EPSILON);

export function calcularTotales(d: { tipo: number; items: ItemDte[] }): Totales {
  let afecto = 0;
  let exento = 0;
  const lineas = d.items.map((it) => {
    const bruto = it.cantidad * it.precio;
    const descuentoMonto = it.descuentoPct ? redondear((bruto * it.descuentoPct) / 100) : 0;
    const montoItem = redondear(bruto - descuentoMonto);
    if (it.exento || esExenta(d.tipo)) exento += montoItem;
    else afecto += montoItem;
    return { montoItem, descuentoMonto };
  });
  if (esBoleta(d.tipo)) {
    // En boletas los precios incluyen IVA: se desglosa.
    const neto = redondear(afecto / (1 + TASA_IVA / 100));
    return { neto, exento, iva: afecto - neto, total: afecto + exento, lineas };
  }
  const iva = redondear((afecto * TASA_IVA) / 100);
  return { neto: afecto, exento, iva, total: afecto + exento + iva, lineas };
}

