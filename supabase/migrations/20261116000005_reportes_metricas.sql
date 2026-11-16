-- Libros, estados financieros, IVA y métricas. Todas SECURITY INVOKER: respetan RLS.

create or replace function app.exigir_miembro(p_empresa uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not app.es_miembro(p_empresa) and not app.es_servicio() then raise exception 'Sin acceso a la empresa'; end if;
end $$;

-- Movimientos contabilizados (base de todos los reportes)
create or replace view public.movimientos with (security_invoker = true) as
select l.empresa_id, a.id as asiento_id, a.numero, a.fecha, a.tipo, a.glosa as glosa_asiento, a.origen,
       l.linea, l.cuenta_id, c.codigo as cuenta_codigo, c.nombre as cuenta_nombre, c.tipo as cuenta_tipo,
       c.clasificacion, c.es_efectivo, l.debe, l.haber, l.glosa, l.auxiliar_id, x.rut as auxiliar_rut,
       x.razon_social as auxiliar_nombre, l.centro_costo_id, l.documento_tipo, l.documento_folio
  from public.asiento_lineas l
  join public.asientos a on a.id = l.asiento_id and a.estado = 'contabilizado'
  join public.cuentas c on c.id = l.cuenta_id
  left join public.auxiliares x on x.id = l.auxiliar_id;

create or replace function public.libro_diario(p_empresa uuid, p_desde date, p_hasta date)
returns setof public.movimientos
language sql stable security invoker set search_path = '' as $$
  select m.* from public.movimientos m
   where m.empresa_id = p_empresa and m.fecha between p_desde and p_hasta
   order by m.fecha, m.numero, m.linea
$$;

create or replace function public.libro_mayor(p_empresa uuid, p_cuenta uuid, p_desde date, p_hasta date)
returns table (fecha date, numero int, glosa text, auxiliar text, debe numeric, haber numeric, saldo numeric)
language sql stable security invoker set search_path = '' as $$
  with ini as (
    select coalesce(sum(debe - haber), 0) as s from public.movimientos
     where empresa_id = p_empresa and cuenta_id = p_cuenta and fecha < p_desde
  ), mov as (
    select m.fecha, m.numero, coalesce(m.glosa, m.glosa_asiento) as glosa, m.auxiliar_nombre as auxiliar, m.debe, m.haber, m.linea
      from public.movimientos m
     where m.empresa_id = p_empresa and m.cuenta_id = p_cuenta and m.fecha between p_desde and p_hasta
  )
  select p_desde - 1, null::int, 'Saldo inicial', null, null::numeric, null::numeric, (select s from ini)
  union all
  select fecha, numero, glosa, auxiliar, debe, haber,
         (select s from ini) + sum(debe - haber) over (order by fecha, numero, linea rows unbounded preceding)
    from mov
$$;

-- Balance tributario de 8 columnas
create or replace function public.balance_8_columnas(p_empresa uuid, p_desde date, p_hasta date)
returns table (codigo text, nombre text, tipo public.tipo_cuenta, debitos numeric, creditos numeric,
               deudor numeric, acreedor numeric, activo numeric, pasivo numeric, perdida numeric, ganancia numeric)
language sql stable security invoker set search_path = '' as $$
  with s as (
    select cuenta_codigo as codigo, cuenta_nombre as nombre, cuenta_tipo as tipo, sum(debe) as d, sum(haber) as h
      from public.movimientos
     where empresa_id = p_empresa and fecha between p_desde and p_hasta
     group by 1, 2, 3
  )
  select codigo, nombre, tipo, d, h,
         greatest(d - h, 0), greatest(h - d, 0),
         case when tipo in ('activo', 'pasivo', 'patrimonio') then greatest(d - h, 0) else 0 end,
         case when tipo in ('activo', 'pasivo', 'patrimonio') then greatest(h - d, 0) else 0 end,
         case when tipo in ('ingreso', 'gasto') then greatest(d - h, 0) else 0 end,
         case when tipo in ('ingreso', 'gasto') then greatest(h - d, 0) else 0 end
    from s order by codigo
$$;

create or replace function public.estado_resultados(p_empresa uuid, p_desde date, p_hasta date)
returns table (orden int, concepto text, monto numeric, es_total boolean)
language sql stable security invoker set search_path = '' as $$
  with s as (
    select clasificacion, sum(haber - debe) as v from public.movimientos
     where empresa_id = p_empresa and fecha between p_desde and p_hasta and cuenta_tipo in ('ingreso', 'gasto')
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
$$;

create or replace function public.balance_general(p_empresa uuid, p_hasta date)
returns table (seccion text, codigo text, nombre text, saldo numeric)
language sql stable security invoker set search_path = '' as $$
  with s as (
    select clasificacion, cuenta_tipo, cuenta_codigo, cuenta_nombre, sum(debe - haber) as saldo
      from public.movimientos
     where empresa_id = p_empresa and fecha <= p_hasta
     group by 1, 2, 3, 4
  )
  select case when cuenta_tipo = 'activo' then 'Activo' when cuenta_tipo = 'pasivo' then 'Pasivo' else 'Patrimonio' end,
         cuenta_codigo, cuenta_nombre,
         case when cuenta_tipo = 'activo' then saldo else -saldo end
    from s where cuenta_tipo in ('activo', 'pasivo', 'patrimonio') and saldo <> 0
  union all
  select 'Patrimonio', '3.9', 'Resultado del período (no cerrado)', -coalesce(sum(saldo), 0)
    from s where cuenta_tipo in ('ingreso', 'gasto')
  order by 2
$$;

-- ---------------------------------------------------------------------------
-- Libros de compras y ventas e insumos del F29

create or replace function public.libro_ventas(p_empresa uuid, p_periodo text)
returns setof public.dte_emitidos
language sql stable security invoker set search_path = '' as $$
  select * from public.dte_emitidos
   where empresa_id = p_empresa and to_char(fecha_emision, 'YYYYMM') = p_periodo
     and tipo <> 52 and estado not in ('borrador', 'rechazado', 'anulado')
   order by fecha_emision, tipo, folio
$$;

create or replace function public.libro_compras(p_empresa uuid, p_periodo text)
returns setof public.dte_recibidos
language sql stable security invoker set search_path = '' as $$
  select * from public.dte_recibidos
   where empresa_id = p_empresa and to_char(fecha_emision, 'YYYYMM') = p_periodo
     and tipo <> 52 and estado <> 'reclamado'
   order by fecha_emision, tipo, folio
$$;

/** Resumen por tipo de documento para el F29. Compras: RCV si fue importado, si no, documentos recibidos. */
create or replace function public.resumen_iva(p_empresa uuid, p_periodo text)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_ventas jsonb;
  v_compras jsonb;
  v_fuente text;
begin
  perform app.exigir_miembro(p_empresa);
  select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'cantidad', n, 'neto', neto, 'exento', exento, 'iva', iva)), '[]')
    into v_ventas
    from (select tipo, count(*) n, sum(neto) neto, sum(exento) exento, sum(iva) iva
            from public.libro_ventas(p_empresa, p_periodo) group by tipo) v;
  if exists (select 1 from public.rcv_registros where empresa_id = p_empresa and periodo = p_periodo and operacion = 'COMPRA') then
    v_fuente := 'rcv';
    select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'cantidad', n, 'neto', neto, 'exento', exento, 'iva', iva, 'ivaNoRecuperable', ivanr)), '[]')
      into v_compras
      from (select tipo, count(*) n, sum(neto) neto, sum(exento) exento, sum(iva) iva, sum(iva_no_recuperable) ivanr
              from public.rcv_registros where empresa_id = p_empresa and periodo = p_periodo and operacion = 'COMPRA' and estado = 'REGISTRO'
             group by tipo) c;
  else
    v_fuente := 'libro';
    select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'cantidad', n, 'neto', neto, 'exento', exento, 'iva', iva, 'ivaNoRecuperable', ivanr)), '[]')
      into v_compras
      from (select tipo, count(*) n, sum(neto) neto, sum(exento) exento, sum(iva) iva, sum(iva_no_recuperable) ivanr
              from public.libro_compras(p_empresa, p_periodo) group by tipo) c;
  end if;
  return jsonb_build_object('ventas', v_ventas, 'compras', v_compras, 'fuenteCompras', v_fuente,
    'remanenteAnterior', coalesce((select remanente_siguiente from public.f29_declaraciones
                                    where empresa_id = p_empresa and periodo < p_periodo order by periodo desc limit 1),
                                  (select remanente_inicial from public.empresas where id = p_empresa), 0),
    'tasaPpm', (select tasa_ppm from public.empresas where id = p_empresa));
end $$;

-- ---------------------------------------------------------------------------
-- Métricas del dashboard

create or replace function public.metricas_dashboard(p_empresa uuid, p_anio int)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
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
  v_dias := greatest(v_hasta - v_desde + 1, 1);

  -- Saldos a la fecha por clasificación
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
    'topClientes', (
      select coalesce(jsonb_agg(jsonb_build_object('rut', receptor_rut, 'nombre', nombre, 'monto', monto) order by monto desc), '[]')
      from (select receptor_rut, max(receptor_razon) nombre,
                   sum(case when tipo = 61 then -total else total end) monto
              from public.dte_emitidos
             where empresa_id = p_empresa and fecha_emision between v_desde and v_hasta and tipo <> 52
               and estado not in ('rechazado', 'anulado', 'borrador')
             group by 1 order by 3 desc limit 5) c
    ),
    'topProveedores', (
      select coalesce(jsonb_agg(jsonb_build_object('rut', emisor_rut, 'nombre', nombre, 'monto', monto) order by monto desc), '[]')
      from (select emisor_rut, max(emisor_razon) nombre, sum(case when tipo = 61 then -total else total end) monto
              from public.dte_recibidos
             where empresa_id = p_empresa and fecha_emision between v_desde and v_hasta and estado <> 'reclamado'
             group by 1 order by 3 desc limit 5) p
    ),
    'dte', jsonb_build_object(
      'emitidosPorEstado', (select coalesce(jsonb_object_agg(estado, n), '{}') from
         (select estado, count(*) n from public.dte_emitidos where empresa_id = p_empresa and fecha_emision between v_desde and v_hasta group by 1) e),
      'recibidosPendientes', (select count(*) from public.dte_recibidos where empresa_id = p_empresa and estado = 'pendiente'),
      'plazoReclamoPorVencer', (select count(*) from public.dte_recibidos where empresa_id = p_empresa and estado = 'pendiente'
                                  and fecha_recepcion > now() - interval '8 days' and fecha_recepcion <= now() - interval '5 days'),
      'sinContabilizar', (select count(*) from public.dte_emitidos where empresa_id = p_empresa and asiento_id is null
                            and tipo <> 52 and estado in ('aceptado', 'aceptado_reparos', 'enviado'))
                       + (select count(*) from public.dte_recibidos where empresa_id = p_empresa and asiento_id is null and estado <> 'reclamado')
    ),
    'ivaMesActual', (
      select jsonb_build_object(
        'debito', coalesce((select sum(case when tipo = 61 then -iva else iva end) from public.dte_emitidos
                     where empresa_id = p_empresa and date_trunc('month', fecha_emision) = date_trunc('month', v_hasta)
                       and tipo <> 52 and estado not in ('rechazado', 'anulado', 'borrador')), 0),
        'credito', coalesce((select sum(case when tipo = 61 then -(iva - iva_no_recuperable) else iva - iva_no_recuperable end) from public.dte_recibidos
                     where empresa_id = p_empresa and date_trunc('month', fecha_emision) = date_trunc('month', v_hasta)
                       and estado <> 'reclamado'), 0))
    ),
    'contabilidad', jsonb_build_object(
      'borradores', (select count(*) from public.asientos where empresa_id = p_empresa and estado = 'borrador'),
      'comprobantesAnio', (select count(*) from public.asientos where empresa_id = p_empresa and estado = 'contabilizado' and anio = p_anio),
      'periodosAbiertos', (select count(*) from public.periodos where empresa_id = p_empresa and estado = 'abierto')
    )
  );
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Defensa en profundidad: el rol anónimo no ejecuta ninguna función de negocio.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.reservar_folio(uuid, int) from authenticated;
revoke execute on function public.crear_asiento_sistema(uuid, date, text, jsonb, text, uuid, public.tipo_comprobante) from authenticated;
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public, anon;
-- Funciones propias de la plataforma que no deben quedar expuestas por el grant anterior
do $$ begin
  if exists (select 1 from pg_proc where proname = 'rls_auto_enable' and pronamespace = 'public'::regnamespace) then
    execute 'revoke execute on function public.rls_auto_enable() from authenticated';
  end if;
end $$;
revoke all on public.movimientos from anon;
