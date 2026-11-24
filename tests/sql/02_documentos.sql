-- Pruebas de la versión simple: compras y ventas manuales, anulación y propuesta F29.
-- Se ejecuta después de 01_pruebas.sql (reutiliza el esquema t y los usuarios de prueba).
\set QUIET on
\o /dev/null
set role authenticated;

-- Empresa nueva administrada por carla
select t.como('00000000-0000-0000-0000-00000000000c');
insert into public.empresas (rut, razon_social, giro, creado_por) values ('76.086.428-5', 'Comercial Dos SpA', 'Comercio', '00000000-0000-0000-0000-00000000000c');
insert into t.ids values ('e2', (select id from public.empresas where rut = '76086428-5'));

-- Venta afecta, compra afecta con IVA parcialmente no recuperable, venta exenta y nota de crédito
select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 101, '2026-10-05', '96.790.240-3', 'Cliente Uno', 1000000);
select public.registrar_documento((select v from t.ids where k = 'e2'), 'compra', 33, 9001, '2026-10-06', '77.123.456-9', 'Proveedor Uno', 400000, 0, 19000);
select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 34, 102, '2026-10-07', '96.790.240-3', 'Cliente Uno', 0, 50000);
select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 61, 7, '2026-10-08', '96.790.240-3', 'Cliente Uno', 100000);

select t.afirmar((select iva from public.documentos where folio = 101) = 190000, 'IVA calculado al 19 %');
select t.afirmar((select count(*) from public.documentos d join public.asientos a on a.id = d.asiento_id
                   where d.empresa_id = (select v from t.ids where k = 'e2') and a.estado = 'contabilizado') = 4, 'cada documento tiene asiento contabilizado');
select t.afirmar((select sum(debe) - sum(haber) from public.movimientos where empresa_id = (select v from t.ids where k = 'e2')) = 0, 'los asientos cuadran');
select t.afirmar((select sum(haber - debe) from public.movimientos where empresa_id = (select v from t.ids where k = 'e2') and cuenta_tipo = 'ingreso') = 950000,
                 'ingresos = venta afecta + exenta - nota de crédito');

-- Propuesta F29: débito 190.000 - 19.000 (NC) = 171.000; crédito 76.000 - 19.000 no recuperable = 57.000
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e2'), '202610') -> 'lineas' ->> '538')::numeric = 171000, 'F29 código 538 (débito)');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e2'), '202610') -> 'lineas' ->> '537')::numeric = 57000, 'F29 código 537 (crédito)');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e2'), '202610') -> 'lineas' ->> '89')::numeric = 114000, 'F29 código 89 (IVA determinado)');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e2'), '202610') -> 'lineas' ->> '563')::numeric = 950000, 'F29 código 563 (base PPM)');

-- Anular la nota de crédito anula su asiento y la saca del F29
select public.anular_documento((select id from public.documentos where folio = 7 and tipo = 61), 'Emitida por error');
select t.afirmar((select a.estado from public.documentos d join public.asientos a on a.id = d.asiento_id where d.folio = 7 and d.tipo = 61) = 'anulado', 'anulación anula el asiento');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e2'), '202610') -> 'lineas' ->> '538')::numeric = 190000, 'F29 ignora documentos anulados');
select public.guardar_f29((select v from t.ids where k = 'e2'), '202610');
select t.afirmar((select total_pagar from public.f29_declaraciones where empresa_id = (select v from t.ids where k = 'e2') and periodo = '202610') > 0, 'propuesta F29 guardada');

-- Validaciones
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 101, '2026-10-05', '96.790.240-3', 'Cliente Uno', 1000)$$, 'duplicate key');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 200, '2026-10-05', '96.790.240-4', 'Rut malo', 1000)$$, 'RUT inválido');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 34, 201, '2026-10-05', '96.790.240-3', 'X', 1000)$$, 'exento no lleva');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 202, current_date + 5, '96.790.240-3', 'X', 1000)$$, 'futura');
select t.debe_fallar($$select public.anular_documento((select id from public.documentos where folio = 7 and tipo = 61), 'otra vez')$$, 'ya está anulado');

-- Seguridad
select t.debe_fallar($$insert into public.documentos (empresa_id, operacion, tipo, folio, fecha, rut, razon_social, total) values ((select v from t.ids where k = 'e2'), 'venta', 33, 999, '2026-10-01', '96.790.240-3', 'X', 0)$$, 'row-level security|permission denied');
select t.como('00000000-0000-0000-0000-00000000000c', 'aal1');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 300, '2026-10-05', '96.790.240-3', 'X', 1000)$$, 'Sin permiso');
select t.como('00000000-0000-0000-0000-00000000000a');
select t.afirmar((select count(*) from public.documentos where empresa_id = (select v from t.ids where k = 'e2')) = 0, 'otra empresa no ve los documentos');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 301, '2026-10-05', '96.790.240-3', 'X', 1000)$$, 'Sin permiso');
select t.debe_fallar($$select public.propuesta_f29((select v from t.ids where k = 'e2'), '202610')$$, 'Sin permiso');

-- Modo probar rol (carla es admin real de e2)
select t.como('00000000-0000-0000-0000-00000000000c');
select public.probar_rol((select v from t.ids where k = 'e2'), 'lector');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 400, '2026-10-05', '96.790.240-3', 'X', 1000)$$, 'Sin permiso');
update public.empresas set giro = 'Otro' where id = (select v from t.ids where k = 'e2');
select t.afirmar((select giro from public.empresas where id = (select v from t.ids where k = 'e2')) = 'Comercio', 'como lector no puede editar la empresa');
select t.afirmar((select count(*) from public.documentos where empresa_id = (select v from t.ids where k = 'e2')) > 0, 'como lector sigue viendo los documentos');
select public.probar_rol((select v from t.ids where k = 'e2'), 'contador');
select public.registrar_documento((select v from t.ids where k = 'e2'), 'venta', 33, 401, '2026-10-05', '96.790.240-3', 'X', 1000);
select t.afirmar(true, 'como contador puede registrar documentos');
select t.debe_fallar($$select public.agregar_miembro((select v from t.ids where k = 'e2'), 'ana@ejemplo.cl', 'lector')$$, 'administrador');
select public.probar_rol((select v from t.ids where k = 'e2'), 'admin');
select t.afirmar((select rol_prueba from public.miembros where user_id = auth.uid() and empresa_id = (select v from t.ids where k = 'e2')) is null, 'vuelve a administrador');
select public.agregar_miembro((select v from t.ids where k = 'e2'), 'beto@ejemplo.cl', 'asistente');
select t.como('00000000-0000-0000-0000-00000000000b');
select t.debe_fallar($$select public.probar_rol((select v from t.ids where k = 'e2'), 'admin')$$, 'Solo un administrador');
select t.como('00000000-0000-0000-0000-00000000000c');
update public.miembros set rol_prueba = 'admin' where user_id = '00000000-0000-0000-0000-00000000000b';
select t.afirmar((select rol_prueba from public.miembros where user_id = '00000000-0000-0000-0000-00000000000b' and empresa_id = (select v from t.ids where k = 'e2')) is null, 'un no-admin nunca recibe rol de prueba');
insert into public.miembros (empresa_id, user_id, rol) select (select v from t.ids where k = 'e2'), '00000000-0000-0000-0000-00000000000a', 'admin';
select t.debe_fallar($$update public.miembros set rol_prueba = 'lector' where user_id = '00000000-0000-0000-0000-00000000000a' and empresa_id = (select v from t.ids where k = 'e2')$$, 'propio rol de prueba');
reset role;
\o
\echo 'PRUEBAS DE COMPRAS Y VENTAS PASARON'
