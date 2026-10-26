-- =====================================================================
-- Migração 04 — Autoria dos registros
--   Quem cadastrou / alterou o paciente e quem registrou cada evolução.
--   Os dados são carimbados por TRIGGER no banco (o app não consegue
--   falsificar o autor). O nome vem do metadado "nome" do usuário no
--   Supabase Auth; sem nome, usa o e-mail.
-- Rode SOMENTE se você já tinha executado o schema.sql antes desta versão.
-- =====================================================================

-- 1) Colunas (nome/e-mail ficam gravados como "foto" do momento do registro)
alter table public.pacientes
  add column if not exists criado_por_nome      text,
  add column if not exists criado_por_email     text,
  add column if not exists atualizado_em        timestamptz,
  add column if not exists atualizado_por       uuid references auth.users (id),
  add column if not exists atualizado_por_nome  text,
  add column if not exists atualizado_por_email text;

alter table public.evolucoes
  add column if not exists criado_por_nome  text,
  add column if not exists criado_por_email text;

-- 2) Preenche a autoria dos registros que já existiam (antes dos triggers)
update public.pacientes p
   set criado_por_nome  = coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email),
       criado_por_email = u.email
  from auth.users u
 where u.id = p.criado_por and p.criado_por_email is null;

update public.evolucoes e
   set criado_por_nome  = coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email),
       criado_por_email = u.email
  from auth.users u
 where u.id = e.criado_por and e.criado_por_email is null;

-- 3) Triggers de carimbo
create or replace function public.carimbar_criacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nome  text;
  v_email text;
begin
  if auth.uid() is not null then
    select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
      into v_nome, v_email
      from auth.users u
     where u.id = auth.uid();
    new.criado_por       := auth.uid();
    new.criado_por_nome  := v_nome;
    new.criado_por_email := v_email;
    new.criado_em        := now();
  end if;
  return new;
end;
$$;

create or replace function public.carimbar_alteracao_paciente()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nome  text;
  v_email text;
begin
  -- a autoria da criação nunca muda
  new.criado_por       := old.criado_por;
  new.criado_por_nome  := old.criado_por_nome;
  new.criado_por_email := old.criado_por_email;
  new.criado_em        := old.criado_em;

  if auth.uid() is not null then
    select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
      into v_nome, v_email
      from auth.users u
     where u.id = auth.uid();
    new.atualizado_por       := auth.uid();
    new.atualizado_por_nome  := v_nome;
    new.atualizado_por_email := v_email;
    new.atualizado_em        := now();
  end if;
  return new;
end;
$$;

drop trigger if exists pacientes_carimbar_criacao on public.pacientes;
create trigger pacientes_carimbar_criacao
  before insert on public.pacientes
  for each row execute function public.carimbar_criacao();

drop trigger if exists pacientes_carimbar_alteracao on public.pacientes;
create trigger pacientes_carimbar_alteracao
  before update on public.pacientes
  for each row execute function public.carimbar_alteracao_paciente();

drop trigger if exists evolucoes_carimbar_criacao on public.evolucoes;
create trigger evolucoes_carimbar_criacao
  before insert on public.evolucoes
  for each row execute function public.carimbar_criacao();

-- Funções de trigger não devem ser chamáveis pela API
revoke execute on function public.carimbar_criacao()            from public, anon, authenticated;
revoke execute on function public.carimbar_alteracao_paciente() from public, anon, authenticated;

-- 4) Só quem registrou a evolução pode excluí-la
drop policy if exists "logados excluem evolucoes" on public.evolucoes;
drop policy if exists "autor exclui sua evolucao" on public.evolucoes;
create policy "autor exclui sua evolucao" on public.evolucoes
  for delete to authenticated
  using (criado_por = (select auth.uid()));
