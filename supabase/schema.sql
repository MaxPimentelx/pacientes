-- =====================================================================
-- Controle de Pacientes — estrutura do banco (Supabase / PostgreSQL)
-- Cole este script inteiro em: Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Cadastro do paciente (dados fixos + entrada)
create table if not exists public.pacientes (
  id              uuid primary key default gen_random_uuid(),
  nome            text not null,
  data_nascimento date,
  sexo            text check (sexo in ('F', 'M')),
  telefone        text,
  documento       text,
  data_entrada    date not null default current_date,
  motivo          text not null,
  observacoes     text,
  cids_entrada    text[] not null default '{}',  -- CID-10 na admissão (1º = principal)
  data_baixa      date,  -- preenchida = processo encerrado
  tipo_alta       text check (tipo_alta in ('Curado','Melhorado','A pedido','Evasão','Transferência','Óbito','Outro')),
  -- autoria (carimbada pelos triggers no fim deste arquivo)
  criado_em       timestamptz not null default now(),
  criado_por      uuid default auth.uid() references auth.users (id),
  criado_por_nome      text,
  criado_por_email     text,
  atualizado_em        timestamptz,
  atualizado_por       uuid references auth.users (id),
  atualizado_por_nome  text,
  atualizado_por_email text,
  constraint pacientes_baixa_apos_entrada check (data_baixa is null or data_baixa >= data_entrada),
  constraint pacientes_tipo_alta_com_baixa check (tipo_alta is null or data_baixa is not null)
);

-- Evoluções: cada atualização vira um novo registro com sua data
create table if not exists public.evolucoes (
  id           uuid primary key default gen_random_uuid(),
  paciente_id  uuid not null references public.pacientes (id) on delete cascade,
  data         date not null default current_date,
  status       text check (status in ('Estável','Melhorando','Piorando','Crítico','Alta')),
  descricao    text not null,
  cids         text[] not null default '{}',  -- CID-10 vigente nesta data (1º = principal)
  cids_tipos   jsonb not null default '{}'::jsonb,  -- secundários: {"E11.9":"comorbidade","N17.9":"complicacao"}
  procedimentos jsonb not null default '[]'::jsonb, -- [{"codigo":"...","descricao":"..."}]
  criado_em    timestamptz not null default now(),
  criado_por   uuid default auth.uid() references auth.users (id),
  criado_por_nome  text,
  criado_por_email text
);

create index if not exists evolucoes_paciente_data_idx
  on public.evolucoes (paciente_id, data desc);

-- ---------------------------------------------------------------------
-- Segurança: só usuários logados (criados por você no painel) acessam
-- ---------------------------------------------------------------------
alter table public.pacientes enable row level security;
alter table public.evolucoes enable row level security;

create policy "logados leem pacientes"      on public.pacientes for select to authenticated using (true);
create policy "logados cadastram pacientes" on public.pacientes for insert to authenticated with check (true);
create policy "logados editam pacientes"    on public.pacientes for update to authenticated using (true) with check (true);

create policy "logados leem evolucoes"      on public.evolucoes for select to authenticated using (true);
create policy "logados registram evolucoes" on public.evolucoes for insert to authenticated with check (true);
create policy "autor exclui sua evolucao"   on public.evolucoes for delete to authenticated using (criado_por = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Autoria: o banco grava quem cadastrou/alterou (o app não pode falsificar)
-- Nome = metadado "nome" do usuário no Supabase Auth; sem nome, o e-mail.
-- ---------------------------------------------------------------------
create or replace function public.carimbar_criacao()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_nome text; v_email text;
begin
  if auth.uid() is not null then
    select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
      into v_nome, v_email from auth.users u where u.id = auth.uid();
    new.criado_por := auth.uid(); new.criado_por_nome := v_nome;
    new.criado_por_email := v_email; new.criado_em := now();
  end if;
  return new;
end; $$;

create or replace function public.carimbar_alteracao_paciente()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_nome text; v_email text;
begin
  new.criado_por := old.criado_por; new.criado_por_nome := old.criado_por_nome;
  new.criado_por_email := old.criado_por_email; new.criado_em := old.criado_em;
  if auth.uid() is not null then
    select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
      into v_nome, v_email from auth.users u where u.id = auth.uid();
    new.atualizado_por := auth.uid(); new.atualizado_por_nome := v_nome;
    new.atualizado_por_email := v_email; new.atualizado_em := now();
  end if;
  return new;
end; $$;

create trigger pacientes_carimbar_criacao   before insert on public.pacientes for each row execute function public.carimbar_criacao();
create trigger pacientes_carimbar_alteracao before update on public.pacientes for each row execute function public.carimbar_alteracao_paciente();
create trigger evolucoes_carimbar_criacao   before insert on public.evolucoes for each row execute function public.carimbar_criacao();

revoke execute on function public.carimbar_criacao()            from public, anon, authenticated;
revoke execute on function public.carimbar_alteracao_paciente() from public, anon, authenticated;
