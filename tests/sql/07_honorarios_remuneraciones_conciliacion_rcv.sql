-- Honorarios, remuneraciones, conciliación bancaria, RCV y preparación SII.
\set QUIET on
\o /dev/null
set role authenticated;

select t.como('00000000-0000-0000-0000-00000000000c');
insert into public.empresas (rut, razon_social, giro, creado_por, tasa_ppm, direccion, comuna)
values ('76.543.210-3', 'Siete SpA', 'Servicios', '00000000-0000-0000-0000-00000000000c', 0.25, 'Av. Uno 123', 'Santiago');
insert into t.ids values ('e7', (select id from public.empresas where rut = '76543210-3'));
reset role;
insert into public.miembros (empresa_id, user_id, rol) values
  ((select v::uuid from t.ids where k = 'e7'), '00000000-0000-0000-0000-00000000000a', 'asistente'),
  ((select v::uuid from t.ids where k = 'e7'), '00000000-0000-0000-0000-00000000000b', 'tesorero');
set role authenticated;
select t.como('00000000-0000-0000-0000-00000000000c');

select t.afirmar((select cuenta_retencion_honorarios is not null and cuenta_impuesto_unico is not null and cuenta_gastos_bancarios is not null
  from public.configuracion_cuentas where empresa_id = (select v from t.ids where k = 'e7')), 'cuentas automáticas nuevas en empresa nueva');
select t.afirmar(public.tasa_retencion_honorarios(date '2026-11-25') = 15.25 and public.tasa_retencion_honorarios(date '2025-06-01') = 14.5, 'tasa de retención por año');

-- ---------------------------------------------------------------- Honorarios
select public.registrar_honorario((select v from t.ids where k = 'e7'), 120, current_date, '12.345.678-5', 'Pedro Pérez', 1000000);
select t.afirmar((select retencion from public.documentos where operacion = 'honorario' and folio = 120) = 152500, 'retención 15,25 %');
select t.afirmar((select saldo from public.documentos_saldo where operacion = 'honorario' and folio = 120) = 847500, 'saldo por pagar es el líquido');
select t.afirmar((select count(*) from public.asiento_lineas l join public.documentos d on d.asiento_id = l.asiento_id
  where d.operacion = 'honorario' and d.folio = 120) = 3, 'asiento con gasto, retención y por pagar');
select public.registrar_honorario((select v from t.ids where k = 'e7'), 121, current_date, '12.345.678-5', 'Pedro Pérez', 200000, false);
select t.afirmar((select retencion from public.documentos where operacion = 'honorario' and folio = 121) = 0, 'sin retención cuando la retiene el emisor');
select t.debe_fallar($$select public.registrar_honorario((select v from t.ids where k = 'e7'), 122, current_date, '12.345.678-0', 'X', 1000)$$, 'RUT inválido');
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e7'), 'honorario', 900, 5, current_date, '12.345.678-5', 'X', 1000)$$, 'Operación inválida');

-- El asistente registra, queda por aprobar y no entra al F29
select t.como('00000000-0000-0000-0000-00000000000a');
select public.registrar_honorario((select v from t.ids where k = 'e7'), 130, current_date, '12.345.678-5', 'Pedro Pérez', 100000);
select t.como('00000000-0000-0000-0000-00000000000c');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM')) -> 'lineas' ->> '151')::numeric = 152500, 'F29 151: solo honorarios aprobados');

-- Pago del honorario desde tesorería rebaja Honorarios por pagar
select t.como('00000000-0000-0000-0000-00000000000b');
select public.registrar_pago((select id from public.documentos where operacion = 'honorario' and folio = 120), current_date, 847500,
  (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e7') and codigo = '1.1.01.02'));
select t.afirmar((select saldo from public.documentos_saldo where operacion = 'honorario' and folio = 120) = 0, 'honorario pagado');
select t.afirmar((public.resumen_tesoreria((select v from t.ids where k = 'e7')) -> 'porPagar' ->> 'total')::numeric = 200000, 'honorarios en por pagar');
select t.como('00000000-0000-0000-0000-00000000000c');

select t.afirmar((select c.codigo from public.pagos p join public.asiento_lineas l on l.asiento_id = p.asiento_id and l.debe > 0
  join public.cuentas c on c.id = l.cuenta_id where p.documento_id = (select id from public.documentos where operacion = 'honorario' and folio = 120)) = '2.1.01.02',
  'el pago debita honorarios por pagar');

-- ---------------------------------------------------------------- Remuneraciones
select t.afirmar(public.impuesto_unico(900000, 69000) = 0, 'impuesto único exento bajo 13,5 UTM');
select t.afirmar(public.impuesto_unico(1500000, 69000) = round(1500000 * 0.04 - 0.54 * 69000), 'impuesto único segundo tramo');
select public.registrar_remuneraciones((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM'), current_date,
  '[{"rut":"11.111.111-1","nombre":"Ana Uno","imponible":1500000,"no_imponible":60000,"afp":167000,"salud":105000,"afc_trabajador":9000,"impuesto_unico":22740,"aporte_empleador":60000},
    {"rut":"22.222.222-2","nombre":"Beto Dos","imponible":600000,"afp":66800,"salud":42000,"afc_trabajador":3600,"otros_descuentos":50000}]'::jsonb,
  69000, (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e7') and codigo = '1.1.05.02'));
select t.afirmar((select total_debe from public.asientos a join public.remuneraciones r on r.asiento_id = a.id
  where r.empresa_id = (select v from t.ids where k = 'e7')) = 2220000, 'centralización: gasto = haberes + aporte');
select t.afirmar((select a.estado from public.asientos a join public.remuneraciones r on r.asiento_id = a.id
  where r.empresa_id = (select v from t.ids where k = 'e7')) = 'contabilizado', 'centralización contabilizada');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM')) -> 'lineas' ->> '48')::numeric = 22740, 'F29 48: impuesto único');
select t.afirmar((public.propuesta_f29((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM')) -> 'lineas' ->> '91')::numeric
  = (public.propuesta_f29((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM')) -> 'lineas' ->> '62')::numeric + 22740 + 152500, 'F29 91 suma retenciones');
select t.debe_fallar($$select public.registrar_remuneraciones((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM'), current_date, '[{"rut":"11.111.111-1","nombre":"A","imponible":1}]')$$, 'Ya hay remuneraciones');
select t.debe_fallar($$select public.registrar_remuneraciones((select v from t.ids where k = 'e7'), '202601', date '2026-01-31', '[{"rut":"11.111.111-1","nombre":"A","imponible":100,"otros_descuentos":10}]')$$, 'cuenta de los otros descuentos');
select t.debe_fallar($$select public.registrar_remuneraciones((select v from t.ids where k = 'e7'), '202601', date '2026-01-31', '[{"rut":"11.111.111-1","nombre":"A","imponible":100,"afp":200}]')$$, 'check');

-- Sueldos: el asistente y el tesorero no ven el detalle
select t.como('00000000-0000-0000-0000-00000000000a');
select t.afirmar((select count(*) from public.remuneracion_lineas) = 0, 'asistente no ve sueldos');
select t.como('00000000-0000-0000-0000-00000000000b');
select t.afirmar((select count(*) from public.remuneracion_lineas) = 0, 'tesorero no ve sueldos');
select t.afirmar((select liquido from public.remuneraciones_por_pagar((select v from t.ids where k = 'e7'))) = 1693860, 'tesorero ve el líquido total por pagar');
select public.pagar_remuneraciones((select id from public.remuneraciones where empresa_id = (select v from t.ids where k = 'e7')), current_date,
  (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e7') and codigo = '1.1.01.02'));
select t.debe_fallar($$select public.pagar_remuneraciones((select id from public.remuneraciones where empresa_id = (select v from t.ids where k = 'e7')), current_date,
  (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e7') and codigo = '1.1.01.02'))$$, 'ya están pagados');
select t.como('00000000-0000-0000-0000-00000000000c');
select t.afirmar((select pagado_en from public.remuneraciones where empresa_id = (select v from t.ids where k = 'e7')) = current_date, 'sueldos pagados');
select t.debe_fallar($$select public.anular_remuneraciones((select id from public.remuneraciones where empresa_id = (select v from t.ids where k = 'e7')), 'error de carga')$$, 'ya se pagaron');

-- ---------------------------------------------------------------- Conciliación bancaria
insert into t.ids values ('banco7', (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e7') and codigo = '1.1.01.02'));
select t.como('00000000-0000-0000-0000-00000000000b');
select t.afirmar((public.importar_cartola((select v from t.ids where k = 'e7'), (select v from t.ids where k = 'banco7'),
  jsonb_build_array(
    jsonb_build_object('fecha', current_date, 'descripcion', 'TRANSF A PEDRO PEREZ', 'monto', -847500, 'saldo', -847500, 'huella', 'h-0001-a'),
    jsonb_build_object('fecha', current_date, 'descripcion', 'COMISION MANTENCION', 'monto', -5950, 'saldo', -853450, 'huella', 'h-0002-a'),
    jsonb_build_object('fecha', current_date, 'descripcion', 'ABONO DESCONOCIDO', 'monto', 10000, 'saldo', -843450, 'huella', 'h-0003-a')))
  ->> 'conciliados')::int = 1, 'concilia automáticamente el pago del honorario');
select t.afirmar((public.importar_cartola((select v from t.ids where k = 'e7'), (select v from t.ids where k = 'banco7'),
  jsonb_build_array(jsonb_build_object('fecha', current_date, 'descripcion', 'COMISION MANTENCION', 'monto', -5950, 'huella', 'h-0002-a'))) ->> 'repetidos')::int = 1,
  'no duplica movimientos ya cargados');
select public.contabilizar_movimiento((select id from public.cartola_movimientos where huella = 'h-0002-a'),
  (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e7') and codigo = '5.3.01'), 'Comisión bancaria');
select t.afirmar((select estado from public.cartola_movimientos where huella = 'h-0002-a') = 'conciliado', 'comisión contabilizada y conciliada');
select t.debe_fallar($$select public.ignorar_movimiento((select id from public.cartola_movimientos where huella = 'h-0003-a'), 'x')$$, 'Explique');
select t.debe_fallar($$select public.conciliar_movimiento((select id from public.cartola_movimientos where huella = 'h-0003-a'),
  (select linea_id from public.cartola_movimientos where huella = 'h-0001-a'))$$, 'ya está conciliada');
select t.como('00000000-0000-0000-0000-00000000000c');
select t.afirmar(jsonb_array_length(public.resumen_conciliacion((select v from t.ids where k = 'e7'), (select v from t.ids where k = 'banco7')) -> 'bancoPendiente') = 1
  and (public.resumen_conciliacion((select v from t.ids where k = 'e7'), (select v from t.ids where k = 'banco7')) ->> 'saldoBanco')::numeric = -843450,
  'resumen: un pendiente en banco y saldo según cartola');
select t.afirmar(jsonb_array_length(public.resumen_conciliacion((select v from t.ids where k = 'e7'), (select v from t.ids where k = 'banco7')) -> 'libroPendiente') = 1,
  'resumen: pago de sueldos pendiente en el banco');
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$select public.resumen_conciliacion((select v from t.ids where k = 'e7'), (select v from t.ids where k = 'banco7'))$$, 'Sin permiso');
select t.como('00000000-0000-0000-0000-00000000000c');

-- ---------------------------------------------------------------- RCV
select public.registrar_documento((select v from t.ids where k = 'e7'), 'compra', 33, 500, current_date, '77.123.456-9', 'Proveedor Uno', 100000);
select public.registrar_documento((select v from t.ids where k = 'e7'), 'compra', 33, 501, current_date, '77.123.456-9', 'Proveedor Uno', 50000);
select t.afirmar((public.importar_rcv((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM'), 'compra',
  jsonb_build_array(
    jsonb_build_object('tipo', 33, 'folio', 500, 'rut', '77123456-9', 'razonSocial', 'Proveedor Uno', 'fechaEmision', current_date, 'neto', 100000, 'iva', 19000, 'total', 119000),
    jsonb_build_object('tipo', 33, 'folio', 501, 'rut', '77123456-9', 'razonSocial', 'Proveedor Uno', 'fechaEmision', current_date, 'neto', 60000, 'iva', 11400, 'total', 71400),
    jsonb_build_object('tipo', 33, 'folio', 777, 'rut', '96790240-3', 'razonSocial', 'Proveedor Nuevo', 'fechaEmision', current_date, 'neto', 20000, 'iva', 3800, 'total', 23800)))
  -> 'cuadratura' -> 'resumen' ->> 'cuadran')::int = 1, 'RCV: una coincide');
select t.afirmar((public.cuadratura_rcv((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM'), 'COMPRA') -> 'resumen' ->> 'soloEnSii')::int = 1
  and (public.cuadratura_rcv((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM'), 'COMPRA') -> 'resumen' ->> 'montoDistinto')::int = 1, 'RCV: falta una y otra difiere');
select t.afirmar((public.registrar_desde_rcv((select v from t.ids where k = 'e7'),
  array(select id from public.rcv_registros where empresa_id = (select v from t.ids where k = 'e7') and folio = 777)) ->> 'registrados')::int = 1, 'registra desde el RCV');
select t.afirmar((select origen from public.documentos where empresa_id = (select v from t.ids where k = 'e7') and folio = 777) = 'rcv', 'documento marcado como del RCV');
select t.afirmar((public.cuadratura_rcv((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM'), 'COMPRA') -> 'resumen' ->> 'soloEnSii')::int = 0, 'ya no falta');
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$select public.importar_rcv((select v from t.ids where k = 'e7'), to_char(current_date, 'YYYYMM'), 'COMPRA', '[]')$$, 'Sin permiso');
select t.como('00000000-0000-0000-0000-00000000000c');

-- ---------------------------------------------------------------- SII
select t.afirmar(not (public.estado_sii((select v from t.ids where k = 'e7')) ->> 'listo')::boolean, 'SII no listo al inicio');
select public.configurar_sii((select v from t.ids where k = 'e7'), 'proveedor', 'certificacion', 'openfactura', null, null, null, null, '{620200}');
select t.afirmar((select count(*) from jsonb_array_elements(public.estado_sii((select v from t.ids where k = 'e7')) -> 'items') i where not (i ->> 'ok')::boolean) = 1,
  'con proveedor solo falta la clave de API');
select t.debe_fallar($$select public.configurar_sii((select v from t.ids where k = 'e7'), 'proveedor', 'certificacion')$$, 'Elija el proveedor');
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$select public.configurar_sii((select v from t.ids where k = 'e7'), 'directo', 'certificacion')$$, 'Solo el administrador');

reset role;
\o
\echo 'PRUEBAS DE HONORARIOS, REMUNERACIONES, CONCILIACIÓN, RCV Y SII PASARON'
