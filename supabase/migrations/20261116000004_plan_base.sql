-- Plan de cuentas base (Chile, PYME) y alta automática de empresas.

create or replace function app.crear_plan_base(p_empresa uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v record;
begin
  insert into public.cuentas (empresa_id, codigo, nombre, tipo, clasificacion, requiere_auxiliar, es_efectivo)
  select p_empresa, x.codigo, x.nombre,
         (case left(x.codigo, 1) when '1' then 'activo' when '2' then 'pasivo' when '3' then 'patrimonio' when '4' then 'ingreso' else 'gasto' end)::public.tipo_cuenta,
         x.clasif::public.clasificacion_cuenta, x.aux, x.efectivo
  from (values
    ('1', 'ACTIVO', null, false, false),
    ('1.1', 'Activo corriente', 'activo_corriente', false, false),
    ('1.1.01', 'Efectivo y equivalentes al efectivo', 'activo_corriente', false, false),
    ('1.1.01.01', 'Caja', 'activo_corriente', false, true),
    ('1.1.01.02', 'Banco cuenta corriente', 'activo_corriente', false, true),
    ('1.1.01.03', 'Depósitos a plazo', 'activo_corriente', false, true),
    ('1.1.02', 'Deudores comerciales', 'activo_corriente', false, false),
    ('1.1.02.01', 'Clientes', 'activo_corriente', true, false),
    ('1.1.02.02', 'Documentos por cobrar', 'activo_corriente', true, false),
    ('1.1.02.03', 'Estimación deudores incobrables', 'activo_corriente', false, false),
    ('1.1.03', 'Impuestos por recuperar', 'activo_corriente', false, false),
    ('1.1.03.01', 'IVA crédito fiscal', 'activo_corriente', false, false),
    ('1.1.03.02', 'Pagos provisionales mensuales (PPM)', 'activo_corriente', false, false),
    ('1.1.03.03', 'Remanente crédito fiscal', 'activo_corriente', false, false),
    ('1.1.04', 'Existencias', 'activo_corriente', false, false),
    ('1.1.04.01', 'Mercaderías', 'activo_corriente', false, false),
    ('1.1.05', 'Otros activos corrientes', 'activo_corriente', false, false),
    ('1.1.05.01', 'Anticipo a proveedores', 'activo_corriente', true, false),
    ('1.1.05.02', 'Fondos por rendir', 'activo_corriente', false, false),
    ('1.2', 'Activo no corriente', 'activo_no_corriente', false, false),
    ('1.2.01', 'Propiedades, planta y equipo', 'activo_no_corriente', false, false),
    ('1.2.01.01', 'Equipos computacionales', 'activo_no_corriente', false, false),
    ('1.2.01.02', 'Muebles y útiles', 'activo_no_corriente', false, false),
    ('1.2.01.03', 'Vehículos', 'activo_no_corriente', false, false),
    ('1.2.01.90', 'Depreciación acumulada', 'activo_no_corriente', false, false),
    ('1.2.02', 'Intangibles', 'activo_no_corriente', false, false),
    ('1.2.02.01', 'Software y licencias', 'activo_no_corriente', false, false),
    ('2', 'PASIVO', null, false, false),
    ('2.1', 'Pasivo corriente', 'pasivo_corriente', false, false),
    ('2.1.01', 'Acreedores comerciales', 'pasivo_corriente', false, false),
    ('2.1.01.01', 'Proveedores', 'pasivo_corriente', true, false),
    ('2.1.01.02', 'Honorarios por pagar', 'pasivo_corriente', true, false),
    ('2.1.01.03', 'Anticipo de clientes', 'pasivo_corriente', true, false),
    ('2.1.02', 'Impuestos por pagar', 'pasivo_corriente', false, false),
    ('2.1.02.01', 'IVA débito fiscal', 'pasivo_corriente', false, false),
    ('2.1.02.02', 'Impuesto único de segunda categoría', 'pasivo_corriente', false, false),
    ('2.1.02.03', 'Retención de honorarios', 'pasivo_corriente', false, false),
    ('2.1.02.04', 'Impuestos por pagar F29', 'pasivo_corriente', false, false),
    ('2.1.02.05', 'Impuesto a la renta por pagar', 'pasivo_corriente', false, false),
    ('2.1.03', 'Remuneraciones', 'pasivo_corriente', false, false),
    ('2.1.03.01', 'Remuneraciones por pagar', 'pasivo_corriente', false, false),
    ('2.1.03.02', 'Leyes sociales por pagar', 'pasivo_corriente', false, false),
    ('2.1.04', 'Obligaciones financieras corto plazo', 'pasivo_corriente', false, false),
    ('2.1.04.01', 'Préstamos bancarios corto plazo', 'pasivo_corriente', false, false),
    ('2.1.04.02', 'Tarjetas de crédito por pagar', 'pasivo_corriente', false, false),
    ('2.2', 'Pasivo no corriente', 'pasivo_no_corriente', false, false),
    ('2.2.01', 'Obligaciones financieras largo plazo', 'pasivo_no_corriente', false, false),
    ('2.2.01.01', 'Préstamos bancarios largo plazo', 'pasivo_no_corriente', false, false),
    ('3', 'PATRIMONIO', null, false, false),
    ('3.1', 'Patrimonio', 'patrimonio', false, false),
    ('3.1.01', 'Capital pagado', 'patrimonio', false, false),
    ('3.1.02', 'Resultados acumulados', 'patrimonio', false, false),
    ('3.1.03', 'Resultado del ejercicio', 'patrimonio', false, false),
    ('3.1.04', 'Retiros y dividendos', 'patrimonio', false, false),
    ('4', 'INGRESOS', null, false, false),
    ('4.1', 'Ingresos de explotación', 'ingreso_operacional', false, false),
    ('4.1.01', 'Ventas afectas', 'ingreso_operacional', false, false),
    ('4.1.02', 'Ventas exentas', 'ingreso_operacional', false, false),
    ('4.1.03', 'Ingresos por servicios', 'ingreso_operacional', false, false),
    ('4.2', 'Otros ingresos', 'ingreso_no_operacional', false, false),
    ('4.2.01', 'Intereses ganados', 'ingreso_no_operacional', false, false),
    ('4.2.02', 'Otros ingresos fuera de explotación', 'ingreso_no_operacional', false, false),
    ('5', 'COSTOS Y GASTOS', null, false, false),
    ('5.1', 'Costos de explotación', 'costo_venta', false, false),
    ('5.1.01', 'Costo de mercaderías vendidas', 'costo_venta', false, false),
    ('5.1.02', 'Costo de servicios prestados', 'costo_venta', false, false),
    ('5.2', 'Gastos de administración y ventas', 'gasto_operacional', false, false),
    ('5.2.01', 'Remuneraciones', 'gasto_operacional', false, false),
    ('5.2.02', 'Honorarios', 'gasto_operacional', false, false),
    ('5.2.03', 'Arriendos', 'gasto_operacional', false, false),
    ('5.2.04', 'Servicios básicos', 'gasto_operacional', false, false),
    ('5.2.05', 'Gastos generales', 'gasto_operacional', false, false),
    ('5.2.06', 'Publicidad y marketing', 'gasto_operacional', false, false),
    ('5.2.07', 'Software y servicios TI', 'gasto_operacional', false, false),
    ('5.2.08', 'Depreciación del ejercicio', 'gasto_operacional', false, false),
    ('5.2.09', 'IVA no recuperable', 'gasto_operacional', false, false),
    ('5.3', 'Otros gastos', 'gasto_no_operacional', false, false),
    ('5.3.01', 'Gastos financieros', 'gasto_no_operacional', false, false),
    ('5.3.02', 'Multas e intereses fiscales', 'gasto_no_operacional', false, false),
    ('5.3.03', 'Otros gastos fuera de explotación', 'gasto_no_operacional', false, false),
    ('5.4', 'Impuesto a la renta', 'impuesto_renta', false, false),
    ('5.4.01', 'Impuesto a la renta del ejercicio', 'impuesto_renta', false, false)
  ) as x (codigo, nombre, clasif, aux, efectivo)
  on conflict (empresa_id, codigo) do nothing;

  -- Jerarquía e imputabilidad
  update public.cuentas h set padre_id = p.id
    from public.cuentas p
   where h.empresa_id = p_empresa and p.empresa_id = p_empresa
     and p.codigo = array_to_string((string_to_array(h.codigo, '.'))[1:array_length(string_to_array(h.codigo, '.'), 1) - 1], '.');
  update public.cuentas c set imputable = not exists (select 1 from public.cuentas h where h.padre_id = c.id)
   where c.empresa_id = p_empresa;

  insert into public.configuracion_cuentas (empresa_id, cuenta_clientes, cuenta_proveedores, cuenta_ventas, cuenta_ventas_exentas,
    cuenta_iva_debito, cuenta_iva_credito, cuenta_gasto_defecto, cuenta_iva_no_recuperable, cuenta_ppm, cuenta_impuestos_por_pagar, cuenta_resultado_ejercicio)
  select p_empresa,
    max(id::text) filter (where codigo = '1.1.02.01')::uuid,
    max(id::text) filter (where codigo = '2.1.01.01')::uuid,
    max(id::text) filter (where codigo = '4.1.01')::uuid,
    max(id::text) filter (where codigo = '4.1.02')::uuid,
    max(id::text) filter (where codigo = '2.1.02.01')::uuid,
    max(id::text) filter (where codigo = '1.1.03.01')::uuid,
    max(id::text) filter (where codigo = '5.2.05')::uuid,
    max(id::text) filter (where codigo = '5.2.09')::uuid,
    max(id::text) filter (where codigo = '1.1.03.02')::uuid,
    max(id::text) filter (where codigo = '2.1.02.04')::uuid,
    max(id::text) filter (where codigo = '3.1.03')::uuid
  from public.cuentas where empresa_id = p_empresa
  on conflict (empresa_id) do nothing;
end $$;

create or replace function app.alta_empresa() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.rut := app.rut_normalizado(new.rut);
  return new;
end $$;
create trigger alta_empresa_normalizar before insert or update of rut on public.empresas
  for each row execute function app.alta_empresa();

create or replace function app.alta_empresa_post() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.creado_por is not null then
    insert into public.miembros (empresa_id, user_id, rol) values (new.id, new.creado_por, 'admin') on conflict do nothing;
  end if;
  perform app.crear_plan_base(new.id);
  insert into public.periodos (empresa_id, anio, mes)
  values (new.id, extract(year from now() at time zone 'America/Santiago'), extract(month from now() at time zone 'America/Santiago'))
  on conflict do nothing;
  return new;
end $$;
create trigger alta_empresa_post after insert on public.empresas
  for each row execute function app.alta_empresa_post();

-- Perfil automático al registrarse
create or replace function app.alta_usuario() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.perfiles (id, nombre) values (new.id, coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1)))
  on conflict do nothing;
  return new;
end $$;
create trigger alta_usuario after insert on auth.users
  for each row execute function app.alta_usuario();
