-- Roles según la práctica contable chilena y la segregación de funciones:
--   operador  -> asistente (asistente contable / digitador: registra, no aprueba)
--   tesorero  (nuevo: cobros, pagos, caja y bancos; no contabiliza ni toca maestros)
--   gerente   (nuevo: vista ejecutiva de resultados, tesorería y F29; sin escritura)
-- Va en su propia migración porque un valor nuevo de enum no puede usarse en la misma transacción.
alter type public.rol_empresa rename value 'operador' to 'asistente';
alter type public.rol_empresa add value if not exists 'tesorero';
alter type public.rol_empresa add value if not exists 'gerente';
