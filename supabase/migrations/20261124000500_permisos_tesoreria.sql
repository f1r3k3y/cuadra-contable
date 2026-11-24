-- Matriz de permisos por rol + módulo de tesorería (cobros y pagos).
-- Todas las escrituras se validan en la base con app.puede(empresa, permiso), que usa el rol
-- efectivo (incluido el modo "ver como") y exige verificación en dos pasos.

-- ---------------------------------------------------------------------------
-- 1. Matriz

create table app.permisos_rol (
  rol public.rol_empresa not null,
  permiso text not null,
  primary key (rol, permiso)
);

insert into app.permisos_rol (rol, permiso)
select r::public.rol_empresa, p from (values
  ('panel.ver',             '{admin,contador,asistente,tesorero,gerente,auditor,lector}'),
  ('documentos.ver',        '{admin,contador,asistente,tesorero,gerente,auditor,lector}'),
  ('documentos.registrar',  '{admin,contador,asistente}'),
  ('documentos.anular',     '{admin,contador}'),
  ('asientos.ver',          '{admin,contador,asistente,auditor}'),
  ('asientos.crear',        '{admin,contador,asistente}'),
  ('asientos.contabilizar', '{admin,contador}'),
  ('asientos.anular',       '{admin,contador}'),
  ('tesoreria.ver',         '{admin,contador,tesorero,gerente,auditor}'),
  ('tesoreria.registrar',   '{admin,tesorero}'),
  ('tesoreria.anular',      '{admin,tesorero}'),
  ('reportes.ver',          '{admin,contador,asistente,gerente,auditor,lector}'),
  ('f29.ver',               '{admin,contador,gerente,auditor}'),
  ('f29.guardar',           '{admin,contador}'),
  ('cuentas.ver',           '{admin,contador,asistente,auditor}'),
  ('cuentas.gestionar',     '{admin,contador}'),
  ('periodos.cerrar',       '{admin,contador}'),
  ('periodos.reabrir',      '{admin}'),
  ('empresa.ver',           '{admin,contador,gerente,auditor}'),
  ('empresa.editar',        '{admin}'),
  ('usuarios.gestionar',    '{admin}'),
  ('auditoria.ver',         '{admin,auditor}')
) m(p, roles), unnest(m.roles::text[]) r;

create or replace function app.rol_efectivo(p_empresa uuid) returns public.rol_empresa
language sql stable security definer set search_path to '' as $$
  select coalesce(m.rol_prueba, m.rol) from public.miembros m where m.empresa_id = p_empresa and m.user_id = auth.uid()
$$;

-- Lectura (sin exigir MFA)
create or replace function app.puede_ver(p_empresa uuid, p_permiso text) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from app.permisos_rol p where p.rol = app.rol_efectivo(p_empresa) and p.permiso = p_permiso)
$$;

-- Escritura (exige MFA)
create or replace function app.puede(p_empresa uuid, p_permiso text) returns boolean
language sql stable security definer set search_path to '' as $$
  select app.puede_ver(p_empresa, p_permiso) and app.mfa_ok()
$$;

-- Operaciones internas (asientos automáticos de documentos y tesorería). Solo se activa dentro
-- de funciones SECURITY DEFINER con set_config local; no es alcanzable desde la API.
create or replace function app.es_sistema() returns boolean
language sql stable set search_path to '' as $$ select coalesce(current_setting('cuadra.sistema', true), '') = 'on' $$;

create or replace function public.mis_permisos(p_empresa uuid) returns text[]
language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(p.permiso order by p.permiso), '{}') from app.permisos_rol p where p.rol = app.rol_efectivo(p_empresa)
$$;

create or replace function public.matriz_permisos() returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_object_agg(rol, permisos) from (
    select rol::text, jsonb_agg(permiso order by permiso) permisos from app.permisos_rol group by rol) x
$$;

-- ---------------------------------------------------------------------------
-- 2. Políticas RLS con permisos

drop policy if exists empresas_upd on public.empresas;
create policy empresas_upd on public.empresas for update to authenticated
  using (app.puede(id, 'empresa.editar')) with check (app.puede(id, 'empresa.editar'));

drop policy if exists miembros_admin on public.miembros;
create policy miembros_admin on public.miembros for all to authenticated
  using (app.puede(empresa_id, 'usuarios.gestionar')) with check (app.puede(empresa_id, 'usuarios.gestionar'));

do $$
declare t text;
begin
  foreach t in array array['cuentas', 'centros_costo', 'configuracion_cuentas'] loop
    execute format('drop policy if exists %1$s_mod on public.%1$s', t);
    execute format('create policy %1$s_mod on public.%1$s for all to authenticated using (app.puede(empresa_id, ''cuentas.gestionar'')) with check (app.puede(empresa_id, ''cuentas.gestionar''))', t);
  end loop;
  foreach t in array array['asientos', 'asiento_lineas'] loop
    execute format('drop policy if exists %1$s_mod on public.%1$s', t);
    execute format('create policy %1$s_mod on public.%1$s for all to authenticated using (app.puede(empresa_id, ''asientos.crear'')) with check (app.puede(empresa_id, ''asientos.crear''))', t);
  end loop;
  foreach t in array array['dte_recibidos', 'rcv_registros'] loop
    execute format('drop policy if exists %1$s_mod on public.%1$s', t);
    execute format('create policy %1$s_mod on public.%1$s for all to authenticated using (app.puede(empresa_id, ''documentos.registrar'')) with check (app.puede(empresa_id, ''documentos.registrar''))', t);
  end loop;
end $$;

drop policy if exists auxiliares_mod on public.auxiliares;
create policy auxiliares_mod on public.auxiliares for all to authenticated
  using (app.puede(empresa_id, 'documentos.registrar') or app.puede(empresa_id, 'cuentas.gestionar'))
  with check (app.puede(empresa_id, 'documentos.registrar') or app.puede(empresa_id, 'cuentas.gestionar'));

-- Períodos y F29 solo cambian vía funciones (cerrar/reabrir/guardar), que validan el permiso.
drop policy if exists periodos_mod on public.periodos;
drop policy if exists f29_mod on public.f29_declaraciones;

drop policy if exists auditoria_sel on public.auditoria;
create policy auditoria_sel on public.auditoria for select to authenticated using (app.puede_ver(empresa_id, 'auditoria.ver'));

-- ---------------------------------------------------------------------------
-- 3. Funciones: reemplazo de chequeos por rol por chequeos por permiso

create or replace function app._reemplazar(p_fn regprocedure, p_de text, p_a text) returns void
language plpgsql set search_path to '' as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_de in d) = 0 then raise exception 'No se encontró el texto a reemplazar en %', p_fn; end if;
  execute replace(d, p_de, p_a);
end $$;

select app._reemplazar('public.crear_asiento(uuid,date,text,jsonb,public.tipo_comprobante,boolean)',
  $x$app.puede_escribir(p_empresa, '{admin,contador,operador}')$x$, $x$app.puede(p_empresa, 'asientos.crear')$x$);
select app._reemplazar('public.contabilizar_asiento(uuid)',
  $x$app.puede_escribir(v.empresa_id, '{admin,contador}')$x$, $x$(app.puede(v.empresa_id, 'asientos.contabilizar') or app.es_sistema())$x$);
select app._reemplazar('public.anular_asiento(uuid,text)',
  $x$app.puede_escribir(v.empresa_id, '{admin,contador}')$x$, $x$(app.puede(v.empresa_id, 'asientos.anular') or app.es_sistema())$x$);
select app._reemplazar('public.reversar_asiento(uuid,date,text)',
  $x$app.puede_escribir(v.empresa_id, '{admin,contador}')$x$, $x$(app.puede(v.empresa_id, 'asientos.anular') or app.es_sistema())$x$);
select app._reemplazar('public.cerrar_periodo(uuid,integer,integer)',
  $x$app.puede_escribir(p_empresa, '{admin,contador}')$x$, $x$app.puede(p_empresa, 'periodos.cerrar')$x$);
select app._reemplazar('public.reabrir_periodo(uuid,integer,integer)',
  $x$app.puede_escribir(p_empresa, '{admin}')$x$, $x$app.puede(p_empresa, 'periodos.reabrir')$x$);
select app._reemplazar('public.agregar_miembro(uuid,text,public.rol_empresa)',
  $x$app.puede_escribir(p_empresa, '{admin}')$x$, $x$app.puede(p_empresa, 'usuarios.gestionar')$x$);
select app._reemplazar('public.verificar_auditoria(uuid)',
  $x$app.tiene_rol(p_empresa, '{admin,auditor}')$x$, $x$app.puede_ver(p_empresa, 'auditoria.ver')$x$);
select app._reemplazar('public.guardar_f29(uuid,text)',
  $x$app.puede_escribir(p_empresa, '{admin,contador}')$x$, $x$app.puede(p_empresa, 'f29.guardar')$x$);
select app._reemplazar('public.contabilizar_dte_emitido(uuid)',
  $x$app.puede_escribir(d.empresa_id, '{admin,contador}')$x$, $x$app.puede(d.empresa_id, 'asientos.contabilizar')$x$);
select app._reemplazar('public.contabilizar_dte_recibido(uuid,uuid,uuid)',
  $x$app.puede_escribir(d.empresa_id, '{admin,contador}')$x$, $x$app.puede(d.empresa_id, 'asientos.contabilizar')$x$);

-- Asientos automáticos: ahora pueden quedar en borrador (para revisión del contador)
drop function public.crear_asiento_sistema(uuid, date, text, jsonb, text, uuid, public.tipo_comprobante);
create function public.crear_asiento_sistema(p_empresa uuid, p_fecha date, p_glosa text, p_lineas jsonb, p_origen text,
  p_origen_id uuid, p_tipo public.tipo_comprobante, p_contabilizar boolean default true)
returns public.asientos language plpgsql security definer set search_path to ''
as $$
declare
  v public.asientos;
  l jsonb;
  i int := 0;
begin
  insert into public.asientos (empresa_id, fecha, glosa, tipo, origen, origen_id)
  values (p_empresa, p_fecha, p_glosa, p_tipo, p_origen, p_origen_id) returning * into v;
  for l in select * from jsonb_array_elements(p_lineas) loop
    i := i + 1;
    if l ->> 'cuenta_id' is null then raise exception 'Falta configurar las cuentas automáticas de la empresa'; end if;
    insert into public.asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber, auxiliar_id, centro_costo_id, documento_tipo, documento_folio)
    values (v.id, p_empresa, i, (l ->> 'cuenta_id')::uuid, coalesce((l ->> 'debe')::numeric, 0), coalesce((l ->> 'haber')::numeric, 0),
            nullif(l ->> 'auxiliar_id', '')::uuid, nullif(l ->> 'centro_costo_id', '')::uuid,
            nullif(l ->> 'documento_tipo', '')::int, nullif(l ->> 'documento_folio', '')::bigint);
  end loop;
  if p_contabilizar then
    perform set_config('cuadra.sistema', 'on', true);
    v := public.contabilizar_asiento(v.id);
    perform set_config('cuadra.sistema', 'off', true);
  end if;
  return v;
end $$;
revoke execute on function public.crear_asiento_sistema(uuid, date, text, jsonb, text, uuid, public.tipo_comprobante, boolean) from public, anon, authenticated;

-- Documentos: el asistente registra (asiento en borrador por aprobar); contador/admin contabilizan directo.
select app._reemplazar('public.registrar_documento(uuid,text,integer,bigint,date,text,text,numeric,numeric,numeric,uuid,text)',
  $x$app.puede_escribir(p_empresa, '{admin,contador}')$x$, $x$app.puede(p_empresa, 'documentos.registrar')$x$);
select app._reemplazar('public.registrar_documento(uuid,text,integer,bigint,date,text,text,numeric,numeric,numeric,uuid,text)',
  $x$Sin permiso (requiere rol admin o contador y verificación en dos pasos)$x$, $x$Sin permiso para registrar documentos (o falta la verificación en dos pasos)$x$);
select app._reemplazar('public.registrar_documento(uuid,text,integer,bigint,date,text,text,numeric,numeric,numeric,uuid,text)',
  $x$else 'egreso'::public.tipo_comprobante end);$x$,
  $x$else 'egreso'::public.tipo_comprobante end,
    app.puede(p_empresa, 'asientos.contabilizar'));$x$);

create or replace function public.anular_documento(p_id uuid, p_motivo text)
returns public.documentos
language plpgsql security definer set search_path to ''
as $$
declare
  d public.documentos;
  v_estado public.estado_asiento;
  v_hoy date := (now() at time zone 'America/Santiago')::date;
begin
  select * into d from public.documentos where id = p_id for update;
  if d.id is null then raise exception 'Documento no encontrado'; end if;
  if not app.puede(d.empresa_id, 'documentos.anular') then raise exception 'Sin permiso para anular documentos'; end if;
  if d.estado = 'anulado' then raise exception 'El documento ya está anulado'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 5 then raise exception 'Indique el motivo de la anulación'; end if;
  if exists (select 1 from public.pagos where documento_id = p_id and estado = 'vigente') then
    raise exception 'El documento tiene cobros o pagos registrados; anúlelos primero en Tesorería';
  end if;
  if d.asiento_id is not null then
    select estado into v_estado from public.asientos where id = d.asiento_id;
    if v_estado = 'borrador' then
      update public.documentos set asiento_id = null where id = p_id;
      delete from public.asientos where id = d.asiento_id;
    elsif v_estado = 'contabilizado' then
      if app.periodo_abierto(d.empresa_id, d.fecha) then
        perform public.anular_asiento(d.asiento_id, p_motivo);
      else
        perform public.reversar_asiento(d.asiento_id, v_hoy, p_motivo);
      end if;
    end if;
  end if;
  update public.documentos set estado = 'anulado', motivo_anulacion = trim(p_motivo) where id = p_id returning * into d;
  return d;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Tesorería: cobros a clientes y pagos a proveedores

create table public.pagos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  documento_id uuid not null references public.documentos(id),
  tipo text not null check (tipo in ('cobro', 'pago')),
  fecha date not null,
  monto numeric(16,0) not null check (monto > 0),
  cuenta_id uuid not null references public.cuentas(id),
  medio text not null check (medio in ('transferencia', 'cheque', 'efectivo', 'tarjeta', 'deposito', 'otro')),
  referencia text check (length(referencia) <= 100),
  estado text not null default 'vigente' check (estado in ('vigente', 'anulado')),
  motivo_anulacion text,
  asiento_id uuid references public.asientos(id),
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now()
);
create index pagos_documento on public.pagos (documento_id) where estado = 'vigente';
create index pagos_empresa_fecha on public.pagos (empresa_id, fecha);
alter table public.pagos enable row level security;
create policy pagos_sel on public.pagos for select to authenticated using (app.es_miembro(empresa_id));
revoke insert, update, delete on public.pagos from anon, authenticated;
grant select on public.pagos to authenticated;
create trigger auditar after insert or update or delete on public.pagos for each row execute function app.auditar();

alter table public.asientos drop constraint asientos_origen_check;
alter table public.asientos add constraint asientos_origen_check check (origen = any (array['manual','dte_emitido','dte_recibido',
  'documento_venta','documento_compra','cobro','pago','f29','cierre','apertura','reverso','importacion']));

-- Documentos con saldo pendiente (vista con RLS del usuario)
create view public.documentos_saldo with (security_invoker = true) as
select d.*,
       a.estado as asiento_estado,
       coalesce(p.pagado, 0) as pagado,
       case when d.tipo = 61 then 0 else d.total - coalesce(p.pagado, 0) end as saldo
  from public.documentos d
  left join public.asientos a on a.id = d.asiento_id
  left join (select documento_id, sum(monto) pagado from public.pagos where estado = 'vigente' group by 1) p on p.documento_id = d.id;
grant select on public.documentos_saldo to authenticated;

create or replace function public.registrar_pago(p_documento uuid, p_fecha date, p_monto numeric, p_cuenta uuid,
  p_medio text default 'transferencia', p_referencia text default null)
returns public.pagos language plpgsql security definer set search_path to ''
as $$
declare
  d public.documentos_saldo;
  c public.configuracion_cuentas;
  r public.pagos;
  v_aux uuid;
  v_tipo text;
  v_lineas jsonb;
  v_asiento public.asientos;
begin
  select * into d from public.documentos_saldo where id = p_documento;
  if d.id is null then raise exception 'Documento no encontrado'; end if;
  perform 1 from public.documentos where id = p_documento for update;
  if not app.puede(d.empresa_id, 'tesoreria.registrar') then raise exception 'Sin permiso para registrar cobros o pagos'; end if;
  if d.estado <> 'vigente' then raise exception 'El documento está anulado'; end if;
  if d.tipo = 61 then raise exception 'Las notas de crédito no se cobran ni se pagan'; end if;
  if d.asiento_estado is distinct from 'contabilizado' then raise exception 'El documento aún no está aprobado por contabilidad'; end if;
  if coalesce(p_monto, 0) <= 0 then raise exception 'El monto debe ser mayor a cero'; end if;
  if p_monto > d.saldo then raise exception 'El monto supera el saldo pendiente (%)', d.saldo; end if;
  if p_fecha < d.fecha then raise exception 'La fecha no puede ser anterior a la del documento'; end if;
  if p_fecha > (now() at time zone 'America/Santiago')::date then raise exception 'La fecha no puede ser futura'; end if;
  if not exists (select 1 from public.cuentas where id = p_cuenta and empresa_id = d.empresa_id and es_efectivo and imputable and activa) then
    raise exception 'Elija una cuenta de caja o banco válida';
  end if;
  select * into c from public.configuracion_cuentas where empresa_id = d.empresa_id;
  v_tipo := case when d.operacion = 'venta' then 'cobro' else 'pago' end;
  select id into v_aux from public.auxiliares where empresa_id = d.empresa_id and rut = d.rut;

  insert into public.pagos (empresa_id, documento_id, tipo, fecha, monto, cuenta_id, medio, referencia)
  values (d.empresa_id, d.id, v_tipo, p_fecha, p_monto, p_cuenta, p_medio, nullif(trim(p_referencia), ''))
  returning * into r;

  if v_tipo = 'cobro' then
    v_lineas := jsonb_build_array(
      jsonb_build_object('cuenta_id', p_cuenta, 'debe', p_monto),
      jsonb_build_object('cuenta_id', c.cuenta_clientes, 'haber', p_monto, 'auxiliar_id', v_aux, 'documento_tipo', d.tipo, 'documento_folio', d.folio));
  else
    v_lineas := jsonb_build_array(
      jsonb_build_object('cuenta_id', c.cuenta_proveedores, 'debe', p_monto, 'auxiliar_id', v_aux, 'documento_tipo', d.tipo, 'documento_folio', d.folio),
      jsonb_build_object('cuenta_id', p_cuenta, 'haber', p_monto));
  end if;
  v_asiento := public.crear_asiento_sistema(d.empresa_id, p_fecha,
    left(initcap(v_tipo) || ' doc. ' || d.tipo || ' N° ' || d.folio || ' ' || d.razon_social, 500), v_lineas, v_tipo, r.id,
    case when v_tipo = 'cobro' then 'ingreso'::public.tipo_comprobante else 'egreso'::public.tipo_comprobante end, true);
  update public.pagos set asiento_id = v_asiento.id where id = r.id returning * into r;
  return r;
end $$;

create or replace function public.anular_pago(p_id uuid, p_motivo text)
returns public.pagos language plpgsql security definer set search_path to ''
as $$
declare r public.pagos;
begin
  select * into r from public.pagos where id = p_id for update;
  if r.id is null then raise exception 'Movimiento no encontrado'; end if;
  if not app.puede(r.empresa_id, 'tesoreria.anular') then raise exception 'Sin permiso para anular cobros o pagos'; end if;
  if r.estado = 'anulado' then raise exception 'El movimiento ya está anulado'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 5 then raise exception 'Indique el motivo de la anulación'; end if;
  perform set_config('cuadra.sistema', 'on', true);
  if app.periodo_abierto(r.empresa_id, r.fecha) then
    perform public.anular_asiento(r.asiento_id, p_motivo);
  else
    perform public.reversar_asiento(r.asiento_id, (now() at time zone 'America/Santiago')::date, p_motivo);
  end if;
  perform set_config('cuadra.sistema', 'off', true);
  update public.pagos set estado = 'anulado', motivo_anulacion = trim(p_motivo) where id = p_id returning * into r;
  return r;
end $$;

-- Antigüedad de saldos y posición de caja
create or replace function public.resumen_tesoreria(p_empresa uuid)
returns jsonb language sql stable set search_path to ''
as $$
  with hoy as (select (now() at time zone 'America/Santiago')::date d),
  abiertos as (
    select s.operacion, s.saldo, (select d from hoy) - s.fecha as dias
      from public.documentos_saldo s
     where s.empresa_id = p_empresa and s.estado = 'vigente' and s.saldo > 0 and s.asiento_estado = 'contabilizado'),
  tramos as (
    select operacion,
           sum(saldo) filter (where dias <= 30) t0, sum(saldo) filter (where dias between 31 and 60) t1,
           sum(saldo) filter (where dias between 61 and 90) t2, sum(saldo) filter (where dias > 90) t3,
           sum(saldo) total, count(*) n
      from abiertos group by operacion)
  select jsonb_build_object(
    'porCobrar', coalesce((select jsonb_build_object('a30', coalesce(t0,0), 'a60', coalesce(t1,0), 'a90', coalesce(t2,0), 'mas90', coalesce(t3,0), 'total', total, 'documentos', n) from tramos where operacion = 'venta'),
                          '{"a30":0,"a60":0,"a90":0,"mas90":0,"total":0,"documentos":0}'),
    'porPagar', coalesce((select jsonb_build_object('a30', coalesce(t0,0), 'a60', coalesce(t1,0), 'a90', coalesce(t2,0), 'mas90', coalesce(t3,0), 'total', total, 'documentos', n) from tramos where operacion = 'compra'),
                         '{"a30":0,"a60":0,"a90":0,"mas90":0,"total":0,"documentos":0}'),
    'cuentas', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'codigo', c.codigo, 'nombre', c.nombre,
                        'saldo', coalesce((select sum(m.debe - m.haber) from public.movimientos m where m.cuenta_id = c.id), 0)) order by c.codigo), '[]')
                  from public.cuentas c where c.empresa_id = p_empresa and c.es_efectivo and c.imputable and c.activa)
  ) where app.es_miembro(p_empresa)
$$;

revoke execute on function public.registrar_pago(uuid, date, numeric, uuid, text, text) from public, anon;
revoke execute on function public.anular_pago(uuid, text) from public, anon;
revoke execute on function public.resumen_tesoreria(uuid) from public, anon;
revoke execute on function public.mis_permisos(uuid) from public, anon;
revoke execute on function public.matriz_permisos() from public, anon;
grant execute on function public.registrar_pago(uuid, date, numeric, uuid, text, text) to authenticated;
grant execute on function public.anular_pago(uuid, text) to authenticated;
grant execute on function public.resumen_tesoreria(uuid) to authenticated;
grant execute on function public.mis_permisos(uuid) to authenticated;
grant execute on function public.matriz_permisos() to authenticated;

drop function app._reemplazar(regprocedure, text, text);
