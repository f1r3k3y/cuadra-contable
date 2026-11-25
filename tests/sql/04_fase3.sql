-- Fase 3a: nota de crédito asociada, vencimientos y edición de borradores.
\set QUIET on
\o /dev/null
set role authenticated;

select t.como('00000000-0000-0000-0000-00000000000c');
insert into public.empresas (rut, razon_social, giro, creado_por) values ('76.354.771-K', 'Cuatro SpA', 'Comercio', '00000000-0000-0000-0000-00000000000c');
insert into t.ids values ('e4', (select id from public.empresas where rut = '76354771-K'));
select public.agregar_miembro((select v from t.ids where k = 'e4'), 'ana@ejemplo.cl', 'asistente');

-- Factura con vencimiento a 30 días (por vencer) y otra antigua sin vencimiento (vencida hace 50 días)
select public.registrar_documento(p_empresa := (select v from t.ids where k = 'e4'), p_operacion := 'venta', p_tipo := 33, p_folio := 1,
  p_fecha := current_date - 10, p_rut := '96.790.240-3', p_razon := 'Cliente Uno', p_neto := 100000, p_vencimiento := current_date + 20);
select public.registrar_documento((select v from t.ids where k = 'e4'), 'venta', 33, 2, current_date - 50, '96.790.240-3', 'Cliente Uno', 10000);
insert into t.ids values ('x4f', (select id from public.documentos where empresa_id = (select v from t.ids where k = 'e4') and folio = 1));
select t.afirmar((select vencimiento from public.documentos where id = (select v from t.ids where k = 'x4f')) = current_date + 20, 'vencimiento guardado');

select t.debe_fallar($$select public.registrar_documento(p_empresa := (select v from t.ids where k = 'e4'), p_operacion := 'venta', p_tipo := 33, p_folio := 3,
  p_fecha := current_date - 10, p_rut := '96.790.240-3', p_razon := 'X', p_neto := 1000, p_vencimiento := current_date - 11)$$, 'vencimiento no puede ser anterior');

-- Nota de crédito: exige referencia, mismo RUT y no supera el saldo
select t.debe_fallar($$select public.registrar_documento((select v from t.ids where k = 'e4'), 'venta', 61, 10, current_date - 5, '96.790.240-3', 'Cliente Uno', 1000)$$, 'Indique el documento');
select t.debe_fallar($$select public.registrar_documento(p_empresa := (select v from t.ids where k = 'e4'), p_operacion := 'venta', p_tipo := 61, p_folio := 10,
  p_fecha := current_date - 5, p_rut := '77.123.456-9', p_razon := 'Otro', p_neto := 1000, p_referencia := (select v from t.ids where k = 'x4f'))$$, 'otro RUT');
select t.debe_fallar($$select public.registrar_documento(p_empresa := (select v from t.ids where k = 'e4'), p_operacion := 'venta', p_tipo := 61, p_folio := 10,
  p_fecha := current_date - 5, p_rut := '96.790.240-3', p_razon := 'Cliente Uno', p_neto := 100001, p_referencia := (select v from t.ids where k = 'x4f'))$$, 'supera el saldo');
select t.debe_fallar($$select public.registrar_documento(p_empresa := (select v from t.ids where k = 'e4'), p_operacion := 'venta', p_tipo := 61, p_folio := 10,
  p_fecha := current_date - 11, p_rut := '96.790.240-3', p_razon := 'Cliente Uno', p_neto := 1000, p_referencia := (select v from t.ids where k = 'x4f'))$$, 'fecha anterior');
select public.registrar_documento(p_empresa := (select v from t.ids where k = 'e4'), p_operacion := 'venta', p_tipo := 61, p_folio := 10,
  p_fecha := current_date - 5, p_rut := '96.790.240-3', p_razon := 'Cliente Uno', p_neto := 20000, p_referencia := (select v from t.ids where k = 'x4f'));
select t.afirmar((select saldo from public.documentos_saldo where id = (select v from t.ids where k = 'x4f')) = 95200, 'la nota de crédito rebaja el saldo de la factura');
select t.afirmar((select notas_credito from public.documentos_saldo where id = (select v from t.ids where k = 'x4f')) = 23800, 'notas de crédito informadas en la vista');
select t.debe_fallar($$select public.anular_documento((select v from t.ids where k = 'x4f'), 'Prueba de anulación')$$, 'notas de crédito o débito vigentes');

-- Antigüedad desde el vencimiento
select t.afirmar((public.resumen_tesoreria((select v from t.ids where k = 'e4')) -> 'porCobrar' ->> 'porVencer')::numeric = 95200, 'factura por vencer');
select t.afirmar((public.resumen_tesoreria((select v from t.ids where k = 'e4')) -> 'porCobrar' ->> 'a60')::numeric = 11900, 'factura sin vencimiento cuenta desde la emisión');
select t.afirmar((public.resumen_tesoreria((select v from t.ids where k = 'e4')) -> 'porCobrar' ->> 'vencido')::numeric = 11900, 'total vencido');

-- El cobro no puede superar el saldo rebajado por la nota de crédito
select t.debe_fallar($$select public.registrar_pago((select v from t.ids where k = 'x4f'), current_date, 95201,
  (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e4') and es_efectivo and imputable order by codigo limit 1))$$, 'supera el saldo');
select public.registrar_pago((select v from t.ids where k = 'x4f'), current_date, 95200,
  (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e4') and es_efectivo and imputable order by codigo limit 1));
select t.afirmar((select saldo from public.documentos_saldo where id = (select v from t.ids where k = 'x4f')) = 0, 'factura saldada con NC + cobro');

-- Editar un comprobante manual en borrador
insert into t.ids values ('x4c1', (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e4') and imputable and activa order by codigo limit 1));
insert into t.ids values ('x4c2', (select id from public.cuentas where empresa_id = (select v from t.ids where k = 'e4') and imputable and activa order by codigo limit 1 offset 1));
insert into t.ids values ('x4a', (select (public.crear_asiento((select v from t.ids where k = 'e4'), current_date, 'Borrador original',
  jsonb_build_array(jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c1'), 'debe', 1000),
                    jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c2'), 'haber', 1000)))).id));
select public.editar_asiento((select v from t.ids where k = 'x4a'), current_date - 1, 'Borrador corregido',
  jsonb_build_array(jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c1'), 'debe', 1500),
                    jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c2'), 'haber', 1000),
                    jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c2'), 'haber', 500)));
select t.afirmar((select glosa from public.asientos where id = (select v from t.ids where k = 'x4a')) = 'Borrador corregido'
  and (select fecha from public.asientos where id = (select v from t.ids where k = 'x4a')) = current_date - 1, 'cabecera editada');
select t.afirmar((select count(*) from public.asiento_lineas where asiento_id = (select v from t.ids where k = 'x4a')) = 3
  and (select sum(debe) from public.asiento_lineas where asiento_id = (select v from t.ids where k = 'x4a')) = 1500, 'líneas reemplazadas');
select t.debe_fallar($$select public.editar_asiento((select v from t.ids where k = 'x4a'), current_date, 'X',
  jsonb_build_array(jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c1'), 'debe', 1)))$$, 'al menos dos líneas');
select public.contabilizar_asiento((select v from t.ids where k = 'x4a'));
select t.debe_fallar($$select public.editar_asiento((select v from t.ids where k = 'x4a'), current_date, 'Otra',
  jsonb_build_array(jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c1'), 'debe', 1),
                    jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c2'), 'haber', 1)))$$, 'Solo se pueden editar comprobantes en borrador');

-- El borrador que genera un documento del asistente no se edita a mano
select t.como('00000000-0000-0000-0000-00000000000a');
select public.registrar_documento((select v from t.ids where k = 'e4'), 'compra', 33, 55, current_date, '77.123.456-9', 'Proveedor', 5000);
select t.debe_fallar($$select public.editar_asiento((select asiento_id from public.documentos where empresa_id = (select v from t.ids where k = 'e4') and folio = 55),
  current_date, 'Cambio', jsonb_build_array(jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c1'), 'debe', 1),
                    jsonb_build_object('cuenta_id', (select v from t.ids where k = 'x4c2'), 'haber', 1)))$$, 'lo generó un documento');

reset role;
\o
\echo 'PRUEBAS DE FASE 3A PASARON'
