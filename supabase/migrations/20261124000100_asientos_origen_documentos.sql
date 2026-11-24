alter table public.asientos drop constraint asientos_origen_check;
alter table public.asientos add constraint asientos_origen_check check (origen = any (array['manual','dte_emitido','dte_recibido','documento_venta','documento_compra','f29','cierre','apertura','reverso','importacion']));
