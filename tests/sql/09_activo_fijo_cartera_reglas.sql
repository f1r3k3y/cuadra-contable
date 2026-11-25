-- Activo fijo, cartera de empresas, reglas de conciliación y aviso del F29.
\set QUIET on
\o /dev/null
set role authenticated;

select t.como('00000000-0000-0000-0000-00000000000c');
insert into public.empresas (rut, razon_social, giro, creado_por, tasa_ppm, direccion, comuna)
values ('77.222.333-1', 'Nueve SpA', 'Servicios', '00000000-0000-0000-0000-00000000000c', 0.25, 'Av. Tres 789', 'Santiago');
insert into t.ids values ('e9', (select id from public.empresas where rut = '77222333-1'));
reset role;
insert into public.miembros (empresa_id, user_id, rol) values
  ((select v::uuid from t.ids where k = 'e9'), '00000000-0000-0000-0000-00000000000a', 'asistente'),
  ((select v::uuid from t.ids where k = 'e9'), '00000000-0000-0000-0000-00000000000b', 'tesorero');
set role authenticated;
select t.como('00000000-0000-0000-0000-00000000000c');

create temp table c9 as select codigo, id from public.cuentas where empresa_id = (select v from t.ids where k = 'e9');

-- ---------------------------------------------------------------- Activo fijo
-- Computador $1.200.001 en 2026-01, vida acelerada 2 años (24 meses), residual $1 → cuota 50.000
select public.registrar_activo((select v from t.ids where k = 'e9'), 'Notebook', date '2026-01-15', 1200001, 24,
  (select id from c9 where codigo = '1.2.01.01'), (select id from c9 where codigo = '1.2.01.90'), (select id from c9 where codigo = '5.2.08'),
  p_categoria => 'Computadores', p_codigo => 'AF-001');
select t.debe_fallar($$select public.registrar_activo((select v from t.ids where k = 'e9'), 'X', date '2026-01-15', 1000, 12,
  (select id from c9 where codigo = '1.2.01.01'), (select id from c9 where codigo = '1.2.01.01'), (select id from c9 where codigo = '5.2.08'))$$, 'distintas');
select t.debe_fallar($$select public.registrar_activo((select v from t.ids where k = 'e9'), 'X', date '2026-01-15', 1000, 12,
  (select id from c9 where codigo = '1.2.01.01'), (select id from c9 where codigo = '1.2.01.90'), (select id from c9 where codigo = '4.1.01'))$$, 'gasto por depreciación');

select t.debe_fallar($$select public.depreciar_mes((select v from t.ids where k = 'e9'), '202512')$$, 'No hay activos por depreciar');
select t.afirmar((public.depreciar_mes((select v from t.ids where k = 'e9'), '202601') ->> 'total')::numeric = 50000, 'cuota mensual lineal');
select t.debe_fallar($$select public.depreciar_mes((select v from t.ids where k = 'e9'), '202601')$$, 'ya está registrada');
select t.afirmar((select saldo from public.balance_general((select v from t.ids where k = 'e9'), '2026-01-31') where codigo = '1.2.01.90') = -50000,
  'depreciación acumulada en el balance');
select t.afirmar((select valor_libro from public.activos_saldo where codigo = 'AF-001') = 1150001, 'valor libro');

-- Anular y rehacer
select public.anular_depreciacion((select v from t.ids where k = 'e9'), '202601', 'prueba de anulación');
select t.afirmar((select valor_libro from public.activos_saldo where codigo = 'AF-001') = 1200001, 'anular restituye el valor libro');
select public.depreciar_mes((select v from t.ids where k = 'e9'), '202601');

-- Último mes toma el saldo: con 23 meses depreciados queda 50.000 exacto (sin residuos)
do $$ declare m int; begin
  for m in 2..12 loop perform public.depreciar_mes((select v from t.ids where k = 'e9'), '2026' || lpad(m::text, 2, '0')); end loop;
  for m in 1..11 loop perform public.depreciar_mes((select v from t.ids where k = 'e9'), '2027' || lpad(m::text, 2, '0')); end loop;
end $$;
select t.afirmar((public.depreciar_mes((select v from t.ids where k = 'e9'), '202712') ->> 'total')::numeric = 50000, 'última cuota');
select t.afirmar((select valor_libro from public.activos_saldo where codigo = 'AF-001') = 1, 'queda el valor residual');
select t.debe_fallar($$select public.depreciar_mes((select v from t.ids where k = 'e9'), '202801')$$, 'No hay activos por depreciar');

-- Baja de un segundo activo con depreciación inicial (traído de otro sistema)
select public.registrar_activo((select v from t.ids where k = 'e9'), 'Escritorio', date '2024-01-10', 840000, 84,
  (select id from c9 where codigo = '1.2.01.02'), (select id from c9 where codigo = '1.2.01.90'), (select id from c9 where codigo = '5.2.08'),
  p_inicio => date '2026-01-01', p_depreciacion_inicial => 240000, p_codigo => 'AF-002');
select public.dar_baja_activo((select id from public.activos_fijos where codigo = 'AF-002'), date '2026-02-15', 'Se dañó en una mudanza');
select t.afirmar((select estado = 'baja' and baja_asiento_id is not null from public.activos_fijos where codigo = 'AF-002'), 'activo dado de baja');
select t.afirmar((select sum(debe) from public.asiento_lineas l join public.activos_fijos f on f.baja_asiento_id = l.asiento_id
                   where f.codigo = 'AF-002' and l.cuenta_id = (select id from c9 where codigo = '5.3.03')) = 600000, 'valor libro a pérdida');
select t.debe_fallar($$select public.dar_baja_activo((select id from public.activos_fijos where codigo = 'AF-002'), date '2026-02-15', 'otra vez')$$, 'ya está dado de baja');

-- Permisos
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$select public.depreciar_mes((select v from t.ids where k = 'e9'), '202801')$$, 'Sin permiso');
select t.afirmar((select count(*) from public.activos_fijos where empresa_id = (select v from t.ids where k = 'e9')) = 0, 'el asistente no ve el activo fijo');

-- ---------------------------------------------------------------- Reglas de conciliación (tesorero)
select t.como('00000000-0000-0000-0000-00000000000b');
select public.guardar_regla_conciliacion((select v from t.ids where k = 'e9'), 'comision', (select id from c9 where codigo = '5.3.01'), 'cargo', null, 'Comisiones bancarias');
select t.debe_fallar($$select public.guardar_regla_conciliacion((select v from t.ids where k = 'e9'), 'ab', (select id from c9 where codigo = '5.3.01'))$$, 'check');
select public.importar_cartola((select v from t.ids where k = 'e9'), (select id from c9 where codigo = '1.1.01.02'), jsonb_build_array(
  jsonb_build_object('fecha', '2026-03-03', 'descripcion', 'Comision mantencion cuenta', 'monto', -5950, 'huella', 'h9-0001-aa'),
  jsonb_build_object('fecha', '2026-03-04', 'descripcion', 'COMISION por abono', 'monto', 1000, 'huella', 'h9-0002-aa'),
  jsonb_build_object('fecha', '2026-03-05', 'descripcion', 'Transferencia cliente', 'monto', 20000, 'huella', 'h9-0003-aa')));
select t.afirmar((public.aplicar_reglas_conciliacion((select v from t.ids where k = 'e9'), (select id from c9 where codigo = '1.1.01.02')) ->> 'contabilizados')::int = 1,
  'la regla contabiliza solo los cargos que calzan');
select t.afirmar((select count(*) from public.cartola_movimientos where empresa_id = (select v from t.ids where k = 'e9') and estado = 'pendiente') = 2, 'el resto queda pendiente');
select t.afirmar((select usos from public.reglas_conciliacion where empresa_id = (select v from t.ids where k = 'e9')) = 1, 'se cuenta el uso de la regla');
select public.eliminar_regla_conciliacion((select id from public.reglas_conciliacion where empresa_id = (select v from t.ids where k = 'e9')));

-- ---------------------------------------------------------------- Cartera
select t.afirmar((select jsonb_array_length(public.mi_cartera() -> 'empresas')) >= 2, 'el tesorero ve sus empresas en la cartera');
select t.afirmar((select e ? 'pagarVencido' and not e ? 'f29' and not e ? 'borradores' from jsonb_array_elements(public.mi_cartera() -> 'empresas') e
                   where e ->> 'rut' = '77222333-1'), 'la cartera respeta los permisos del rol');
select t.como('00000000-0000-0000-0000-00000000000c');
select t.afirmar((select e ? 'f29' and e ? 'borradores' from jsonb_array_elements(public.mi_cartera() -> 'empresas') e where e ->> 'rut' = '77222333-1'),
  'el administrador ve todo en la cartera');

-- ---------------------------------------------------------------- F29: montos en cero no cuentan como cambio
reset role;
select t.afirmar(app.f29_montos('{"89": 100, "48": 0, "115": 0.25}') = '{"89": 100, "115": 0.25}'::jsonb, 'comparación del F29 ignora líneas en cero');

\o
select 'OK 09 activo fijo, cartera y reglas';
