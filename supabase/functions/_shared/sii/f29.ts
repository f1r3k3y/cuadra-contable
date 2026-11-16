// Propuesta de Formulario 29 calculada desde los libros de compras y ventas.
// Es una PROPUESTA: siempre se debe contrastar con la propuesta que muestra el SII
// antes de declarar. Los códigos corresponden al F29 vigente.

export interface ResumenLibro {
  tipo: number; // tipo de documento SII
  cantidad: number;
  neto: number;
  exento: number;
  iva: number;
  ivaUsoComun?: number;
  ivaNoRecuperable?: number;
}

export interface EntradaF29 {
  ventas: ResumenLibro[];
  compras: ResumenLibro[];
  remanenteAnterior: number; // código 504, ya reajustado
  tasaPpm: number; // % (ej. 0.25)
  retencionHonorarios?: number; // código 151
  utmMes?: number; // para conversión del remanente si corresponde
}

export interface LineaF29 {
  codigo: number;
  glosa: string;
  valor: number;
}

const sum = (xs: ResumenLibro[], tipos: number[], k: keyof ResumenLibro) =>
  xs.filter((x) => tipos.includes(x.tipo)).reduce((a, x) => a + Number(x[k] ?? 0), 0);

export function calcularF29(e: EntradaF29): { lineas: LineaF29[]; ivaDeterminado: number; remanenteSiguiente: number; totalAPagar: number } {
  const v = e.ventas;
  const c = e.compras;
  const facturas = [33, 34];
  const lineas: LineaF29[] = [];
  const add = (codigo: number, glosa: string, valor: number) => {
    if (valor) lineas.push({ codigo, glosa, valor: Math.round(valor) });
    return Math.round(valor);
  };

  // Débitos
  add(503, 'Cantidad de facturas emitidas', sum(v, [33], 'cantidad'));
  const deb502 = add(502, 'Débito facturas emitidas', sum(v, [33], 'iva'));
  add(110, 'Cantidad de boletas', sum(v, [39], 'cantidad'));
  const deb111 = add(111, 'Débito boletas', sum(v, [39], 'iva'));
  add(512, 'Cantidad notas de débito emitidas', sum(v, [56], 'cantidad'));
  const deb513 = add(513, 'Débito notas de débito emitidas', sum(v, [56], 'iva'));
  add(509, 'Cantidad notas de crédito emitidas', sum(v, [61], 'cantidad'));
  const deb510 = add(510, 'Débito notas de crédito emitidas (resta)', sum(v, [61], 'iva'));
  add(142, 'Ventas y/o servicios exentos o no gravados', sum(v, [...facturas, 41, 39, 56], 'exento') - sum(v, [61], 'exento'));
  const totalDebitos = add(538, 'Total débitos', deb502 + deb111 + deb513 - deb510);

  // Créditos
  add(519, 'Cantidad facturas recibidas del giro', sum(c, [33, 46], 'cantidad'));
  const cre520 = add(520, 'Crédito facturas recibidas del giro', sum(c, [33, 46], 'iva') - sum(c, [33, 46], 'ivaNoRecuperable'));
  add(531, 'Cantidad notas de débito recibidas', sum(c, [56], 'cantidad'));
  const cre532 = add(532, 'Crédito notas de débito recibidas', sum(c, [56], 'iva'));
  add(527, 'Cantidad notas de crédito recibidas', sum(c, [61], 'cantidad'));
  const cre528 = add(528, 'Crédito notas de crédito recibidas (resta)', sum(c, [61], 'iva'));
  add(504, 'Remanente crédito fiscal mes anterior', e.remanenteAnterior);
  const totalCreditos = add(537, 'Total créditos', cre520 + cre532 - cre528 + e.remanenteAnterior);

  const diferencia = totalDebitos - totalCreditos;
  const ivaDeterminado = Math.max(0, diferencia);
  const remanenteSiguiente = Math.max(0, -diferencia);
  add(89, 'IVA determinado', ivaDeterminado);
  add(77, 'Remanente de crédito fiscal para el período siguiente', remanenteSiguiente);

  // PPM
  const baseVentas =
    sum(v, [33, 34, 39, 41, 56], 'neto') + sum(v, [33, 34, 39, 41, 56], 'exento') - sum(v, [61], 'neto') - sum(v, [61], 'exento');
  add(563, 'Base imponible PPM (ingresos brutos)', baseVentas);
  add(115, 'Tasa PPM (%)', e.tasaPpm);
  const ppm = add(62, 'PPM neto determinado', (baseVentas * e.tasaPpm) / 100);
  const ret = add(151, 'Retención honorarios', e.retencionHonorarios ?? 0);

  const totalAPagar = add(91, 'Total a pagar dentro del plazo legal', ivaDeterminado + ppm + ret);
  // El 115 es una tasa y no un monto: se deja con su valor decimal.
  const l115 = lineas.find((l) => l.codigo === 115);
  if (l115) l115.valor = e.tasaPpm;
  return { lineas, ivaDeterminado, remanenteSiguiente, totalAPagar };
}
