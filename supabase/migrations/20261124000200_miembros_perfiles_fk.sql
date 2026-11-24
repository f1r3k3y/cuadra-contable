insert into public.perfiles (id, nombre) select u.id, split_part(u.email, '@', 1) from auth.users u on conflict do nothing;
alter table public.miembros add constraint miembros_perfil_fk foreign key (user_id) references public.perfiles(id) on delete cascade;
