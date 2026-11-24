-- Pruebas de la matriz de roles y del módulo de tesorería.
\set QUIET on
\o /dev/null
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000d', 'dani@ejemplo.cl'),
  ('00000000-0000-0000-0000-00000000000e', 'eva@ejemplo.cl'),
  ('00000000-0000-0000-0000-00000000000f', 'fede@ejemplo.cl');
set role authenticated;

-- carla (c) crea e3 y asigna roles: ana asistente, beto tesorero, dani gerente, eva auditora, fede contador
select t.como('00000000-0000-0000-0000-00000000000c');
insert into public.empresas (rut, razon_social, giro, creado_por) values ('77.123.456-9', 'Tres Ltda', 'Servicios', '00000000-0000-0000-0000-00000000000c');
insert into t.ids values ('e3', (select id from public.empresas where rut = '77123456-9'));
select public.agregar_miembro((select v from t.ids where k = 'e3'), 'ana@ejemplo.cl', 'asistente');
select public.agregar_miembro((select v from t.ids where k = 'e3'), 'beto@ejemplo.cl', 'tesorero');
select public.agregar_miembro((select v from t.ids where k = 'e3'), 'dani@ejemplo.cl', 'gerente');
select public.agregar_miembro((select v from t.ids where k = 'e3'), 'eva@ejemplo.cl', 'auditor');
select public.agregar_miembro((select v from t.ids where k = 'e3'), 'fede@ejemplo.cl', 'contador');

-- Asistente: registra documentos y asientos en borrador, no aprueba ni anula
select t.como('00000000-0000-0000-0000-00000000000a');
select t.afirmar('documentos.registrar' = any (public.mis_permisos((select v from t.ids where k = 'e3'))) and not ('asientos.contabilizar' = any (public.mis_permisos((select v from t.ids where k = 'e3')))), 'permisos del asistente');
select public.registrar_documento((select v from t.ids where k = 'e3'), 'venta', 33, 500, '2026-10-10', '96.790.240-3', 'Cliente Tres', 200000);
insert into t.ids values ('doc', (select id from public.documentos where empresa_id = (select v from t.ids where k = 'e3') and folio = 500));
select t.afirmar((select asiento_estado from public.documentos_saldo where id = (select v from t.ids where k = 'doc')) = 'borrador', 'documento del asistente queda por aprobar');
select t.debe_fallar($$select public.contabilizar_asiento((select asiento_id from public.documentos where id = (select v from t.ids where k = 'doc')))$$, 'Solo administradores o contadores');
select t.debe_fallar($$select public.anular_documento((select v from t.ids where k = 'doc'), 'no corresponde')$$, 'Sin permiso');
select t.debe_fallar($$select public.cerrar_periodo((select v from t.ids where k = 'e3'), 2026, 10)$$, 'Sin permiso');

-- Tesorero: no puede pagar un documento sin aprobar
select t.como('00000000-0000-0000-0000-00000000000b');
select t.debe_fallar($$select public.registrar_pago((select v from t.ids where k = 'doc'), '2026-10-20', 1000, (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e3') and es_efectivo and imputable limit 1))$$, 'no está aprobado');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e3'), 'compra', 33, 9, '2026-10-10', '96.790.240-3', 'X', 1000)$$, 'Sin permiso');

-- Contador aprueba; no puede registrar cobros (segregación) ni gestionar usuarios ni reabrir
select t.como('00000000-0000-0000-0000-00000000000f');
select public.contabilizar_asiento((select asiento_id from public.documentos where id = (select v from t.ids where k = 'doc')));
select t.afirmar((select asiento_estado from public.documentos_saldo where id = (select v from t.ids where k = 'doc')) = 'contabilizado', 'contador aprueba el documento');
select t.debe_fallar($$select public.registrar_pago((select v from t.ids where k = 'doc'), '2026-10-20', 1000, (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e3') and es_efectivo and imputable limit 1))$$, 'Sin permiso');
select t.debe_fallar($$select public.agregar_miembro((select v from t.ids where k = 'e3'), 'ana@ejemplo.cl', 'admin')$$, 'Solo un administrador');
select public.registrar_documento((select v from t.ids where k = 'e3'), 'compra', 33, 77, '2026-10-11', '96.790.240-3', 'Proveedor Tres', 50000);
select t.afirmar((select asiento_estado from public.documentos_saldo where folio = 77 and empresa_id = (select v from t.ids where k = 'e3')) = 'contabilizado', 'documento del contador queda contabilizado');

-- Tesorero cobra parcial y paga
select t.como('00000000-0000-0000-0000-00000000000b');
select public.registrar_pago((select v from t.ids where k = 'doc'), '2026-10-20', 100000, (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e3') and es_efectivo and imputable order by codigo limit 1), 'transferencia', 'TRX-1');
select t.afirmar((select saldo from public.documentos_saldo where id = (select v from t.ids where k = 'doc')) = 138000, 'saldo tras cobro parcial');
select t.debe_fallar($$select public.registrar_pago((select v from t.ids where k = 'doc'), '2026-10-21', 200000, (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e3') and es_efectivo and imputable order by codigo limit 1))$$, 'supera el saldo');
select public.registrar_pago((select id from public.documentos where folio = 77 and empresa_id = (select v from t.ids where k = 'e3')), '2026-10-22', 59500, (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e3') and es_efectivo and imputable order by codigo limit 1));
select t.afirmar((public.resumen_tesoreria((select v from t.ids where k = 'e3')) -> 'porCobrar' ->> 'total')::numeric = 138000, 'antigüedad de cuentas por cobrar');
select t.afirmar((public.resumen_tesoreria((select v from t.ids where k = 'e3')) -> 'porPagar' ->> 'total')::numeric = 0, 'compra pagada completa');
select t.afirmar((select count(*) from public.pagos p join public.asientos a on a.id = p.asiento_id where p.empresa_id = (select v from t.ids where k = 'e3') and a.estado = 'contabilizado') = 2, 'cobros y pagos generan asiento contabilizado');
select t.afirmar((select sum(debe) - sum(haber) from public.movimientos where empresa_id = (select v from t.ids where k = 'e3')) = 0, 'contabilidad cuadra con tesorería');

-- Contador no puede anular un documento con cobros
select t.como('00000000-0000-0000-0000-00000000000f');
select t.debe_fallar($$select public.anular_documento((select v from t.ids where k = 'doc'), 'error de folio')$$, 'cobros o pagos registrados');

-- Tesorero anula el cobro
select t.como('00000000-0000-0000-0000-00000000000b');
select public.anular_pago((select id from public.pagos where documento_id = (select v from t.ids where k = 'doc')), 'Transferencia rebotada');
select t.afirmar((select saldo from public.documentos_saldo where id = (select v from t.ids where k = 'doc')) = 238000, 'anular cobro restituye el saldo');

-- Gerente: solo consulta
select t.como('00000000-0000-0000-0000-00000000000d');
select t.afirmar(public.resumen_tesoreria((select v from t.ids where k = 'e3')) is not null, 'gerente ve tesorería');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e3'), 'venta', 33, 600, '2026-10-10', '96.790.240-3', 'X', 1000)$$, 'Sin permiso');
select t.debe_fallar($$select public.guardar_f29((select v from t.ids where k = 'e3'), '202610')$$, 'Sin permiso');
select t.afirmar((select count(*) from public.auditoria where empresa_id = (select v from t.ids where k = 'e3')) = 0, 'gerente no ve la auditoría');
update public.periodos set estado = 'cerrado' where empresa_id = (select v from t.ids where k = 'e3');
select t.afirmar((select count(*) from public.periodos where empresa_id = (select v from t.ids where k = 'e3') and estado = 'cerrado') = 0, 'nadie modifica períodos por fuera de las funciones');

-- Auditor: ve y verifica la auditoría, no escribe
select t.como('00000000-0000-0000-0000-00000000000e');
select t.afirmar((select count(*) from public.auditoria where empresa_id = (select v from t.ids where k = 'e3')) > 0, 'auditor ve la auditoría');
select t.afirmar(public.verificar_auditoria((select v from t.ids where k = 'e3')) is null, 'auditor verifica la integridad');
select t.debe_fallar($$select public.crear_asiento((select v from t.ids where k = 'e3'), '2026-10-12', 'x', '[]'::jsonb)$$, 'Sin permiso');

-- Contador cierra; solo el admin reabre
select t.como('00000000-0000-0000-0000-00000000000f');
select public.cerrar_periodo((select v from t.ids where k = 'e3'), 2026, 10);
select t.debe_fallar($$select public.reabrir_periodo((select v from t.ids where k = 'e3'), 2026, 10)$$, 'Solo un administrador');
select t.como('00000000-0000-0000-0000-00000000000c');
select public.reabrir_periodo((select v from t.ids where k = 'e3'), 2026, 10);
select t.afirmar((select estado from public.periodos where empresa_id = (select v from t.ids where k = 'e3') and anio = 2026 and mes = 10) = 'abierto', 'admin reabre el período');

-- Modo "ver como tesorero" para el admin aplica los permisos reales
select public.probar_rol((select v from t.ids where k = 'e3'), 'tesorero');
select t.afirmar('tesoreria.registrar' = any (public.mis_permisos((select v from t.ids where k = 'e3'))) and not ('documentos.registrar' = any (public.mis_permisos((select v from t.ids where k = 'e3')))), 'ver como tesorero cambia los permisos');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e3'), 'venta', 33, 700, '2026-10-10', '96.790.240-3', 'X', 1000)$$, 'Sin permiso');
select public.probar_rol((select v from t.ids where k = 'e3'), 'admin');
reset role;
\o
\echo 'PRUEBAS DE ROLES Y TESORERÍA PASARON'
