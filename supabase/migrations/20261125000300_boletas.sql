-- Boletas: en compras su IVA no da derecho a crédito fiscal (va al gasto).
create or replace function app._reemplazar(p_fn regprocedure, p_de text, p_a text) returns void
language plpgsql set search_path to '' as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_de in d) = 0 then raise exception 'No se encontró el texto a reemplazar en %', p_fn; end if;
  execute replace(d, p_de, p_a);
end $$;

select app._reemplazar('public.registrar_documento(uuid,text,integer,bigint,date,text,text,numeric,numeric,numeric,uuid,text,uuid,date)',
  $x$  if coalesce(p_iva_no_recuperable, 0) > v_iva then raise exception 'El IVA no recuperable supera el IVA del documento'; end if;$x$,
  $x$  if coalesce(p_iva_no_recuperable, 0) > v_iva then raise exception 'El IVA no recuperable supera el IVA del documento'; end if;
  -- Una boleta recibida no da derecho a crédito fiscal: todo su IVA va al gasto
  if p_operacion = 'compra' and p_tipo = 39 then p_iva_no_recuperable := v_iva; end if;$x$);
drop function app._reemplazar(regprocedure, text, text);
