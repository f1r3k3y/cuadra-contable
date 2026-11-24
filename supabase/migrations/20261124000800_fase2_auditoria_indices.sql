-- Fase 2 (revisión 23-11-2026):
--  * IP real en la auditoría: cf-connecting-ip (la pone Cloudflare; el cliente no la controla).
--    Antes se tomaba el primer valor de X-Forwarded-For, que el cliente puede inventar.
--  * Se guarda además el navegador (user-agent) y el país (cf-ipcountry). Estos dos datos son
--    informativos y no forman parte del hash, para no alterar la cadena existente.
--  * Índices para claves foráneas usadas en filtros/uniones y políticas que evalúan auth.uid() una vez.

drop function if exists public.diag_cabeceras_ip();

alter table public.auditoria add column if not exists agente text;
alter table public.auditoria add column if not exists pais text;

create or replace function app.auditar()
returns trigger language plpgsql security definer set search_path to ''
as $$
declare
  v_empresa uuid;
  v_id text;
  v_antes jsonb;
  v_despues jsonb;
  v_prev text;
  v_ip text;
  v_agente text;
  v_pais text;
  v_cab jsonb;
  v_en timestamptz := clock_timestamp();
begin
  if tg_op in ('UPDATE', 'DELETE') then v_antes := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_despues := to_jsonb(new); end if;
  v_antes := v_antes - 'xml' - 'cifrado';
  v_despues := v_despues - 'xml' - 'cifrado';
  v_empresa := coalesce((v_despues ->> 'empresa_id')::uuid, (v_antes ->> 'empresa_id')::uuid,
                        case when tg_table_name = 'empresas' then coalesce((v_despues ->> 'id')::uuid, (v_antes ->> 'id')::uuid) end);
  v_id := coalesce(v_despues ->> 'id', v_antes ->> 'id');
  begin
    v_cab := current_setting('request.headers', true)::jsonb;
    -- IP: la que agrega Cloudflare; si no hay, el último salto de X-Forwarded-For (el que agregó el proxy)
    v_ip := coalesce(nullif(v_cab ->> 'cf-connecting-ip', ''),
                     nullif(trim((regexp_split_to_array(coalesce(v_cab ->> 'x-forwarded-for', ''), ','))[
                       array_length(regexp_split_to_array(coalesce(v_cab ->> 'x-forwarded-for', ''), ','), 1)]), ''));
    v_agente := left(v_cab ->> 'user-agent', 300);
    v_pais := left(v_cab ->> 'cf-ipcountry', 2);
  exception when others then v_ip := null;
  end;
  perform pg_advisory_xact_lock(hashtextextended('auditoria:' || coalesce(v_empresa::text, '-'), 0));
  select a.hash into v_prev from public.auditoria a
   where a.empresa_id is not distinct from v_empresa order by a.id desc limit 1;
  insert into public.auditoria (empresa_id, tabla, registro_id, accion, usuario_id, ip, agente, pais, antes, despues, en, hash_anterior, hash)
  values (v_empresa, tg_table_name, v_id, tg_op, auth.uid(), v_ip, v_agente, v_pais, v_antes, v_despues, v_en, v_prev,
          encode(extensions.digest(coalesce(v_prev, '') || tg_table_name || coalesce(v_id, '') || tg_op ||
                 coalesce(auth.uid()::text, '') || coalesce(v_antes::text, '') || coalesce(v_despues::text, '') ||
                 to_char(v_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'sha256'), 'hex'));
  return coalesce(new, old);
end $$;

drop function if exists public.auditoria_consulta(uuid, timestamptz, timestamptz, uuid, text, text, text, int, int);
create function public.auditoria_consulta(
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
               usuario_nombre text, usuario_correo text, ip text, agente text, pais text, antes jsonb, despues jsonb,
               hash text, hash_anterior text, total bigint)
language plpgsql stable security definer set search_path to ''
as $$
begin
  if not app.puede_ver(p_empresa, 'auditoria.ver') then raise exception 'Sin permiso para ver la auditoría'; end if;
  return query
  select a.id, a.en, a.tabla, a.accion, a.registro_id, a.usuario_id,
         p.nombre, u.email::text, a.ip, a.agente, a.pais, a.antes, a.despues, a.hash, a.hash_anterior,
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
revoke execute on function public.auditoria_consulta(uuid, timestamptz, timestamptz, uuid, text, text, text, int, int) from public, anon;
grant execute on function public.auditoria_consulta(uuid, timestamptz, timestamptz, uuid, text, text, text, int, int) to authenticated;

-- Índices
create index if not exists asiento_lineas_cuenta on public.asiento_lineas (cuenta_id);
create index if not exists asientos_reverso_de on public.asientos (reverso_de) where reverso_de is not null;
create index if not exists asientos_empresa_estado on public.asientos (empresa_id, estado);
create index if not exists documentos_asiento on public.documentos (asiento_id);
create index if not exists pagos_asiento on public.pagos (asiento_id);
create index if not exists pagos_cuenta on public.pagos (cuenta_id);
create index if not exists cuentas_padre on public.cuentas (padre_id);
create index if not exists accesos_usuario on public.accesos (empresa_id, usuario_id, en desc);
create index if not exists auditoria_empresa_id on public.auditoria (empresa_id, id desc);

-- Políticas que evaluaban auth.uid() por fila
drop policy if exists perfiles_ins on public.perfiles;
create policy perfiles_ins on public.perfiles for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists perfiles_upd on public.perfiles;
create policy perfiles_upd on public.perfiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
drop policy if exists perfiles_sel on public.perfiles;
create policy perfiles_sel on public.perfiles for select to authenticated
  using (id = (select auth.uid()) or exists (
    select 1 from public.miembros a join public.miembros b on a.empresa_id = b.empresa_id
     where a.user_id = (select auth.uid()) and b.user_id = perfiles.id));
drop policy if exists empresas_ins on public.empresas;
create policy empresas_ins on public.empresas for insert to authenticated
  with check (creado_por = (select auth.uid()) and app.mfa_ok());
drop policy if exists empresas_sel on public.empresas;
create policy empresas_sel on public.empresas for select to authenticated
  using (app.es_miembro(id) or creado_por = (select auth.uid()));
