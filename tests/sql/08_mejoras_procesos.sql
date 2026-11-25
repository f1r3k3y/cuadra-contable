-- Cierre del ejercicio, balance de 8 columnas multiaño, pago masivo y resumen anual de retenciones.
\set QUIET on
\o /dev/null
set role authenticated;

select t.como('00000000-0000-0000-0000-00000000000c');
insert into public.empresas (rut, razon_social, giro, creado_por, tasa_ppm, direccion, comuna)
values ('76.111.222-8', 'Ocho SpA', 'Servicios', '00000000-0000-0000-0000-00000000000c', 0.25, 'Av. Dos 456', 'Santiago');
insert into t.ids values ('e8', (select id from public.empresas where rut = '76111222-8'));
insert into t.ids values ('banco8', (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e8') and codigo = '1.1.01.02'));
reset role;
insert into public.miembros (empresa_id, user_id, rol) values
  ((select v::uuid from t.ids where k = 'e8'), '00000000-0000-0000-0000-00000000000b', 'tesorero');
set role authenticated;
select t.como('00000000-0000-0000-0000-00000000000c');

-- Ejercicio 2025: una venta (neto 1.000.000) y una compra (neto 300.000) → utilidad 700.000
select public.registrar_documento((select v from t.ids where k = 'e8'), 'venta', 33, 1, date '2025-06-10', '77.222.333-1', 'Cliente Ocho', 1000000);
select public.registrar_documento((select v from t.ids where k = 'e8'), 'compra', 33, 10, date '2025-07-10', '77.222.333-1', 'Proveedor Ocho', 300000);

select t.afirmar((select monto from public.estado_resultados((select v from t.ids where k = 'e8'), '2025-01-01', '2025-12-31') where orden = 10) = 700000,
  'resultado 2025 antes del cierre');
select t.debe_fallar($$select public.cerrar_ejercicio((select v from t.ids where k = 'e8'), extract(year from current_date)::int + 1)$$, 'todavía no termina');

select public.cerrar_ejercicio((select v from t.ids where k = 'e8'), 2025);
select t.afirmar((select monto from public.estado_resultados((select v from t.ids where k = 'e8'), '2025-01-01', '2025-12-31') where orden = 10) = 700000,
  'el estado de resultados no se anula con el asiento de cierre');
select t.afirmar((select saldo from public.balance_general((select v from t.ids where k = 'e8'), '2025-12-31') where codigo = '3.1.03') = 700000,
  'la utilidad queda en Resultado del ejercicio');
select t.afirmar((select saldo from public.balance_general((select v from t.ids where k = 'e8'), '2025-12-31') where codigo = '3.9') = 0,
  'sin resultados pendientes de cierre');
select t.afirmar((public.estado_ejercicio((select v from t.ids where k = 'e8'), 2025) ->> 'cerrado')::boolean, 'estado del ejercicio: cerrado');
select t.debe_fallar($$select public.cerrar_ejercicio((select v from t.ids where k = 'e8'), 2025)$$, 'ya está cerrado');

-- Balance de 8 columnas de 2026: arrastra saldos de 2025 y cuadra
select public.registrar_documento((select v from t.ids where k = 'e8'), 'venta', 33, 2, date '2026-02-10', '77.222.333-1', 'Cliente Ocho', 200000);
select t.afirmar((select sum(debitos) = sum(creditos) and sum(activo) - sum(pasivo) = sum(ganancia) - sum(perdida)
                    from public.balance_8_columnas((select v from t.ids where k = 'e8'), '2026-01-01', '2026-12-31')),
  'balance de 8 columnas 2026 cuadra con saldos iniciales');
select t.afirmar((select deudor from public.balance_8_columnas((select v from t.ids where k = 'e8'), '2026-01-01', '2026-12-31') where codigo = '1.1.02.01') > 1190000,
  'clientes incluye el saldo de 2025');
select t.afirmar((select acreedor from public.balance_8_columnas((select v from t.ids where k = 'e8'), '2026-01-01', '2026-12-31') where codigo = '3.1.03') = 700000,
  'resultado 2025 aparece como patrimonio en 2026');
select t.afirmar(not exists (select 1 from public.balance_8_columnas((select v from t.ids where k = 'e8'), '2026-01-01', '2026-12-31') where codigo in ('4.1.01', '3.9') and debitos + creditos = 0 and codigo = '3.9'),
  'sin línea de resultados sin cerrar');

-- Sin cierre: el balance igual cuadra mostrando los resultados anteriores en patrimonio
select public.anular_asiento((select id from public.asientos where empresa_id = (select v from t.ids where k = 'e8') and origen = 'cierre'), 'prueba');
select t.afirmar((select sum(debitos) = sum(creditos) from public.balance_8_columnas((select v from t.ids where k = 'e8'), '2026-01-01', '2026-12-31')),
  'balance de 8 columnas cuadra sin cierre');
select t.afirmar((select acreedor from public.balance_8_columnas((select v from t.ids where k = 'e8'), '2026-01-01', '2026-12-31') where codigo = '3.9') = 700000,
  'resultados no cerrados de 2025 en patrimonio');
select public.cerrar_ejercicio((select v from t.ids where k = 'e8'), 2025);

-- Pago masivo (tesorero)
select public.registrar_documento((select v from t.ids where k = 'e8'), 'compra', 33, 11, date '2026-03-01', '77.222.333-1', 'Proveedor Ocho', 10000);
select public.registrar_documento((select v from t.ids where k = 'e8'), 'compra', 33, 12, date '2026-03-02', '77.222.333-1', 'Proveedor Ocho', 20000);
select t.como('00000000-0000-0000-0000-00000000000b');
select t.afirmar((public.registrar_pagos(array(select id from public.documentos where empresa_id = (select v from t.ids where k = 'e8') and folio in (11, 12) and operacion = 'compra'),
                  date '2026-03-05', (select v::uuid from t.ids where k = 'banco8')) ->> 'total')::numeric = 35700, 'pago masivo por el saldo total');
select t.afirmar((select count(*) from public.documentos_saldo where empresa_id = (select v from t.ids where k = 'e8') and folio in (11, 12) and saldo = 0) = 2, 'documentos quedan pagados');
select t.debe_fallar($$select public.registrar_pagos(array(select id from public.documentos where empresa_id = (select v from t.ids where k = 'e8') and folio = 11 and operacion = 'compra'), date '2026-03-05', (select v::uuid from t.ids where k = 'banco8'))$$, 'no tiene saldo');
select t.debe_fallar($$select public.cerrar_ejercicio((select v from t.ids where k = 'e8'), 2025)$$, 'Sin permiso');

-- Resumen anual de retenciones
select t.como('00000000-0000-0000-0000-00000000000c');
select public.registrar_honorario((select v from t.ids where k = 'e8'), 1, date '2026-04-10', '12.345.678-5', 'Pedro Pérez', 1000000);
select public.registrar_honorario((select v from t.ids where k = 'e8'), 2, date '2026-05-10', '12.345.678-5', 'Pedro Pérez', 500000);
select public.registrar_remuneraciones((select v from t.ids where k = 'e8'), '202604', date '2026-04-30',
  '[{"rut":"11.111.111-1","nombre":"Ana Uno","imponible":1500000,"afp":167000,"salud":105000,"afc_trabajador":9000,"impuesto_unico":22740}]'::jsonb, 69000);
select t.afirmar((select (r -> 'honorarios' -> 0 ->> 'retencion')::numeric = 228750 and (r -> 'honorarios' -> 0 -> 'meses' ->> 4)::numeric = 76250
                    and (r -> 'remuneraciones' -> 0 ->> 'rentaTributable')::numeric = 1219000 and (r -> 'remuneraciones' -> 0 ->> 'impuesto')::numeric = 22740
                  from public.resumen_anual_retenciones((select v from t.ids where k = 'e8'), 2026) r), 'resumen anual de retenciones');
select t.como('00000000-0000-0000-0000-00000000000b');
select t.afirmar((select r -> 'remuneraciones' = 'null'::jsonb from public.resumen_anual_retenciones((select v from t.ids where k = 'e8'), 2026) r),
  'el tesorero no ve el detalle de sueldos');

\o
select 'OK 08 mejoras de procesos';
