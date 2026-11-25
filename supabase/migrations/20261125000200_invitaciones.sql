-- Invitaciones por enlace: el administrador invita un correo con un rol; quien abre el enlace
-- y entra con ese correo queda como miembro. El enlace se guarda solo como hash (SHA-256).

create table public.invitaciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  correo text not null check (correo = lower(trim(correo)) and correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  rol public.rol_empresa not null,
  token_hash text not null unique,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aceptada', 'revocada')),
  creado_por uuid default auth.uid() references auth.users(id),
  creado_en timestamptz not null default now(),
  expira_en timestamptz not null default now() + interval '7 days',
  aceptada_por uuid references auth.users(id),
  aceptada_en timestamptz
);
create index invitaciones_empresa on public.invitaciones (empresa_id, estado);

alter table public.invitaciones enable row level security;
create policy invitaciones_sel on public.invitaciones for select to authenticated
  using (app.puede_ver(empresa_id, 'usuarios.gestionar'));
revoke all on public.invitaciones from anon;
revoke insert, update, delete, truncate on public.invitaciones from authenticated;
grant select on public.invitaciones to authenticated;
create trigger auditar after insert or update or delete on public.invitaciones for each row execute function app.auditar();

create or replace function app.hash_token(p_token text) returns text
language sql immutable set search_path to '' as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

-- Crea la invitación y devuelve el token (solo esta vez). Reemplaza una pendiente al mismo correo.
create or replace function public.crear_invitacion(p_empresa uuid, p_correo text, p_rol public.rol_empresa)
returns text
language plpgsql security definer set search_path to ''
as $$
declare
  v_correo text := lower(trim(p_correo));
  v_token text;
begin
  if not app.puede(p_empresa, 'usuarios.gestionar') then
    raise exception 'Sin permiso para invitar usuarios (o falta la verificación en dos pasos)';
  end if;
  if v_correo !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo inválido'; end if;
  update public.invitaciones set estado = 'revocada'
   where empresa_id = p_empresa and correo = v_correo and estado = 'pendiente';
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  insert into public.invitaciones (empresa_id, correo, rol, token_hash)
  values (p_empresa, v_correo, p_rol, app.hash_token(v_token));
  return v_token;
end $$;

-- Datos mínimos para mostrar la invitación antes de entrar (el token es secreto e imposible de adivinar)
create or replace function public.ver_invitacion(p_token text)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $$
declare i public.invitaciones; v_empresa text;
begin
  if coalesce(length(p_token), 0) < 20 then return null; end if;
  select * into i from public.invitaciones where token_hash = app.hash_token(p_token);
  if i.id is null then return null; end if;
  select razon_social into v_empresa from public.empresas where id = i.empresa_id;
  return jsonb_build_object('empresa', v_empresa, 'rol', i.rol, 'correo', i.correo,
    'vigente', i.estado = 'pendiente' and i.expira_en > now(), 'estado', i.estado);
end $$;

-- Acepta la invitación con la sesión actual; el correo de la cuenta debe ser el invitado
create or replace function public.aceptar_invitacion(p_token text)
returns uuid
language plpgsql security definer set search_path to ''
as $$
declare i public.invitaciones; v_correo text;
begin
  if auth.uid() is null then raise exception 'Inicia sesión para aceptar la invitación'; end if;
  select * into i from public.invitaciones where token_hash = app.hash_token(p_token) for update;
  if i.id is null then raise exception 'La invitación no existe'; end if;
  if i.estado = 'aceptada' and i.aceptada_por = auth.uid() then return i.empresa_id; end if;
  if i.estado <> 'pendiente' then raise exception 'La invitación ya no está disponible (fue %)', i.estado; end if;
  if i.expira_en <= now() then raise exception 'La invitación venció; pide una nueva'; end if;
  select lower(email) into v_correo from auth.users where id = auth.uid();
  if v_correo is distinct from i.correo then
    raise exception 'Esta invitación es para %; entra con ese correo', i.correo;
  end if;
  insert into public.miembros (empresa_id, user_id, rol) values (i.empresa_id, auth.uid(), i.rol)
  on conflict (empresa_id, user_id) do nothing;
  update public.invitaciones set estado = 'aceptada', aceptada_por = auth.uid(), aceptada_en = now() where id = i.id;
  return i.empresa_id;
end $$;

create or replace function public.revocar_invitacion(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $$
declare i public.invitaciones;
begin
  select * into i from public.invitaciones where id = p_id for update;
  if i.id is null then raise exception 'Invitación no encontrada'; end if;
  if not app.puede(i.empresa_id, 'usuarios.gestionar') then raise exception 'Sin permiso para revocar invitaciones'; end if;
  if i.estado <> 'pendiente' then raise exception 'La invitación ya no está pendiente'; end if;
  update public.invitaciones set estado = 'revocada' where id = p_id;
end $$;

revoke execute on function public.crear_invitacion(uuid, text, public.rol_empresa) from public, anon;
revoke execute on function public.aceptar_invitacion(text) from public, anon;
revoke execute on function public.revocar_invitacion(uuid) from public, anon;
revoke execute on function public.ver_invitacion(text) from public;
grant execute on function public.crear_invitacion(uuid, text, public.rol_empresa) to authenticated;
grant execute on function public.aceptar_invitacion(text) to authenticated;
grant execute on function public.revocar_invitacion(uuid) to authenticated;
grant execute on function public.ver_invitacion(text) to anon, authenticated;

-- Agregar por correo revelaba si la persona tenía cuenta: desde ahora solo por invitación
revoke execute on function public.agregar_miembro(uuid, text, public.rol_empresa) from authenticated;
