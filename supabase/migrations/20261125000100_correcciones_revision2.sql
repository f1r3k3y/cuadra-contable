-- Correcciones de la segunda revisión (R1, R2, R4, P2, P8, P9).

-- ---------------------------------------------------------------------------
-- Montos con formato chileno en los mensajes ($1.234.567)

create or replace function app.pesos(p numeric) returns text
language sql immutable set search_path to '' as $$
  select case when p < 0 then '-' else '' end || '$' || translate(to_char(abs(round(coalesce(p, 0))), 'FM999,999,999,999,990'), ',', '.')
$$;

create or replace function app._reemplazar(p_fn regprocedure, p_de text, p_a text) returns void
language plpgsql set search_path to '' as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_de in d) = 0 then raise exception 'No se encontró el texto a reemplazar en %', p_fn; end if;
  execute replace(d, p_de, p_a);
end $$;

select app._reemplazar('public.registrar_documento(uuid,text,integer,bigint,date,text,text,numeric,numeric,numeric,uuid,text,uuid,date)',
  $x$raise exception 'La nota de crédito (%) supera el saldo pendiente del documento (%)',
        coalesce(p_neto, 0) + coalesce(p_exento, 0) + v_iva, ref.saldo;$x$,
  $x$raise exception 'La nota de crédito (%) supera el saldo pendiente del documento (%)',
        app.pesos(coalesce(p_neto, 0) + coalesce(p_exento, 0) + v_iva), app.pesos(ref.saldo);$x$);
select app._reemplazar('public.registrar_pago(uuid,date,numeric,uuid,text,text)',
  $x$raise exception 'El monto supera el saldo pendiente (%)', d.saldo;$x$,
  $x$raise exception 'El monto supera el saldo pendiente (%)', app.pesos(d.saldo);$x$);
drop function app._reemplazar(regprocedure, text, text);

-- ---------------------------------------------------------------------------
-- R2: no desactivar cuentas automáticas ni cuentas con saldo

create or replace function app.saldo_cuenta(p_cuenta uuid) returns numeric
language sql stable security definer set search_path to '' as $$
  select coalesce(sum(l.debe - l.haber), 0)
    from public.asiento_lineas l join public.asientos a on a.id = l.asiento_id
   where l.cuenta_id = p_cuenta and a.estado = 'contabilizado'
$$;
revoke execute on function app.saldo_cuenta(uuid) from public, anon;
grant execute on function app.saldo_cuenta(uuid) to authenticated;

create or replace function app.es_cuenta_automatica(p_cuenta uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.configuracion_cuentas c
                  where p_cuenta in (c.cuenta_clientes, c.cuenta_proveedores, c.cuenta_ventas, c.cuenta_ventas_exentas,
                                     c.cuenta_iva_debito, c.cuenta_iva_credito, c.cuenta_iva_no_recuperable, c.cuenta_gasto_defecto,
                                     c.cuenta_ppm, c.cuenta_impuestos_por_pagar, c.cuenta_resultado_ejercicio))
$$;
revoke execute on function app.es_cuenta_automatica(uuid) from public, anon;
grant execute on function app.es_cuenta_automatica(uuid) to authenticated;

create or replace function app.proteger_cuenta() returns trigger
language plpgsql set search_path to '' as $$
declare v_saldo numeric;
begin
  if old.activa and not new.activa then
    if app.es_cuenta_automatica(old.id) then
      raise exception 'La cuenta % % es una cuenta automática; cámbiela en "Cuentas automáticas" antes de desactivarla', old.codigo, old.nombre;
    end if;
    v_saldo := app.saldo_cuenta(old.id);
    if v_saldo <> 0 then
      raise exception 'La cuenta % % tiene saldo (%); traspáselo a otra cuenta antes de desactivarla', old.codigo, old.nombre, app.pesos(v_saldo);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists proteger_cuenta on public.cuentas;
create trigger proteger_cuenta before update on public.cuentas for each row execute function app.proteger_cuenta();

-- ---------------------------------------------------------------------------
-- R1 + R4: F29 solo con documentos aprobados, remanente desde lo presentado

-- Documentos que entran al F29: vigentes y con asiento aprobado por contabilidad
create or replace function app.f29_documentos(p_empresa uuid, p_periodo text) returns setof public.documentos
language sql stable set search_path to '' as $$
  select * from public.documentos
   where empresa_id = p_empresa and estado = 'vigente' and to_char(fecha, 'YYYYMM') = p_periodo
     and app.estado_asiento(asiento_id) = 'contabilizado'
$$;
grant execute on function app.f29_documentos(uuid, text) to authenticated;

create or replace function public.propuesta_f29(p_empresa uuid, p_periodo text)
returns jsonb
language plpgsql stable set search_path to ''
as $$
declare
  v_debito numeric; v_credito numeric; v_base_ppm numeric; v_rem_ant numeric; v_tasa numeric;
  v_iva_det numeric; v_ppm numeric; v_ventas jsonb; v_compras jsonb; v_pend int; v_fuente text;
  v_lineas jsonb; v_guardada public.f29_declaraciones;
begin
  if not app.puede_ver(p_empresa, 'f29.ver') then raise exception 'Sin permiso para ver el F29'; end if;
  if p_periodo !~ '^\d{6}$' then raise exception 'Período inválido (use AAAAMM)'; end if;

  select count(*) into v_pend from public.documentos
   where empresa_id = p_empresa and estado = 'vigente' and to_char(fecha, 'YYYYMM') = p_periodo
     and app.estado_asiento(asiento_id) is distinct from 'contabilizado';

  select coalesce(sum(case when tipo = 61 then -iva else iva end), 0),
         coalesce(sum(case when tipo = 61 then -(neto + exento) else neto + exento end), 0)
    into v_debito, v_base_ppm from app.f29_documentos(p_empresa, p_periodo) where operacion = 'venta';
  select coalesce(sum(case when tipo = 61 then -(iva - iva_no_recuperable) else iva - iva_no_recuperable end), 0)
    into v_credito from app.f29_documentos(p_empresa, p_periodo) where operacion = 'compra';

  select coalesce(jsonb_agg(x order by x ->> 'tipo'), '[]') into v_ventas from (
    select jsonb_build_object('tipo', tipo, 'cantidad', count(*), 'neto', sum(neto), 'exento', sum(exento), 'iva', sum(iva), 'total', sum(total)) x
      from app.f29_documentos(p_empresa, p_periodo) where operacion = 'venta' group by tipo) s;
  select coalesce(jsonb_agg(x order by x ->> 'tipo'), '[]') into v_compras from (
    select jsonb_build_object('tipo', tipo, 'cantidad', count(*), 'neto', sum(neto), 'exento', sum(exento), 'iva', sum(iva),
                              'ivaNoRecuperable', sum(iva_no_recuperable), 'total', sum(total)) x
      from app.f29_documentos(p_empresa, p_periodo) where operacion = 'compra' group by tipo) s;

  -- Remanente: del último F29 presentado; si no hay, del último guardado; si no, el inicial de la empresa
  select remanente_siguiente, 'presentado ' || periodo into v_rem_ant, v_fuente from public.f29_declaraciones
   where empresa_id = p_empresa and periodo < p_periodo and estado = 'presentado' order by periodo desc limit 1;
  if v_fuente is null then
    select remanente_siguiente, 'borrador ' || periodo into v_rem_ant, v_fuente from public.f29_declaraciones
     where empresa_id = p_empresa and periodo < p_periodo order by periodo desc limit 1;
  end if;
  if v_fuente is null then
    select coalesce(remanente_inicial, 0), 'inicial' into v_rem_ant, v_fuente from public.empresas where id = p_empresa;
  end if;
  v_rem_ant := coalesce(v_rem_ant, 0);
  v_tasa := coalesce((select tasa_ppm from public.empresas where id = p_empresa), 0);
  v_iva_det := v_debito - v_credito - v_rem_ant;
  v_ppm := round(greatest(v_base_ppm, 0) * v_tasa / 100);

  v_lineas := jsonb_build_object(
      '538', v_debito, '537', v_credito, '504', v_rem_ant,
      '89', greatest(v_iva_det, 0), '77', greatest(-v_iva_det, 0),
      '563', greatest(v_base_ppm, 0), '115', v_tasa, '62', v_ppm,
      '91', greatest(v_iva_det, 0) + v_ppm);

  select * into v_guardada from public.f29_declaraciones where empresa_id = p_empresa and periodo = p_periodo;

  return jsonb_build_object(
    'periodo', p_periodo, 'ventas', v_ventas, 'compras', v_compras, 'lineas', v_lineas,
    'pendientes', v_pend,
    'remanenteDesde', v_fuente,
    'guardada', case when v_guardada.id is null then null else jsonb_build_object(
        'estado', v_guardada.estado, 'folio', v_guardada.folio_sii, 'totalPagar', v_guardada.total_pagar,
        'cambio', v_guardada.lineas is distinct from v_lineas) end,
    'nota', 'Propuesta referencial: solo considera documentos aprobados por contabilidad; no incluye reajuste UTM del remanente, retenciones ni otros impuestos. Verifique en sii.cl antes de declarar.');
end $$;

create or replace function public.guardar_f29(p_empresa uuid, p_periodo text)
returns public.f29_declaraciones
language plpgsql security definer set search_path to ''
as $$
declare p jsonb; r public.f29_declaraciones;
begin
  if not app.puede(p_empresa, 'f29.guardar') then raise exception 'Sin permiso para guardar el F29 (o falta la verificación en dos pasos)'; end if;
  if exists (select 1 from public.f29_declaraciones where empresa_id = p_empresa and periodo = p_periodo and estado = 'presentado') then
    raise exception 'El F29 de ese período ya está marcado como presentado';
  end if;
  p := public.propuesta_f29(p_empresa, p_periodo);
  delete from public.f29_declaraciones where empresa_id = p_empresa and periodo = p_periodo and estado = 'borrador';
  insert into public.f29_declaraciones (empresa_id, periodo, lineas, iva_determinado, remanente_siguiente, total_pagar, estado, creado_por)
  values (p_empresa, p_periodo, p -> 'lineas', (p -> 'lineas' ->> '89')::numeric, (p -> 'lineas' ->> '77')::numeric,
          (p -> 'lineas' ->> '91')::numeric, 'borrador', auth.uid())
  returning * into r;
  return r;
end $$;

create or replace function public.marcar_f29_presentado(p_empresa uuid, p_periodo text, p_folio text default null)
returns public.f29_declaraciones
language plpgsql security definer set search_path to ''
as $$
declare p jsonb; r public.f29_declaraciones;
begin
  if not app.puede(p_empresa, 'f29.guardar') then raise exception 'Sin permiso para marcar el F29 (o falta la verificación en dos pasos)'; end if;
  select * into r from public.f29_declaraciones where empresa_id = p_empresa and periodo = p_periodo for update;
  if r.id is null then raise exception 'Primero guarde la propuesta del período'; end if;
  if r.estado = 'presentado' then raise exception 'El F29 de ese período ya está marcado como presentado'; end if;
  p := public.propuesta_f29(p_empresa, p_periodo);
  if (p -> 'lineas') is distinct from r.lineas then
    raise exception 'La propuesta cambió desde que se guardó (hay documentos nuevos o aprobados); guárdela de nuevo y revísela antes de marcarla';
  end if;
  update public.f29_declaraciones set estado = 'presentado', folio_sii = nullif(trim(p_folio), '')
   where id = r.id returning * into r;
  return r;
end $$;
revoke execute on function public.marcar_f29_presentado(uuid, text, text) from public, anon;
grant execute on function public.marcar_f29_presentado(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- P2 + P9: panel con IVA del mes desde el libro y días de cobro sobre el período con actividad

create or replace function public.metricas_dashboard(p_empresa uuid, p_anio integer)
 returns jsonb
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_desde date := make_date(p_anio, 1, 1);
  v_hasta date := least(make_date(p_anio, 12, 31), (now() at time zone 'America/Santiago')::date);
  v_dias int;
  r jsonb := '{}';
  s record;
  v_ventas numeric;
  v_costo numeric;
  v_gop numeric;
  v_resultado numeric;
begin
  perform app.exigir_miembro(p_empresa);
  if v_hasta < v_desde then v_hasta := make_date(p_anio, 12, 31); end if;
  -- Días con actividad: desde el primer movimiento del año (evita inflar días de cobro en empresas nuevas)
  v_dias := greatest(v_hasta - coalesce((select min(fecha) from public.movimientos
                                          where empresa_id = p_empresa and fecha between v_desde and v_hasta), v_desde) + 1, 1);

  select
    coalesce(sum(debe - haber) filter (where clasificacion = 'activo_corriente'), 0) as ac,
    coalesce(sum(debe - haber) filter (where cuenta_tipo = 'activo'), 0) as at,
    coalesce(sum(haber - debe) filter (where clasificacion = 'pasivo_corriente'), 0) as pc,
    coalesce(sum(haber - debe) filter (where cuenta_tipo = 'pasivo'), 0) as pt,
    coalesce(sum(haber - debe) filter (where cuenta_tipo in ('patrimonio', 'ingreso', 'gasto')), 0) as pat,
    coalesce(sum(debe - haber) filter (where es_efectivo), 0) as caja,
    coalesce(sum(debe - haber) filter (where cuenta_codigo like '1.1.04%'), 0) as existencias,
    coalesce(sum(debe - haber) filter (where cuenta_codigo like '1.1.02%'), 0) as cxc,
    coalesce(sum(haber - debe) filter (where cuenta_codigo like '2.1.01%'), 0) as cxp
  into s
  from public.movimientos where empresa_id = p_empresa and fecha <= v_hasta;

  select coalesce(sum(haber - debe) filter (where clasificacion = 'ingreso_operacional'), 0),
         coalesce(sum(debe - haber) filter (where clasificacion = 'costo_venta'), 0),
         coalesce(sum(debe - haber) filter (where clasificacion = 'gasto_operacional'), 0),
         coalesce(sum(haber - debe) filter (where cuenta_tipo in ('ingreso', 'gasto')), 0)
    into v_ventas, v_costo, v_gop, v_resultado
    from public.movimientos where empresa_id = p_empresa and fecha between v_desde and v_hasta;

  r := jsonb_build_object(
    'periodo', jsonb_build_object('desde', v_desde, 'hasta', v_hasta),
    'kpis', jsonb_build_object(
      'ventas', v_ventas,
      'resultado', v_resultado,
      'margenBruto', case when v_ventas <> 0 then round((v_ventas - v_costo) / v_ventas * 100, 1) end,
      'margenOperacional', case when v_ventas <> 0 then round((v_ventas - v_costo - v_gop) / v_ventas * 100, 1) end,
      'liquidezCorriente', case when s.pc <> 0 then round(s.ac / s.pc, 2) end,
      'pruebaAcida', case when s.pc <> 0 then round((s.ac - s.existencias) / s.pc, 2) end,
      'endeudamiento', case when s.pat <> 0 then round(s.pt / s.pat, 2) end,
      'capitalTrabajo', s.ac - s.pc,
      'caja', s.caja,
      'cuentasPorCobrar', s.cxc,
      'cuentasPorPagar', s.cxp,
      'diasActividad', v_dias,
      'diasCobro', case when v_ventas > 0 then round(s.cxc / (v_ventas * 1.19) * v_dias) end,
      'diasPago', case when (v_costo + v_gop) > 0 then round(s.cxp / ((v_costo + v_gop) * 1.19) * v_dias) end
    ),
    'mensual', (
      select coalesce(jsonb_agg(jsonb_build_object('mes', m,
        'ingresos', coalesce(ing, 0), 'costos', coalesce(cos, 0), 'gastos', coalesce(gas, 0),
        'resultado', coalesce(res, 0), 'entradasCaja', coalesce(ent, 0), 'salidasCaja', coalesce(sal, 0)) order by m), '[]')
      from generate_series(1, 12) m
      left join (
        select extract(month from fecha)::int as mes,
               sum(haber - debe) filter (where clasificacion in ('ingreso_operacional', 'ingreso_no_operacional')) ing,
               sum(debe - haber) filter (where clasificacion = 'costo_venta') cos,
               sum(debe - haber) filter (where clasificacion in ('gasto_operacional', 'gasto_no_operacional', 'impuesto_renta')) gas,
               sum(haber - debe) filter (where cuenta_tipo in ('ingreso', 'gasto')) res,
               sum(debe) filter (where es_efectivo) ent,
               sum(haber) filter (where es_efectivo) sal
          from public.movimientos
         where empresa_id = p_empresa and fecha between v_desde and make_date(p_anio, 12, 31)
         group by 1
      ) x on x.mes = m
    ),
    'gastosPorCuenta', (
      select coalesce(jsonb_agg(jsonb_build_object('cuenta', nombre, 'monto', monto) order by monto desc), '[]')
      from (select cuenta_nombre nombre, sum(debe - haber) monto from public.movimientos
             where empresa_id = p_empresa and fecha between v_desde and v_hasta and cuenta_tipo = 'gasto'
             group by 1 having sum(debe - haber) > 0 order by 2 desc limit 8) g
    ),
    -- Igual que el F29: documentos vigentes y aprobados del mes en curso
    'ivaMesActual', (
      select jsonb_build_object(
        'debito', coalesce(sum(case when tipo = 61 then -iva else iva end) filter (where operacion = 'venta'), 0),
        'credito', coalesce(sum(case when tipo = 61 then -(iva - iva_no_recuperable) else iva - iva_no_recuperable end) filter (where operacion = 'compra'), 0))
        from public.documentos
       where empresa_id = p_empresa and estado = 'vigente' and date_trunc('month', fecha) = date_trunc('month', v_hasta)
         and app.estado_asiento(asiento_id) = 'contabilizado'
    ),
    'contabilidad', jsonb_build_object(
      'borradores', (select count(*) from public.asientos where empresa_id = p_empresa and estado = 'borrador'),
      'comprobantesAnio', (select count(*) from public.asientos where empresa_id = p_empresa and estado = 'contabilizado' and anio = p_anio),
      'periodosAbiertos', (select count(*) from public.periodos where empresa_id = p_empresa and estado = 'abierto')
    )
  );
  return r;
end $function$;
