#!/usr/bin/env bash
# Crea una base efímera, aplica stubs + migraciones y corre las pruebas SQL.
set -euo pipefail
# Las fechas de las pruebas (current_date) deben ser las de Chile, igual que la app.
export PGTZ=America/Santiago
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DB=cuadra_test
PSQL="psql -v ON_ERROR_STOP=1 -q -X"
$PSQL -d postgres -c "drop database if exists $DB" -c "create database $DB"
for r in anon authenticated service_role; do $PSQL -d postgres -c "do \$\$begin if not exists (select from pg_roles where rolname='$r') then execute 'create role $r nologin'; end if; end\$\$" ; done
sed '/^create role/d' "$DIR/tests/sql/00_stubs_supabase.sql" | $PSQL -d $DB
$PSQL -d $DB -c "alter role service_role bypassrls"
for f in "$DIR"/supabase/migrations/*.sql; do echo "== $(basename "$f")"; $PSQL -d $DB -f "$f"; done
$PSQL -d $DB -c "grant select, insert, update, delete on all tables in schema public to authenticated, service_role; grant usage, select on all sequences in schema public to authenticated, service_role; grant execute on all functions in schema public to authenticated, service_role; revoke all on public.secretos from authenticated; revoke execute on function public.reservar_folio(uuid,int) from authenticated; revoke execute on function public.crear_asiento_sistema(uuid,date,text,jsonb,text,uuid,public.tipo_comprobante,boolean) from authenticated; revoke insert, update, delete on public.auditoria from authenticated;"
echo "== pruebas"
$PSQL -d $DB -f "$DIR/tests/sql/01_pruebas.sql"
$PSQL -d $DB -f "$DIR/tests/sql/02_documentos.sql"
$PSQL -d $DB -f "$DIR/tests/sql/03_roles.sql"
$PSQL -d $DB -f "$DIR/tests/sql/04_fase3.sql"
$PSQL -d $DB -f "$DIR/tests/sql/05_correcciones.sql"
$PSQL -d $DB -f "$DIR/tests/sql/06_invitaciones.sql"
$PSQL -d $DB -f "$DIR/tests/sql/07_honorarios_remuneraciones_conciliacion_rcv.sql"
$PSQL -d $DB -f "$DIR/tests/sql/08_mejoras_procesos.sql"
$PSQL -d $DB -f "$DIR/tests/sql/09_activo_fijo_cartera_reglas.sql"
