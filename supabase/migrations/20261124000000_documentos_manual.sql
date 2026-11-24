-- Cuadra Contable (versión simple): registro manual de compras y ventas, libros y propuesta F29.
-- Reutiliza el núcleo existente: empresas, miembros/roles, plan de cuentas, asientos, períodos, auditoría con hash.

create table public.documentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  operacion text not null check (operacion in ('venta', 'compra')),
  tipo integer not null check (tipo in (33, 34, 39, 41, 46, 56, 61)),
  folio bigint not null check (folio > 0),
  fecha date not null,
  rut text not null check (app.rut_valido(rut)),
  razon_social text not null check (length(trim(razon_social)) between 1 and 200),
  neto numeric(16,0) not null default 0 check (neto >= 0),
  exento numeric(16,0) not null default 0 check (exento >= 0),
  iva numeric(16,0) not null default 0 check (iva >= 0),
  iva_no_recuperable numeric(16,0) not null default 0 check (iva_no_recuperable >= 0 and iva_no_recuperable <= iva),
  total numeric(16,0) not null check (total = neto + exento + iva),
  cuenta_id uuid references public.cuentas(id),
  glosa text check (length(glosa) <= 300),
  estado text not null default 'vigente' check (estado in ('vigente', 'anulado')),
  motivo_anulacion text,
  asiento_id uuid references public.asientos(id),
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now(),
  unique (empresa_id, operacion, tipo, rut, folio)
);
create index documentos_empresa_fecha on public.documentos (empresa_id, operacion, fecha);

alter table public.documentos enable row level security;
-- Solo lectura directa para miembros; toda escritura pasa por las funciones de abajo.
create policy documentos_sel on public.documentos for select to authenticated using (app.es_miembro(empresa_id));
revoke insert, update, delete on public.documentos from anon, authenticated;
create trigger auditar after insert or update or delete on public.documentos for each row execute function app.auditar();

create or replace function public.registrar_documento(
  p_empresa uuid, p_operacion text, p_tipo integer, p_folio bigint, p_fecha date,
  p_rut text, p_razon text, p_neto numeric, p_exento numeric default 0,
  p_iva_no_recuperable numeric default 0, p_cuenta uuid default null, p_glosa text default null)
returns public.documentos
language plpgsql security definer set search_path to ''
as $$
declare
  c public.configuracion_cuentas;
  d public.documentos;
  v_iva numeric;
  v_aux uuid;
  v_cuenta uuid;
  v_lineas jsonb := '[]';
  v_debe text;
  v_haber text;
  v_asiento public.asientos;
  v_exentos int[] := '{34,41}';
begin
  if not app.puede_escribir(p_empresa, '{admin,contador}') then
    raise exception 'Sin permiso (requiere rol admin o contador y verificación en dos pasos)';
  end if;
  if p_operacion not in ('venta', 'compra') then raise exception 'Operación inválida'; end if;
  if not app.rut_valido(p_rut) then raise exception 'RUT inválido: %', p_rut; end if;
  if coalesce(p_neto, 0) < 0 or coalesce(p_exento, 0) < 0 then raise exception 'Los montos no pueden ser negativos'; end if;
  if p_tipo = any (v_exentos) and coalesce(p_neto, 0) > 0 then raise exception 'Un documento exento no lleva monto neto afecto'; end if;
  if coalesce(p_neto, 0) + coalesce(p_exento, 0) = 0 then raise exception 'El documento no tiene montos'; end if;
  if p_fecha > (now() at time zone 'America/Santiago')::date then raise exception 'La fecha no puede ser futura'; end if;
  if p_operacion = 'venta' and coalesce(p_iva_no_recuperable, 0) > 0 then raise exception 'El IVA no recuperable solo aplica a compras'; end if;

  v_iva := round(coalesce(p_neto, 0) * 0.19);
  if coalesce(p_iva_no_recuperable, 0) > v_iva then raise exception 'El IVA no recuperable supera el IVA del documento'; end if;

  select * into c from public.configuracion_cuentas where empresa_id = p_empresa;
  if c.empresa_id is null then raise exception 'Falta configurar las cuentas automáticas de la empresa'; end if;

  if p_cuenta is not null and not exists (
      select 1 from public.cuentas where id = p_cuenta and empresa_id = p_empresa and imputable and activa
        and tipo = case when p_operacion = 'venta' then 'ingreso'::public.tipo_cuenta else tipo end) then
    raise exception 'Cuenta de contrapartida inválida';
  end if;

  insert into public.documentos (empresa_id, operacion, tipo, folio, fecha, rut, razon_social, neto, exento, iva,
                                 iva_no_recuperable, total, cuenta_id, glosa)
  values (p_empresa, p_operacion, p_tipo, p_folio, p_fecha, app.rut_normalizado(p_rut), trim(p_razon),
          coalesce(p_neto, 0), coalesce(p_exento, 0), v_iva, coalesce(p_iva_no_recuperable, 0),
          coalesce(p_neto, 0) + coalesce(p_exento, 0) + v_iva, p_cuenta, nullif(trim(p_glosa), ''))
  returning * into d;

  v_aux := app.auxiliar_para(p_empresa, d.rut, d.razon_social, p_operacion = 'venta');
  -- Nota de crédito invierte el asiento
  v_debe := case when d.tipo = 61 then 'haber' else 'debe' end;
  v_haber := case when d.tipo = 61 then 'debe' else 'haber' end;

  if p_operacion = 'venta' then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_clientes, 'auxiliar_id', v_aux, v_debe, d.total,
                                               'documento_tipo', d.tipo, 'documento_folio', d.folio);
    if d.neto > 0 then
      v_lineas := v_lineas || jsonb_build_object('cuenta_id', coalesce(p_cuenta, c.cuenta_ventas), v_haber, d.neto);
    end if;
    if d.exento > 0 then
      v_lineas := v_lineas || jsonb_build_object('cuenta_id', coalesce(p_cuenta, c.cuenta_ventas_exentas), v_haber, d.exento);
    end if;
    if d.iva > 0 then
      v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_iva_debito, v_haber, d.iva);
    end if;
  else
    v_cuenta := coalesce(p_cuenta, c.cuenta_gasto_defecto);
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', v_cuenta, v_debe, d.neto + d.exento);
    if d.iva - d.iva_no_recuperable > 0 then
      v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_iva_credito, v_debe, d.iva - d.iva_no_recuperable);
    end if;
    if d.iva_no_recuperable > 0 then
      v_lineas := v_lineas || jsonb_build_object('cuenta_id', coalesce(c.cuenta_iva_no_recuperable, v_cuenta), v_debe, d.iva_no_recuperable);
    end if;
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_proveedores, 'auxiliar_id', v_aux, v_haber, d.total,
                                               'documento_tipo', d.tipo, 'documento_folio', d.folio);
  end if;

  v_asiento := public.crear_asiento_sistema(p_empresa, d.fecha,
    left(initcap(p_operacion) || ' doc. ' || d.tipo || ' N° ' || d.folio || ' ' || d.razon_social, 500),
    v_lineas, 'documento_' || p_operacion, d.id,
    case when d.tipo = 61 then 'traspaso'::public.tipo_comprobante
         when p_operacion = 'venta' then 'ingreso'::public.tipo_comprobante
         else 'egreso'::public.tipo_comprobante end);

  update public.documentos set asiento_id = v_asiento.id where id = d.id returning * into d;
  return d;
end $$;

create or replace function public.anular_documento(p_id uuid, p_motivo text)
returns public.documentos
language plpgsql security definer set search_path to ''
as $$
declare
  d public.documentos;
  v_hoy date := (now() at time zone 'America/Santiago')::date;
begin
  select * into d from public.documentos where id = p_id for update;
  if d.id is null then raise exception 'Documento no encontrado'; end if;
  if not app.puede_escribir(d.empresa_id, '{admin,contador}') then raise exception 'Sin permiso'; end if;
  if d.estado = 'anulado' then raise exception 'El documento ya está anulado'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 5 then raise exception 'Indique el motivo de la anulación'; end if;
  if d.asiento_id is not null then
    if app.periodo_abierto(d.empresa_id, d.fecha) then
      perform public.anular_asiento(d.asiento_id, p_motivo);
    else
      perform public.reversar_asiento(d.asiento_id, v_hoy, p_motivo);
    end if;
  end if;
  update public.documentos set estado = 'anulado', motivo_anulacion = trim(p_motivo) where id = p_id returning * into d;
  return d;
end $$;

create or replace function public.propuesta_f29(p_empresa uuid, p_periodo text)
returns jsonb
language plpgsql stable set search_path to ''
as $$
declare
  v_debito numeric; v_credito numeric; v_base_ppm numeric; v_rem_ant numeric; v_tasa numeric;
  v_iva_det numeric; v_ppm numeric; v_ventas jsonb; v_compras jsonb;
begin
  perform app.exigir_miembro(p_empresa);
  if p_periodo !~ '^\d{6}$' then raise exception 'Período inválido (use AAAAMM)'; end if;

  select coalesce(sum(case when tipo = 61 then -iva else iva end), 0),
         coalesce(sum(case when tipo = 61 then -(neto + exento) else neto + exento end), 0)
    into v_debito, v_base_ppm
    from public.documentos where empresa_id = p_empresa and operacion = 'venta' and estado = 'vigente'
     and to_char(fecha, 'YYYYMM') = p_periodo;
  select coalesce(sum(case when tipo = 61 then -(iva - iva_no_recuperable) else iva - iva_no_recuperable end), 0)
    into v_credito
    from public.documentos where empresa_id = p_empresa and operacion = 'compra' and estado = 'vigente'
     and to_char(fecha, 'YYYYMM') = p_periodo;

  select coalesce(jsonb_agg(x order by x ->> 'tipo'), '[]') into v_ventas from (
    select jsonb_build_object('tipo', tipo, 'cantidad', count(*), 'neto', sum(neto), 'exento', sum(exento), 'iva', sum(iva), 'total', sum(total)) x
      from public.documentos where empresa_id = p_empresa and operacion = 'venta' and estado = 'vigente' and to_char(fecha, 'YYYYMM') = p_periodo
     group by tipo) s;
  select coalesce(jsonb_agg(x order by x ->> 'tipo'), '[]') into v_compras from (
    select jsonb_build_object('tipo', tipo, 'cantidad', count(*), 'neto', sum(neto), 'exento', sum(exento), 'iva', sum(iva),
                              'ivaNoRecuperable', sum(iva_no_recuperable), 'total', sum(total)) x
      from public.documentos where empresa_id = p_empresa and operacion = 'compra' and estado = 'vigente' and to_char(fecha, 'YYYYMM') = p_periodo
     group by tipo) s;

  v_rem_ant := coalesce((select remanente_siguiente from public.f29_declaraciones
                          where empresa_id = p_empresa and periodo < p_periodo order by periodo desc limit 1),
                        (select remanente_inicial from public.empresas where id = p_empresa), 0);
  v_tasa := coalesce((select tasa_ppm from public.empresas where id = p_empresa), 0);
  v_iva_det := v_debito - v_credito - v_rem_ant;
  v_ppm := round(greatest(v_base_ppm, 0) * v_tasa / 100);

  return jsonb_build_object(
    'periodo', p_periodo, 'ventas', v_ventas, 'compras', v_compras,
    'lineas', jsonb_build_object(
      '538', v_debito, '537', v_credito, '504', v_rem_ant,
      '89', greatest(v_iva_det, 0), '77', greatest(-v_iva_det, 0),
      '563', greatest(v_base_ppm, 0), '115', v_tasa, '62', v_ppm,
      '91', greatest(v_iva_det, 0) + v_ppm),
    'nota', 'Propuesta referencial: no incluye reajuste UTM del remanente, retenciones ni otros impuestos. Verifique en sii.cl antes de declarar.');
end $$;

create or replace function public.guardar_f29(p_empresa uuid, p_periodo text)
returns public.f29_declaraciones
language plpgsql security definer set search_path to ''
as $$
declare p jsonb; r public.f29_declaraciones;
begin
  if not app.puede_escribir(p_empresa, '{admin,contador}') then raise exception 'Sin permiso'; end if;
  p := public.propuesta_f29(p_empresa, p_periodo);
  delete from public.f29_declaraciones where empresa_id = p_empresa and periodo = p_periodo and estado = 'borrador';
  insert into public.f29_declaraciones (empresa_id, periodo, lineas, iva_determinado, remanente_siguiente, total_pagar, estado, creado_por)
  values (p_empresa, p_periodo, p -> 'lineas', (p -> 'lineas' ->> '89')::numeric, (p -> 'lineas' ->> '77')::numeric,
          (p -> 'lineas' ->> '91')::numeric, 'borrador', auth.uid())
  returning * into r;
  return r;
end $$;

-- Métricas comerciales desde documentos manuales
create or replace function public.metricas_documentos(p_empresa uuid, p_anio integer)
returns jsonb
language sql stable set search_path to ''
as $$
  select jsonb_build_object(
    'topClientes', (select coalesce(jsonb_agg(t order by (t ->> 'monto')::numeric desc), '[]') from (
        select jsonb_build_object('rut', rut, 'nombre', max(razon_social), 'monto', sum(case when tipo = 61 then -total else total end)) t
          from public.documentos where empresa_id = p_empresa and operacion = 'venta' and estado = 'vigente' and extract(year from fecha) = p_anio
         group by rut order by sum(case when tipo = 61 then -total else total end) desc limit 5) a),
    'topProveedores', (select coalesce(jsonb_agg(t order by (t ->> 'monto')::numeric desc), '[]') from (
        select jsonb_build_object('rut', rut, 'nombre', max(razon_social), 'monto', sum(case when tipo = 61 then -total else total end)) t
          from public.documentos where empresa_id = p_empresa and operacion = 'compra' and estado = 'vigente' and extract(year from fecha) = p_anio
         group by rut order by sum(case when tipo = 61 then -total else total end) desc limit 5) b),
    'ivaMensual', (select coalesce(jsonb_agg(jsonb_build_object('mes', m, 'debito', coalesce(deb, 0), 'credito', coalesce(cre, 0)) order by m), '[]')
        from generate_series(1, 12) m left join (
          select extract(month from fecha)::int mes,
                 sum(case when operacion = 'venta' then (case when tipo = 61 then -iva else iva end) end) deb,
                 sum(case when operacion = 'compra' then (case when tipo = 61 then -(iva - iva_no_recuperable) else iva - iva_no_recuperable end) end) cre
            from public.documentos where empresa_id = p_empresa and estado = 'vigente' and extract(year from fecha) = p_anio
           group by 1) x on x.mes = m)
  ) where app.es_miembro(p_empresa)
$$;

revoke execute on function public.registrar_documento(uuid, text, integer, bigint, date, text, text, numeric, numeric, numeric, uuid, text) from public, anon;
revoke execute on function public.anular_documento(uuid, text) from public, anon;
revoke execute on function public.propuesta_f29(uuid, text) from public, anon;
revoke execute on function public.guardar_f29(uuid, text) from public, anon;
revoke execute on function public.metricas_documentos(uuid, integer) from public, anon;
grant execute on function public.registrar_documento(uuid, text, integer, bigint, date, text, text, numeric, numeric, numeric, uuid, text) to authenticated;
grant execute on function public.anular_documento(uuid, text) to authenticated;
grant execute on function public.propuesta_f29(uuid, text) to authenticated;
grant execute on function public.guardar_f29(uuid, text) to authenticated;
grant execute on function public.metricas_documentos(uuid, integer) to authenticated;
grant select on public.documentos to authenticated;
