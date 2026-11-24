-- Modo "probar como rol": un administrador puede actuar temporalmente con los permisos de otro rol
-- en una empresa, para validar accesos. La base de datos aplica el rol de prueba en todas las
-- políticas RLS y funciones (vía app.tiene_rol), y el admin puede volver siempre porque
-- probar_rol() revisa el rol REAL. Cada cambio queda en la auditoría (trigger de miembros).

alter table public.miembros add column rol_prueba public.rol_empresa;

create or replace function app.tiene_rol(p_empresa uuid, p_roles public.rol_empresa[])
returns boolean language sql stable security definer set search_path to ''
as $$
  select exists (
    select 1 from public.miembros m
    where m.empresa_id = p_empresa and m.user_id = auth.uid() and coalesce(m.rol_prueba, m.rol) = any (p_roles)
  )
$$;

-- Solo el propio usuario, siendo admin real, puede tener un rol de prueba.
create or replace function app.validar_rol_prueba()
returns trigger language plpgsql set search_path to ''
as $$
begin
  if new.rol <> 'admin' then
    new.rol_prueba := null;  -- si deja de ser admin, se pierde el modo prueba
  elsif new.rol_prueba is distinct from old.rol_prueba
        and new.rol_prueba is not null
        and new.user_id is distinct from auth.uid() then
    raise exception 'Solo puedes cambiar tu propio rol de prueba';
  end if;
  if new.rol_prueba = 'admin' then new.rol_prueba := null; end if;
  return new;
end $$;

create trigger validar_rol_prueba before update on public.miembros
for each row execute function app.validar_rol_prueba();

create or replace function public.probar_rol(p_empresa uuid, p_rol public.rol_empresa default null)
returns public.rol_empresa
language plpgsql security definer set search_path to ''
as $$
declare v_real public.rol_empresa;
begin
  select rol into v_real from public.miembros where empresa_id = p_empresa and user_id = auth.uid();
  if v_real is distinct from 'admin' or not app.mfa_ok() then
    raise exception 'Solo un administrador (con verificación en dos pasos) puede probar otros roles';
  end if;
  update public.miembros set rol_prueba = nullif(p_rol, 'admin')
   where empresa_id = p_empresa and user_id = auth.uid();
  return coalesce(nullif(p_rol, 'admin'), 'admin');
end $$;

revoke execute on function public.probar_rol(uuid, public.rol_empresa) from public, anon;
grant execute on function public.probar_rol(uuid, public.rol_empresa) to authenticated;
