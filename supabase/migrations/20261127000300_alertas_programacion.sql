-- Envío diario de alertas: pg_cron llama a la función Edge "alertas" a las 11:30 UTC (8:30 en verano / 7:30 en invierno, Chile).
-- Se omite en bases sin pg_cron (pruebas locales).
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.schedule('cuadra-alertas-diarias', '30 11 * * *', $$
      select net.http_post(
        url := 'https://owojgfjhkxydlhnnqnee.supabase.co/functions/v1/alertas',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 60000)
    $$);
  end if;
end $do$;
