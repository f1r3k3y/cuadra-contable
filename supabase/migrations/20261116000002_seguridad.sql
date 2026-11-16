-- Seguridad: roles por empresa, MFA, RLS en todas las tablas y auditoría encadenada.

-- ---------------------------------------------------------------------------
-- Funciones de autorización

create or replace function app.es_miembro(p_empresa uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.miembros m where m.empresa_id = p_empresa and m.user_id = auth.uid())
$$;

create or replace function app.tiene_rol(p_empresa uuid, p_roles public.rol_empresa[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.miembros m
    where m.empresa_id = p_empresa and m.user_id = auth.uid() and m.rol = any (p_roles)
  )
$$;

-- MFA obligatorio para escribir. Se puede desactivar en desarrollo con:
--   alter database postgres set app.exigir_mfa = 'off';
create or replace function app.mfa_ok() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('app.exigir_mfa', true), 'on') = 'off'
      or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

-- Llamadas desde Edge Functions con la service key.
create or replace function app.es_servicio() returns boolean
language sql stable set search_path = '' as $$ select coalesce(auth.jwt() ->> 'role', '') = 'service_role' $$;

create or replace function app.puede_escribir(p_empresa uuid, p_roles public.rol_empresa[]) returns boolean
language sql stable set search_path = '' as $$
  select app.tiene_rol(p_empresa, p_roles) and app.mfa_ok()
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS

alter table public.perfiles enable row level security;
alter table public.empresas enable row level security;
alter table public.miembros enable row level security;
alter table public.cuentas enable row level security;
alter table public.centros_costo enable row level security;
alter table public.auxiliares enable row level security;
alter table public.configuracion_cuentas enable row level security;
alter table public.periodos enable row level security;
alter table public.asientos enable row level security;
alter table public.asiento_lineas enable row level security;
alter table public.secretos enable row level security;
alter table public.certificados enable row level security;
alter table public.cafs enable row level security;
alter table public.dte_emitidos enable row level security;
alter table public.dte_recibidos enable row level security;
alter table public.envios_sii enable row level security;
alter table public.rcv_registros enable row level security;
alter table public.f29_declaraciones enable row level security;
alter table public.auditoria enable row level security;

-- Perfiles: cada uno ve y edita el suyo; ve los de sus compañeros de empresa.
create policy perfiles_sel on public.perfiles for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from public.miembros a join public.miembros b on a.empresa_id = b.empresa_id
    where a.user_id = auth.uid() and b.user_id = perfiles.id));
create policy perfiles_ins on public.perfiles for insert to authenticated with check (id = auth.uid());
create policy perfiles_upd on public.perfiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Empresas
create policy empresas_sel on public.empresas for select to authenticated using (app.es_miembro(id));
create policy empresas_ins on public.empresas for insert to authenticated with check (creado_por = auth.uid() and app.mfa_ok());
create policy empresas_upd on public.empresas for update to authenticated
  using (app.puede_escribir(id, '{admin}')) with check (app.puede_escribir(id, '{admin}'));

-- Miembros: se ven entre sí; solo admin administra.
create policy miembros_sel on public.miembros for select to authenticated using (app.es_miembro(empresa_id));
create policy miembros_admin on public.miembros for all to authenticated
  using (app.puede_escribir(empresa_id, '{admin}')) with check (app.puede_escribir(empresa_id, '{admin}'));

-- Maestros contables: admin y contador.
do $$
declare t text;
begin
  foreach t in array array['cuentas', 'centros_costo', 'configuracion_cuentas', 'periodos'] loop
    execute format('create policy %1$s_sel on public.%1$s for select to authenticated using (app.es_miembro(empresa_id))', t);
    execute format('create policy %1$s_mod on public.%1$s for all to authenticated using (app.puede_escribir(empresa_id, ''{admin,contador}'')) with check (app.puede_escribir(empresa_id, ''{admin,contador}''))', t);
  end loop;
  -- Operadores también registran clientes/proveedores y comprobantes en borrador.
  foreach t in array array['auxiliares', 'asientos', 'asiento_lineas', 'dte_recibidos', 'rcv_registros'] loop
    execute format('create policy %1$s_sel on public.%1$s for select to authenticated using (app.es_miembro(empresa_id))', t);
    execute format('create policy %1$s_mod on public.%1$s for all to authenticated using (app.puede_escribir(empresa_id, ''{admin,contador,operador}'')) with check (app.puede_escribir(empresa_id, ''{admin,contador,operador}''))', t);
  end loop;
  -- Solo lectura desde el cliente; se escriben desde Edge Functions con rol de servicio.
  foreach t in array array['certificados', 'cafs', 'dte_emitidos', 'envios_sii'] loop
    execute format('create policy %1$s_sel on public.%1$s for select to authenticated using (app.es_miembro(empresa_id))', t);
  end loop;
end $$;

create policy f29_sel on public.f29_declaraciones for select to authenticated using (app.es_miembro(empresa_id));
create policy f29_mod on public.f29_declaraciones for all to authenticated
  using (app.puede_escribir(empresa_id, '{admin,contador}')) with check (app.puede_escribir(empresa_id, '{admin,contador}'));

-- Auditoría: la ven admin y auditor. Nadie la modifica.
create policy auditoria_sel on public.auditoria for select to authenticated
  using (app.tiene_rol(empresa_id, '{admin,auditor}'));

-- secretos: sin políticas => inaccesible para anon/authenticated.
revoke all on public.secretos from anon, authenticated;
revoke insert, update, delete on public.auditoria from anon, authenticated;
revoke all on all tables in schema public from anon;

-- Columnas pesadas o sensibles de DTE que no hace falta exponer en listados masivos
-- siguen siendo legibles por miembros (necesarias para PDF y reenvío).

-- ---------------------------------------------------------------------------
-- Auditoría encadenada

create or replace function app.auditar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_empresa uuid;
  v_id text;
  v_antes jsonb;
  v_despues jsonb;
  v_prev text;
  v_ip text;
  v_en timestamptz := clock_timestamp();
begin
  if tg_op in ('UPDATE', 'DELETE') then v_antes := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_despues := to_jsonb(new); end if;
  -- No guardar XML completos en la bitácora (se conservan en su tabla).
  v_antes := v_antes - 'xml' - 'cifrado';
  v_despues := v_despues - 'xml' - 'cifrado';
  v_empresa := coalesce((v_despues ->> 'empresa_id')::uuid, (v_antes ->> 'empresa_id')::uuid,
                        case when tg_table_name = 'empresas' then coalesce((v_despues ->> 'id')::uuid, (v_antes ->> 'id')::uuid) end);
  v_id := coalesce(v_despues ->> 'id', v_antes ->> 'id');
  begin
    v_ip := split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1);
  exception when others then v_ip := null;
  end;
  perform pg_advisory_xact_lock(hashtextextended('auditoria:' || coalesce(v_empresa::text, '-'), 0));
  select a.hash into v_prev from public.auditoria a
   where a.empresa_id is not distinct from v_empresa order by a.id desc limit 1;
  insert into public.auditoria (empresa_id, tabla, registro_id, accion, usuario_id, ip, antes, despues, en, hash_anterior, hash)
  values (v_empresa, tg_table_name, v_id, tg_op, auth.uid(), v_ip, v_antes, v_despues, v_en, v_prev,
          encode(extensions.digest(coalesce(v_prev, '') || tg_table_name || coalesce(v_id, '') || tg_op ||
                 coalesce(auth.uid()::text, '') || coalesce(v_antes::text, '') || coalesce(v_despues::text, '') ||
                 to_char(v_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'sha256'), 'hex'));
  return coalesce(new, old);
end $$;

create or replace function app.auditoria_inmutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'La bitácora de auditoría no se puede modificar ni borrar';
end $$;

create trigger auditoria_inmutable before update or delete on public.auditoria
  for each row execute function app.auditoria_inmutable();

do $$
declare t text;
begin
  foreach t in array array['empresas', 'miembros', 'cuentas', 'configuracion_cuentas', 'periodos', 'asientos',
                           'asiento_lineas', 'certificados', 'cafs', 'dte_emitidos', 'dte_recibidos',
                           'f29_declaraciones', 'auxiliares'] loop
    execute format('create trigger auditar after insert or update or delete on public.%I for each row execute function app.auditar()', t);
  end loop;
end $$;

-- Verifica la integridad de la cadena de una empresa: devuelve el primer id roto o null.
create or replace function public.verificar_auditoria(p_empresa uuid) returns bigint
language plpgsql stable security invoker set search_path = '' as $$
declare
  r record;
  v_prev text := null;
begin
  if not app.tiene_rol(p_empresa, '{admin,auditor}') then raise exception 'Sin permiso'; end if;
  for r in select * from public.auditoria where empresa_id = p_empresa order by id loop
    if r.hash_anterior is distinct from v_prev or r.hash <> encode(extensions.digest(
         coalesce(r.hash_anterior, '') || r.tabla || coalesce(r.registro_id, '') || r.accion ||
         coalesce(r.usuario_id::text, '') || coalesce(r.antes::text, '') || coalesce(r.despues::text, '') ||
         to_char(r.en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'sha256'), 'hex') then
      return r.id;
    end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;
