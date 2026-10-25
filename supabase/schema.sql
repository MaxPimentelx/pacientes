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
  criado_em       timestamptz not null default now(),
  criado_por      uuid default auth.uid() references auth.users (id),
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
  criado_por   uuid default auth.uid() references auth.users (id)
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
create policy "logados excluem evolucoes"   on public.evolucoes for delete to authenticated using (true);
