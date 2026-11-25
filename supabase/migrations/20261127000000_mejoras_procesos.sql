-- Mejoras de procesos (revisión por roles):
--  1. Cierre del ejercicio: asiento de cierre automático (resultados → patrimonio) y reportes que lo respetan.
--  2. Balance de 8 columnas con saldos iniciales de ejercicios anteriores (antes partía de cero cada año).
--  3. Pago o cobro masivo de documentos en Tesorería.
--  4. Resumen anual de retenciones por persona (base para DJ 1879 y DJ 1887).

-- ───────────────────────── 1. Cierre del ejercicio ─────────────────────────

create or replace function public.cerrar_ejercicio(p_empresa uuid, p_anio int)
returns public.asientos
language plpgsql security definer set search_path = '' as $$
declare
  v_hoy date := (now() at time zone 'America/Santiago')::date;
  v_fecha date := make_date(p_anio, 12, 31);
  v_res uuid; v_acum uuid;
  v_lineas jsonb := '[]';
  v_neto numeric := 0;
  v_previo numeric;
  r record;
  v_asiento public.asientos;
begin
  if not app.puede(p_empresa, 'periodos.cerrar') then
    raise exception 'Sin permiso para cerrar el ejercicio (o falta la verificación en dos pasos)';
  end if;
  if p_anio > extract(year from v_hoy) or (p_anio = extract(year from v_hoy) and extract(month from v_hoy) < 12) then
    raise exception 'El ejercicio % todavía no termina; el cierre se hace desde diciembre', p_anio;
  end if;
  if exists (select 1 from public.asientos where empresa_id = p_empresa and origen = 'cierre'
              and estado = 'contabilizado' and fecha = v_fecha) then
    raise exception 'El ejercicio % ya está cerrado (anule el asiento de cierre para rehacerlo)', p_anio;
  end if;
  if exists (select 1 from public.asientos where empresa_id = p_empresa and estado = 'borrador'
              and fecha between make_date(p_anio, 1, 1) and v_fecha) then
    raise exception 'Hay comprobantes en borrador en %; contabilícelos o elimínelos antes de cerrar', p_anio;
  end if;

  select id into v_res from public.cuentas where empresa_id = p_empresa and codigo = '3.1.03' and imputable and activa;
  select id into v_acum from public.cuentas where empresa_id = p_empresa and codigo = '3.1.02' and imputable and activa;
  if v_res is null or v_acum is null then
    raise exception 'Faltan las cuentas 3.1.02 Resultados acumulados y 3.1.03 Resultado del ejercicio en el plan de cuentas';
  end if;

  -- Cada cuenta de resultado queda en cero; la diferencia va a Resultado del ejercicio
  for r in
    select cuenta_id, sum(debe - haber) as saldo
      from public.movimientos
     where empresa_id = p_empresa and fecha between make_date(p_anio, 1, 1) and v_fecha
       and cuenta_tipo in ('ingreso', 'gasto') and tipo <> 'cierre'
     group by cuenta_id having sum(debe - haber) <> 0
  loop
    v_lineas := v_lineas || case when r.saldo > 0
      then jsonb_build_object('cuenta_id', r.cuenta_id, 'haber', r.saldo)
      else jsonb_build_object('cuenta_id', r.cuenta_id, 'debe', -r.saldo) end;
    v_neto := v_neto + r.saldo;   -- > 0 pérdida, < 0 utilidad
  end loop;

  -- El resultado del ejercicio anterior pasa a Resultados acumulados
  select coalesce(sum(haber - debe), 0) into v_previo
    from public.movimientos where empresa_id = p_empresa and cuenta_id = v_res and fecha < make_date(p_anio, 1, 1);

  if jsonb_array_length(v_lineas) = 0 and v_previo = 0 then
    raise exception 'No hay resultados que cerrar en %', p_anio;
  end if;

  if v_neto <> 0 then
    v_lineas := v_lineas || case when v_neto < 0
      then jsonb_build_object('cuenta_id', v_res, 'haber', -v_neto, 'glosa', 'Utilidad del ejercicio ' || p_anio)
      else jsonb_build_object('cuenta_id', v_res, 'debe', v_neto, 'glosa', 'Pérdida del ejercicio ' || p_anio) end;
  end if;
  if v_previo <> 0 then
    v_lineas := v_lineas
      || case when v_previo > 0 then jsonb_build_object('cuenta_id', v_res, 'debe', v_previo) else jsonb_build_object('cuenta_id', v_res, 'haber', -v_previo) end
      || case when v_previo > 0 then jsonb_build_object('cuenta_id', v_acum, 'haber', v_previo) else jsonb_build_object('cuenta_id', v_acum, 'debe', -v_previo) end;
  end if;

  v_asiento := public.crear_asiento_sistema(p_empresa, v_fecha, 'Cierre del ejercicio ' || p_anio,
    v_lineas, 'cierre', null, 'cierre'::public.tipo_comprobante, true);
  return v_asiento;
end $$;
revoke execute on function public.cerrar_ejercicio(uuid, int) from public, anon;
grant execute on function public.cerrar_ejercicio(uuid, int) to authenticated;

-- Estado de un ejercicio para la pantalla de cierre
create or replace function public.estado_ejercicio(p_empresa uuid, p_anio int)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_cierre public.asientos;
begin
  if not (app.puede_ver(p_empresa, 'reportes.ver') or app.puede_ver(p_empresa, 'periodos.cerrar')) then
    raise exception 'Sin permiso';
  end if;
  select * into v_cierre from public.asientos where empresa_id = p_empresa and origen = 'cierre'
     and estado = 'contabilizado' and fecha = make_date(p_anio, 12, 31) limit 1;
  return jsonb_build_object(
    'anio', p_anio,
    'cerrado', v_cierre.id is not null,
    'asiento', case when v_cierre.id is not null then jsonb_build_object('id', v_cierre.id, 'numero', v_cierre.numero) end,
    'borradores', (select count(*) from public.asientos where empresa_id = p_empresa and estado = 'borrador'
                     and fecha between make_date(p_anio, 1, 1) and make_date(p_anio, 12, 31)),
    'mesesAbiertos', (select count(*) from public.periodos where empresa_id = p_empresa and anio = p_anio and estado = 'abierto'),
    'resultado', (select coalesce(sum(haber - debe), 0) from public.movimientos where empresa_id = p_empresa
                     and fecha between make_date(p_anio, 1, 1) and make_date(p_anio, 12, 31)
                     and cuenta_tipo in ('ingreso', 'gasto') and tipo <> 'cierre'));
end $$;
revoke execute on function public.estado_ejercicio(uuid, int) from public, anon;
grant execute on function public.estado_ejercicio(uuid, int) to authenticated;

-- El estado de resultados muestra el ejercicio antes del cierre
create or replace function public.estado_resultados(p_empresa uuid, p_desde date, p_hasta date)
 returns table(orden integer, concepto text, monto numeric, es_total boolean)
 language sql stable set search_path to ''
as $function$
  with s as (
    select clasificacion, sum(haber - debe) as v from public.movimientos
     where empresa_id = p_empresa and fecha between p_desde and p_hasta and cuenta_tipo in ('ingreso', 'gasto')
       and tipo <> 'cierre'
     group by 1
  ), g as (
    select coalesce(sum(v) filter (where clasificacion = 'ingreso_operacional'), 0) as io,
           coalesce(sum(v) filter (where clasificacion = 'costo_venta'), 0) as cv,
           coalesce(sum(v) filter (where clasificacion = 'gasto_operacional'), 0) as go,
           coalesce(sum(v) filter (where clasificacion = 'ingreso_no_operacional'), 0) as ino,
           coalesce(sum(v) filter (where clasificacion = 'gasto_no_operacional'), 0) as gno,
           coalesce(sum(v) filter (where clasificacion = 'impuesto_renta'), 0) as ir
      from s
  )
  select * from (values
    (1, 'Ingresos de explotación', (select io from g), false),
    (2, 'Costos de explotación', (select cv from g), false),
    (3, 'Margen bruto', (select io + cv from g), true),
    (4, 'Gastos de administración y ventas', (select go from g), false),
    (5, 'Resultado operacional', (select io + cv + go from g), true),
    (6, 'Otros ingresos', (select ino from g), false),
    (7, 'Otros gastos', (select gno from g), false),
    (8, 'Resultado antes de impuesto', (select io + cv + go + ino + gno from g), true),
    (9, 'Impuesto a la renta', (select ir from g), false),
    (10, 'Resultado del ejercicio', (select io + cv + go + ino + gno + ir from g), true)
  ) as t (orden, concepto, monto, es_total)
$function$;

-- ─────────── 2. Balance de 8 columnas con saldos de ejercicios anteriores ───────────
-- Las cuentas de balance arrastran su saldo previo a p_desde (como una apertura); los resultados
-- de ejercicios anteriores que no se cerraron aparecen en una línea de patrimonio para que cuadre.
-- El asiento de cierre del período no se incluye (balance tributario previo al cierre).
create or replace function public.balance_8_columnas(p_empresa uuid, p_desde date, p_hasta date)
 returns table(codigo text, nombre text, tipo tipo_cuenta, debitos numeric, creditos numeric, deudor numeric, acreedor numeric, activo numeric, pasivo numeric, perdida numeric, ganancia numeric)
 language sql stable set search_path to ''
as $function$
  with base as (
    select cuenta_codigo as codigo, cuenta_nombre as nombre, cuenta_tipo as tipo,
           sum(debe) filter (where fecha >= p_desde) as d_per,
           sum(haber) filter (where fecha >= p_desde) as h_per,
           sum(debe - haber) filter (where fecha < p_desde) as previo
      from public.movimientos
     where empresa_id = p_empresa and fecha <= p_hasta
       and not (tipo = 'cierre' and fecha >= p_desde)
     group by 1, 2, 3
  ), s as (
    select codigo, nombre, tipo,
           coalesce(d_per, 0) + case when tipo in ('activo', 'pasivo', 'patrimonio') then greatest(coalesce(previo, 0), 0) else 0 end as d,
           coalesce(h_per, 0) + case when tipo in ('activo', 'pasivo', 'patrimonio') then greatest(-coalesce(previo, 0), 0) else 0 end as h
      from base
     where coalesce(d_per, 0) <> 0 or coalesce(h_per, 0) <> 0 or (tipo in ('activo', 'pasivo', 'patrimonio') and coalesce(previo, 0) <> 0)
    union all
    select '3.9', 'Resultados de ejercicios anteriores sin cerrar', 'patrimonio'::public.tipo_cuenta,
           greatest(sum(previo), 0), greatest(-sum(previo), 0)
      from base where tipo in ('ingreso', 'gasto')
    having coalesce(sum(previo), 0) <> 0
  )
  select codigo, nombre, tipo, d, h,
         greatest(d - h, 0), greatest(h - d, 0),
         case when tipo in ('activo', 'pasivo', 'patrimonio') then greatest(d - h, 0) else 0 end,
         case when tipo in ('activo', 'pasivo', 'patrimonio') then greatest(h - d, 0) else 0 end,
         case when tipo in ('ingreso', 'gasto') then greatest(d - h, 0) else 0 end,
         case when tipo in ('ingreso', 'gasto') then greatest(h - d, 0) else 0 end
    from s order by codigo
$function$;

-- Panel: los indicadores del año no se ven afectados por el asiento de cierre
create or replace function public.metricas_dashboard(p_empresa uuid, p_anio integer)
 returns jsonb
 language plpgsql stable set search_path to ''
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
    from public.movimientos where empresa_id = p_empresa and fecha between v_desde and v_hasta and tipo <> 'cierre';

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
         where empresa_id = p_empresa and fecha between v_desde and make_date(p_anio, 12, 31) and tipo <> 'cierre'
         group by 1
      ) x on x.mes = m
    ),
    'gastosPorCuenta', (
      select coalesce(jsonb_agg(jsonb_build_object('cuenta', nombre, 'monto', monto) order by monto desc), '[]')
      from (select cuenta_nombre nombre, sum(debe - haber) monto from public.movimientos
             where empresa_id = p_empresa and fecha between v_desde and v_hasta and cuenta_tipo = 'gasto' and tipo <> 'cierre'
             group by 1 having sum(debe - haber) > 0 order by 2 desc limit 8) g
    ),
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

-- ───────────────────────── 3. Pago o cobro masivo ─────────────────────────
-- Paga el saldo completo de cada documento con una misma fecha, cuenta y medio.
-- Todo o nada: si un documento falla, no se registra ninguno.
create or replace function public.registrar_pagos(p_documentos uuid[], p_fecha date, p_cuenta uuid,
                                                  p_medio text default 'transferencia', p_referencia text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d record;
  n int := 0;
  v_total numeric := 0;
  v_empresa uuid;
begin
  if coalesce(array_length(p_documentos, 1), 0) = 0 then raise exception 'Seleccione al menos un documento'; end if;
  if array_length(p_documentos, 1) > 200 then raise exception 'Máximo 200 documentos por vez'; end if;
  for d in
    select s.id, s.empresa_id, s.saldo, s.tipo, s.folio
      from public.documentos_saldo s where s.id = any (p_documentos) order by s.fecha, s.folio
  loop
    if v_empresa is null then v_empresa := d.empresa_id;
    elsif v_empresa <> d.empresa_id then raise exception 'Los documentos deben ser de la misma empresa';
    end if;
    if d.saldo <= 0 then raise exception 'El documento % N° % no tiene saldo pendiente', d.tipo, d.folio; end if;
    perform public.registrar_pago(d.id, p_fecha, d.saldo, p_cuenta, p_medio, p_referencia);
    n := n + 1;
    v_total := v_total + d.saldo;
  end loop;
  if n <> array_length(p_documentos, 1) then raise exception 'Algún documento no existe o no está vigente'; end if;
  return jsonb_build_object('documentos', n, 'total', v_total);
end $$;
revoke execute on function public.registrar_pagos(uuid[], date, uuid, text, text) from public, anon;
grant execute on function public.registrar_pagos(uuid[], date, uuid, text, text) to authenticated;

-- ─────────────── 4. Resumen anual de retenciones (DJ 1879 / DJ 1887) ───────────────
create or replace function public.resumen_anual_retenciones(p_empresa uuid, p_anio int)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_hon jsonb; v_rem jsonb;
begin
  if app.puede_ver(p_empresa, 'documentos.ver') then
    select coalesce(jsonb_agg(x order by x->>'nombre'), '[]') into v_hon from (
      select jsonb_build_object('rut', d.rut, 'nombre', max(d.razon_social),
               'bruto', sum(d.total), 'retencion', sum(d.retencion), 'boletas', count(*),
               'meses', (select jsonb_agg(coalesce(m.ret, 0) order by g) from generate_series(1, 12) g
                          left join (select extract(month from d2.fecha)::int mes, sum(d2.retencion) ret
                                       from public.documentos d2
                                      where d2.empresa_id = p_empresa and d2.operacion = 'honorario' and d2.estado = 'vigente'
                                        and d2.rut = d.rut and extract(year from d2.fecha) = p_anio group by 1) m on m.mes = g)) x
        from public.documentos d
       where d.empresa_id = p_empresa and d.operacion = 'honorario' and d.estado = 'vigente'
         and extract(year from d.fecha) = p_anio
       group by d.rut) t;
  end if;
  if app.puede_ver(p_empresa, 'remuneraciones.ver') then
    select coalesce(jsonb_agg(x order by x->>'nombre'), '[]') into v_rem from (
      select jsonb_build_object('rut', l.rut, 'nombre', max(l.nombre),
               'rentaTributable', sum(l.imponible - l.afp - l.salud - l.afc_trabajador),
               'impuesto', sum(l.impuesto_unico), 'meses', count(*),
               'detalle', jsonb_agg(jsonb_build_object('periodo', r.periodo,
                            'renta', l.imponible - l.afp - l.salud - l.afc_trabajador, 'impuesto', l.impuesto_unico) order by r.periodo)) x
        from public.remuneracion_lineas l join public.remuneraciones r on r.id = l.remuneracion_id
       where r.empresa_id = p_empresa and r.estado = 'vigente' and left(r.periodo, 4) = p_anio::text
       group by l.rut) t;
  end if;
  if v_hon is null and v_rem is null then raise exception 'Sin permiso'; end if;
  return jsonb_build_object('anio', p_anio, 'honorarios', v_hon, 'remuneraciones', v_rem);
end $$;
revoke execute on function public.resumen_anual_retenciones(uuid, int) from public, anon;
grant execute on function public.resumen_anual_retenciones(uuid, int) to authenticated;
