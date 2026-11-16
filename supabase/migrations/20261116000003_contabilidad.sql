-- Reglas contables: períodos, inmutabilidad de comprobantes, numeración,
-- contabilización automática de DTE y alta de empresas.

-- ---------------------------------------------------------------------------
-- Períodos

create or replace function app.periodo_abierto(p_empresa uuid, p_fecha date) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_estado public.estado_periodo;
begin
  select estado into v_estado from public.periodos
   where empresa_id = p_empresa and anio = extract(year from p_fecha) and mes = extract(month from p_fecha);
  if v_estado is null then
    insert into public.periodos (empresa_id, anio, mes) values (p_empresa, extract(year from p_fecha), extract(month from p_fecha))
    on conflict do nothing;
    return true;
  end if;
  return v_estado = 'abierto';
end $$;

-- Un cambio "privilegiado" solo puede venir de funciones SECURITY DEFINER del sistema,
-- nunca de una escritura directa del cliente (rol authenticated/anon).
create or replace function app.es_operacion_interna() returns boolean
language sql stable set search_path = '' as $$ select current_user not in ('authenticated', 'anon') $$;

-- ---------------------------------------------------------------------------
-- Inmutabilidad de comprobantes

create or replace function app.validar_asiento() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Solo se pueden eliminar comprobantes en borrador (use anular o reversar)';
    end if;
    if not app.periodo_abierto(old.empresa_id, old.fecha) then
      raise exception 'El período % está cerrado', to_char(old.fecha, 'YYYY-MM');
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' and not app.es_operacion_interna() then
      raise exception 'Los comprobantes se crean en borrador; use contabilizar_asiento()';
    end if;
    if not app.periodo_abierto(new.empresa_id, new.fecha) then
      raise exception 'El período % está cerrado', to_char(new.fecha, 'YYYY-MM');
    end if;
    new.numero := null;
    new.total_debe := 0;
    new.total_haber := 0;
    return new;
  end if;

  -- UPDATE
  if new.empresa_id <> old.empresa_id then raise exception 'No se puede cambiar la empresa de un comprobante'; end if;
  if old.estado = 'anulado' then raise exception 'El comprobante está anulado'; end if;
  if old.estado = 'contabilizado' then
    if not app.es_operacion_interna() then
      raise exception 'Un comprobante contabilizado no se puede modificar (use anular o reversar)';
    end if;
    if new.estado <> 'anulado' or new.fecha <> old.fecha or new.total_debe <> old.total_debe then
      raise exception 'Solo se permite anular un comprobante contabilizado';
    end if;
    return new;
  end if;
  -- borrador
  if new.estado <> 'borrador' and not app.es_operacion_interna() then
    raise exception 'Use contabilizar_asiento() para contabilizar';
  end if;
  if not app.es_operacion_interna() then
    new.numero := old.numero;
    new.total_debe := old.total_debe;
    new.total_haber := old.total_haber;
  end if;
  if not app.periodo_abierto(new.empresa_id, new.fecha) then
    raise exception 'El período % está cerrado', to_char(new.fecha, 'YYYY-MM');
  end if;
  return new;
end $$;

create trigger validar_asiento before insert or update or delete on public.asientos
  for each row execute function app.validar_asiento();

create or replace function app.validar_linea() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_asiento public.asientos;
  v_cuenta public.cuentas;
  r record;
begin
  r := coalesce(new, old);
  select * into v_asiento from public.asientos where id = r.asiento_id;
  if v_asiento.estado <> 'borrador' then
    raise exception 'No se pueden modificar líneas de un comprobante %', v_asiento.estado;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.empresa_id <> v_asiento.empresa_id then raise exception 'La línea no corresponde a la empresa del comprobante'; end if;
  select * into v_cuenta from public.cuentas where id = new.cuenta_id;
  if v_cuenta.empresa_id <> new.empresa_id then raise exception 'La cuenta no pertenece a la empresa'; end if;
  if not v_cuenta.imputable then raise exception 'La cuenta % % no es imputable', v_cuenta.codigo, v_cuenta.nombre; end if;
  if not v_cuenta.activa then raise exception 'La cuenta % está inactiva', v_cuenta.codigo; end if;
  if new.auxiliar_id is not null and not exists (select 1 from public.auxiliares where id = new.auxiliar_id and empresa_id = new.empresa_id) then
    raise exception 'Auxiliar inválido';
  end if;
  if new.centro_costo_id is not null and not exists (select 1 from public.centros_costo where id = new.centro_costo_id and empresa_id = new.empresa_id) then
    raise exception 'Centro de costo inválido';
  end if;
  return new;
end $$;

create trigger validar_linea before insert or update or delete on public.asiento_lineas
  for each row execute function app.validar_linea();

-- ---------------------------------------------------------------------------
-- Operaciones sobre comprobantes (RPC)

create or replace function public.contabilizar_asiento(p_id uuid) returns public.asientos
language plpgsql security definer set search_path = '' as $$
declare
  v public.asientos;
  v_debe numeric;
  v_haber numeric;
  v_n int;
  v_falta text;
begin
  select * into v from public.asientos where id = p_id for update;
  if v.id is null then raise exception 'Comprobante no encontrado'; end if;
  if not app.es_servicio() and not app.puede_escribir(v.empresa_id, '{admin,contador}') then
    raise exception 'Solo administradores o contadores pueden contabilizar';
  end if;
  if v.estado <> 'borrador' then raise exception 'El comprobante ya está %', v.estado; end if;
  if not app.periodo_abierto(v.empresa_id, v.fecha) then raise exception 'El período está cerrado'; end if;
  select count(*), coalesce(sum(debe), 0), coalesce(sum(haber), 0) into v_n, v_debe, v_haber
    from public.asiento_lineas where asiento_id = p_id;
  if v_n < 2 then raise exception 'El comprobante debe tener al menos dos líneas'; end if;
  if v_debe <> v_haber then raise exception 'El comprobante no cuadra: debe % / haber %', v_debe, v_haber; end if;
  if v_debe = 0 then raise exception 'El comprobante no tiene montos'; end if;
  select string_agg(c.codigo || ' ' || c.nombre, ', ') into v_falta
    from public.asiento_lineas l join public.cuentas c on c.id = l.cuenta_id
   where l.asiento_id = p_id and ((c.requiere_auxiliar and l.auxiliar_id is null) or (c.requiere_centro_costo and l.centro_costo_id is null));
  if v_falta is not null then raise exception 'Faltan auxiliar o centro de costo en: %', v_falta; end if;

  perform pg_advisory_xact_lock(hashtextextended('folio_asiento:' || v.empresa_id || ':' || v.anio, 0));
  update public.asientos set
    estado = 'contabilizado',
    numero = (select coalesce(max(numero), 0) + 1 from public.asientos where empresa_id = v.empresa_id and anio = v.anio),
    total_debe = v_debe,
    total_haber = v_haber,
    contabilizado_por = auth.uid(),
    contabilizado_en = now()
  where id = p_id returning * into v;
  return v;
end $$;

create or replace function public.anular_asiento(p_id uuid, p_motivo text) returns public.asientos
language plpgsql security definer set search_path = '' as $$
declare v public.asientos;
begin
  select * into v from public.asientos where id = p_id for update;
  if v.id is null then raise exception 'Comprobante no encontrado'; end if;
  if not app.puede_escribir(v.empresa_id, '{admin,contador}') then raise exception 'Sin permiso'; end if;
  if v.estado <> 'contabilizado' then raise exception 'Solo se anulan comprobantes contabilizados'; end if;
  if coalesce(length(trim(p_motivo)), 0) < 5 then raise exception 'Indique el motivo de la anulación'; end if;
  if not app.periodo_abierto(v.empresa_id, v.fecha) then
    raise exception 'El período está cerrado: use reversar_asiento() con fecha en un período abierto';
  end if;
  update public.asientos set estado = 'anulado', anulado_por = auth.uid(), anulado_en = now(), motivo_anulacion = p_motivo
   where id = p_id returning * into v;
  update public.dte_emitidos set asiento_id = null where asiento_id = p_id;
  update public.dte_recibidos set asiento_id = null where asiento_id = p_id;
  return v;
end $$;

create or replace function public.reversar_asiento(p_id uuid, p_fecha date, p_motivo text) returns public.asientos
language plpgsql security definer set search_path = '' as $$
declare
  v public.asientos;
  v_nuevo uuid;
begin
  select * into v from public.asientos where id = p_id;
  if v.id is null then raise exception 'Comprobante no encontrado'; end if;
  if not app.puede_escribir(v.empresa_id, '{admin,contador}') then raise exception 'Sin permiso'; end if;
  if v.estado <> 'contabilizado' then raise exception 'Solo se reversan comprobantes contabilizados'; end if;
  if exists (select 1 from public.asientos where reverso_de = p_id and estado = 'contabilizado') then
    raise exception 'El comprobante ya fue reversado';
  end if;
  insert into public.asientos (empresa_id, tipo, fecha, glosa, origen, reverso_de)
  values (v.empresa_id, 'traspaso', p_fecha, left('Reverso #' || v.numero || ': ' || coalesce(p_motivo, v.glosa), 500), 'reverso', p_id)
  returning id into v_nuevo;
  insert into public.asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber, glosa, centro_costo_id, auxiliar_id, documento_tipo, documento_folio)
  select v_nuevo, empresa_id, linea, cuenta_id, haber, debe, glosa, centro_costo_id, auxiliar_id, documento_tipo, documento_folio
    from public.asiento_lineas where asiento_id = p_id;
  return public.contabilizar_asiento(v_nuevo);
end $$;

/**
 * Crea un comprobante completo en una sola transacción.
 * p_lineas: [{cuenta_id, debe, haber, glosa?, auxiliar_id?, centro_costo_id?, documento_tipo?, documento_folio?}]
 */
create or replace function public.crear_asiento(
  p_empresa uuid, p_fecha date, p_glosa text, p_lineas jsonb,
  p_tipo public.tipo_comprobante default 'traspaso', p_contabilizar boolean default false
) returns public.asientos
language plpgsql security invoker set search_path = '' as $$
declare
  v public.asientos;
  l jsonb;
  i int := 0;
begin
  if not app.puede_escribir(p_empresa, '{admin,contador,operador}') then raise exception 'Sin permiso'; end if;
  insert into public.asientos (empresa_id, fecha, glosa, tipo) values (p_empresa, p_fecha, p_glosa, p_tipo) returning * into v;
  for l in select * from jsonb_array_elements(p_lineas) loop
    i := i + 1;
    insert into public.asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber, glosa, auxiliar_id, centro_costo_id, documento_tipo, documento_folio)
    values (v.id, p_empresa, i, (l ->> 'cuenta_id')::uuid, coalesce((l ->> 'debe')::numeric, 0), coalesce((l ->> 'haber')::numeric, 0),
            nullif(l ->> 'glosa', ''), nullif(l ->> 'auxiliar_id', '')::uuid, nullif(l ->> 'centro_costo_id', '')::uuid,
            nullif(l ->> 'documento_tipo', '')::int, nullif(l ->> 'documento_folio', '')::bigint);
  end loop;
  if p_contabilizar then v := public.contabilizar_asiento(v.id); end if;
  return v;
end $$;

create or replace function public.cerrar_periodo(p_empresa uuid, p_anio int, p_mes int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.puede_escribir(p_empresa, '{admin,contador}') then raise exception 'Sin permiso'; end if;
  if exists (select 1 from public.asientos where empresa_id = p_empresa and estado = 'borrador'
             and extract(year from fecha) = p_anio and extract(month from fecha) = p_mes) then
    raise exception 'Hay comprobantes en borrador en el período; contabilícelos o elimínelos antes de cerrar';
  end if;
  insert into public.periodos (empresa_id, anio, mes, estado, cerrado_por, cerrado_en)
  values (p_empresa, p_anio, p_mes, 'cerrado', auth.uid(), now())
  on conflict (empresa_id, anio, mes) do update set estado = 'cerrado', cerrado_por = auth.uid(), cerrado_en = now();
end $$;

create or replace function public.reabrir_periodo(p_empresa uuid, p_anio int, p_mes int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.puede_escribir(p_empresa, '{admin}') then raise exception 'Solo un administrador puede reabrir períodos'; end if;
  update public.periodos set estado = 'abierto', cerrado_por = null, cerrado_en = null
   where empresa_id = p_empresa and anio = p_anio and mes = p_mes;
end $$;

-- ---------------------------------------------------------------------------
-- Miembros

create or replace function public.agregar_miembro(p_empresa uuid, p_correo text, p_rol public.rol_empresa) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not app.puede_escribir(p_empresa, '{admin}') then raise exception 'Solo un administrador puede agregar usuarios'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_correo));
  if v_user is null then raise exception 'No existe un usuario registrado con ese correo'; end if;
  insert into public.miembros (empresa_id, user_id, rol) values (p_empresa, v_user, p_rol)
  on conflict (empresa_id, user_id) do update set rol = excluded.rol;
end $$;

create or replace function app.proteger_ultimo_admin() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.rol = 'admin' and (tg_op = 'DELETE' or new.rol <> 'admin') and
     not exists (select 1 from public.miembros where empresa_id = old.empresa_id and rol = 'admin' and user_id <> old.user_id)
     and exists (select 1 from public.empresas where id = old.empresa_id) then
    raise exception 'La empresa debe tener al menos un administrador';
  end if;
  return coalesce(new, old);
end $$;
create trigger proteger_ultimo_admin before update or delete on public.miembros
  for each row execute function app.proteger_ultimo_admin();

-- ---------------------------------------------------------------------------
-- Folios (solo Edge Functions con rol de servicio)

create or replace function public.reservar_folio(p_empresa uuid, p_tipo int)
returns table (caf_id uuid, folio int, secreto_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v public.cafs;
begin
  select * into v from public.cafs
   where empresa_id = p_empresa and tipo_dte = p_tipo and activo and folio_siguiente <= folio_hasta
   order by folio_desde limit 1 for update;
  if v.id is null then raise exception 'No hay folios disponibles para el tipo %; cargue un CAF nuevo', p_tipo; end if;
  update public.cafs set folio_siguiente = folio_siguiente + 1 where id = v.id;
  return query select v.id, v.folio_siguiente, v.secreto_id;
end $$;
revoke execute on function public.reservar_folio(uuid, int) from public, anon, authenticated;
grant execute on function public.reservar_folio(uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- Contabilización automática de DTE

create or replace function app.auxiliar_para(p_empresa uuid, p_rut text, p_razon text, p_cliente boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  insert into public.auxiliares (empresa_id, rut, razon_social, es_cliente, es_proveedor)
  values (p_empresa, app.rut_normalizado(p_rut), coalesce(nullif(p_razon, ''), p_rut), p_cliente, not p_cliente)
  on conflict (empresa_id, rut) do update set
    es_cliente = public.auxiliares.es_cliente or excluded.es_cliente,
    es_proveedor = public.auxiliares.es_proveedor or excluded.es_proveedor
  returning id into v;
  return v;
end $$;

create or replace function public.contabilizar_dte_emitido(p_dte uuid) returns public.asientos
language plpgsql security definer set search_path = '' as $$
declare
  d public.dte_emitidos;
  c public.configuracion_cuentas;
  v_aux uuid;
  v_signo int;
  v_lineas jsonb := '[]';
  v_asiento public.asientos;
  v_nombre text;
begin
  select * into d from public.dte_emitidos where id = p_dte for update;
  if d.id is null then raise exception 'Documento no encontrado'; end if;
  if not app.es_servicio() and not app.puede_escribir(d.empresa_id, '{admin,contador}') then raise exception 'Sin permiso'; end if;
  if d.asiento_id is not null then raise exception 'El documento ya está contabilizado'; end if;
  if d.tipo = 52 then raise exception 'Las guías de despacho no generan asiento'; end if;
  select * into c from public.configuracion_cuentas where empresa_id = d.empresa_id;
  v_aux := app.auxiliar_para(d.empresa_id, d.receptor_rut, d.receptor_razon, true);
  v_signo := case when d.tipo = 61 then -1 else 1 end;
  v_nombre := case d.tipo when 33 then 'Factura' when 34 then 'Factura exenta' when 39 then 'Boleta' when 41 then 'Boleta exenta'
                when 56 then 'Nota de débito' when 61 then 'Nota de crédito' else 'DTE' end;
  -- Cliente
  v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_clientes, 'auxiliar_id', v_aux,
    case when v_signo > 0 then 'debe' else 'haber' end, d.total, 'documento_tipo', d.tipo, 'documento_folio', d.folio);
  if d.neto > 0 then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_ventas, case when v_signo > 0 then 'haber' else 'debe' end, d.neto);
  end if;
  if d.exento > 0 then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', coalesce(c.cuenta_ventas_exentas, c.cuenta_ventas), case when v_signo > 0 then 'haber' else 'debe' end, d.exento);
  end if;
  if d.iva > 0 then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_iva_debito, case when v_signo > 0 then 'haber' else 'debe' end, d.iva);
  end if;
  v_asiento := public.crear_asiento_sistema(d.empresa_id, d.fecha_emision,
    left(v_nombre || ' N° ' || d.folio || ' a ' || d.receptor_razon, 500), v_lineas, 'dte_emitido', d.id,
    case when v_signo > 0 then 'ingreso'::public.tipo_comprobante else 'traspaso'::public.tipo_comprobante end);
  update public.dte_emitidos set asiento_id = v_asiento.id where id = d.id;
  return v_asiento;
end $$;

create or replace function public.contabilizar_dte_recibido(p_dte uuid, p_cuenta_gasto uuid default null, p_centro_costo uuid default null)
returns public.asientos
language plpgsql security definer set search_path = '' as $$
declare
  d public.dte_recibidos;
  c public.configuracion_cuentas;
  v_aux uuid;
  v_gasto uuid;
  v_signo int;
  v_lineas jsonb := '[]';
  v_asiento public.asientos;
  v_debe text;
  v_haber text;
begin
  select * into d from public.dte_recibidos where id = p_dte for update;
  if d.id is null then raise exception 'Documento no encontrado'; end if;
  if not app.puede_escribir(d.empresa_id, '{admin,contador}') then raise exception 'Sin permiso'; end if;
  if d.asiento_id is not null then raise exception 'El documento ya está contabilizado'; end if;
  if d.estado = 'reclamado' then raise exception 'El documento fue reclamado; no se contabiliza'; end if;
  select * into c from public.configuracion_cuentas where empresa_id = d.empresa_id;
  v_gasto := coalesce(p_cuenta_gasto, c.cuenta_gasto_defecto);
  if not exists (select 1 from public.cuentas where id = v_gasto and empresa_id = d.empresa_id) then raise exception 'Cuenta de gasto inválida'; end if;
  v_aux := app.auxiliar_para(d.empresa_id, d.emisor_rut, d.emisor_razon, false);
  v_signo := case when d.tipo = 61 then -1 else 1 end;
  v_debe := case when v_signo > 0 then 'debe' else 'haber' end;
  v_haber := case when v_signo > 0 then 'haber' else 'debe' end;
  if d.neto + d.exento > 0 then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', v_gasto, v_debe, d.neto + d.exento, 'centro_costo_id', p_centro_costo);
  end if;
  if d.iva - d.iva_no_recuperable > 0 then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_iva_credito, v_debe, d.iva - d.iva_no_recuperable);
  end if;
  if d.iva_no_recuperable > 0 then
    v_lineas := v_lineas || jsonb_build_object('cuenta_id', coalesce(c.cuenta_iva_no_recuperable, v_gasto), v_debe, d.iva_no_recuperable);
  end if;
  v_lineas := v_lineas || jsonb_build_object('cuenta_id', c.cuenta_proveedores, 'auxiliar_id', v_aux, v_haber, d.total,
    'documento_tipo', d.tipo, 'documento_folio', d.folio);
  v_asiento := public.crear_asiento_sistema(d.empresa_id, d.fecha_emision,
    left('Doc. ' || d.tipo || ' N° ' || d.folio || ' de ' || d.emisor_razon, 500), v_lineas, 'dte_recibido', d.id,
    case when v_signo > 0 then 'egreso'::public.tipo_comprobante else 'traspaso'::public.tipo_comprobante end);
  update public.dte_recibidos set asiento_id = v_asiento.id where id = d.id;
  return v_asiento;
end $$;

create or replace function public.crear_asiento_sistema(
  p_empresa uuid, p_fecha date, p_glosa text, p_lineas jsonb, p_origen text, p_origen_id uuid, p_tipo public.tipo_comprobante
) returns public.asientos
language plpgsql security definer set search_path = '' as $$
declare
  v public.asientos;
  l jsonb;
  i int := 0;
begin
  insert into public.asientos (empresa_id, fecha, glosa, tipo, origen, origen_id)
  values (p_empresa, p_fecha, p_glosa, p_tipo, p_origen, p_origen_id) returning * into v;
  for l in select * from jsonb_array_elements(p_lineas) loop
    i := i + 1;
    if l ->> 'cuenta_id' is null then raise exception 'Falta configurar las cuentas automáticas de la empresa'; end if;
    insert into public.asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber, auxiliar_id, centro_costo_id, documento_tipo, documento_folio)
    values (v.id, p_empresa, i, (l ->> 'cuenta_id')::uuid, coalesce((l ->> 'debe')::numeric, 0), coalesce((l ->> 'haber')::numeric, 0),
            nullif(l ->> 'auxiliar_id', '')::uuid, nullif(l ->> 'centro_costo_id', '')::uuid,
            nullif(l ->> 'documento_tipo', '')::int, nullif(l ->> 'documento_folio', '')::bigint);
  end loop;
  return public.contabilizar_asiento(v.id);
end $$;
revoke execute on function public.crear_asiento_sistema(uuid, date, text, jsonb, text, uuid, public.tipo_comprobante) from public, anon, authenticated;
