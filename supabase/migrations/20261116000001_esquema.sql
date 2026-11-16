-- Cuadra Contable — esquema base
-- Multiempresa, plan de cuentas, comprobantes, documentos tributarios electrónicos,
-- RCV, F29 y auditoría encadenada.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tipos

create type public.rol_empresa as enum ('admin', 'contador', 'operador', 'auditor', 'lector');
create type public.tipo_cuenta as enum ('activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'orden');
create type public.clasificacion_cuenta as enum (
  'activo_corriente', 'activo_no_corriente',
  'pasivo_corriente', 'pasivo_no_corriente', 'patrimonio',
  'ingreso_operacional', 'costo_venta', 'gasto_operacional',
  'ingreso_no_operacional', 'gasto_no_operacional', 'impuesto_renta', 'orden'
);
create type public.estado_asiento as enum ('borrador', 'contabilizado', 'anulado');
create type public.tipo_comprobante as enum ('ingreso', 'egreso', 'traspaso', 'apertura', 'cierre');
create type public.estado_periodo as enum ('abierto', 'cerrado');
create type public.ambiente_sii as enum ('certificacion', 'produccion');
create type public.estado_dte as enum ('borrador', 'firmado', 'enviado', 'aceptado', 'aceptado_reparos', 'rechazado', 'anulado');
create type public.estado_recibido as enum ('pendiente', 'aceptado', 'reclamado', 'recibo_mercaderias');

-- ---------------------------------------------------------------------------
-- Utilidades de RUT

create or replace function app.rut_valido(rut text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  limpio text := upper(regexp_replace(coalesce(rut, ''), '[^0-9kK]', '', 'g'));
  cuerpo text;
  dv text;
  suma int := 0;
  mult int := 2;
  r int;
  esperado text;
begin
  if length(limpio) < 2 then return false; end if;
  cuerpo := left(limpio, -1);
  dv := right(limpio, 1);
  if cuerpo !~ '^\d+$' then return false; end if;
  for i in reverse length(cuerpo)..1 loop
    suma := suma + substr(cuerpo, i, 1)::int * mult;
    mult := case when mult = 7 then 2 else mult + 1 end;
  end loop;
  r := 11 - (suma % 11);
  esperado := case r when 11 then '0' when 10 then 'K' else r::text end;
  return esperado = dv;
end $$;

create or replace function app.rut_normalizado(rut text) returns text
language sql immutable set search_path = '' as $$
  select (left(l, -1)::bigint)::text || '-' || right(l, 1)
  from (select upper(regexp_replace(coalesce(rut, ''), '[^0-9kK]', '', 'g')) as l) x
$$;

-- ---------------------------------------------------------------------------
-- Empresas y usuarios

create table public.perfiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null default '',
  rut text check (rut is null or app.rut_valido(rut)),
  creado_en timestamptz not null default now()
);

create table public.empresas (
  id uuid primary key default gen_random_uuid(),
  rut text not null unique check (app.rut_valido(rut)),
  razon_social text not null check (length(razon_social) between 2 and 100),
  nombre_fantasia text,
  giro text not null check (length(giro) between 2 and 80),
  actecos int[] not null default '{}',
  direccion text not null default '',
  comuna text not null default '',
  ciudad text,
  correo text,
  telefono text,
  codigo_sucursal int,
  sii_ambiente public.ambiente_sii not null default 'certificacion',
  sii_resolucion_numero int not null default 0,
  sii_resolucion_fecha date,
  rut_envia text check (rut_envia is null or app.rut_valido(rut_envia)),
  tasa_ppm numeric(6, 3) not null default 0.25 check (tasa_ppm between 0 and 100),
  remanente_inicial numeric(18, 0) not null default 0,
  creado_por uuid references auth.users (id),
  creado_en timestamptz not null default now()
);

create table public.miembros (
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  rol public.rol_empresa not null,
  creado_en timestamptz not null default now(),
  primary key (empresa_id, user_id)
);
create index on public.miembros (user_id);

-- ---------------------------------------------------------------------------
-- Plan de cuentas y maestros

create table public.cuentas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  codigo text not null check (codigo ~ '^[0-9]+(\.[0-9]+)*$'),
  nombre text not null,
  tipo public.tipo_cuenta not null,
  clasificacion public.clasificacion_cuenta,
  padre_id uuid references public.cuentas (id),
  nivel int generated always as (array_length(string_to_array(codigo, '.'), 1)) stored,
  imputable boolean not null default true,
  requiere_auxiliar boolean not null default false,
  requiere_centro_costo boolean not null default false,
  es_efectivo boolean not null default false,
  activa boolean not null default true,
  unique (empresa_id, codigo)
);
create index on public.cuentas (empresa_id, tipo);

create table public.centros_costo (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  codigo text not null,
  nombre text not null,
  activo boolean not null default true,
  unique (empresa_id, codigo)
);

create table public.auxiliares (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  rut text not null check (app.rut_valido(rut)),
  razon_social text not null,
  giro text,
  direccion text,
  comuna text,
  ciudad text,
  correo text,
  correo_dte text,
  es_cliente boolean not null default false,
  es_proveedor boolean not null default false,
  creado_en timestamptz not null default now(),
  unique (empresa_id, rut)
);

create table public.configuracion_cuentas (
  empresa_id uuid primary key references public.empresas (id) on delete cascade,
  cuenta_clientes uuid references public.cuentas (id),
  cuenta_proveedores uuid references public.cuentas (id),
  cuenta_ventas uuid references public.cuentas (id),
  cuenta_ventas_exentas uuid references public.cuentas (id),
  cuenta_iva_debito uuid references public.cuentas (id),
  cuenta_iva_credito uuid references public.cuentas (id),
  cuenta_gasto_defecto uuid references public.cuentas (id),
  cuenta_iva_no_recuperable uuid references public.cuentas (id),
  cuenta_ppm uuid references public.cuentas (id),
  cuenta_impuestos_por_pagar uuid references public.cuentas (id),
  cuenta_resultado_ejercicio uuid references public.cuentas (id)
);

-- ---------------------------------------------------------------------------
-- Períodos y comprobantes contables

create table public.periodos (
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  anio int not null check (anio between 2000 and 2100),
  mes int not null check (mes between 1 and 12),
  estado public.estado_periodo not null default 'abierto',
  cerrado_por uuid references auth.users (id),
  cerrado_en timestamptz,
  primary key (empresa_id, anio, mes)
);

create table public.asientos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  numero int,
  tipo public.tipo_comprobante not null default 'traspaso',
  fecha date not null,
  anio int generated always as (extract(year from fecha)::int) stored,
  glosa text not null check (length(glosa) between 1 and 500),
  estado public.estado_asiento not null default 'borrador',
  origen text not null default 'manual' check (origen in ('manual', 'dte_emitido', 'dte_recibido', 'f29', 'cierre', 'apertura', 'reverso', 'importacion')),
  origen_id uuid,
  reverso_de uuid references public.asientos (id),
  total_debe numeric(18, 2) not null default 0,
  total_haber numeric(18, 2) not null default 0,
  creado_por uuid references auth.users (id) default auth.uid(),
  creado_en timestamptz not null default now(),
  contabilizado_por uuid references auth.users (id),
  contabilizado_en timestamptz,
  anulado_por uuid references auth.users (id),
  anulado_en timestamptz,
  motivo_anulacion text,
  unique (empresa_id, anio, numero)
);
create index on public.asientos (empresa_id, fecha);
create index on public.asientos (empresa_id, estado);
create index on public.asientos (origen, origen_id);

create table public.asiento_lineas (
  id uuid primary key default gen_random_uuid(),
  asiento_id uuid not null references public.asientos (id) on delete cascade,
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  linea int not null,
  cuenta_id uuid not null references public.cuentas (id),
  debe numeric(18, 2) not null default 0 check (debe >= 0),
  haber numeric(18, 2) not null default 0 check (haber >= 0),
  glosa text,
  centro_costo_id uuid references public.centros_costo (id),
  auxiliar_id uuid references public.auxiliares (id),
  documento_tipo int,
  documento_folio bigint,
  check ((debe = 0) <> (haber = 0)),
  unique (asiento_id, linea)
);
create index on public.asiento_lineas (empresa_id, cuenta_id);
create index on public.asiento_lineas (auxiliar_id);

-- ---------------------------------------------------------------------------
-- Secretos (certificado digital y claves de CAF), cifrados en la Edge Function.
-- RLS sin políticas: solo el rol de servicio puede leerlos.

create table public.secretos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  tipo text not null check (tipo in ('certificado', 'caf')),
  cifrado text not null,
  creado_en timestamptz not null default now()
);

create table public.certificados (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  titular_nombre text not null,
  titular_rut text not null check (app.rut_valido(titular_rut)),
  valido_desde timestamptz not null,
  valido_hasta timestamptz not null,
  secreto_id uuid not null references public.secretos (id),
  activo boolean not null default true,
  creado_por uuid references auth.users (id) default auth.uid(),
  creado_en timestamptz not null default now()
);

create table public.cafs (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  tipo_dte int not null,
  folio_desde int not null,
  folio_hasta int not null,
  folio_siguiente int not null,
  fecha_autorizacion date not null,
  secreto_id uuid not null references public.secretos (id),
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  check (folio_desde <= folio_hasta),
  check (folio_siguiente between folio_desde and folio_hasta + 1)
);
create index on public.cafs (empresa_id, tipo_dte, activo);

-- ---------------------------------------------------------------------------
-- Documentos tributarios

create table public.dte_emitidos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  tipo int not null,
  folio int not null,
  fecha_emision date not null,
  receptor_rut text not null,
  receptor_razon text not null,
  auxiliar_id uuid references public.auxiliares (id),
  neto numeric(18, 0) not null default 0,
  exento numeric(18, 0) not null default 0,
  iva numeric(18, 0) not null default 0,
  total numeric(18, 0) not null default 0,
  estado public.estado_dte not null default 'firmado',
  ambiente public.ambiente_sii not null,
  track_id text,
  sii_estado text,
  sii_glosa text,
  sii_respuesta jsonb,
  datos jsonb not null,
  xml text not null,
  ted text,
  asiento_id uuid references public.asientos (id),
  referencia_id uuid references public.dte_emitidos (id),
  creado_por uuid references auth.users (id),
  creado_en timestamptz not null default now(),
  enviado_en timestamptz,
  unique (empresa_id, tipo, folio, ambiente)
);
create index on public.dte_emitidos (empresa_id, fecha_emision);
create index on public.dte_emitidos (empresa_id, estado);

create table public.dte_recibidos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  tipo int not null,
  folio bigint not null,
  fecha_emision date not null,
  fecha_recepcion timestamptz not null default now(),
  emisor_rut text not null,
  emisor_razon text not null default '',
  auxiliar_id uuid references public.auxiliares (id),
  neto numeric(18, 0) not null default 0,
  exento numeric(18, 0) not null default 0,
  iva numeric(18, 0) not null default 0,
  iva_no_recuperable numeric(18, 0) not null default 0,
  total numeric(18, 0) not null default 0,
  estado public.estado_recibido not null default 'pendiente',
  origen text not null default 'intercambio' check (origen in ('intercambio', 'rcv', 'manual')),
  xml text,
  accion_sii text,
  accion_respuesta jsonb,
  accion_en timestamptz,
  accion_por uuid references auth.users (id),
  asiento_id uuid references public.asientos (id),
  unique (empresa_id, emisor_rut, tipo, folio)
);
create index on public.dte_recibidos (empresa_id, fecha_emision);

create table public.envios_sii (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  tipo text not null check (tipo in ('dte', 'boleta', 'respuesta', 'recibos')),
  ambiente public.ambiente_sii not null,
  track_id text,
  estado text,
  glosa text,
  respuesta jsonb,
  documentos uuid[] not null default '{}',
  creado_por uuid references auth.users (id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz
);

create table public.rcv_registros (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  periodo char(6) not null check (periodo ~ '^\d{6}$'),
  operacion text not null check (operacion in ('COMPRA', 'VENTA')),
  tipo int not null,
  folio bigint not null,
  rut_contraparte text not null default '',
  razon_social text not null default '',
  fecha_emision date,
  fecha_recepcion date,
  neto numeric(18, 0) not null default 0,
  exento numeric(18, 0) not null default 0,
  iva numeric(18, 0) not null default 0,
  iva_no_recuperable numeric(18, 0) not null default 0,
  total numeric(18, 0) not null default 0,
  estado text not null default 'REGISTRO',
  fuente text not null default 'csv' check (fuente in ('csv', 'sii')),
  importado_en timestamptz not null default now(),
  unique (empresa_id, periodo, operacion, tipo, folio, rut_contraparte)
);

create table public.f29_declaraciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  periodo char(6) not null check (periodo ~ '^\d{6}$'),
  lineas jsonb not null,
  iva_determinado numeric(18, 0) not null,
  remanente_siguiente numeric(18, 0) not null,
  total_pagar numeric(18, 0) not null,
  estado text not null default 'borrador' check (estado in ('borrador', 'presentado')),
  folio_sii text,
  creado_por uuid references auth.users (id) default auth.uid(),
  creado_en timestamptz not null default now(),
  unique (empresa_id, periodo)
);

-- ---------------------------------------------------------------------------
-- Auditoría: append-only con cadena de hashes (evidencia de manipulación)

create table public.auditoria (
  id bigint generated always as identity primary key,
  empresa_id uuid,
  tabla text not null,
  registro_id text,
  accion text not null,
  usuario_id uuid,
  ip text,
  antes jsonb,
  despues jsonb,
  en timestamptz not null default clock_timestamp(),
  hash_anterior text,
  hash text not null
);
create index on public.auditoria (empresa_id, en desc);
