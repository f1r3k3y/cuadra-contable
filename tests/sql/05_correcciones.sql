-- Correcciones de la segunda revisión: F29 solo aprobados y presentado, cuentas protegidas, panel.
\set QUIET on
\o /dev/null
set role authenticated;

select t.como('00000000-0000-0000-0000-00000000000c');
insert into public.empresas (rut, razon_social, giro, creado_por, tasa_ppm) values ('78.414.390-2', 'Cinco SpA', 'Comercio', '00000000-0000-0000-0000-00000000000c', 0.25);
insert into t.ids values ('e5', (select id from public.empresas where rut = '78414390-2'));
select public.agregar_miembro((select v from t.ids where k = 'e5'), 'ana@ejemplo.cl', 'asistente');

-- Venta y compra aprobadas (admin) + compra del asistente por aprobar
select public.registrar_documento((select v from t.ids where k = 'e5'), 'venta', 33, 1, current_date, '96.790.240-3', 'Cliente', 100000);
select public.registrar_documento((select v from t.ids where k = 'e5'), 'compra', 33, 1, current_date, '77.123.456-9', 'Proveedor', 40000);
select t.como('00000000-0000-0000-0000-00000000000a');
select public.registrar_documento((select v from t.ids where k = 'e5'), 'compra', 33, 2, current_date, '77.123.456-9', 'Proveedor', 10000);
select t.como('00000000-0000-0000-0000-00000000000c');

-- R1: el F29 ignora la compra por aprobar y la informa como pendiente
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM')) -> 'lineas' ->> '537')::numeric = 7600, 'F29 sin documentos por aprobar');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM')) ->> 'pendientes')::int = 1, 'F29 informa pendientes');

-- P2: IVA del mes del panel igual al F29
select t.afirmar(((public.metricas_dashboard((select v from t.ids where k = 'e5'), extract(year from current_date)::int) -> 'ivaMesActual' ->> 'debito')::numeric
  - (public.metricas_dashboard((select v from t.ids where k = 'e5'), extract(year from current_date)::int) -> 'ivaMesActual' ->> 'credito')::numeric) = 19000 - 7600, 'IVA del mes desde el libro');

-- R4: guardar, cambiar, marcar presentado
select public.guardar_f29((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM'));
select public.contabilizar_asiento((select asiento_id from public.documentos where empresa_id = (select v from t.ids where k = 'e5') and operacion = 'compra' and folio = 2));
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM')) -> 'guardada' ->> 'cambio')::boolean, 'detecta propuesta cambiada');
select t.debe_fallar($$select public.marcar_f29_presentado((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM'))$$, 'cambió desde que se guardó');
select public.guardar_f29((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM'));
select public.marcar_f29_presentado((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM'), '123456');
select t.afirmar((select estado from public.f29_declaraciones where empresa_id = (select v from t.ids where k = 'e5')) = 'presentado', 'F29 marcado como presentado');
select t.debe_fallar($$select public.guardar_f29((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM'))$$, 'ya está marcado como presentado');
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$select public.marcar_f29_presentado((select v from t.ids where k = 'e5'), to_char(current_date, 'YYYYMM'))$$, 'Sin permiso');
select t.como('00000000-0000-0000-0000-00000000000c');

-- R2: no se desactivan cuentas automáticas ni con saldo
select t.debe_fallar($$update public.cuentas set activa = false where id = (select cuenta_clientes from public.configuracion_cuentas where empresa_id = (select v from t.ids where k = 'e5'))$$, 'cuenta automática');
insert into t.ids values ('c5', (select l.cuenta_id from public.asiento_lineas l join public.documentos d on d.asiento_id = l.asiento_id
  where d.empresa_id = (select v from t.ids where k = 'e5') and d.operacion = 'compra' and d.folio = 1 and l.debe = 40000));
update public.configuracion_cuentas set cuenta_gasto_defecto = (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e5') and tipo = 'gasto' and imputable and id <> (select v from t.ids where k = 'c5') order by codigo desc limit 1)
 where empresa_id = (select v from t.ids where k = 'e5');
select t.debe_fallar($$update public.cuentas set activa = false where id = (select v from t.ids where k = 'c5')$$, 'tiene saldo .\$50\.000');
update public.cuentas set activa = false where empresa_id = (select v from t.ids where k = 'e5') and codigo = (select min(codigo) from public.cuentas where empresa_id = (select v from t.ids where k = 'e5') and tipo = 'gasto' and imputable and not app.es_cuenta_automatica(id) and app.saldo_cuenta(id) = 0);
select t.afirmar((select count(*) from public.cuentas where empresa_id = (select v from t.ids where k = 'e5') and not activa) = 1, 'cuenta sin saldo se desactiva');

-- P8: montos con formato en los mensajes
select t.debe_fallar($$select public.registrar_pago((select id from public.documentos where empresa_id = (select v from t.ids where k = 'e5') and operacion = 'venta' and folio = 1), current_date, 999999,
  (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e5') and es_efectivo and imputable order by codigo limit 1))$$, '\$119\.000');

reset role;
\o
\echo 'PRUEBAS DE CORRECCIONES PASARON'
