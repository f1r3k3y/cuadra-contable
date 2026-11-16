-- Simula lo mínimo de Supabase para probar las migraciones en un Postgres local.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema extensions;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
grant usage on schema auth, extensions, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
