// Utilidades de RUT chileno (módulo 11).

export function limpiarRut(rut: string): string {
  return rut.replace(/[^0-9kK]/g, '').toUpperCase();
}

export function calcularDv(cuerpo: number | string): string {
  const digitos = String(cuerpo).replace(/\D/g, '');
  let suma = 0;
  let mult = 2;
  for (let i = digitos.length - 1; i >= 0; i--) {
    suma += Number(digitos[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const res = 11 - (suma % 11);
  if (res === 11) return '0';
  if (res === 10) return 'K';
  return String(res);
}

export function validarRut(rut: string): boolean {
  const limpio = limpiarRut(rut);
  if (limpio.length < 2) return false;
  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return false;
  if (Number(cuerpo) < 1000000 && cuerpo !== '1') return false;
  return calcularDv(cuerpo) === dv;
}

/** Formato que exige el SII en los XML: 76123456-7 (sin puntos). */
export function rutSii(rut: string): string {
  const limpio = limpiarRut(rut);
  return `${Number(limpio.slice(0, -1))}-${limpio.slice(-1)}`;
}

/** Formato de lectura: 76.123.456-7 */
export function formatearRut(rut: string): string {
  const limpio = limpiarRut(rut);
  const cuerpo = limpio.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cuerpo}-${limpio.slice(-1)}`;
}

export function partesRut(rut: string): { cuerpo: string; dv: string } {
  const limpio = limpiarRut(rut);
  return { cuerpo: String(Number(limpio.slice(0, -1))), dv: limpio.slice(-1) };
}
