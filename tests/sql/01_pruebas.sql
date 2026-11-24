-- Pruebas de reglas contables y de seguridad sobre las migraciones.
\set QUIET on
\o /dev/null
create schema t;
grant usage on schema t to public;
create function t.debe_fallar(p_sql text, p_patron text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'NO FALLÓ: %', p_sql;
exception when others then
  if sqlerrm like 'NO FALLÓ%' then raise; end if;
  if sqlerrm !~* p_patron then raise exception 'Falló con otro error. Esperado "%", obtenido "%"', p_patron, sqlerrm; end if;
  raise notice 'ok (rechazado): %', sqlerrm;
end $$;
create function t.como(p_user uuid, p_aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, false);
$$;
create function t.afirmar(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'AFIRMACIÓN FALLIDA: %', p_msg; end if;
  raise notice 'ok: %', p_msg;
end $$;
grant execute on all functions in schema t to public;
create table t.ids (k text primary key, v uuid);
grant all on t.ids to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'ana@ejemplo.cl'),
  ('00000000-0000-0000-0000-00000000000b', 'beto@ejemplo.cl'),
  ('00000000-0000-0000-0000-00000000000c', 'carla@ejemplo.cl');

set role authenticated;

-- 1. Alta de empresa con MFA
select t.como('00000000-0000-0000-0000-00000000000a', 'aal1');
select t.debe_fallar($$insert into public.empresas (rut, razon_social, giro, creado_por) values ('76.192.083-9', 'Empresa Uno SpA', 'Servicios', '00000000-0000-0000-0000-00000000000a')$$, 'row-level security');
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$insert into public.empresas (rut, razon_social, giro, creado_por) values ('76.192.083-8', 'Mala', 'X', '00000000-0000-0000-0000-00000000000a')$$, 'check');
insert into public.empresas (rut, razon_social, giro, creado_por, direccion, comuna)
values ('76.192.083-9', 'Empresa Uno SpA', 'Servicios informáticos', '00000000-0000-0000-0000-00000000000a', 'Av. Uno 1', 'Santiago');
insert into t.ids select 'emp', id from public.empresas where rut = '76192083-9';
select t.afirmar((select rut from public.empresas) = '76192083-9', 'RUT normalizado');
select t.afirmar((select rol from public.miembros where user_id = auth.uid()) = 'admin', 'el creador queda como admin');
select t.afirmar((select count(*) from public.cuentas) > 70, 'plan de cuentas base creado');
select t.afirmar((select imputable from public.cuentas where codigo = '1.1') = false and (select imputable from public.cuentas where codigo = '1.1.01.01'), 'imputabilidad por jerarquía');
select t.afirmar((select cuenta_clientes is not null and cuenta_iva_debito is not null from public.configuracion_cuentas), 'cuentas automáticas configuradas');

-- 2. Aislamiento entre usuarios
select t.como('00000000-0000-0000-0000-00000000000b');
select t.afirmar((select count(*) from public.empresas) = 0, 'otro usuario no ve la empresa');
select t.afirmar((select count(*) from public.cuentas) = 0, 'otro usuario no ve el plan de cuentas');
select t.debe_fallar($$select public.contabilizar_asiento(gen_random_uuid())$$, 'no encontrado|permiso');

-- 3. Comprobantes
select t.como('00000000-0000-0000-0000-00000000000a');
select public.agregar_miembro((select v from t.ids where k = 'emp'), 'beto@ejemplo.cl', 'asistente');
select public.agregar_miembro((select v from t.ids where k = 'emp'), 'carla@ejemplo.cl', 'lector');

select t.debe_fallar(format($$select public.crear_asiento(%L, current_date, 'Descuadrado', %L::jsonb, 'traspaso', true)$$,
  (select v from t.ids where k = 'emp'),
  json_build_array(
    json_build_object('cuenta_id', (select id from public.cuentas where codigo = '1.1.01.02'), 'debe', 1000),
    json_build_object('cuenta_id', (select id from public.cuentas where codigo = '3.1.01'), 'haber', 900))), 'no cuadra');

select t.debe_fallar(format($$select public.crear_asiento(%L, current_date, 'Cuenta de grupo', %L::jsonb)$$,
  (select v from t.ids where k = 'emp'),
  json_build_array(json_build_object('cuenta_id', (select id from public.cuentas where codigo = '1.1'), 'debe', 1000))), 'no es imputable');

insert into t.ids select 'a1', id from public.crear_asiento((select v from t.ids where k = 'emp'), current_date, 'Aporte de capital',
  json_build_array(
    json_build_object('cuenta_id', (select id from public.cuentas where codigo = '1.1.01.02'), 'debe', 10000000),
    json_build_object('cuenta_id', (select id from public.cuentas where codigo = '3.1.01'), 'haber', 10000000))::jsonb, 'apertura', true);
select t.afirmar((select numero = 1 and estado = 'contabilizado' and total_debe = 10000000 from public.asientos where id = (select v from t.ids where k = 'a1')), 'comprobante contabilizado con número 1');

select t.debe_fallar(format($$update public.asientos set glosa = 'cambio' where id = %L$$, (select v from t.ids where k = 'a1')), 'contabilizado no se puede modificar');
select t.debe_fallar(format($$update public.asiento_lineas set debe = 1 where asiento_id = %L and debe > 0$$, (select v from t.ids where k = 'a1')), 'no se pueden modificar líneas');
select t.debe_fallar(format($$delete from public.asientos where id = %L$$, (select v from t.ids where k = 'a1')), 'borrador');
select t.debe_fallar(format($$insert into public.asientos (empresa_id, fecha, glosa, estado) values (%L, current_date, 'x', 'contabilizado')$$, (select v from t.ids where k = 'emp')), 'borrador');

-- Operador: crea borradores pero no contabiliza
select t.como('00000000-0000-0000-0000-00000000000b');
insert into t.ids select 'a2', id from public.crear_asiento((select v from t.ids where k = 'emp'), current_date, 'Gasto de oficina',
  json_build_array(
    json_build_object('cuenta_id', (select id from public.cuentas where codigo = '5.2.05'), 'debe', 50000),
    json_build_object('cuenta_id', (select id from public.cuentas where codigo = '1.1.01.01'), 'haber', 50000))::jsonb);
select t.debe_fallar(format($$select public.contabilizar_asiento(%L)$$, (select v from t.ids where k = 'a2')), 'administradores o contadores');

-- Lector: solo lee
select t.como('00000000-0000-0000-0000-00000000000c');
select t.afirmar((select count(*) from public.asientos) = 2, 'lector ve los comprobantes');
select t.debe_fallar(format($$insert into public.auxiliares (empresa_id, rut, razon_social) values (%L, '96790240-3', 'X')$$, (select v from t.ids where k = 'emp')), 'row-level security');

select t.como('00000000-0000-0000-0000-00000000000a');
select public.contabilizar_asiento((select v from t.ids where k = 'a2'));
select t.afirmar((select numero from public.asientos where id = (select v from t.ids where k = 'a2')) = 2, 'numeración correlativa');

-- Anular y reversar
select t.debe_fallar(format($$select public.anular_asiento(%L, 'x')$$, (select v from t.ids where k = 'a2')), 'motivo');
select public.reversar_asiento((select v from t.ids where k = 'a2'), current_date, 'Error de digitación');
select t.afirmar((select count(*) from public.asientos where reverso_de = (select v from t.ids where k = 'a2') and estado = 'contabilizado') = 1, 'reverso creado y contabilizado');
select t.debe_fallar(format($$select public.reversar_asiento(%L, current_date, 'otra vez')$$, (select v from t.ids where k = 'a2')), 'ya fue reversado');

-- 4. DTE emitido (lo inserta la Edge Function con rol de servicio) y contabilización automática
reset role;
set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
insert into public.dte_emitidos (empresa_id, tipo, folio, fecha_emision, receptor_rut, receptor_razon, neto, exento, iva, total, estado, ambiente, datos, xml)
values ((select v from t.ids where k = 'emp'), 33, 1, current_date, '96790240-3', 'Cliente Uno Ltda.', 1000000, 50000, 190000, 1240000, 'aceptado', 'certificacion', '{}', '<DTE/>');
select public.contabilizar_dte_emitido((select id from public.dte_emitidos where folio = 1));
insert into public.dte_recibidos (empresa_id, tipo, folio, fecha_emision, emisor_rut, emisor_razon, neto, iva, total)
values ((select v from t.ids where k = 'emp'), 33, 555, current_date, '96790240-3', 'Proveedor SA', 300000, 57000, 357000);
reset role;
set role authenticated;
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$select * from public.reservar_folio(gen_random_uuid(), 33)$$, 'permission denied');
select t.debe_fallar($$select * from public.secretos$$, 'permission denied');
select t.debe_fallar($$insert into public.dte_emitidos (empresa_id, tipo, folio, fecha_emision, receptor_rut, receptor_razon, ambiente, datos, xml) select id, 33, 99, current_date, '1-9', 'x', 'certificacion', '{}', 'x' from public.empresas$$, 'row-level security');
select public.contabilizar_dte_recibido((select id from public.dte_recibidos where folio = 555), (select id from public.cuentas where codigo = '5.2.07'));
select t.afirmar((select count(*) from public.auxiliares where rut = '96790240-3' and es_cliente and es_proveedor) = 1, 'auxiliar creado como cliente y proveedor');
select t.afirmar((select total_debe from public.asientos where origen = 'dte_emitido') = 1240000, 'asiento de venta por el total');

-- 5. Reportes
select t.afirmar((select sum(debitos) = sum(creditos) from public.balance_8_columnas((select v from t.ids where k = 'emp'), date_trunc('year', current_date)::date, current_date)), 'balance de 8 columnas cuadra');
select t.afirmar((select sum(activo) - sum(pasivo) = sum(ganancia) - sum(perdida) from public.balance_8_columnas((select v from t.ids where k = 'emp'), date_trunc('year', current_date)::date, current_date)), 'resultado de inventario = resultado de cuentas de resultado');
select t.afirmar((select monto from public.estado_resultados((select v from t.ids where k = 'emp'), date_trunc('year', current_date)::date, current_date) where orden = 10) = 750000, 'resultado del ejercicio 1.050.000 - 300.000');
select t.afirmar((select sum(case when seccion = 'Activo' then saldo else -saldo end) from public.balance_general((select v from t.ids where k = 'emp'), current_date)) = 0, 'balance general: activo = pasivo + patrimonio');
select t.afirmar((select count(*) from public.libro_mayor((select v from t.ids where k = 'emp'), (select id from public.cuentas where codigo = '1.1.01.01'), date_trunc('year', current_date)::date, current_date)) = 3, 'libro mayor con saldo inicial y movimientos');
select t.afirmar((public.metricas_dashboard((select v from t.ids where k = 'emp'), extract(year from current_date)::int) -> 'kpis' ->> 'ventas')::numeric = 1050000, 'métrica de ventas');
select t.afirmar((public.resumen_iva((select v from t.ids where k = 'emp'), to_char(current_date, 'YYYYMM')) -> 'ventas' -> 0 ->> 'iva')::numeric = 190000, 'resumen IVA para F29');

-- 6. Cierre de período
select public.cerrar_periodo((select v from t.ids where k = 'emp'), extract(year from current_date)::int, extract(month from current_date)::int);
select t.debe_fallar(format($$select public.crear_asiento(%L, current_date, 'tarde', '[]'::jsonb)$$, (select v from t.ids where k = 'emp')), 'cerrado');
select public.reabrir_periodo((select v from t.ids where k = 'emp'), extract(year from current_date)::int, extract(month from current_date)::int);

-- 7. Auditoría
select t.afirmar((select count(*) from public.auditoria) > 10, 'bitácora con registros');
select t.afirmar(public.verificar_auditoria((select v from t.ids where k = 'emp')) is null, 'cadena de auditoría íntegra');
select t.debe_fallar($$delete from public.auditoria$$, 'permission denied');
reset role;
select t.debe_fallar($$update public.auditoria set accion = 'X' where id = (select min(id) from public.auditoria)$$, 'no se puede modificar');
select t.debe_fallar($$delete from public.miembros where rol = 'admin'$$, 'al menos un administrador');

-- 8. Anónimo
set role anon;
select t.debe_fallar($$select public.contabilizar_asiento(gen_random_uuid())$$, 'permission denied');
select t.debe_fallar($$select * from public.empresas$$, 'permission denied');
reset role;
\o
\echo 'TODAS LAS PRUEBAS SQL PASARON'
