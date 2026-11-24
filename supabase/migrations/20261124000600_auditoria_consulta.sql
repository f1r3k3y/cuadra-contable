-- Consulta de auditoría para el rol auditor (y admin): quién, qué, cuándo, desde dónde,
-- con valores antes/después. Registra además ingresos y salidas de usuarios a cada empresa.

-- Ingresos/salidas: cada fila pasa por app.auditar(), así queda en la misma cadena con hash.
create table public.accesos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  usuario_id uuid not null default auth.uid(),
  evento text not null check (evento in ('ingreso', 'salida')),
  rol text,
  en timestamptz not null default now()
);
alter table public.accesos enable row level security;
create policy accesos_sel on public.accesos for select to authenticated using (app.puede_ver(empresa_id, 'auditoria.ver'));
revoke insert, update, delete on public.accesos from anon, authenticated;
grant select on public.accesos to authenticated;
create trigger auditar after insert on public.accesos for each row execute function app.auditar();

create or replace function public.registrar_acceso(p_empresa uuid, p_evento text default 'ingreso')
returns void language plpgsql security definer set search_path to ''
as $$
begin
  if not app.es_miembro(p_empresa) then return; end if;
  if p_evento not in ('ingreso', 'salida') then raise exception 'Evento inválido'; end if;
  -- evita duplicados por recargas: un ingreso por usuario y empresa cada 10 minutos
  if p_evento = 'ingreso' and exists (select 1 from public.accesos where empresa_id = p_empresa and usuario_id = auth.uid()
       and evento = 'ingreso' and en > now() - interval '10 minutes') then
    return;
  end if;
  insert into public.accesos (empresa_id, usuario_id, evento, rol) values (p_empresa, auth.uid(), p_evento, app.rol_efectivo(p_empresa)::text);
end $$;

-- Consulta filtrada y paginada, con nombre y correo del usuario
create or replace function public.auditoria_consulta(
  p_empresa uuid,
  p_desde timestamptz default null,
  p_hasta timestamptz default null,
  p_usuario uuid default null,
  p_tabla text default null,
  p_accion text default null,
  p_texto text default null,
  p_limite int default 100,
  p_offset int default 0)
returns table (id bigint, en timestamptz, tabla text, accion text, registro_id text, usuario_id uuid,
               usuario_nombre text, usuario_correo text, ip text, antes jsonb, despues jsonb,
               hash text, hash_anterior text, total bigint)
language plpgsql stable security definer set search_path to ''
as $$
begin
  if not app.puede_ver(p_empresa, 'auditoria.ver') then raise exception 'Sin permiso para ver la auditoría'; end if;
  return query
  select a.id, a.en, a.tabla, a.accion, a.registro_id, a.usuario_id,
         p.nombre, u.email::text, a.ip, a.antes, a.despues, a.hash, a.hash_anterior,
         count(*) over () as total
    from public.auditoria a
    left join public.perfiles p on p.id = a.usuario_id
    left join auth.users u on u.id = a.usuario_id
   where a.empresa_id = p_empresa
     and (p_desde is null or a.en >= p_desde)
     and (p_hasta is null or a.en < p_hasta)
     and (p_usuario is null or a.usuario_id = p_usuario)
     and (p_tabla is null or a.tabla = p_tabla)
     and (p_accion is null or a.accion = p_accion)
     and (p_texto is null or a.antes::text ilike '%' || p_texto || '%' or a.despues::text ilike '%' || p_texto || '%'
          or a.registro_id ilike '%' || p_texto || '%')
   order by a.id desc
   limit least(greatest(p_limite, 1), 5000) offset greatest(p_offset, 0);
end $$;

-- Usuarios que aparecen en la auditoría (para el filtro) y su actividad
create or replace function public.auditoria_usuarios(p_empresa uuid)
returns table (usuario_id uuid, nombre text, correo text, cambios bigint, ultimo timestamptz)
language plpgsql stable security definer set search_path to ''
as $$
begin
  if not app.puede_ver(p_empresa, 'auditoria.ver') then raise exception 'Sin permiso para ver la auditoría'; end if;
  return query
  select a.usuario_id, p.nombre, u.email::text, count(*), max(a.en)
    from public.auditoria a
    left join public.perfiles p on p.id = a.usuario_id
    left join auth.users u on u.id = a.usuario_id
   where a.empresa_id = p_empresa
   group by a.usuario_id, p.nombre, u.email
   order by max(a.en) desc;
end $$;

revoke execute on function public.registrar_acceso(uuid, text) from public, anon;
revoke execute on function public.auditoria_consulta(uuid, timestamptz, timestamptz, uuid, text, text, text, int, int) from public, anon;
revoke execute on function public.auditoria_usuarios(uuid) from public, anon;
grant execute on function public.registrar_acceso(uuid, text) to authenticated;
grant execute on function public.auditoria_consulta(uuid, timestamptz, timestamptz, uuid, text, text, text, int, int) to authenticated;
grant execute on function public.auditoria_usuarios(uuid) to authenticated;
