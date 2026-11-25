-- Conciliación bancaria, cuadratura del RCV del SII y preparación de la conexión con el SII.

-- ---------------------------------------------------------------------------
-- 1. Conciliación bancaria

create table public.cartola_movimientos (
  id uuid primary key default gen_random_uuid(),
  orden bigint generated always as identity,
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  cuenta_id uuid not null references public.cuentas(id),
  fecha date not null,
  descripcion text not null default '' check (length(descripcion) <= 300),
  referencia text check (length(referencia) <= 100),
  monto numeric(16,0) not null check (monto <> 0),          -- abono (+) o cargo (-)
  saldo numeric(16,0),
  huella text not null check (length(huella) between 8 and 200),
  linea_id uuid references public.asiento_lineas(id) on delete set null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'conciliado', 'ignorado')),
  nota text check (length(nota) <= 300),
  importado_por uuid default auth.uid(),
  importado_en timestamptz not null default now(),
  conciliado_por uuid,
  conciliado_en timestamptz,
  unique (empresa_id, cuenta_id, huella),
  check ((estado = 'conciliado') = (linea_id is not null))
);
create unique index cartola_linea_unica on public.cartola_movimientos (linea_id) where linea_id is not null;
create index cartola_cuenta_fecha on public.cartola_movimientos (empresa_id, cuenta_id, fecha);
alter table public.cartola_movimientos enable row level security;
create policy cartola_sel on public.cartola_movimientos for select to authenticated using (app.puede_ver(empresa_id, 'conciliacion.ver'));
revoke insert, update, delete on public.cartola_movimientos from anon, authenticated;
grant select on public.cartola_movimientos to authenticated;
create trigger auditar after insert or update or delete on public.cartola_movimientos for each row execute function app.auditar();

-- Líneas contables de una cuenta de banco con su estado de conciliación
create or replace function app.lineas_banco(p_empresa uuid, p_cuenta uuid)
returns table (linea_id uuid, fecha date, numero int, glosa text, monto numeric, asiento_id uuid, conciliada boolean)
language sql stable security definer set search_path to '' as $$
  select l.id, a.fecha, a.numero, coalesce(l.glosa, a.glosa), l.debe - l.haber, a.id,
         exists (select 1 from public.cartola_movimientos m where m.linea_id = l.id)
    from public.asiento_lineas l join public.asientos a on a.id = l.asiento_id
   where l.empresa_id = p_empresa and l.cuenta_id = p_cuenta and a.estado = 'contabilizado'
$$;
revoke execute on function app.lineas_banco(uuid, uuid) from public, anon;

create or replace function app.validar_banco(p_empresa uuid, p_cuenta uuid) returns void
language plpgsql stable security definer set search_path to '' as $$
begin
  if not exists (select 1 from public.cuentas where id = p_cuenta and empresa_id = p_empresa and es_efectivo and imputable) then
    raise exception 'Elija una cuenta de banco de la empresa';
  end if;
end $$;

create or replace function public.importar_cartola(p_empresa uuid, p_cuenta uuid, p_movimientos jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  m jsonb; n_nuevos int := 0; n_repetidos int := 0; v_id uuid;
begin
  if not app.puede(p_empresa, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar (o falta la verificación en dos pasos)'; end if;
  perform app.validar_banco(p_empresa, p_cuenta);
  if jsonb_typeof(p_movimientos) <> 'array' or jsonb_array_length(p_movimientos) = 0 then raise exception 'La cartola no tiene movimientos'; end if;
  if jsonb_array_length(p_movimientos) > 5000 then raise exception 'Cargue como máximo 5.000 movimientos por vez'; end if;
  for m in select * from jsonb_array_elements(p_movimientos) loop
    if coalesce((m ->> 'monto')::numeric, 0) = 0 then continue; end if;
    insert into public.cartola_movimientos (empresa_id, cuenta_id, fecha, descripcion, referencia, monto, saldo, huella)
    values (p_empresa, p_cuenta, (m ->> 'fecha')::date, left(coalesce(m ->> 'descripcion', ''), 300),
            nullif(left(m ->> 'referencia', 100), ''), round((m ->> 'monto')::numeric), round(nullif(m ->> 'saldo', '')::numeric),
            left(m ->> 'huella', 200))
    on conflict (empresa_id, cuenta_id, huella) do nothing
    returning id into v_id;
    if found then n_nuevos := n_nuevos + 1; else n_repetidos := n_repetidos + 1; end if;
  end loop;
  return jsonb_build_object('nuevos', n_nuevos, 'repetidos', n_repetidos,
                            'conciliados', public.conciliar_automatico(p_empresa, p_cuenta));
end $$;

-- Empareja por monto exacto y fecha cercana (±5 días); solo cuando hay un único candidato razonable
create or replace function public.conciliar_automatico(p_empresa uuid, p_cuenta uuid)
returns int language plpgsql security definer set search_path to '' as $$
declare m record; v_linea uuid; n int := 0;
begin
  if not app.puede(p_empresa, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  for m in select * from public.cartola_movimientos
            where empresa_id = p_empresa and cuenta_id = p_cuenta and estado = 'pendiente' order by fecha, orden loop
    select l.linea_id into v_linea
      from app.lineas_banco(p_empresa, p_cuenta) l
     where not l.conciliada and l.monto = m.monto and abs(l.fecha - m.fecha) <= 5
     order by abs(l.fecha - m.fecha), l.numero
     limit 1;
    if v_linea is not null then
      update public.cartola_movimientos set linea_id = v_linea, estado = 'conciliado', conciliado_por = auth.uid(), conciliado_en = now()
       where id = m.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.conciliar_movimiento(p_movimiento uuid, p_linea uuid)
returns public.cartola_movimientos language plpgsql security definer set search_path to '' as $$
declare m public.cartola_movimientos; l record;
begin
  select * into m from public.cartola_movimientos where id = p_movimiento for update;
  if m.id is null then raise exception 'Movimiento no encontrado'; end if;
  if not app.puede(m.empresa_id, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  if m.estado <> 'pendiente' then raise exception 'El movimiento ya está conciliado o ignorado'; end if;
  select * into l from app.lineas_banco(m.empresa_id, m.cuenta_id) where linea_id = p_linea;
  if l.linea_id is null then raise exception 'Esa línea contable no es de este banco o no está contabilizada'; end if;
  if l.conciliada then raise exception 'Esa línea contable ya está conciliada con otro movimiento'; end if;
  if l.monto <> m.monto then raise exception 'Los montos no coinciden (banco %, contabilidad %)', app.pesos(m.monto), app.pesos(l.monto); end if;
  update public.cartola_movimientos set linea_id = p_linea, estado = 'conciliado', conciliado_por = auth.uid(), conciliado_en = now()
   where id = m.id returning * into m;
  return m;
end $$;

create or replace function public.desconciliar_movimiento(p_movimiento uuid)
returns public.cartola_movimientos language plpgsql security definer set search_path to '' as $$
declare m public.cartola_movimientos;
begin
  select * into m from public.cartola_movimientos where id = p_movimiento for update;
  if m.id is null then raise exception 'Movimiento no encontrado'; end if;
  if not app.puede(m.empresa_id, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  update public.cartola_movimientos set linea_id = null, estado = 'pendiente', nota = null, conciliado_por = null, conciliado_en = null
   where id = m.id returning * into m;
  return m;
end $$;

create or replace function public.ignorar_movimiento(p_movimiento uuid, p_nota text)
returns public.cartola_movimientos language plpgsql security definer set search_path to '' as $$
declare m public.cartola_movimientos;
begin
  select * into m from public.cartola_movimientos where id = p_movimiento for update;
  if m.id is null then raise exception 'Movimiento no encontrado'; end if;
  if not app.puede(m.empresa_id, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  if m.estado <> 'pendiente' then raise exception 'El movimiento no está pendiente'; end if;
  if coalesce(length(trim(p_nota)), 0) < 5 then raise exception 'Explique por qué no se contabiliza'; end if;
  update public.cartola_movimientos set estado = 'ignorado', nota = trim(p_nota), conciliado_por = auth.uid(), conciliado_en = now()
   where id = m.id returning * into m;
  return m;
end $$;

-- Contabiliza un movimiento que solo está en el banco (comisión, interés, cargo automático) y lo concilia
create or replace function public.contabilizar_movimiento(p_movimiento uuid, p_cuenta uuid, p_glosa text default null)
returns public.cartola_movimientos language plpgsql security definer set search_path to '' as $$
declare m public.cartola_movimientos; v_asiento public.asientos; v_linea uuid; v_abs numeric;
begin
  select * into m from public.cartola_movimientos where id = p_movimiento for update;
  if m.id is null then raise exception 'Movimiento no encontrado'; end if;
  if not app.puede(m.empresa_id, 'conciliacion.gestionar') then raise exception 'Sin permiso para conciliar'; end if;
  if m.estado <> 'pendiente' then raise exception 'El movimiento no está pendiente'; end if;
  if not exists (select 1 from public.cuentas where id = p_cuenta and empresa_id = m.empresa_id and imputable and activa and id <> m.cuenta_id) then
    raise exception 'Elija la cuenta de contrapartida';
  end if;
  v_abs := abs(m.monto);
  v_asiento := public.crear_asiento_sistema(m.empresa_id, m.fecha,
    left(coalesce(nullif(trim(p_glosa), ''), 'Banco: ' || m.descripcion), 500),
    case when m.monto > 0
      then jsonb_build_array(jsonb_build_object('cuenta_id', m.cuenta_id, 'debe', v_abs), jsonb_build_object('cuenta_id', p_cuenta, 'haber', v_abs))
      else jsonb_build_array(jsonb_build_object('cuenta_id', p_cuenta, 'debe', v_abs), jsonb_build_object('cuenta_id', m.cuenta_id, 'haber', v_abs)) end,
    'conciliacion', m.id,
    case when m.monto > 0 then 'ingreso'::public.tipo_comprobante else 'egreso'::public.tipo_comprobante end,
    true);
  select id into v_linea from public.asiento_lineas where asiento_id = v_asiento.id and cuenta_id = m.cuenta_id;
  update public.cartola_movimientos set linea_id = v_linea, estado = 'conciliado', conciliado_por = auth.uid(), conciliado_en = now()
   where id = m.id returning * into m;
  return m;
end $$;

-- Resumen: saldo según banco vs. contabilidad y partidas en tránsito
create or replace function public.resumen_conciliacion(p_empresa uuid, p_cuenta uuid, p_hasta date default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_hasta date := coalesce(p_hasta, (now() at time zone 'America/Santiago')::date);
  v_libro numeric; v_banco numeric; v_saldo_fecha date;
begin
  if not app.puede_ver(p_empresa, 'conciliacion.ver') then raise exception 'Sin permiso para ver la conciliación'; end if;
  perform app.validar_banco(p_empresa, p_cuenta);
  -- Un movimiento conciliado con una línea que luego se anuló vuelve a quedar pendiente
  select coalesce(sum(monto), 0) into v_libro from app.lineas_banco(p_empresa, p_cuenta) where fecha <= v_hasta;
  select saldo, fecha into v_banco, v_saldo_fecha from public.cartola_movimientos
   where empresa_id = p_empresa and cuenta_id = p_cuenta and fecha <= v_hasta and saldo is not null
   order by fecha desc, orden desc limit 1;
  return jsonb_build_object(
    'hasta', v_hasta,
    'saldoLibro', v_libro,
    'saldoBanco', v_banco,
    'saldoBancoFecha', v_saldo_fecha,
    'bancoPendiente', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'fecha', fecha, 'descripcion', descripcion, 'referencia', referencia, 'monto', monto) order by fecha, orden), '[]')
                         from public.cartola_movimientos m
                        where empresa_id = p_empresa and cuenta_id = p_cuenta and fecha <= v_hasta
                          and (estado = 'pendiente' or (estado = 'conciliado' and not exists (
                               select 1 from app.lineas_banco(p_empresa, p_cuenta) l where l.linea_id = m.linea_id)))),
    'libroPendiente', (select coalesce(jsonb_agg(jsonb_build_object('lineaId', linea_id, 'fecha', fecha, 'numero', numero, 'glosa', glosa, 'monto', monto) order by fecha, numero), '[]')
                         from app.lineas_banco(p_empresa, p_cuenta) where not conciliada and fecha <= v_hasta),
    'conciliados', (select count(*) from public.cartola_movimientos where empresa_id = p_empresa and cuenta_id = p_cuenta and estado = 'conciliado'),
    'ignorados', (select count(*) from public.cartola_movimientos where empresa_id = p_empresa and cuenta_id = p_cuenta and estado = 'ignorado'));
end $$;

revoke execute on function public.importar_cartola(uuid, uuid, jsonb), public.conciliar_automatico(uuid, uuid),
  public.conciliar_movimiento(uuid, uuid), public.desconciliar_movimiento(uuid), public.ignorar_movimiento(uuid, text),
  public.contabilizar_movimiento(uuid, uuid, text), public.resumen_conciliacion(uuid, uuid, date) from public, anon;
grant execute on function public.importar_cartola(uuid, uuid, jsonb), public.conciliar_automatico(uuid, uuid),
  public.conciliar_movimiento(uuid, uuid), public.desconciliar_movimiento(uuid), public.ignorar_movimiento(uuid, text),
  public.contabilizar_movimiento(uuid, uuid, text), public.resumen_conciliacion(uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Registro de Compras y Ventas (RCV): importación del detalle de sii.cl y cuadratura con el libro

-- La lectura pasa a depender del permiso (antes: cualquier miembro)
drop policy if exists rcv_registros_sel on public.rcv_registros;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'rcv_registros' loop
    execute format('drop policy %I on public.rcv_registros', p.policyname);
  end loop;
end $$;
create policy rcv_registros_sel on public.rcv_registros for select to authenticated using (app.puede_ver(empresa_id, 'rcv.ver'));
revoke insert, update, delete on public.rcv_registros from anon, authenticated;
grant select on public.rcv_registros to authenticated;
alter table public.rcv_registros add column if not exists documento_id uuid references public.documentos(id) on delete set null;

create or replace function public.importar_rcv(p_empresa uuid, p_periodo text, p_operacion text, p_filas jsonb, p_fuente text default 'csv')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare f jsonb; n int := 0; v_op text := upper(p_operacion);
begin
  if p_fuente not in ('csv', 'sii') then raise exception 'Fuente inválida'; end if;
  if not app.puede(p_empresa, 'rcv.importar') then raise exception 'Sin permiso para importar el RCV (o falta la verificación en dos pasos)'; end if;
  if p_periodo !~ '^\d{6}$' then raise exception 'Período inválido (use AAAAMM)'; end if;
  if v_op not in ('COMPRA', 'VENTA') then raise exception 'Operación inválida'; end if;
  if jsonb_typeof(p_filas) <> 'array' then raise exception 'Formato inválido'; end if;
  if jsonb_array_length(p_filas) > 10000 then raise exception 'Demasiadas filas (máximo 10.000)'; end if;
  -- Reemplaza la carga anterior del mismo período y operación
  delete from public.rcv_registros where empresa_id = p_empresa and periodo = p_periodo and operacion = v_op;
  for f in select * from jsonb_array_elements(p_filas) loop
    if coalesce((f ->> 'tipo')::int, 0) = 0 then continue; end if;
    insert into public.rcv_registros (empresa_id, periodo, operacion, tipo, folio, rut_contraparte, razon_social, fecha_emision,
                                      fecha_recepcion, neto, exento, iva, iva_no_recuperable, total, estado, fuente)
    values (p_empresa, p_periodo, v_op, (f ->> 'tipo')::int, coalesce((f ->> 'folio')::bigint, 0),
            coalesce(app.rut_normalizado(nullif(f ->> 'rut', '')), ''), left(coalesce(f ->> 'razonSocial', ''), 200),
            nullif(f ->> 'fechaEmision', '')::date, nullif(f ->> 'fechaRecepcion', '')::date,
            round(coalesce((f ->> 'neto')::numeric, 0)), round(coalesce((f ->> 'exento')::numeric, 0)), round(coalesce((f ->> 'iva')::numeric, 0)),
            round(coalesce((f ->> 'ivaNoRecuperable')::numeric, 0)), round(coalesce((f ->> 'total')::numeric, 0)),
            coalesce(nullif(f ->> 'estado', ''), 'REGISTRO'), p_fuente)
    on conflict (empresa_id, periodo, operacion, tipo, folio, rut_contraparte) do update set
      neto = excluded.neto, exento = excluded.exento, iva = excluded.iva, iva_no_recuperable = excluded.iva_no_recuperable,
      total = excluded.total, estado = excluded.estado, fuente = excluded.fuente, importado_en = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('importados', n, 'cuadratura', public.cuadratura_rcv(p_empresa, p_periodo, v_op));
end $$;

-- Compara el RCV con los documentos vigentes del libro (por tipo, folio y RUT). Las boletas (39/41) se comparan por total.
create or replace function public.cuadratura_rcv(p_empresa uuid, p_periodo text, p_operacion text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_op text := upper(p_operacion); v_lop text := lower(p_operacion); r jsonb;
begin
  if not app.puede_ver(p_empresa, 'rcv.ver') then raise exception 'Sin permiso para ver el RCV'; end if;
  with rcv as (
    select * from public.rcv_registros
     where empresa_id = p_empresa and periodo = p_periodo and operacion = v_op and estado in ('REGISTRO', 'PENDIENTE') and tipo not in (39, 41)),
  libro as (
    select * from public.documentos
     where empresa_id = p_empresa and operacion = v_lop and estado = 'vigente' and to_char(fecha, 'YYYYMM') = p_periodo and tipo not in (39, 41)),
  cruce as (
    select r.id rcv_id, l.id doc_id, coalesce(r.tipo, l.tipo) tipo, coalesce(r.folio, l.folio) folio,
           coalesce(r.rut_contraparte, l.rut) rut, coalesce(nullif(r.razon_social, ''), l.razon_social) razon,
           coalesce(r.fecha_emision, l.fecha) fecha, r.estado estado_sii,
           r.neto r_neto, r.exento r_exento, r.iva r_iva, r.iva_no_recuperable r_ivanr, r.total r_total,
           l.total l_total, l.iva l_iva, app.estado_asiento(l.asiento_id) asiento_estado
      from rcv r full join libro l on l.tipo = r.tipo and l.folio = r.folio and l.rut = r.rut_contraparte),
  clasif as (
    select *, case when doc_id is null then 'solo_en_sii'
                   when rcv_id is null then 'solo_en_libro'
                   when abs(r_total - l_total) > 1 or abs(r_iva - l_iva) > 1 then 'monto_distinto'
                   else 'cuadra' end motivo
      from cruce),
  boletas as (
    select coalesce((select sum(total) from public.rcv_registros where empresa_id = p_empresa and periodo = p_periodo and operacion = v_op
                      and tipo in (39, 41) and estado in ('REGISTRO', 'PENDIENTE')), 0) sii,
           coalesce((select sum(total) from public.documentos where empresa_id = p_empresa and operacion = v_lop and estado = 'vigente'
                      and to_char(fecha, 'YYYYMM') = p_periodo and tipo in (39, 41)), 0) libro)
  select jsonb_build_object(
    'periodo', p_periodo, 'operacion', v_op,
    'importado', (select max(importado_en) from public.rcv_registros where empresa_id = p_empresa and periodo = p_periodo and operacion = v_op),
    'resumen', jsonb_build_object(
      'cuadran', (select count(*) from clasif where motivo = 'cuadra'),
      'soloEnSii', (select count(*) from clasif where motivo = 'solo_en_sii'),
      'soloEnLibro', (select count(*) from clasif where motivo = 'solo_en_libro'),
      'montoDistinto', (select count(*) from clasif where motivo = 'monto_distinto'),
      'totalSii', (select coalesce(sum(r_total), 0) from clasif),
      'totalLibro', (select coalesce(sum(l_total), 0) from clasif),
      'ivaSii', (select coalesce(sum(case when tipo = 61 then -r_iva else r_iva end), 0) from clasif),
      'ivaLibro', (select coalesce(sum(case when tipo = 61 then -l_iva else l_iva end), 0) from clasif)),
    'boletas', (select jsonb_build_object('sii', sii, 'libro', libro) from boletas),
    'diferencias', (select coalesce(jsonb_agg(jsonb_build_object(
        'motivo', motivo, 'rcvId', rcv_id, 'documentoId', doc_id, 'tipo', tipo, 'folio', folio, 'rut', rut, 'razonSocial', razon,
        'fecha', fecha, 'estadoSii', estado_sii, 'totalSii', r_total, 'totalLibro', l_total, 'ivaSii', r_iva, 'ivaLibro', l_iva,
        'neto', r_neto, 'exento', r_exento, 'ivaNoRecuperable', r_ivanr, 'asientoEstado', asiento_estado)
        order by motivo, fecha, tipo, folio), '[]') from clasif where motivo <> 'cuadra'))
  into r;
  return r;
end $$;

-- Registra en el libro los documentos que están en el RCV y faltan en la contabilidad
create or replace function public.registrar_desde_rcv(p_empresa uuid, p_ids uuid[], p_cuenta uuid default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.rcv_registros; d public.documentos; ok int := 0; errores jsonb := '[]';
begin
  if not app.puede(p_empresa, 'documentos.registrar') then raise exception 'Sin permiso para registrar documentos'; end if;
  for r in select * from public.rcv_registros where empresa_id = p_empresa and id = any (p_ids) order by fecha_emision, folio loop
    begin
      if r.tipo in (56, 61) then raise exception 'Las notas de crédito y débito se registran a mano, indicando la factura que modifican'; end if;
      if r.tipo not in (33, 34, 46) then raise exception 'Tipo % no se registra automáticamente', r.tipo; end if;
      if r.fecha_emision is null then raise exception 'Falta la fecha de emisión'; end if;
      d := public.registrar_documento(p_empresa, lower(r.operacion), r.tipo, r.folio, r.fecha_emision, r.rut_contraparte,
             coalesce(nullif(r.razon_social, ''), r.rut_contraparte), r.neto, r.exento, r.iva_no_recuperable, p_cuenta,
             'Registrado desde el RCV del SII', null, null);
      if abs(d.total - r.total) > 1 then
        raise exception 'El total calculado (%) no coincide con el del SII (%)', app.pesos(d.total), app.pesos(r.total);
      end if;
      update public.documentos set origen = 'rcv' where id = d.id;
      update public.rcv_registros set documento_id = d.id where id = r.id;
      ok := ok + 1;
    exception when others then
      errores := errores || jsonb_build_object('tipo', r.tipo, 'folio', r.folio, 'rut', r.rut_contraparte, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('registrados', ok, 'errores', errores);
end $$;

revoke execute on function public.importar_rcv(uuid, text, text, jsonb, text), public.cuadratura_rcv(uuid, text, text),
  public.registrar_desde_rcv(uuid, uuid[], uuid) from public, anon;
grant execute on function public.importar_rcv(uuid, text, text, jsonb, text), public.cuadratura_rcv(uuid, text, text),
  public.registrar_desde_rcv(uuid, uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Preparación de la conexión con el SII (directa o vía proveedor)

alter table public.documentos add column origen text not null default 'manual' check (origen in ('manual', 'rcv', 'dte', 'intercambio'));
alter table public.documentos add column dte_emitido_id uuid references public.dte_emitidos(id);
alter table public.documentos add column dte_recibido_id uuid references public.dte_recibidos(id);

alter table public.empresas add column sii_conector text not null default 'ninguno' check (sii_conector in ('ninguno', 'directo', 'proveedor'));
alter table public.empresas add column sii_proveedor text check (sii_proveedor in ('openfactura', 'libredte'));
alter table public.empresas add column sii_proveedor_url text check (sii_proveedor_url is null or sii_proveedor_url ~ '^https://[a-z0-9.-]+(/[A-Za-z0-9._/-]*)?$');
alter table public.empresas add constraint empresas_proveedor_check check (sii_conector <> 'proveedor' or sii_proveedor is not null);

-- Claves de API de proveedores: cifradas en la Edge Function, como el certificado y los CAF
alter table public.secretos drop constraint secretos_tipo_check;
alter table public.secretos add constraint secretos_tipo_check check (tipo in ('certificado', 'caf', 'api_key'));

-- Configuración no secreta de la conexión (solo administrador)
create or replace function public.configurar_sii(p_empresa uuid, p_conector text, p_ambiente public.ambiente_sii,
  p_proveedor text default null, p_proveedor_url text default null,
  p_resolucion_numero int default null, p_resolucion_fecha date default null, p_rut_envia text default null,
  p_actecos int[] default null)
returns public.empresas language plpgsql security definer set search_path to '' as $$
declare e public.empresas;
begin
  if not app.puede(p_empresa, 'sii.configurar') then raise exception 'Solo el administrador configura la conexión con el SII'; end if;
  if p_conector not in ('ninguno', 'directo', 'proveedor') then raise exception 'Conector inválido'; end if;
  if p_conector = 'proveedor' and p_proveedor is null then raise exception 'Elija el proveedor'; end if;
  if p_rut_envia is not null and p_rut_envia <> '' and not app.rut_valido(p_rut_envia) then raise exception 'RUT de quien envía inválido'; end if;
  if p_actecos is not null and (cardinality(p_actecos) > 4 or exists (select 1 from unnest(p_actecos) a where a < 100000 or a > 999999)) then
    raise exception 'Indique hasta 4 códigos de actividad económica de 6 dígitos';
  end if;
  update public.empresas set
    sii_conector = p_conector,
    sii_ambiente = p_ambiente,
    sii_proveedor = case when p_conector = 'proveedor' then p_proveedor end,
    sii_proveedor_url = case when p_conector = 'proveedor' then nullif(trim(p_proveedor_url), '') end,
    sii_resolucion_numero = coalesce(p_resolucion_numero, sii_resolucion_numero),
    sii_resolucion_fecha = coalesce(p_resolucion_fecha, sii_resolucion_fecha),
    rut_envia = case when p_rut_envia = '' then null when p_rut_envia is null then rut_envia else app.rut_normalizado(p_rut_envia) end,
    actecos = coalesce(p_actecos, actecos)
  where id = p_empresa returning * into e;
  return e;
end $$;

-- Lista de chequeo de lo que falta para operar con el SII
create or replace function public.estado_sii(p_empresa uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare e public.empresas; v_cert record; v_items jsonb := '[]'; v_cafs jsonb; v_key boolean;
begin
  if not app.puede_ver(p_empresa, 'sii.ver') then raise exception 'Sin permiso para ver la conexión con el SII'; end if;
  select * into e from public.empresas where id = p_empresa;
  select titular_nombre, titular_rut, valido_hasta into v_cert from public.certificados
   where empresa_id = p_empresa and activo order by creado_en desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo_dte, 'desde', folio_desde, 'hasta', folio_hasta,
           'disponibles', folio_hasta - folio_siguiente + 1, 'autorizado', fecha_autorizacion) order by tipo_dte), '[]')
    into v_cafs from public.cafs where empresa_id = p_empresa and activo and folio_siguiente <= folio_hasta;
  select exists (select 1 from public.secretos where empresa_id = p_empresa and tipo = 'api_key') into v_key;

  v_items := jsonb_build_array(
    jsonb_build_object('clave', 'datos', 'ok', length(e.giro) >= 2 and e.direccion <> '' and e.comuna <> '',
      'texto', 'Razón social, giro, dirección y comuna de la empresa'),
    jsonb_build_object('clave', 'actecos', 'ok', cardinality(e.actecos) > 0, 'texto', 'Código de actividad económica (Acteco)'),
    jsonb_build_object('clave', 'conector', 'ok', e.sii_conector <> 'ninguno', 'texto', 'Forma de conexión: directa o vía proveedor'));
  if e.sii_conector = 'directo' then
    v_items := v_items
      || jsonb_build_object('clave', 'resolucion', 'ok', e.sii_resolucion_fecha is not null and (e.sii_ambiente = 'certificacion' or e.sii_resolucion_numero > 0),
           'texto', 'Número y fecha de la resolución de autorización del SII')
      || jsonb_build_object('clave', 'certificado', 'ok', v_cert.valido_hasta is not null and v_cert.valido_hasta > now(),
           'texto', 'Certificado digital vigente del representante o usuario autorizado')
      || jsonb_build_object('clave', 'caf', 'ok', jsonb_array_length(v_cafs) > 0, 'texto', 'Folios (CAF) descargados desde sii.cl');
  elsif e.sii_conector = 'proveedor' then
    v_items := v_items
      || jsonb_build_object('clave', 'proveedor', 'ok', e.sii_proveedor is not null, 'texto', 'Proveedor de facturación elegido')
      || jsonb_build_object('clave', 'api_key', 'ok', v_key, 'texto', 'Clave de API del proveedor cargada');
  end if;
  return jsonb_build_object(
    'conector', e.sii_conector, 'proveedor', e.sii_proveedor, 'proveedorUrl', e.sii_proveedor_url, 'ambiente', e.sii_ambiente,
    'resolucionNumero', e.sii_resolucion_numero, 'resolucionFecha', e.sii_resolucion_fecha, 'rutEnvia', e.rut_envia, 'actecos', e.actecos,
    'certificado', case when v_cert.titular_rut is null then null else jsonb_build_object(
        'titular', v_cert.titular_nombre, 'rut', v_cert.titular_rut, 'validoHasta', v_cert.valido_hasta) end,
    'cafs', v_cafs, 'apiKey', v_key,
    'listo', not exists (select 1 from jsonb_array_elements(v_items) i where not (i ->> 'ok')::boolean),
    'items', v_items);
end $$;

revoke execute on function public.configurar_sii(uuid, text, public.ambiente_sii, text, text, int, date, text, int[]), public.estado_sii(uuid) from public, anon;
grant execute on function public.configurar_sii(uuid, text, public.ambiente_sii, text, text, int, date, text, int[]), public.estado_sii(uuid) to authenticated;
