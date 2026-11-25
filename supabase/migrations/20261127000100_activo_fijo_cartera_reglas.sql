-- Brechas frente a otros software contables chilenos:
--  1. Activo fijo: registro, depreciación mensual lineal (normal o acelerada según tabla SII) y baja.
--  2. Cartera: resumen de todas las empresas del usuario (para contadores con varios clientes).
--  3. Reglas de conciliación: contabilizan solos los movimientos de la cartola que calzan con un texto.
--  4. F29: el aviso de "la propuesta cambió" compara montos, no la forma de las líneas.

-- ───────────────────────── Permisos ─────────────────────────
insert into app.permisos_rol (rol, permiso)
select r::public.rol_empresa, p from (values
  ('activos.ver',       '{admin,contador,auditor,gerente}'),
  ('activos.gestionar', '{admin,contador}')
) as v(p, roles), unnest(roles::text[]) as r
on conflict do nothing;

alter table public.asientos drop constraint asientos_origen_check;
alter table public.asientos add constraint asientos_origen_check check (origen = any (array[
  'manual', 'dte_emitido', 'dte_recibido', 'documento_venta', 'documento_compra', 'documento_honorario', 'cobro', 'pago',
  'remuneracion', 'pago_remuneracion', 'conciliacion', 'f29', 'cierre', 'apertura', 'reverso', 'importacion',
  'depreciacion', 'baja_activo']));

-- ───────────────────────── 1. Activo fijo ─────────────────────────
create table public.activos_fijos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  codigo text check (length(codigo) <= 30),
  nombre text not null check (length(trim(nombre)) between 1 and 150),
  categoria text check (length(categoria) <= 120),
  fecha_compra date not null,
  inicio_depreciacion date not null check (extract(day from inicio_depreciacion) = 1),
  valor numeric(14,0) not null check (valor > 0),
  valor_residual numeric(14,0) not null default 1 check (valor_residual >= 0),
  vida_util_meses int not null check (vida_util_meses between 1 and 1200),
  depreciacion_inicial numeric(14,0) not null default 0 check (depreciacion_inicial >= 0),
  cuenta_activo uuid not null references public.cuentas(id),
  cuenta_depreciacion uuid not null references public.cuentas(id),
  cuenta_gasto uuid not null references public.cuentas(id),
  documento_id uuid references public.documentos(id),
  estado text not null default 'activo' check (estado in ('activo', 'baja')),
  fecha_baja date,
  motivo_baja text check (length(motivo_baja) <= 300),
  baja_asiento_id uuid references public.asientos(id),
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now(),
  check (valor_residual + depreciacion_inicial <= valor),
  check ((estado = 'baja') = (fecha_baja is not null))
);
create index on public.activos_fijos (empresa_id);
create unique index activos_fijos_codigo on public.activos_fijos (empresa_id, codigo) where codigo is not null;

-- Una fila por activo y mes; vale mientras su asiento no esté anulado.
create table public.depreciaciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  activo_id uuid not null references public.activos_fijos(id) on delete cascade,
  periodo char(6) not null check (periodo ~ '^\d{6}$'),
  monto numeric(14,0) not null check (monto > 0),
  asiento_id uuid not null references public.asientos(id) on delete cascade,
  creado_en timestamptz not null default now()
);
create index on public.depreciaciones (empresa_id, periodo);
create index on public.depreciaciones (activo_id);

alter table public.activos_fijos enable row level security;
alter table public.depreciaciones enable row level security;
create policy activos_fijos_sel on public.activos_fijos for select to authenticated using (app.puede_ver(empresa_id, 'activos.ver'));
create policy depreciaciones_sel on public.depreciaciones for select to authenticated using (app.puede_ver(empresa_id, 'activos.ver'));
create trigger auditar after insert or update or delete on public.activos_fijos for each row execute function app.auditar();
create trigger auditar after insert or update or delete on public.depreciaciones for each row execute function app.auditar();

-- Depreciación vigente acumulada de un activo (sin la de asientos anulados)
create or replace function app.depreciacion_acumulada(p_activo uuid, p_hasta char(6) default '999912')
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(d.monto), 0) from public.depreciaciones d join public.asientos a on a.id = d.asiento_id
   where d.activo_id = p_activo and d.periodo <= p_hasta and a.estado <> 'anulado'
$$;

create view public.activos_saldo with (security_invoker = true) as
select f.*,
       f.depreciacion_inicial + app.depreciacion_acumulada(f.id) as depreciacion_acumulada,
       f.valor - f.depreciacion_inicial - app.depreciacion_acumulada(f.id) as valor_libro,
       round((f.valor - f.valor_residual)::numeric / f.vida_util_meses) as cuota_mensual,
       (select max(d.periodo) from public.depreciaciones d join public.asientos a on a.id = d.asiento_id
         where d.activo_id = f.id and a.estado <> 'anulado') as ultimo_periodo
  from public.activos_fijos f;
grant select on public.activos_saldo to authenticated;

create or replace function app.validar_cuenta(p_empresa uuid, p_cuenta uuid, p_tipo public.tipo_cuenta, p_nombre text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.cuentas where id = p_cuenta and empresa_id = p_empresa and imputable and activa and tipo = p_tipo) then
    raise exception 'Elija una cuenta de % válida (imputable y activa)', p_nombre;
  end if;
end $$;

create or replace function public.registrar_activo(
  p_empresa uuid, p_nombre text, p_fecha_compra date, p_valor numeric, p_vida_util_meses int,
  p_cuenta_activo uuid, p_cuenta_depreciacion uuid, p_cuenta_gasto uuid,
  p_inicio date default null, p_valor_residual numeric default 1, p_depreciacion_inicial numeric default 0,
  p_categoria text default null, p_codigo text default null, p_documento uuid default null)
returns public.activos_fijos
language plpgsql security definer set search_path = '' as $$
declare a public.activos_fijos;
begin
  if not app.puede(p_empresa, 'activos.gestionar') then
    raise exception 'Sin permiso para gestionar activos fijos (o falta la verificación en dos pasos)';
  end if;
  perform app.validar_cuenta(p_empresa, p_cuenta_activo, 'activo', 'activo fijo');
  perform app.validar_cuenta(p_empresa, p_cuenta_depreciacion, 'activo', 'depreciación acumulada');
  perform app.validar_cuenta(p_empresa, p_cuenta_gasto, 'gasto', 'gasto por depreciación');
  if p_cuenta_activo = p_cuenta_depreciacion then raise exception 'La cuenta del activo y la de depreciación acumulada deben ser distintas'; end if;
  if p_documento is not null and not exists (select 1 from public.documentos where id = p_documento and empresa_id = p_empresa and operacion = 'compra') then
    raise exception 'La factura de compra no corresponde a la empresa';
  end if;
  insert into public.activos_fijos (empresa_id, codigo, nombre, categoria, fecha_compra, inicio_depreciacion, valor, valor_residual,
                                    vida_util_meses, depreciacion_inicial, cuenta_activo, cuenta_depreciacion, cuenta_gasto, documento_id)
  values (p_empresa, nullif(trim(p_codigo), ''), trim(p_nombre), nullif(trim(p_categoria), ''), p_fecha_compra,
          date_trunc('month', coalesce(p_inicio, p_fecha_compra))::date, round(p_valor), round(coalesce(p_valor_residual, 1)),
          p_vida_util_meses, round(coalesce(p_depreciacion_inicial, 0)), p_cuenta_activo, p_cuenta_depreciacion, p_cuenta_gasto, p_documento)
  returning * into a;
  return a;
end $$;
revoke execute on function public.registrar_activo(uuid, text, date, numeric, int, uuid, uuid, uuid, date, numeric, numeric, text, text, uuid) from public, anon;
grant execute on function public.registrar_activo(uuid, text, date, numeric, int, uuid, uuid, uuid, date, numeric, numeric, text, text, uuid) to authenticated;

-- Cuota de un activo para un mes (lineal; el último mes toma el saldo para no dejar residuos por redondeo)
create or replace function app.cuota_depreciacion(a public.activos_fijos, p_periodo char(6))
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare
  v_mes date := to_date(p_periodo || '01', 'YYYYMMDD');
  v_pend numeric;
  v_cuota numeric;
  v_meses int;
begin
  if v_mes < a.inicio_depreciacion then return 0; end if;
  if a.estado = 'baja' and v_mes > date_trunc('month', a.fecha_baja) then return 0; end if;
  v_pend := a.valor - a.valor_residual - a.depreciacion_inicial - app.depreciacion_acumulada(a.id);
  if v_pend <= 0 then return 0; end if;
  v_cuota := round((a.valor - a.valor_residual)::numeric / a.vida_util_meses);
  v_meses := (extract(year from age(v_mes, a.inicio_depreciacion)) * 12 + extract(month from age(v_mes, a.inicio_depreciacion)))::int + 1;
  if v_meses >= a.vida_util_meses or v_cuota >= v_pend then return v_pend; end if;
  return v_cuota;
end $$;

create or replace function public.depreciar_mes(p_empresa uuid, p_periodo text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.activos_fijos;
  v_cuota numeric;
  v_total numeric := 0;
  n int := 0;
  v_lineas jsonb := '[]';
  v_items jsonb := '[]';
  v_asiento public.asientos;
  v_fecha date;
  g record;
begin
  if not app.puede(p_empresa, 'activos.gestionar') then
    raise exception 'Sin permiso para depreciar (o falta la verificación en dos pasos)';
  end if;
  if p_periodo !~ '^\d{6}$' then raise exception 'Período inválido (use AAAAMM)'; end if;
  v_fecha := (to_date(p_periodo || '01', 'YYYYMMDD') + interval '1 month - 1 day')::date;
  if exists (select 1 from public.depreciaciones d join public.asientos x on x.id = d.asiento_id
              where d.empresa_id = p_empresa and d.periodo = p_periodo and x.estado <> 'anulado') then
    raise exception 'La depreciación de %-% ya está registrada (anúlela para rehacerla)', substr(p_periodo, 5, 2), substr(p_periodo, 1, 4);
  end if;

  for a in select * from public.activos_fijos where empresa_id = p_empresa order by nombre loop
    v_cuota := app.cuota_depreciacion(a, p_periodo);
    if v_cuota > 0 then
      v_items := v_items || jsonb_build_object('activo_id', a.id, 'monto', v_cuota, 'cuenta_gasto', a.cuenta_gasto, 'cuenta_depreciacion', a.cuenta_depreciacion);
      v_total := v_total + v_cuota; n := n + 1;
    end if;
  end loop;
  if n = 0 then raise exception 'No hay activos por depreciar en %-%', substr(p_periodo, 5, 2), substr(p_periodo, 1, 4); end if;

  for g in select x.cuenta_gasto c, sum(x.monto) m from jsonb_to_recordset(v_items) as x(cuenta_gasto uuid, monto numeric) group by 1 loop
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', g.c, 'debe', g.m);
  end loop;
  for g in select x.cuenta_depreciacion c, sum(x.monto) m from jsonb_to_recordset(v_items) as x(cuenta_depreciacion uuid, monto numeric) group by 1 loop
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', g.c, 'haber', g.m);
  end loop;

  v_asiento := public.crear_asiento_sistema(p_empresa, v_fecha,
    'Depreciación activo fijo ' || substr(p_periodo, 5, 2) || '-' || substr(p_periodo, 1, 4),
    v_lineas, 'depreciacion', null, 'traspaso'::public.tipo_comprobante, app.puede(p_empresa, 'asientos.contabilizar'));
  insert into public.depreciaciones (empresa_id, activo_id, periodo, monto, asiento_id)
  select p_empresa, x.activo_id, p_periodo, x.monto, v_asiento.id from jsonb_to_recordset(v_items) as x(activo_id uuid, monto numeric);
  return jsonb_build_object('activos', n, 'total', v_total, 'asiento', v_asiento.numero, 'estado', v_asiento.estado);
end $$;
revoke execute on function public.depreciar_mes(uuid, text) from public, anon;
grant execute on function public.depreciar_mes(uuid, text) to authenticated;

create or replace function public.anular_depreciacion(p_empresa uuid, p_periodo text, p_motivo text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_asiento uuid; v_estado public.estado_asiento;
begin
  if not app.puede(p_empresa, 'activos.gestionar') then raise exception 'Sin permiso para gestionar activos fijos'; end if;
  select a.id, a.estado into v_asiento, v_estado from public.depreciaciones d join public.asientos a on a.id = d.asiento_id
   where d.empresa_id = p_empresa and d.periodo = p_periodo and a.estado <> 'anulado' limit 1;
  if v_asiento is null then raise exception 'No hay depreciación registrada en ese mes'; end if;
  if v_estado = 'borrador' then
    delete from public.asientos where id = v_asiento;
  else
    perform public.anular_asiento(v_asiento, p_motivo);
  end if;
end $$;
revoke execute on function public.anular_depreciacion(uuid, text, text) from public, anon;
grant execute on function public.anular_depreciacion(uuid, text, text) to authenticated;

-- Baja (venta, pérdida o desuso): saca el costo y la depreciación acumulada; el valor libro va a "Otros gastos fuera de explotación".
create or replace function public.dar_baja_activo(p_id uuid, p_fecha date, p_motivo text, p_cuenta_perdida uuid default null)
returns public.activos_fijos
language plpgsql security definer set search_path = '' as $$
declare
  a public.activos_fijos;
  v_acum numeric;
  v_libro numeric;
  v_perdida uuid := p_cuenta_perdida;
  v_lineas jsonb;
  v_asiento public.asientos;
begin
  select * into a from public.activos_fijos where id = p_id for update;
  if a.id is null then raise exception 'Activo no encontrado'; end if;
  if not app.puede(a.empresa_id, 'activos.gestionar') then raise exception 'Sin permiso para gestionar activos fijos'; end if;
  if a.estado = 'baja' then raise exception 'El activo ya está dado de baja'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 5 then raise exception 'Indique el motivo de la baja'; end if;
  if p_fecha < a.fecha_compra then raise exception 'La fecha de baja es anterior a la compra'; end if;
  if v_perdida is null then
    select id into v_perdida from public.cuentas where empresa_id = a.empresa_id and codigo = '5.3.03' and imputable and activa;
  end if;
  perform app.validar_cuenta(a.empresa_id, v_perdida, 'gasto', 'pérdida por baja');

  v_acum := a.depreciacion_inicial + app.depreciacion_acumulada(a.id);
  v_libro := a.valor - v_acum;
  v_lineas := jsonb_build_array(jsonb_build_object('cuenta_id', a.cuenta_activo, 'haber', a.valor));
  if v_acum > 0 then v_lineas := v_lineas || jsonb_build_object('cuenta_id', a.cuenta_depreciacion, 'debe', v_acum); end if;
  if v_libro > 0 then v_lineas := v_lineas || jsonb_build_object('cuenta_id', v_perdida, 'debe', v_libro, 'glosa', 'Valor libro dado de baja'); end if;

  v_asiento := public.crear_asiento_sistema(a.empresa_id, p_fecha, left('Baja activo fijo: ' || a.nombre, 500),
    v_lineas, 'baja_activo', a.id, 'traspaso'::public.tipo_comprobante, app.puede(a.empresa_id, 'asientos.contabilizar'));
  update public.activos_fijos set estado = 'baja', fecha_baja = p_fecha, motivo_baja = trim(p_motivo), baja_asiento_id = v_asiento.id
   where id = a.id returning * into a;
  return a;
end $$;
revoke execute on function public.dar_baja_activo(uuid, date, text, uuid) from public, anon;
grant execute on function public.dar_baja_activo(uuid, date, text, uuid) to authenticated;

-- ───────────────────────── 2. Cartera de empresas ─────────────────────────
create or replace function public.mi_cartera()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_hoy date := (now() at time zone 'America/Santiago')::date;
  v_ant text := to_char(v_hoy - interval '1 month', 'YYYYMM');
  r jsonb := '[]';
  e record;
  x jsonb;
begin
  if auth.uid() is null then raise exception 'No autenticado'; end if;
  for e in select em.id, em.rut, em.razon_social from public.miembros m join public.empresas em on em.id = m.empresa_id
            where m.user_id = auth.uid() order by em.razon_social loop
    x := jsonb_build_object('id', e.id, 'rut', e.rut, 'razonSocial', e.razon_social, 'rol', app.rol_efectivo(e.id));
    if app.puede_ver(e.id, 'asientos.ver') then
      x := x || jsonb_build_object('borradores', (select count(*) from public.asientos where empresa_id = e.id and estado = 'borrador'));
    end if;
    if app.puede_ver(e.id, 'documentos.ver') then
      x := x || jsonb_build_object('documentosMes', (select count(*) from public.documentos where empresa_id = e.id and estado = 'vigente'
                                                     and date_trunc('month', fecha) = date_trunc('month', v_hoy)));
    end if;
    if app.puede_ver(e.id, 'f29.ver') then
      x := x || jsonb_build_object('f29', (select jsonb_build_object('periodo', v_ant, 'estado', coalesce(f.estado, 'sin guardar'), 'total', f.total_pagar)
                                             from (select 1) d left join public.f29_declaraciones f on f.empresa_id = e.id and f.periodo = v_ant));
    end if;
    if app.puede_ver(e.id, 'tesoreria.ver') then
      x := x || jsonb_build_object(
        'cobrarVencido', (select coalesce(sum(saldo), 0) from public.documentos_saldo where empresa_id = e.id and operacion = 'venta'
                            and estado = 'vigente' and tipo <> 61 and saldo > 0 and vence < v_hoy),
        'pagarVencido', (select coalesce(sum(saldo), 0) from public.documentos_saldo where empresa_id = e.id and operacion in ('compra', 'honorario')
                            and estado = 'vigente' and tipo <> 61 and saldo > 0 and vence < v_hoy));
    end if;
    if app.puede_ver(e.id, 'conciliacion.ver') then
      x := x || jsonb_build_object('cartolaPendiente', (select count(*) from public.cartola_movimientos where empresa_id = e.id and estado = 'pendiente'));
    end if;
    if app.puede_ver(e.id, 'remuneraciones.ver') then
      x := x || jsonb_build_object('remuneracionesMesAnterior', exists (select 1 from public.remuneraciones where empresa_id = e.id and periodo = v_ant and estado = 'vigente'));
    end if;
    x := x || jsonb_build_object('mesesAbiertos', (select count(*) from public.periodos where empresa_id = e.id and estado = 'abierto'));
    r := r || x;
  end loop;
  return jsonb_build_object('mesAnterior', v_ant, 'empresas', r);
end $$;
revoke execute on function public.mi_cartera() from public, anon;
grant execute on function public.mi_cartera() to authenticated;

-- ───────────────────────── 3. Reglas de conciliación ─────────────────────────
create table public.reglas_conciliacion (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  cuenta_banco uuid references public.cuentas(id) on delete cascade,
  texto text not null check (length(trim(texto)) between 3 and 100),
  sentido text not null default 'ambos' check (sentido in ('cargo', 'abono', 'ambos')),
  cuenta_id uuid not null references public.cuentas(id),
  glosa text check (length(glosa) <= 200),
  usos int not null default 0,
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now()
);
create index on public.reglas_conciliacion (empresa_id);
alter table public.reglas_conciliacion enable row level security;
create policy reglas_conciliacion_sel on public.reglas_conciliacion for select to authenticated using (app.puede_ver(empresa_id, 'conciliacion.ver'));
create trigger auditar after insert or update or delete on public.reglas_conciliacion for each row execute function app.auditar();

create or replace function public.guardar_regla_conciliacion(p_empresa uuid, p_texto text, p_cuenta uuid,
  p_sentido text default 'ambos', p_cuenta_banco uuid default null, p_glosa text default null, p_id uuid default null)
returns public.reglas_conciliacion
language plpgsql security definer set search_path = '' as $$
declare r public.reglas_conciliacion;
begin
  if not app.puede(p_empresa, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  if not exists (select 1 from public.cuentas where id = p_cuenta and empresa_id = p_empresa and imputable and activa) then
    raise exception 'Elija la cuenta de contrapartida';
  end if;
  if p_cuenta_banco is not null and not exists (select 1 from public.cuentas where id = p_cuenta_banco and empresa_id = p_empresa and es_efectivo) then
    raise exception 'Cuenta de banco inválida';
  end if;
  if p_id is null then
    insert into public.reglas_conciliacion (empresa_id, cuenta_banco, texto, sentido, cuenta_id, glosa)
    values (p_empresa, p_cuenta_banco, upper(trim(p_texto)), p_sentido, p_cuenta, nullif(trim(p_glosa), ''))
    returning * into r;
  else
    update public.reglas_conciliacion set cuenta_banco = p_cuenta_banco, texto = upper(trim(p_texto)), sentido = p_sentido,
           cuenta_id = p_cuenta, glosa = nullif(trim(p_glosa), '')
     where id = p_id and empresa_id = p_empresa returning * into r;
    if r.id is null then raise exception 'Regla no encontrada'; end if;
  end if;
  return r;
end $$;
revoke execute on function public.guardar_regla_conciliacion(uuid, text, uuid, text, uuid, text, uuid) from public, anon;
grant execute on function public.guardar_regla_conciliacion(uuid, text, uuid, text, uuid, text, uuid) to authenticated;

create or replace function public.eliminar_regla_conciliacion(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_empresa uuid;
begin
  select empresa_id into v_empresa from public.reglas_conciliacion where id = p_id;
  if v_empresa is null then raise exception 'Regla no encontrada'; end if;
  if not app.puede(v_empresa, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  delete from public.reglas_conciliacion where id = p_id;
end $$;
revoke execute on function public.eliminar_regla_conciliacion(uuid) from public, anon;
grant execute on function public.eliminar_regla_conciliacion(uuid) to authenticated;

-- Aplica las reglas a los movimientos pendientes de una cuenta de banco (la regla de texto más largo gana)
create or replace function public.aplicar_reglas_conciliacion(p_empresa uuid, p_cuenta uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m record;
  rg public.reglas_conciliacion;
  n int := 0;
begin
  if not app.puede(p_empresa, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  for m in select * from public.cartola_movimientos where empresa_id = p_empresa and cuenta_id = p_cuenta and estado = 'pendiente' order by fecha, orden loop
    select * into rg from public.reglas_conciliacion r
     where r.empresa_id = p_empresa and (r.cuenta_banco is null or r.cuenta_banco = p_cuenta)
       and (r.sentido = 'ambos' or (r.sentido = 'abono' and m.monto > 0) or (r.sentido = 'cargo' and m.monto < 0))
       and upper(m.descripcion) like '%' || replace(replace(r.texto, '%', '\%'), '_', '\_') || '%'
     order by length(r.texto) desc limit 1;
    if rg.id is not null and rg.cuenta_id <> p_cuenta then
      perform public.contabilizar_movimiento(m.id, rg.cuenta_id, coalesce(rg.glosa, 'Banco: ' || m.descripcion));
      update public.reglas_conciliacion set usos = usos + 1 where id = rg.id;
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('contabilizados', n);
end $$;
revoke execute on function public.aplicar_reglas_conciliacion(uuid, uuid) from public, anon;
grant execute on function public.aplicar_reglas_conciliacion(uuid, uuid) to authenticated;

-- ───────────────────────── 4. F29: comparar montos ─────────────────────────
create or replace function app.f29_montos(p jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(coalesce(p, '{}'::jsonb)) e(k, v)
   where jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric <> 0
$$;

do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.propuesta_f29(uuid, text)'::regprocedure);
  if position('v_guardada.lineas is distinct from v_lineas' in v_def) = 0 then
    raise exception 'No se encontró la comparación del F29 a reemplazar';
  end if;
  execute replace(v_def, 'v_guardada.lineas is distinct from v_lineas', 'app.f29_montos(v_guardada.lineas) is distinct from app.f29_montos(v_lineas)');
end $$;
