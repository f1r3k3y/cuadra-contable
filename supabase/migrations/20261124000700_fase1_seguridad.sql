-- Fase 1 de seguridad (revisión del 23-11-2026):
--  1. Lecturas segregadas por rol en la base (antes solo en la interfaz).
--  2. Modo "ver como" expira a las 8 horas y se limpia al cerrar sesión.
--  3. Eventos de salida limitados (uno por ingreso).
--  4. Privilegios sobrantes: nada para anon, sin TRUNCATE, vistas de solo lectura, DTE heredado revocado.

-- ---------------------------------------------------------------------------
-- 2. Rol de prueba con vencimiento

alter table public.miembros add column if not exists rol_prueba_desde timestamptz;

create or replace function app.validar_rol_prueba()
returns trigger language plpgsql set search_path to ''
as $$
begin
  if new.rol <> 'admin' then
    new.rol_prueba := null;
  elsif new.rol_prueba is distinct from old.rol_prueba
        and new.rol_prueba is not null
        and new.user_id is distinct from auth.uid() then
    raise exception 'Solo puedes cambiar tu propio rol de prueba';
  end if;
  if new.rol_prueba = 'admin' then new.rol_prueba := null; end if;
  if new.rol_prueba is null then
    new.rol_prueba_desde := null;
  elsif new.rol_prueba is distinct from old.rol_prueba then
    new.rol_prueba_desde := now();
  end if;
  return new;
end $$;

-- Rol que rige: el de prueba solo si se activó hace menos de 8 horas
create or replace function app.rol_vigente(p_rol public.rol_empresa, p_prueba public.rol_empresa, p_desde timestamptz)
returns public.rol_empresa language sql stable set search_path to '' as $$
  select case when p_prueba is not null and p_desde > now() - interval '8 hours' then p_prueba else p_rol end
$$;

create or replace function app.rol_efectivo(p_empresa uuid) returns public.rol_empresa
language sql stable security definer set search_path to '' as $$
  select app.rol_vigente(m.rol, m.rol_prueba, m.rol_prueba_desde)
    from public.miembros m where m.empresa_id = p_empresa and m.user_id = auth.uid()
$$;

create or replace function app.tiene_rol(p_empresa uuid, p_roles public.rol_empresa[])
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.miembros m
                  where m.empresa_id = p_empresa and m.user_id = auth.uid()
                    and app.rol_vigente(m.rol, m.rol_prueba, m.rol_prueba_desde) = any (p_roles))
$$;

-- ---------------------------------------------------------------------------
-- 3. Accesos: la salida también apaga el modo prueba; una salida por ingreso

create or replace function public.registrar_acceso(p_empresa uuid, p_evento text default 'ingreso')
returns void language plpgsql security definer set search_path to ''
as $$
declare v_ultimo text;
begin
  if not app.es_miembro(p_empresa) then return; end if;
  if p_evento not in ('ingreso', 'salida') then raise exception 'Evento inválido'; end if;
  select evento into v_ultimo from public.accesos
   where empresa_id = p_empresa and usuario_id = auth.uid() order by en desc limit 1;
  if p_evento = 'ingreso' and v_ultimo = 'ingreso' and exists (select 1 from public.accesos where empresa_id = p_empresa
       and usuario_id = auth.uid() and evento = 'ingreso' and en > now() - interval '10 minutes') then
    return;
  end if;
  if p_evento = 'salida' then
    update public.miembros set rol_prueba = null
     where empresa_id = p_empresa and user_id = auth.uid() and rol_prueba is not null;
    if v_ultimo is distinct from 'ingreso' then return; end if;
  end if;
  insert into public.accesos (empresa_id, usuario_id, evento, rol) values (p_empresa, auth.uid(), p_evento, app.rol_efectivo(p_empresa)::text);
end $$;

-- ---------------------------------------------------------------------------
-- 1. Lecturas por rol

-- Estado de aprobación de un asiento (sin exponer el asiento), para tesorería
create or replace function app.estado_asiento(p_id uuid) returns public.estado_asiento
language sql stable security definer set search_path to '' as $$
  select estado from public.asientos where id = p_id
$$;

-- Monto cobrado/pagado de un documento (sin exponer los movimientos de tesorería)
create or replace function app.pagado_documento(p_id uuid) returns numeric
language sql stable security definer set search_path to '' as $$
  select coalesce(sum(monto), 0) from public.pagos where documento_id = p_id and estado = 'vigente'
$$;

create or replace view public.documentos_saldo with (security_invoker = true) as
select d.*,
       app.estado_asiento(d.asiento_id) as asiento_estado,
       app.pagado_documento(d.id) as pagado,
       case when d.tipo = 61 then 0 else d.total - app.pagado_documento(d.id) end as saldo
  from public.documentos d;

drop policy if exists asientos_sel on public.asientos;
create policy asientos_sel on public.asientos for select to authenticated
  using (app.puede_ver(empresa_id, 'asientos.ver') or app.puede_ver(empresa_id, 'reportes.ver'));
drop policy if exists asiento_lineas_sel on public.asiento_lineas;
create policy asiento_lineas_sel on public.asiento_lineas for select to authenticated
  using (app.puede_ver(empresa_id, 'asientos.ver') or app.puede_ver(empresa_id, 'reportes.ver'));

drop policy if exists f29_sel on public.f29_declaraciones;
create policy f29_sel on public.f29_declaraciones for select to authenticated using (app.puede_ver(empresa_id, 'f29.ver'));

-- Los movimientos de tesorería solo con permiso de tesorería; el saldo por documento lo da la vista
drop policy if exists pagos_sel on public.pagos;
create policy pagos_sel on public.pagos for select to authenticated using (app.puede_ver(empresa_id, 'tesoreria.ver'));

-- Cada usuario ve su propia membresía; el resto solo quien puede ver la empresa
drop policy if exists miembros_sel on public.miembros;
create policy miembros_sel on public.miembros for select to authenticated
  using (user_id = (select auth.uid()) or app.puede_ver(empresa_id, 'empresa.ver'));

-- Tesorería: calcula saldos de caja aunque el rol no vea los asientos
create or replace function public.resumen_tesoreria(p_empresa uuid)
returns jsonb language plpgsql stable security definer set search_path to ''
as $$
declare r jsonb;
begin
  if not app.puede_ver(p_empresa, 'tesoreria.ver') then raise exception 'Sin permiso para ver tesorería'; end if;
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
  ) into r;
  return r;
end $$;

create or replace function app._reemplazar(p_fn regprocedure, p_de text, p_a text) returns void
language plpgsql set search_path to '' as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_de in d) = 0 then raise exception 'No se encontró el texto a reemplazar en %', p_fn; end if;
  execute replace(d, p_de, p_a);
end $$;
select app._reemplazar('public.propuesta_f29(uuid,text)',
  $x$perform app.exigir_miembro(p_empresa);$x$,
  $x$if not app.puede_ver(p_empresa, 'f29.ver') then raise exception 'Sin permiso para ver el F29'; end if;$x$);
drop function app._reemplazar(regprocedure, text, text);

-- ---------------------------------------------------------------------------
-- 4. Privilegios

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

revoke truncate on all tables in schema public from authenticated;
alter default privileges for role postgres in schema public revoke truncate on tables from authenticated;

revoke insert, update, delete on public.documentos_saldo, public.movimientos from authenticated;

-- Facturación electrónica heredada (sin uso en esta versión)
revoke execute on function public.contabilizar_dte_emitido(uuid) from authenticated, public;
revoke execute on function public.contabilizar_dte_recibido(uuid, uuid, uuid) from authenticated, public;

revoke execute on function app.estado_asiento(uuid) from public, anon;
grant execute on function app.estado_asiento(uuid) to authenticated;
revoke execute on function app.pagado_documento(uuid) from public, anon;
grant execute on function app.pagado_documento(uuid) to authenticated;
grant execute on function app.rol_vigente(public.rol_empresa, public.rol_empresa, timestamptz) to authenticated;
