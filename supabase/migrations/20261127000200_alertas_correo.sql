-- Alertas por correo: cada usuario elige por empresa si las recibe; una función Edge las envía una vez al día (Resend).

create table public.preferencias_alertas (
  user_id uuid not null references auth.users(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  activo boolean not null default true,
  actualizado_en timestamptz not null default now(),
  primary key (user_id, empresa_id)
);
alter table public.preferencias_alertas enable row level security;
create policy preferencias_alertas_sel on public.preferencias_alertas for select to authenticated
  using (user_id = (select auth.uid()));

create table public.envios_alertas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null,
  correo text not null,
  empresas int not null,
  estado text not null check (estado in ('enviado', 'error', 'prueba')),
  error text check (length(error) <= 500),
  creado_en timestamptz not null default now()
);
create unique index envios_alertas_dia on public.envios_alertas (user_id, fecha) where estado = 'enviado';
alter table public.envios_alertas enable row level security;
create policy envios_alertas_sel on public.envios_alertas for select to authenticated using (user_id = (select auth.uid()));

-- El usuario activa o desactiva las alertas de una empresa donde es miembro
create or replace function public.guardar_preferencia_alertas(p_empresa uuid, p_activo boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.miembros where empresa_id = p_empresa and user_id = auth.uid()) then
    raise exception 'No pertenece a la empresa';
  end if;
  insert into public.preferencias_alertas (user_id, empresa_id, activo) values (auth.uid(), p_empresa, p_activo)
  on conflict (user_id, empresa_id) do update set activo = excluded.activo, actualizado_en = now();
end $$;
revoke execute on function public.guardar_preferencia_alertas(uuid, boolean) from public, anon;
grant execute on function public.guardar_preferencia_alertas(uuid, boolean) to authenticated;

-- Avisos del día para un usuario en una empresa, según el rol real (no el de prueba).
-- Para no saturar: plazos tributarios solo cerca del vencimiento; resúmenes semanales los lunes.
create or replace function app.alertas_empresa(p_user uuid, p_empresa uuid, p_hoy date, p_todo boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rol public.rol_empresa;
  v_dia int := extract(day from p_hoy);
  v_lunes boolean := extract(isodow from p_hoy) = 1 or p_todo;
  v_ant text := to_char(p_hoy - interval '1 month', 'YYYYMM');
  v_mes_ant text := (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])
                    [extract(month from p_hoy - interval '1 month')::int];
  xs jsonb := '[]';
  n int; m numeric;
  tiene boolean;
begin
  select rol into v_rol from public.miembros where empresa_id = p_empresa and user_id = p_user;
  if v_rol is null then return xs; end if;
  tiene := false;

  -- F29: del 14 al 20, si el del mes anterior no está presentado
  if exists (select 1 from app.permisos_rol where rol = v_rol and permiso = 'f29.ver') and (v_dia between 14 and 20 or p_todo)
     and not exists (select 1 from public.f29_declaraciones where empresa_id = p_empresa and periodo = v_ant and estado = 'presentado') then
    xs := xs || jsonb_build_object('nivel', case when v_dia >= 18 then 'urgente' else 'aviso' end, 'ruta', '/f29',
      'texto', 'F29 de ' || v_mes_ant || ' sin presentar: vence el 20' || case when v_dia between 14 and 20 then ' (en ' || (20 - v_dia) || ' días)' else '' end || '.');
  end if;

  -- Previred: del 9 al 13
  if exists (select 1 from app.permisos_rol where rol = v_rol and permiso = 'remuneraciones.ver') and (v_dia between 9 and 13 or p_todo)
     and exists (select 1 from public.remuneraciones where empresa_id = p_empresa and periodo = v_ant and estado = 'vigente') then
    xs := xs || jsonb_build_object('nivel', 'aviso', 'ruta', '/remuneraciones',
      'texto', 'Cotizaciones de ' || v_mes_ant || ' en Previred: vencen el 13.');
  end if;

  if exists (select 1 from app.permisos_rol where rol = v_rol and permiso = 'tesoreria.ver') then
    -- Pagos que vencen en los próximos 3 días (todos los días)
    select count(*), coalesce(sum(saldo), 0) into n, m from public.documentos_saldo
     where empresa_id = p_empresa and operacion in ('compra', 'honorario') and estado = 'vigente' and tipo <> 61 and saldo > 0
       and vence between p_hoy and p_hoy + 3;
    if n > 0 then
      xs := xs || jsonb_build_object('nivel', 'aviso', 'ruta', '/tesoreria',
        'texto', n || case when n = 1 then ' documento por pagar vence' else ' documentos por pagar vencen' end || ' en los próximos 3 días ($' || to_char(m, 'FM999G999G999G999') || ').');
    end if;
    -- Vencidos (lunes)
    if v_lunes then
      select count(*), coalesce(sum(saldo), 0) into n, m from public.documentos_saldo
       where empresa_id = p_empresa and operacion = 'venta' and estado = 'vigente' and tipo <> 61 and saldo > 0 and vence < p_hoy;
      if n > 0 then
        xs := xs || jsonb_build_object('nivel', 'aviso', 'ruta', '/tesoreria',
          'texto', n || ' cobros vencidos por $' || to_char(m, 'FM999G999G999G999') || '.');
      end if;
      select count(*), coalesce(sum(saldo), 0) into n, m from public.documentos_saldo
       where empresa_id = p_empresa and operacion in ('compra', 'honorario') and estado = 'vigente' and tipo <> 61 and saldo > 0 and vence < p_hoy;
      if n > 0 then
        xs := xs || jsonb_build_object('nivel', 'urgente', 'ruta', '/tesoreria',
          'texto', n || ' pagos vencidos por $' || to_char(m, 'FM999G999G999G999') || '.');
      end if;
    end if;
  end if;

  -- Borradores por aprobar (lunes)
  if v_lunes and exists (select 1 from app.permisos_rol where rol = v_rol and permiso = 'asientos.contabilizar') then
    select count(*) into n from public.asientos where empresa_id = p_empresa and estado = 'borrador';
    if n > 0 then
      xs := xs || jsonb_build_object('nivel', 'aviso', 'ruta', '/asientos', 'texto', n || ' asientos o documentos esperan tu aprobación.');
    end if;
  end if;

  -- Cartola sin conciliar (lunes)
  if v_lunes and exists (select 1 from app.permisos_rol where rol = v_rol and permiso = 'conciliacion.gestionar') then
    select count(*) into n from public.cartola_movimientos where empresa_id = p_empresa and estado = 'pendiente';
    if n > 0 then
      xs := xs || jsonb_build_object('nivel', 'aviso', 'ruta', '/conciliacion', 'texto', n || ' movimientos del banco sin conciliar.');
    end if;
  end if;

  -- Diciembre: cierre del ejercicio (lunes)
  if v_lunes and extract(month from p_hoy) = 12 and exists (select 1 from app.permisos_rol where rol = v_rol and permiso = 'periodos.cerrar') then
    xs := xs || jsonb_build_object('nivel', 'aviso', 'ruta', '/empresa', 'texto', 'Prepara el cierre del ejercicio ' || extract(year from p_hoy) || '.');
  end if;
  return xs;
end $$;

-- Lote del día para la función Edge (solo con la clave de servicio): usuarios con alertas activas y sus avisos.
create or replace function public.alertas_pendientes(p_hoy date default null, p_user uuid default null, p_todo boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_hoy date := coalesce(p_hoy, (now() at time zone 'America/Santiago')::date);
  r jsonb := '[]';
  u record;
  e record;
  emps jsonb;
  items jsonb;
begin
  for u in
    select distinct p.user_id, au.email, coalesce(pf.nombre, split_part(au.email, '@', 1)) as nombre
      from public.preferencias_alertas p join auth.users au on au.id = p.user_id
      left join public.perfiles pf on pf.id = p.user_id
     where p.activo and au.email is not null and (p_user is null or p.user_id = p_user)
       and (p_user is not null or not exists (select 1 from public.envios_alertas x where x.user_id = p.user_id and x.fecha = v_hoy and x.estado = 'enviado'))
  loop
    emps := '[]';
    for e in select em.id, em.razon_social from public.preferencias_alertas p join public.empresas em on em.id = p.empresa_id
              join public.miembros m on m.empresa_id = p.empresa_id and m.user_id = p.user_id
             where p.user_id = u.user_id and p.activo order by em.razon_social loop
      items := app.alertas_empresa(u.user_id, e.id, v_hoy, p_todo);
      if jsonb_array_length(items) > 0 then emps := emps || jsonb_build_object('empresa', e.razon_social, 'id', e.id, 'avisos', items); end if;
    end loop;
    if jsonb_array_length(emps) > 0 or p_user is not null then
      r := r || jsonb_build_object('userId', u.user_id, 'correo', u.email, 'nombre', u.nombre, 'empresas', emps);
    end if;
  end loop;
  return jsonb_build_object('fecha', v_hoy, 'destinatarios', r);
end $$;
revoke execute on function public.alertas_pendientes(date, uuid, boolean) from public, anon, authenticated;
grant execute on function public.alertas_pendientes(date, uuid, boolean) to service_role;

-- Evita más de una ejecución del lote por día aunque alguien llame a la función pública varias veces
create table app.ejecuciones_alertas (fecha date primary key, iniciado_en timestamptz not null default now());
create or replace function public.reclamar_ejecucion_alertas()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_hoy date := (now() at time zone 'America/Santiago')::date;
begin
  insert into app.ejecuciones_alertas (fecha) values (v_hoy) on conflict do nothing;
  return found;
end $$;
revoke execute on function public.reclamar_ejecucion_alertas() from public, anon, authenticated;
grant execute on function public.reclamar_ejecucion_alertas() to service_role;

create or replace function public.registrar_envio_alerta(p_user uuid, p_correo text, p_empresas int, p_estado text, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.envios_alertas (user_id, fecha, correo, empresas, estado, error)
  values (p_user, (now() at time zone 'America/Santiago')::date, p_correo, p_empresas, p_estado, left(p_error, 500))
  on conflict do nothing
$$;
revoke execute on function public.registrar_envio_alerta(uuid, text, int, text, text) from public, anon, authenticated;
grant execute on function public.registrar_envio_alerta(uuid, text, int, text, text) to service_role;
