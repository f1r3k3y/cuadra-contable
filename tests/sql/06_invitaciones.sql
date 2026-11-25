-- Invitaciones por enlace.
\set QUIET on
\o /dev/null
create table t.tokens (k text primary key, v text);
grant all on t.tokens to public;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000011', 'Nuevo@Ejemplo.cl');
set role authenticated;

-- El administrador de e5 (carla) invita a un contador
select t.como('00000000-0000-0000-0000-00000000000c');
insert into t.tokens values ('t1', public.crear_invitacion((select v from t.ids where k = 'e5'), ' nuevo@ejemplo.cl ', 'contador'));
select t.afirmar((select count(*) from public.invitaciones where token_hash = (select v from t.tokens where k = 't1')) = 0, 'el token no se guarda en texto plano');
select t.afirmar((select estado from public.invitaciones where correo = 'nuevo@ejemplo.cl') = 'pendiente', 'invitación pendiente');

-- El asistente no puede invitar; agregar por correo ya no está disponible desde la API
select t.como('00000000-0000-0000-0000-00000000000a');
select t.debe_fallar($$select public.crear_invitacion((select v from t.ids where k = 'e5'), 'x@ejemplo.cl', 'admin')$$, 'Sin permiso');
select t.afirmar((select count(*) from public.invitaciones where correo = 'nuevo@ejemplo.cl') = 0, 'el asistente no ve las invitaciones');

-- Sin sesión se ve a qué empresa y rol invita
reset role;
set role anon;
select t.afirmar((public.ver_invitacion((select v from t.tokens where k = 't1')) ->> 'empresa') = 'Cinco SpA'
  and (public.ver_invitacion((select v from t.tokens where k = 't1')) ->> 'vigente')::boolean, 'ver invitación sin sesión');
select t.afirmar(public.ver_invitacion('token-que-no-existe-xxxxxxxx') is null, 'token inválido no muestra nada');
reset role;
set role authenticated;

-- Otra persona no puede usar el enlace
select t.como('00000000-0000-0000-0000-00000000000b');
select t.debe_fallar($$select public.aceptar_invitacion((select v from t.tokens where k = 't1'))$$, 'es para nuevo@ejemplo.cl');

-- La persona invitada acepta (el correo se compara sin mayúsculas) y queda con el rol
select t.como('00000000-0000-0000-0000-000000000011');
select t.afirmar(public.aceptar_invitacion((select v from t.tokens where k = 't1')) = (select v from t.ids where k = 'e5'), 'acepta la invitación');
select t.afirmar((select rol::text from public.miembros where user_id = '00000000-0000-0000-0000-000000000011' and empresa_id = (select v from t.ids where k = 'e5')) = 'contador', 'queda con el rol invitado');
select t.afirmar(public.aceptar_invitacion((select v from t.tokens where k = 't1')) = (select v from t.ids where k = 'e5'), 'aceptar dos veces no falla');

-- Revocada y vencida
select t.como('00000000-0000-0000-0000-00000000000c');
insert into t.tokens values ('t2', public.crear_invitacion((select v from t.ids where k = 'e5'), 'otro@ejemplo.cl', 'lector'));
select public.revocar_invitacion((select id from public.invitaciones where correo = 'otro@ejemplo.cl' and estado = 'pendiente'));
insert into t.tokens values ('t3', public.crear_invitacion((select v from t.ids where k = 'e5'), 'otro@ejemplo.cl', 'lector'));
select t.afirmar((select count(*) from public.invitaciones where correo = 'otro@ejemplo.cl' and estado = 'revocada') = 1
  and (select count(*) from public.invitaciones where correo = 'otro@ejemplo.cl' and estado = 'pendiente') = 1, 'una sola invitación pendiente por correo');
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000012', 'otro@ejemplo.cl');
update public.invitaciones set expira_en = now() - interval '1 minute' where correo = 'otro@ejemplo.cl' and estado = 'pendiente';
set role authenticated;
select t.como('00000000-0000-0000-0000-000000000012');
select t.debe_fallar($$select public.aceptar_invitacion((select v from t.tokens where k = 't2'))$$, 'ya no está disponible');
select t.debe_fallar($$select public.aceptar_invitacion((select v from t.tokens where k = 't3'))$$, 'venció');

reset role;
\o
\echo 'PRUEBAS DE INVITACIONES PASARON'
