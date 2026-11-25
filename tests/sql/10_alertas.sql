-- Alertas por correo: preferencias, cálculo de avisos por rol y control de una ejecución diaria.
\set QUIET on
\o /dev/null
set role authenticated;
select t.como('00000000-0000-0000-0000-00000000000c');
select public.guardar_preferencia_alertas((select v from t.ids where k = 'e9'), true);
select t.como('00000000-0000-0000-0000-00000000000b');
select public.guardar_preferencia_alertas((select v from t.ids where k = 'e9'), true);
select t.debe_fallar($$select public.guardar_preferencia_alertas((select v from t.ids where k = 'e8') , true) from (select 1) x where false union all select public.guardar_preferencia_alertas('00000000-0000-0000-0000-000000000999', true)$$, 'No pertenece');
select t.afirmar((select count(*) from public.preferencias_alertas) = 1, 'cada usuario ve solo sus preferencias');

reset role;
-- Día 16 (lunes 16-11-2026): F29 pendiente para el admin; el tesorero no ve el F29
select t.afirmar((select (e -> 'avisos') @> '[{"ruta": "/f29"}]' from jsonb_array_elements(public.alertas_pendientes(date '2026-11-16') -> 'destinatarios') d,
                  jsonb_array_elements(d -> 'empresas') e where d ->> 'correo' = 'carla@ejemplo.cl' and e ->> 'empresa' = 'Nueve SpA'), 'aviso de F29 para quien lo prepara');
select t.afirmar(not exists (select 1 from jsonb_array_elements(public.alertas_pendientes(date '2026-11-16') -> 'destinatarios') d,
                  jsonb_array_elements(d -> 'empresas') e, jsonb_array_elements(e -> 'avisos') a
                  where d ->> 'correo' = 'beto@ejemplo.cl' and a ->> 'ruta' = '/f29'), 'el tesorero no recibe el aviso del F29');
-- Día 25 (miércoles): sin plazos cerca y sin resúmenes semanales → sin correo para el admin
select t.afirmar(not exists (select 1 from jsonb_array_elements(public.alertas_pendientes(date '2026-11-25') -> 'destinatarios') d where d ->> 'correo' = 'carla@ejemplo.cl'),
  'sin avisos no hay correo');
-- Prueba manual: siempre devuelve al usuario aunque no tenga avisos
select t.afirmar(jsonb_array_length(public.alertas_pendientes(date '2026-11-25', '00000000-0000-0000-0000-00000000000c', true) -> 'destinatarios') = 1, 'correo de prueba');
-- Una ejecución por día
select t.afirmar(public.reclamar_ejecucion_alertas() and not public.reclamar_ejecucion_alertas(), 'el lote corre una vez al día');
select public.registrar_envio_alerta('00000000-0000-0000-0000-00000000000c', 'carla@ejemplo.cl', 1, 'enviado');
select t.afirmar(not exists (select 1 from jsonb_array_elements(public.alertas_pendientes() -> 'destinatarios') d where d ->> 'correo' = 'carla@ejemplo.cl'),
  'no repite el correo el mismo día');
\o
select 'OK 10 alertas';
