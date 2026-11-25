-- Boletas de honorarios (con retención al F29) y centralización de remuneraciones (impuesto único al F29).

-- ---------------------------------------------------------------------------
-- 0. Permisos, orígenes de asientos y cuentas automáticas nuevas

insert into app.permisos_rol (rol, permiso)
select r::public.rol_empresa, p from (values
  ('honorarios.registrar',      '{admin,contador,asistente}'),
  ('remuneraciones.ver',        '{admin,contador,gerente,auditor}'),
  ('remuneraciones.registrar',  '{admin,contador}'),
  ('conciliacion.ver',          '{admin,contador,tesorero,gerente,auditor}'),
  ('conciliacion.gestionar',    '{admin,contador,tesorero}'),
  ('rcv.ver',                   '{admin,contador,asistente,auditor}'),
  ('rcv.importar',              '{admin,contador}'),
  ('sii.ver',                   '{admin,contador,auditor}'),
  ('sii.configurar',            '{admin}'),
  ('sii.emitir',                '{admin,contador,asistente}')
) m(p, roles), unnest(m.roles::text[]) r
on conflict do nothing;

alter table public.asientos drop constraint asientos_origen_check;
alter table public.asientos add constraint asientos_origen_check check (origen = any (array['manual','dte_emitido','dte_recibido',
  'documento_venta','documento_compra','documento_honorario','cobro','pago','remuneracion','pago_remuneracion','conciliacion',
  'f29','cierre','apertura','reverso','importacion']));

alter table public.configuracion_cuentas
  add column cuenta_gasto_honorarios uuid references public.cuentas(id),
  add column cuenta_honorarios_por_pagar uuid references public.cuentas(id),
  add column cuenta_retencion_honorarios uuid references public.cuentas(id),
  add column cuenta_gasto_remuneraciones uuid references public.cuentas(id),
  add column cuenta_remuneraciones_por_pagar uuid references public.cuentas(id),
  add column cuenta_leyes_sociales uuid references public.cuentas(id),
  add column cuenta_impuesto_unico uuid references public.cuentas(id),
  add column cuenta_gastos_bancarios uuid references public.cuentas(id);

-- Completa las cuentas nuevas por código del plan base (empresas nuevas y existentes)
create or replace function app.completar_cuentas_nuevas() returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  f_cuenta text := 'select id from public.cuentas where empresa_id = $1 and codigo = $2 and imputable and activa';
begin
  if new.cuenta_gasto_honorarios is null then execute f_cuenta into new.cuenta_gasto_honorarios using new.empresa_id, '5.2.02'; end if;
  if new.cuenta_honorarios_por_pagar is null then execute f_cuenta into new.cuenta_honorarios_por_pagar using new.empresa_id, '2.1.01.02'; end if;
  if new.cuenta_retencion_honorarios is null then execute f_cuenta into new.cuenta_retencion_honorarios using new.empresa_id, '2.1.02.03'; end if;
  if new.cuenta_gasto_remuneraciones is null then execute f_cuenta into new.cuenta_gasto_remuneraciones using new.empresa_id, '5.2.01'; end if;
  if new.cuenta_remuneraciones_por_pagar is null then execute f_cuenta into new.cuenta_remuneraciones_por_pagar using new.empresa_id, '2.1.03.01'; end if;
  if new.cuenta_leyes_sociales is null then execute f_cuenta into new.cuenta_leyes_sociales using new.empresa_id, '2.1.03.02'; end if;
  if new.cuenta_impuesto_unico is null then execute f_cuenta into new.cuenta_impuesto_unico using new.empresa_id, '2.1.02.02'; end if;
  if new.cuenta_gastos_bancarios is null then execute f_cuenta into new.cuenta_gastos_bancarios using new.empresa_id, '5.3.01'; end if;
  return new;
end $$;
create trigger completar_cuentas_nuevas before insert on public.configuracion_cuentas
  for each row execute function app.completar_cuentas_nuevas();
-- Backfill: un update "vacío" dispara la misma lógica si se reutiliza como before update de una sola vez
create trigger completar_cuentas_nuevas_upd before update on public.configuracion_cuentas
  for each row execute function app.completar_cuentas_nuevas();
update public.configuracion_cuentas set cuenta_gasto_honorarios = cuenta_gasto_honorarios;
drop trigger completar_cuentas_nuevas_upd on public.configuracion_cuentas;

create or replace function app.es_cuenta_automatica(p_cuenta uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.configuracion_cuentas c
                  where p_cuenta in (c.cuenta_clientes, c.cuenta_proveedores, c.cuenta_ventas, c.cuenta_ventas_exentas,
                                     c.cuenta_iva_debito, c.cuenta_iva_credito, c.cuenta_iva_no_recuperable, c.cuenta_gasto_defecto,
                                     c.cuenta_ppm, c.cuenta_impuestos_por_pagar, c.cuenta_resultado_ejercicio,
                                     c.cuenta_gasto_honorarios, c.cuenta_honorarios_por_pagar, c.cuenta_retencion_honorarios,
                                     c.cuenta_gasto_remuneraciones, c.cuenta_remuneraciones_por_pagar, c.cuenta_leyes_sociales,
                                     c.cuenta_impuesto_unico, c.cuenta_gastos_bancarios))
$$;

-- ---------------------------------------------------------------------------
-- 1. Boletas de honorarios recibidas (tipo interno 900 = BHE, 901 = boleta de prestación de servicios de terceros)

alter table public.documentos drop constraint documentos_operacion_check;
alter table public.documentos add constraint documentos_operacion_check check (operacion in ('venta', 'compra', 'honorario'));
alter table public.documentos drop constraint documentos_tipo_check;
alter table public.documentos add constraint documentos_tipo_check check (tipo in (33, 34, 39, 41, 46, 56, 61, 900, 901));
alter table public.documentos add column retencion numeric(16,0) not null default 0;
alter table public.documentos add column tasa_retencion numeric(5,2);
alter table public.documentos add constraint documentos_retencion_check check (retencion >= 0 and retencion <= total);
alter table public.documentos add constraint documentos_honorario_check check (
  (operacion = 'honorario') = (tipo in (900, 901)) and (operacion = 'honorario' or retencion = 0));

-- Tasa de retención de honorarios vigente según la fecha de la boleta (Ley 21.133)
create or replace function public.tasa_retencion_honorarios(p_fecha date) returns numeric
language sql immutable set search_path to '' as $$
  select case
    when p_fecha < date '2020-01-01' then 10.00
    when p_fecha < date '2021-01-01' then 10.75
    when p_fecha < date '2022-01-01' then 11.50
    when p_fecha < date '2023-01-01' then 12.25
    when p_fecha < date '2024-01-01' then 13.00
    when p_fecha < date '2025-01-01' then 13.75
    when p_fecha < date '2026-01-01' then 14.50
    when p_fecha < date '2027-01-01' then 15.25
    when p_fecha < date '2028-01-01' then 16.00
    else 17.00 end
$$;
grant execute on function public.tasa_retencion_honorarios(date) to authenticated, anon;

create or replace function public.registrar_honorario(
  p_empresa uuid, p_folio bigint, p_fecha date, p_rut text, p_nombre text, p_bruto numeric,
  p_retiene boolean default true, p_tipo integer default 900, p_cuenta uuid default null,
  p_glosa text default null, p_vencimiento date default null)
returns public.documentos
language plpgsql security definer set search_path to ''
as $$
declare
  c public.configuracion_cuentas;
  d public.documentos;
  v_tasa numeric;
  v_ret numeric;
  v_aux uuid;
  v_lineas jsonb;
  v_asiento public.asientos;
begin
  if not app.puede(p_empresa, 'honorarios.registrar') then
    raise exception 'Sin permiso para registrar boletas de honorarios (o falta la verificación en dos pasos)';
  end if;
  if p_tipo not in (900, 901) then raise exception 'Tipo de boleta inválido'; end if;
  if not app.rut_valido(p_rut) then raise exception 'RUT inválido: %', p_rut; end if;
  if coalesce(p_folio, 0) <= 0 then raise exception 'Indique el número de la boleta'; end if;
  if coalesce(p_bruto, 0) <= 0 then raise exception 'El monto bruto debe ser mayor a cero'; end if;
  if p_fecha > (now() at time zone 'America/Santiago')::date then raise exception 'La fecha no puede ser futura'; end if;
  if p_vencimiento is not null and p_vencimiento < p_fecha then raise exception 'El vencimiento no puede ser anterior a la fecha'; end if;
  select * into c from public.configuracion_cuentas where empresa_id = p_empresa;
  if c.cuenta_honorarios_por_pagar is null or c.cuenta_retencion_honorarios is null then
    raise exception 'Configure las cuentas de honorarios por pagar y retención en Plan de cuentas';
  end if;
  if p_cuenta is not null and not exists (
      select 1 from public.cuentas where id = p_cuenta and empresa_id = p_empresa and imputable and activa and tipo in ('gasto', 'activo')) then
    raise exception 'Cuenta de gasto inválida';
  end if;

  v_tasa := case when p_retiene then public.tasa_retencion_honorarios(p_fecha) else 0 end;
  v_ret := round(p_bruto * v_tasa / 100);

  insert into public.documentos (empresa_id, operacion, tipo, folio, fecha, rut, razon_social, neto, exento, iva, total,
                                 retencion, tasa_retencion, cuenta_id, glosa, vencimiento)
  values (p_empresa, 'honorario', p_tipo, p_folio, p_fecha, app.rut_normalizado(p_rut), trim(p_nombre), 0, round(p_bruto), 0,
          round(p_bruto), v_ret, v_tasa, p_cuenta, nullif(trim(p_glosa), ''), p_vencimiento)
  returning * into d;

  v_aux := app.auxiliar_para(p_empresa, d.rut, d.razon_social, false);
  v_lineas := jsonb_build_array(
    jsonb_build_object('cuenta_id', coalesce(p_cuenta, c.cuenta_gasto_honorarios, c.cuenta_gasto_defecto), 'debe', d.total));
  if v_ret > 0 then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_retencion_honorarios, 'haber', v_ret);
  end if;
  v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_honorarios_por_pagar, 'haber', d.total - v_ret,
                                             'auxiliar_id', v_aux, 'documento_tipo', d.tipo, 'documento_folio', d.folio);

  v_asiento := public.crear_asiento_sistema(p_empresa, d.fecha,
    left('Honorarios ' || case when d.tipo = 900 then 'BHE' else 'BTE' end || ' N° ' || d.folio || ' ' || d.razon_social, 500),
    v_lineas, 'documento_honorario', d.id, 'egreso'::public.tipo_comprobante,
    app.puede(p_empresa, 'asientos.contabilizar'));
  update public.documentos set asiento_id = v_asiento.id where id = d.id returning * into d;
  return d;
end $$;
revoke execute on function public.registrar_honorario(uuid, bigint, date, text, text, numeric, boolean, integer, uuid, text, date) from public, anon;
grant execute on function public.registrar_honorario(uuid, bigint, date, text, text, numeric, boolean, integer, uuid, text, date) to authenticated;

-- Saldo: los honorarios se pagan por el líquido (bruto menos retención)
drop view public.documentos_saldo;
create view public.documentos_saldo with (security_invoker = true) as
select d.*,
       app.estado_asiento(d.asiento_id) as asiento_estado,
       app.pagado_documento(d.id) as pagado,
       case when d.tipo = 61 then 0 else app.notas_credito_documento(d.id) end as notas_credito,
       case when d.tipo = 61 then 0
            else d.total - d.retencion - app.pagado_documento(d.id) - app.notas_credito_documento(d.id) end as saldo,
       coalesce(d.vencimiento, d.fecha) as vence
  from public.documentos d;
grant select on public.documentos_saldo to authenticated;

create or replace function app._reemplazar(p_fn regprocedure, p_de text, p_a text) returns void
language plpgsql set search_path to '' as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_de in d) = 0 then raise exception 'No se encontró el texto a reemplazar en %', p_fn; end if;
  execute replace(d, p_de, p_a);
end $$;

-- El pago de un honorario rebaja "Honorarios por pagar"
select app._reemplazar('public.registrar_pago(uuid,date,numeric,uuid,text,text)',
  $x$jsonb_build_object('cuenta_id', c.cuenta_proveedores, 'debe', p_monto$x$,
  $x$jsonb_build_object('cuenta_id', case when d.operacion = 'honorario' then c.cuenta_honorarios_por_pagar else c.cuenta_proveedores end, 'debe', p_monto$x$);
select app._reemplazar('public.registrar_pago(uuid,date,numeric,uuid,text,text)',
  $x$left(initcap(v_tipo) || ' doc. ' || d.tipo$x$,
  $x$left(initcap(v_tipo) || case when d.operacion = 'honorario' then ' honorarios N° ' || d.folio || ' ' || d.razon_social else ' doc. ' || d.tipo end$x$);

-- Las boletas de honorarios se pagan desde "Por pagar"
select app._reemplazar('public.resumen_tesoreria(uuid)',
  $x$select s.operacion, s.saldo,$x$,
  $x$select case when s.operacion = 'honorario' then 'compra' else s.operacion end as operacion, s.saldo,$x$);

-- ---------------------------------------------------------------------------
-- 2. Remuneraciones: libro mensual y centralización

create table public.remuneraciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  periodo char(6) not null check (periodo ~ '^\d{6}$'),
  fecha date not null,
  utm numeric(10,0) check (utm is null or utm > 0),
  cuenta_descuentos uuid references public.cuentas(id),
  estado text not null default 'vigente' check (estado in ('vigente', 'anulada')),
  motivo_anulacion text,
  asiento_id uuid references public.asientos(id),
  pago_asiento_id uuid references public.asientos(id),
  pagado_en date,
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now()
);
create unique index remuneraciones_periodo on public.remuneraciones (empresa_id, periodo) where estado = 'vigente';

create table public.remuneracion_lineas (
  id uuid primary key default gen_random_uuid(),
  remuneracion_id uuid not null references public.remuneraciones(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  rut text not null check (app.rut_valido(rut)),
  nombre text not null check (length(trim(nombre)) between 1 and 120),
  imponible numeric(14,0) not null default 0 check (imponible >= 0),
  no_imponible numeric(14,0) not null default 0 check (no_imponible >= 0),
  afp numeric(14,0) not null default 0 check (afp >= 0),
  salud numeric(14,0) not null default 0 check (salud >= 0),
  afc_trabajador numeric(14,0) not null default 0 check (afc_trabajador >= 0),
  impuesto_unico numeric(14,0) not null default 0 check (impuesto_unico >= 0),
  otros_descuentos numeric(14,0) not null default 0 check (otros_descuentos >= 0),
  aporte_empleador numeric(14,0) not null default 0 check (aporte_empleador >= 0),
  liquido numeric(14,0) generated always as (imponible + no_imponible - afp - salud - afc_trabajador - impuesto_unico - otros_descuentos) stored,
  check (imponible + no_imponible - afp - salud - afc_trabajador - impuesto_unico - otros_descuentos >= 0),
  unique (remuneracion_id, rut)
);
create index on public.remuneracion_lineas (empresa_id);

alter table public.remuneraciones enable row level security;
alter table public.remuneracion_lineas enable row level security;
-- Sueldos: solo quien tiene permiso de remuneraciones (no todos los miembros)
-- La cabecera (sin montos por persona) la ve también tesorería, que paga los sueldos
create policy remuneraciones_sel on public.remuneraciones for select to authenticated
  using (app.puede_ver(empresa_id, 'remuneraciones.ver') or app.puede_ver(empresa_id, 'tesoreria.ver'));
create policy remuneracion_lineas_sel on public.remuneracion_lineas for select to authenticated using (app.puede_ver(empresa_id, 'remuneraciones.ver'));
revoke insert, update, delete on public.remuneraciones, public.remuneracion_lineas from anon, authenticated;
grant select on public.remuneraciones, public.remuneracion_lineas to authenticated;
create trigger auditar after insert or update or delete on public.remuneraciones for each row execute function app.auditar();
create trigger auditar after insert or update or delete on public.remuneracion_lineas for each row execute function app.auditar();

-- Impuesto único de segunda categoría (tabla mensual en UTM, art. 43 N°1 LIR)
create or replace function public.impuesto_unico(p_base numeric, p_utm numeric) returns numeric
language sql immutable set search_path to '' as $$
  select case when coalesce(p_utm, 0) <= 0 or coalesce(p_base, 0) <= 0 then 0 else greatest(0, round(
    case
      when p_base <= 13.5 * p_utm then 0
      when p_base <= 30 * p_utm then p_base * 0.04 - 0.54 * p_utm
      when p_base <= 50 * p_utm then p_base * 0.08 - 1.74 * p_utm
      when p_base <= 70 * p_utm then p_base * 0.135 - 4.49 * p_utm
      when p_base <= 90 * p_utm then p_base * 0.23 - 11.14 * p_utm
      when p_base <= 120 * p_utm then p_base * 0.304 - 17.80 * p_utm
      when p_base <= 310 * p_utm then p_base * 0.35 - 23.32 * p_utm
      else p_base * 0.40 - 38.82 * p_utm end)) end
$$;
grant execute on function public.impuesto_unico(numeric, numeric) to authenticated;

create or replace function public.registrar_remuneraciones(
  p_empresa uuid, p_periodo text, p_fecha date, p_lineas jsonb, p_utm numeric default null, p_cuenta_descuentos uuid default null)
returns public.remuneraciones
language plpgsql security definer set search_path to ''
as $$
declare
  c public.configuracion_cuentas;
  r public.remuneraciones;
  l jsonb;
  t record;
  v_lineas jsonb;
  v_asiento public.asientos;
begin
  if not app.puede(p_empresa, 'remuneraciones.registrar') then
    raise exception 'Sin permiso para registrar remuneraciones (o falta la verificación en dos pasos)';
  end if;
  if p_periodo !~ '^\d{6}$' then raise exception 'Período inválido (use AAAAMM)'; end if;
  if p_fecha < to_date(p_periodo || '01', 'YYYYMMDD') then raise exception 'La fecha de centralización no puede ser anterior al mes'; end if;
  if p_fecha > (now() at time zone 'America/Santiago')::date then raise exception 'La fecha no puede ser futura'; end if;
  if jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then raise exception 'Agregue al menos un trabajador'; end if;
  if exists (select 1 from public.remuneraciones where empresa_id = p_empresa and periodo = p_periodo and estado = 'vigente') then
    raise exception 'Ya hay remuneraciones vigentes para ese mes; anúlelas para volver a registrarlas';
  end if;
  select * into c from public.configuracion_cuentas where empresa_id = p_empresa;
  if c.cuenta_gasto_remuneraciones is null or c.cuenta_remuneraciones_por_pagar is null or c.cuenta_leyes_sociales is null or c.cuenta_impuesto_unico is null then
    raise exception 'Configure las cuentas de remuneraciones en Plan de cuentas';
  end if;
  if p_cuenta_descuentos is not null and not exists (
      select 1 from public.cuentas where id = p_cuenta_descuentos and empresa_id = p_empresa and imputable and activa) then
    raise exception 'Cuenta de otros descuentos inválida';
  end if;

  insert into public.remuneraciones (empresa_id, periodo, fecha, utm, cuenta_descuentos)
  values (p_empresa, p_periodo, p_fecha, p_utm, p_cuenta_descuentos) returning * into r;

  for l in select * from jsonb_array_elements(p_lineas) loop
    insert into public.remuneracion_lineas (remuneracion_id, empresa_id, rut, nombre, imponible, no_imponible, afp, salud,
                                            afc_trabajador, impuesto_unico, otros_descuentos, aporte_empleador)
    values (r.id, p_empresa, app.rut_normalizado(l ->> 'rut'), trim(l ->> 'nombre'),
            round(coalesce((l ->> 'imponible')::numeric, 0)), round(coalesce((l ->> 'no_imponible')::numeric, 0)),
            round(coalesce((l ->> 'afp')::numeric, 0)), round(coalesce((l ->> 'salud')::numeric, 0)),
            round(coalesce((l ->> 'afc_trabajador')::numeric, 0)), round(coalesce((l ->> 'impuesto_unico')::numeric, 0)),
            round(coalesce((l ->> 'otros_descuentos')::numeric, 0)), round(coalesce((l ->> 'aporte_empleador')::numeric, 0)));
  end loop;

  select sum(imponible + no_imponible) haberes, sum(afp + salud + afc_trabajador) leyes, sum(impuesto_unico) iu,
         sum(otros_descuentos) otros, sum(aporte_empleador) aporte, sum(liquido) liq
    into t from public.remuneracion_lineas where remuneracion_id = r.id;
  if t.haberes <= 0 then raise exception 'El total de haberes debe ser mayor a cero'; end if;
  if t.otros > 0 and p_cuenta_descuentos is null then
    raise exception 'Indique la cuenta de los otros descuentos (anticipos, préstamos, etc.)';
  end if;

  v_lineas := jsonb_build_array(jsonb_build_object('cuenta_id', c.cuenta_gasto_remuneraciones, 'debe', t.haberes + t.aporte));
  if t.liq > 0 then v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_remuneraciones_por_pagar, 'haber', t.liq); end if;
  if t.leyes + t.aporte > 0 then v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_leyes_sociales, 'haber', t.leyes + t.aporte); end if;
  if t.iu > 0 then v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_impuesto_unico, 'haber', t.iu); end if;
  if t.otros > 0 then v_lineas := v_lineas || jsonb_build_object('cuenta_id', p_cuenta_descuentos, 'haber', t.otros); end if;

  v_asiento := public.crear_asiento_sistema(p_empresa, p_fecha,
    'Centralización remuneraciones ' || substr(p_periodo, 5, 2) || '-' || substr(p_periodo, 1, 4),
    v_lineas, 'remuneracion', r.id, 'traspaso'::public.tipo_comprobante, app.puede(p_empresa, 'asientos.contabilizar'));
  update public.remuneraciones set asiento_id = v_asiento.id where id = r.id returning * into r;
  return r;
end $$;
revoke execute on function public.registrar_remuneraciones(uuid, text, date, jsonb, numeric, uuid) from public, anon;
grant execute on function public.registrar_remuneraciones(uuid, text, date, jsonb, numeric, uuid) to authenticated;

-- Pago de los sueldos líquidos (tesorería)
create or replace function public.pagar_remuneraciones(p_id uuid, p_fecha date, p_cuenta uuid)
returns public.remuneraciones
language plpgsql security definer set search_path to ''
as $$
declare
  r public.remuneraciones;
  c public.configuracion_cuentas;
  v_liq numeric;
  v_asiento public.asientos;
begin
  select * into r from public.remuneraciones where id = p_id for update;
  if r.id is null then raise exception 'Remuneraciones no encontradas'; end if;
  if not app.puede(r.empresa_id, 'tesoreria.registrar') then raise exception 'Sin permiso para registrar pagos'; end if;
  if r.estado <> 'vigente' then raise exception 'Las remuneraciones están anuladas'; end if;
  if r.pago_asiento_id is not null and app.estado_asiento(r.pago_asiento_id) <> 'anulado' then raise exception 'Los sueldos de ese mes ya están pagados'; end if;
  if app.estado_asiento(r.asiento_id) <> 'contabilizado' then raise exception 'La centralización aún no está aprobada por contabilidad'; end if;
  if p_fecha < r.fecha then raise exception 'La fecha de pago no puede ser anterior a la centralización'; end if;
  if p_fecha > (now() at time zone 'America/Santiago')::date then raise exception 'La fecha no puede ser futura'; end if;
  if not exists (select 1 from public.cuentas where id = p_cuenta and empresa_id = r.empresa_id and es_efectivo and imputable and activa) then
    raise exception 'Elija una cuenta de caja o banco válida';
  end if;
  select * into c from public.configuracion_cuentas where empresa_id = r.empresa_id;
  select sum(liquido) into v_liq from public.remuneracion_lineas where remuneracion_id = r.id;
  if coalesce(v_liq, 0) <= 0 then raise exception 'No hay líquido por pagar'; end if;
  v_asiento := public.crear_asiento_sistema(r.empresa_id, p_fecha,
    'Pago remuneraciones ' || substr(r.periodo, 5, 2) || '-' || substr(r.periodo, 1, 4),
    jsonb_build_array(jsonb_build_object('cuenta_id', c.cuenta_remuneraciones_por_pagar, 'debe', v_liq),
                      jsonb_build_object('cuenta_id', p_cuenta, 'haber', v_liq)),
    'pago_remuneracion', r.id, 'egreso'::public.tipo_comprobante, true);
  update public.remuneraciones set pago_asiento_id = v_asiento.id, pagado_en = p_fecha where id = r.id returning * into r;
  return r;
end $$;
revoke execute on function public.pagar_remuneraciones(uuid, date, uuid) from public, anon;

-- Sueldos por pagar para tesorería: solo el total líquido del mes, sin detalle por persona
create or replace function public.remuneraciones_por_pagar(p_empresa uuid)
returns table (id uuid, periodo char(6), fecha date, trabajadores bigint, liquido numeric)
language plpgsql stable security definer set search_path to '' as $$
begin
  if not app.puede_ver(p_empresa, 'tesoreria.ver') then raise exception 'Sin permiso para ver tesorería'; end if;
  return query
    select r.id, r.periodo, r.fecha, count(l.id), coalesce(sum(l.liquido), 0)
      from public.remuneraciones r join public.remuneracion_lineas l on l.remuneracion_id = r.id
     where r.empresa_id = p_empresa and r.estado = 'vigente' and app.estado_asiento(r.asiento_id) = 'contabilizado'
       and (r.pago_asiento_id is null or app.estado_asiento(r.pago_asiento_id) = 'anulado')
     group by r.id order by r.periodo;
end $$;
revoke execute on function public.remuneraciones_por_pagar(uuid) from public, anon;
grant execute on function public.remuneraciones_por_pagar(uuid) to authenticated;
grant execute on function public.pagar_remuneraciones(uuid, date, uuid) to authenticated;

create or replace function public.anular_remuneraciones(p_id uuid, p_motivo text)
returns public.remuneraciones
language plpgsql security definer set search_path to ''
as $$
declare
  r public.remuneraciones;
  v_estado public.estado_asiento;
  v_hoy date := (now() at time zone 'America/Santiago')::date;
begin
  select * into r from public.remuneraciones where id = p_id for update;
  if r.id is null then raise exception 'Remuneraciones no encontradas'; end if;
  if not app.puede(r.empresa_id, 'remuneraciones.registrar') then raise exception 'Sin permiso para anular remuneraciones'; end if;
  if r.estado = 'anulada' then raise exception 'Ya están anuladas'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 5 then raise exception 'Indique el motivo de la anulación'; end if;
  if r.pago_asiento_id is not null and app.estado_asiento(r.pago_asiento_id) = 'contabilizado' then
    raise exception 'Los sueldos ya se pagaron; anule primero el comprobante de pago en Asientos';
  end if;
  if r.asiento_id is not null then
    select estado into v_estado from public.asientos where id = r.asiento_id;
    if v_estado = 'borrador' then
      update public.remuneraciones set asiento_id = null where id = p_id;
      delete from public.asientos where id = r.asiento_id;
    elsif v_estado = 'contabilizado' then
      perform set_config('cuadra.sistema', 'on', true);
      if app.periodo_abierto(r.empresa_id, r.fecha) then
        perform public.anular_asiento(r.asiento_id, p_motivo);
      else
        perform public.reversar_asiento(r.asiento_id, v_hoy, p_motivo);
      end if;
      perform set_config('cuadra.sistema', 'off', true);
    end if;
  end if;
  update public.remuneraciones set estado = 'anulada', motivo_anulacion = trim(p_motivo) where id = p_id returning * into r;
  return r;
end $$;
revoke execute on function public.anular_remuneraciones(uuid, text) from public, anon;
grant execute on function public.anular_remuneraciones(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. F29: retención de honorarios (151) e impuesto único (48)

select app._reemplazar('public.propuesta_f29(uuid,text)',
  $x$v_lineas jsonb; v_guardada public.f29_declaraciones;$x$,
  $x$v_lineas jsonb; v_guardada public.f29_declaraciones; v_ret_hon numeric; v_iu numeric; v_honorarios jsonb;$x$);
select app._reemplazar('public.propuesta_f29(uuid,text)',
  $x$  select remanente_siguiente, 'presentado ' || periodo into v_rem_ant$x$,
  $x$  -- Honorarios: retenciones de boletas aprobadas del mes; remuneraciones: impuesto único centralizado y aprobado
  select coalesce(sum(retencion), 0), jsonb_build_object('cantidad', count(*), 'bruto', coalesce(sum(total), 0), 'retencion', coalesce(sum(retencion), 0))
    into v_ret_hon, v_honorarios from app.f29_documentos(p_empresa, p_periodo) where operacion = 'honorario';
  select coalesce(sum(l.impuesto_unico), 0) into v_iu
    from public.remuneraciones r join public.remuneracion_lineas l on l.remuneracion_id = r.id
   where r.empresa_id = p_empresa and r.periodo = p_periodo and r.estado = 'vigente' and app.estado_asiento(r.asiento_id) = 'contabilizado';

  select remanente_siguiente, 'presentado ' || periodo into v_rem_ant$x$);
select app._reemplazar('public.propuesta_f29(uuid,text)',
  $x$'563', greatest(v_base_ppm, 0), '115', v_tasa, '62', v_ppm,
      '91', greatest(v_iva_det, 0) + v_ppm);$x$,
  $x$'563', greatest(v_base_ppm, 0), '115', v_tasa, '62', v_ppm,
      '48', v_iu, '151', v_ret_hon,
      '91', greatest(v_iva_det, 0) + v_ppm + v_iu + v_ret_hon);$x$);
select app._reemplazar('public.propuesta_f29(uuid,text)',
  $x$'periodo', p_periodo, 'ventas', v_ventas, 'compras', v_compras, 'lineas', v_lineas,$x$,
  $x$'periodo', p_periodo, 'ventas', v_ventas, 'compras', v_compras, 'honorarios', v_honorarios, 'lineas', v_lineas,$x$);
select app._reemplazar('public.propuesta_f29(uuid,text)',
  $x$no incluye reajuste UTM del remanente, retenciones ni otros impuestos.$x$,
  $x$incluye retenciones de honorarios e impuesto único de remuneraciones aprobadas; no incluye reajuste UTM del remanente ni otros impuestos.$x$);

drop function app._reemplazar(regprocedure, text, text);
