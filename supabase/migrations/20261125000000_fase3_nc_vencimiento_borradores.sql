-- Fase 3a: nota de crédito asociada a su factura, fecha de vencimiento y edición de borradores.

-- ---------------------------------------------------------------------------
-- 1. Columnas nuevas en documentos

alter table public.documentos
  add column referencia_id uuid references public.documentos(id),
  add column vencimiento date,
  add constraint documentos_vencimiento_check check (vencimiento is null or vencimiento >= fecha),
  add constraint documentos_referencia_check check (referencia_id is null or (tipo in (56, 61) and referencia_id <> id));
create index documentos_referencia on public.documentos (referencia_id) where referencia_id is not null;

comment on column public.documentos.referencia_id is 'Documento que modifica una nota de crédito (61) o débito (56)';
comment on column public.documentos.vencimiento is 'Fecha en que vence el cobro o pago; si es nula, vence el día de emisión';

-- Total de notas de crédito vigentes que rebajan un documento
create or replace function app.notas_credito_documento(p_id uuid) returns numeric
language sql stable security definer set search_path to '' as $$
  select coalesce(sum(total), 0) from public.documentos where referencia_id = p_id and tipo = 61 and estado = 'vigente'
$$;
revoke execute on function app.notas_credito_documento(uuid) from public, anon;
grant execute on function app.notas_credito_documento(uuid) to authenticated;

-- La vista se recrea porque cambian las columnas de documentos (d.*)
drop view public.documentos_saldo;
create view public.documentos_saldo with (security_invoker = true) as
select d.*,
       app.estado_asiento(d.asiento_id) as asiento_estado,
       app.pagado_documento(d.id) as pagado,
       case when d.tipo = 61 then 0 else app.notas_credito_documento(d.id) end as notas_credito,
       case when d.tipo = 61 then 0
            else d.total - app.pagado_documento(d.id) - app.notas_credito_documento(d.id) end as saldo,
       coalesce(d.vencimiento, d.fecha) as vence
  from public.documentos d;
revoke all on public.documentos_saldo from anon;
revoke insert, update, delete, truncate on public.documentos_saldo from authenticated;
grant select on public.documentos_saldo to authenticated;

-- ---------------------------------------------------------------------------
-- 2. registrar_documento con referencia y vencimiento

drop function public.registrar_documento(uuid, text, integer, bigint, date, text, text, numeric, numeric, numeric, uuid, text);
create function public.registrar_documento(
  p_empresa uuid, p_operacion text, p_tipo integer, p_folio bigint, p_fecha date,
  p_rut text, p_razon text, p_neto numeric, p_exento numeric default 0,
  p_iva_no_recuperable numeric default 0, p_cuenta uuid default null, p_glosa text default null,
  p_referencia uuid default null, p_vencimiento date default null)
returns public.documentos
language plpgsql security definer set search_path to ''
as $function$
declare
  c public.configuracion_cuentas;
  d public.documentos;
  ref public.documentos_saldo;
  v_iva numeric;
  v_aux uuid;
  v_cuenta uuid;
  v_lineas jsonb := '[]';
  v_debe text;
  v_haber text;
  v_asiento public.asientos;
  v_exentos int[] := '{34,41}';
begin
  if not app.puede(p_empresa, 'documentos.registrar') then
    raise exception 'Sin permiso para registrar documentos (o falta la verificación en dos pasos)';
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

  -- Vencimiento: solo documentos que se cobran o pagan
  if p_vencimiento is not null then
    if p_tipo = 61 then raise exception 'Una nota de crédito no tiene vencimiento'; end if;
    if p_vencimiento < p_fecha then raise exception 'El vencimiento no puede ser anterior a la fecha del documento'; end if;
  end if;

  -- Nota de crédito: debe indicar la factura que rebaja y no puede superar su saldo
  if p_tipo = 61 and p_referencia is null then
    raise exception 'Indique el documento que modifica la nota de crédito';
  end if;
  if p_referencia is not null then
    if p_tipo not in (56, 61) then raise exception 'Solo las notas de crédito y débito hacen referencia a otro documento'; end if;
    perform 1 from public.documentos where id = p_referencia for update;
    select * into ref from public.documentos_saldo where id = p_referencia;
    if ref.id is null or ref.empresa_id <> p_empresa then raise exception 'Documento de referencia no encontrado'; end if;
    if ref.operacion <> p_operacion then raise exception 'El documento de referencia es de otra operación (compra o venta)'; end if;
    if ref.rut <> app.rut_normalizado(p_rut) then raise exception 'El documento de referencia es de otro RUT'; end if;
    if ref.estado <> 'vigente' then raise exception 'El documento de referencia está anulado'; end if;
    if ref.tipo = 61 then raise exception 'Una nota no puede hacer referencia a otra nota de crédito'; end if;
    if ref.fecha > p_fecha then raise exception 'La nota no puede tener fecha anterior al documento que modifica'; end if;
    if p_tipo = 61 and coalesce(p_neto, 0) + coalesce(p_exento, 0) + v_iva > ref.saldo then
      raise exception 'La nota de crédito (%) supera el saldo pendiente del documento (%)',
        coalesce(p_neto, 0) + coalesce(p_exento, 0) + v_iva, ref.saldo;
    end if;
  end if;

  select * into c from public.configuracion_cuentas where empresa_id = p_empresa;
  if c.empresa_id is null then raise exception 'Falta configurar las cuentas automáticas de la empresa'; end if;

  if p_cuenta is not null and not exists (
      select 1 from public.cuentas where id = p_cuenta and empresa_id = p_empresa and imputable and activa
        and tipo = case when p_operacion = 'venta' then 'ingreso'::public.tipo_cuenta else tipo end) then
    raise exception 'Cuenta de contrapartida inválida';
  end if;

  insert into public.documentos (empresa_id, operacion, tipo, folio, fecha, rut, razon_social, neto, exento, iva,
                                 iva_no_recuperable, total, cuenta_id, glosa, referencia_id, vencimiento)
  values (p_empresa, p_operacion, p_tipo, p_folio, p_fecha, app.rut_normalizado(p_rut), trim(p_razon),
          coalesce(p_neto, 0), coalesce(p_exento, 0), v_iva, coalesce(p_iva_no_recuperable, 0),
          coalesce(p_neto, 0) + coalesce(p_exento, 0) + v_iva, p_cuenta, nullif(trim(p_glosa), ''),
          p_referencia, p_vencimiento)
  returning * into d;

  v_aux := app.auxiliar_para(p_empresa, d.rut, d.razon_social, p_operacion = 'venta');
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
         else 'egreso'::public.tipo_comprobante end,
    app.puede(p_empresa, 'asientos.contabilizar'));

  update public.documentos set asiento_id = v_asiento.id where id = d.id returning * into d;
  return d;
end $function$;
revoke execute on function public.registrar_documento(uuid, text, integer, bigint, date, text, text, numeric, numeric, numeric, uuid, text, uuid, date) from public, anon;
grant execute on function public.registrar_documento(uuid, text, integer, bigint, date, text, text, numeric, numeric, numeric, uuid, text, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. No anular un documento con notas de crédito vigentes

create or replace function public.anular_documento(p_id uuid, p_motivo text)
returns public.documentos
language plpgsql security definer set search_path to ''
as $function$
declare
  d public.documentos;
  v_estado public.estado_asiento;
  v_hoy date := (now() at time zone 'America/Santiago')::date;
begin
  select * into d from public.documentos where id = p_id for update;
  if d.id is null then raise exception 'Documento no encontrado'; end if;
  if not app.puede(d.empresa_id, 'documentos.anular') then raise exception 'Sin permiso para anular documentos'; end if;
  if d.estado = 'anulado' then raise exception 'El documento ya está anulado'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 5 then raise exception 'Indique el motivo de la anulación'; end if;
  if exists (select 1 from public.pagos where documento_id = p_id and estado = 'vigente') then
    raise exception 'El documento tiene cobros o pagos registrados; anúlelos primero en Tesorería';
  end if;
  if exists (select 1 from public.documentos where referencia_id = p_id and estado = 'vigente') then
    raise exception 'El documento tiene notas de crédito o débito vigentes; anúlelas primero';
  end if;
  if d.asiento_id is not null then
    select estado into v_estado from public.asientos where id = d.asiento_id;
    if v_estado = 'borrador' then
      update public.documentos set asiento_id = null where id = p_id;
      delete from public.asientos where id = d.asiento_id;
    elsif v_estado = 'contabilizado' then
      if app.periodo_abierto(d.empresa_id, d.fecha) then
        perform public.anular_asiento(d.asiento_id, p_motivo);
      else
        perform public.reversar_asiento(d.asiento_id, v_hoy, p_motivo);
      end if;
    end if;
  end if;
  update public.documentos set estado = 'anulado', motivo_anulacion = trim(p_motivo) where id = p_id returning * into d;
  return d;
end $function$;

-- ---------------------------------------------------------------------------
-- 4. Antigüedad desde el vencimiento

create or replace function public.resumen_tesoreria(p_empresa uuid)
returns jsonb language plpgsql stable security definer set search_path to ''
as $$
declare r jsonb;
begin
  if not app.puede_ver(p_empresa, 'tesoreria.ver') then raise exception 'Sin permiso para ver tesorería'; end if;
  with hoy as (select (now() at time zone 'America/Santiago')::date d),
  abiertos as (
    select s.operacion, s.saldo, (select d from hoy) - s.vence as dias
      from public.documentos_saldo s
     where s.empresa_id = p_empresa and s.estado = 'vigente' and s.saldo > 0 and s.asiento_estado = 'contabilizado'),
  tramos as (
    select operacion,
           sum(saldo) filter (where dias <= 0) pv,
           sum(saldo) filter (where dias between 1 and 30) t0, sum(saldo) filter (where dias between 31 and 60) t1,
           sum(saldo) filter (where dias between 61 and 90) t2, sum(saldo) filter (where dias > 90) t3,
           sum(saldo) filter (where dias > 0) venc,
           sum(saldo) total, count(*) n
      from abiertos group by operacion),
  vacio as (select '{"porVencer":0,"a30":0,"a60":0,"a90":0,"mas90":0,"vencido":0,"total":0,"documentos":0}'::jsonb j)
  select jsonb_build_object(
    'porCobrar', coalesce((select jsonb_build_object('porVencer', coalesce(pv,0), 'a30', coalesce(t0,0), 'a60', coalesce(t1,0), 'a90', coalesce(t2,0), 'mas90', coalesce(t3,0), 'vencido', coalesce(venc,0), 'total', total, 'documentos', n) from tramos where operacion = 'venta'), (select j from vacio)),
    'porPagar', coalesce((select jsonb_build_object('porVencer', coalesce(pv,0), 'a30', coalesce(t0,0), 'a60', coalesce(t1,0), 'a90', coalesce(t2,0), 'mas90', coalesce(t3,0), 'vencido', coalesce(venc,0), 'total', total, 'documentos', n) from tramos where operacion = 'compra'), (select j from vacio)),
    'cuentas', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'codigo', c.codigo, 'nombre', c.nombre,
                        'saldo', coalesce((select sum(m.debe - m.haber) from public.movimientos m where m.cuenta_id = c.id), 0)) order by c.codigo), '[]')
                  from public.cuentas c where c.empresa_id = p_empresa and c.es_efectivo and c.imputable and c.activa)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Editar un comprobante manual en borrador

create or replace function public.editar_asiento(
  p_id uuid, p_fecha date, p_glosa text, p_lineas jsonb, p_tipo public.tipo_comprobante default null
) returns public.asientos
language plpgsql security invoker set search_path = '' as $$
declare
  v public.asientos;
  l jsonb;
  i int := 0;
begin
  select * into v from public.asientos where id = p_id for update;
  if v.id is null then raise exception 'Comprobante no encontrado'; end if;
  if not app.puede(v.empresa_id, 'asientos.crear') then raise exception 'Sin permiso para editar comprobantes'; end if;
  if v.estado <> 'borrador' then raise exception 'Solo se pueden editar comprobantes en borrador'; end if;
  if v.origen <> 'manual' then
    raise exception 'Este borrador lo generó un documento o un pago: corrija o anule el origen en vez del comprobante';
  end if;
  if coalesce(length(trim(p_glosa)), 0) = 0 then raise exception 'Indique la glosa del comprobante'; end if;
  if jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) < 2 then
    raise exception 'El comprobante necesita al menos dos líneas';
  end if;
  -- El trigger valida que la fecha nueva esté en un período abierto
  update public.asientos set fecha = p_fecha, glosa = trim(p_glosa), tipo = coalesce(p_tipo, tipo)
   where id = p_id returning * into v;
  delete from public.asiento_lineas where asiento_id = p_id;
  for l in select * from jsonb_array_elements(p_lineas) loop
    i := i + 1;
    insert into public.asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber, glosa, auxiliar_id, centro_costo_id, documento_tipo, documento_folio)
    values (v.id, v.empresa_id, i, (l ->> 'cuenta_id')::uuid, coalesce((l ->> 'debe')::numeric, 0), coalesce((l ->> 'haber')::numeric, 0),
            nullif(l ->> 'glosa', ''), nullif(l ->> 'auxiliar_id', '')::uuid, nullif(l ->> 'centro_costo_id', '')::uuid,
            nullif(l ->> 'documento_tipo', '')::int, nullif(l ->> 'documento_folio', '')::bigint);
  end loop;
  return v;
end $$;
revoke execute on function public.editar_asiento(uuid, date, text, jsonb, public.tipo_comprobante) from public, anon;
grant execute on function public.editar_asiento(uuid, date, text, jsonb, public.tipo_comprobante) to authenticated;
