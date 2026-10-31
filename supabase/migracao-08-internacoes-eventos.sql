-- =====================================================================
-- Migração 08 — Internações (episódios), tipo de registro, setores,
--                previsão de alta e pendências
--
--   * paciente = a PESSOA (nome, nascimento, sexo, documento, telefone)
--   * internacoes = cada EPISÓDIO (entrada, motivo, CIDs, setor, alta...)
--     - só uma internação aberta por paciente
--     - setor/leito atual, previsão, pendências e alta são CALCULADOS
--       pelo banco a partir das evoluções válidas (não anuladas)
--   * evolucoes ganham "tipo": rotina | setor | intercorrencia |
--     procedimento | alta. A ALTA acontece por evolução e encerra a
--     internação; anular a evolução de alta reabre a internação.
--   * setores: lista padrão editável por administradores
--     (papel "admin" em app_metadata do usuário no Supabase Auth)
--
--   Estratégia "expandir/contrair": as colunas antigas de episódio em
--   "pacientes" permanecem (não são mais usadas) e serão removidas numa
--   migração futura, depois que o app novo estiver em produção.
-- =====================================================================

-- 0) Auditoria: ignora colunas técnicas/derivadas (evita ruído) ---------
create or replace function public.registrar_auditoria()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nome    text;
  v_email   text;
  v_antes   jsonb;
  v_depois  jsonb := to_jsonb(new);
  v_diff    jsonb := '{}'::jsonb;
  v_acao    text;
  v_ignorar text[] := array[
    'id', 'paciente_id', 'internacao_id',
    'criado_em', 'criado_por', 'criado_por_nome', 'criado_por_email',
    'atualizado_em', 'atualizado_por', 'atualizado_por_nome', 'atualizado_por_email',
    'anulada_por', 'anulada_por_nome', 'anulada_por_email',
    -- derivados das evoluções (a evolução que os causou já é auditada)
    'setor_atual', 'leito_atual', 'previsao_alta', 'pendencias_alta', 'data_baixa', 'tipo_alta'];
begin
  select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
    into v_nome, v_email from auth.users u where u.id = auth.uid();

  if tg_op = 'INSERT' then
    v_acao := 'cadastro';
    if tg_table_name in ('pacientes', 'internacoes') then
      select coalesce(jsonb_object_agg(k, jsonb_build_object('para', v)), '{}'::jsonb) into v_diff
        from jsonb_each(v_depois) as e(k, v)
       where k <> all (v_ignorar)
         and v not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb);
    end if;
  else
    v_antes := to_jsonb(old);
    v_acao := case
      when tg_table_name = 'evolucoes'
       and (v_antes->>'anulada_em') is null and (v_depois->>'anulada_em') is not null
      then 'anulacao' else 'alteracao' end;
    select coalesce(jsonb_object_agg(k, jsonb_build_object('de', v_antes->k, 'para', v)), '{}'::jsonb) into v_diff
      from jsonb_each(v_depois) as e(k, v)
     where k <> all (v_ignorar)
       and (v_antes->k) is distinct from v;
    if v_diff = '{}'::jsonb then
      return null;
    end if;
  end if;

  insert into public.auditoria
    (tabela, registro_id, paciente_id, acao, usuario_id, usuario_nome, usuario_email, alteracoes)
  values
    (tg_table_name,
     (v_depois->>'id')::uuid,
     case when tg_table_name = 'pacientes' then (v_depois->>'id')::uuid
          else (v_depois->>'paciente_id')::uuid end,
     v_acao, auth.uid(), v_nome, v_email, v_diff);
  return null;
end;
$$;

-- 1) Setores -------------------------------------------------------------
create table if not exists public.setores (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null unique check (length(trim(nome)) between 2 and 60),
  ordem     int  not null default 100,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);

insert into public.setores (nome, ordem) values
  ('Pronto-socorro', 10), ('Observação', 20), ('Enfermaria', 30), ('Apartamento', 40),
  ('Semi-intensiva', 50), ('UTI adulto', 60), ('Centro cirúrgico', 70), ('Hemodinâmica', 80)
on conflict (nome) do nothing;

alter table public.setores enable row level security;
drop policy if exists "logados leem setores" on public.setores;
create policy "logados leem setores" on public.setores for select to authenticated using (true);
drop policy if exists "admin cadastra setores" on public.setores;
create policy "admin cadastra setores" on public.setores for insert to authenticated
  with check ((select auth.jwt()->'app_metadata'->>'papel') = 'admin');
drop policy if exists "admin edita setores" on public.setores;
create policy "admin edita setores" on public.setores for update to authenticated
  using ((select auth.jwt()->'app_metadata'->>'papel') = 'admin')
  with check ((select auth.jwt()->'app_metadata'->>'papel') = 'admin');
drop policy if exists "exige 2 etapas" on public.setores;
create policy "exige 2 etapas" on public.setores as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2') with check ((select auth.jwt()->>'aal') = 'aal2');

-- 2) Internações -----------------------------------------------------------
create table if not exists public.internacoes (
  id                    uuid primary key default gen_random_uuid(),
  paciente_id           uuid not null references public.pacientes (id),
  data_entrada          date not null default current_date,
  motivo                text not null,
  cids_entrada          text[] not null default '{}',
  setor_entrada         text,
  leito_entrada         text,
  previsao_alta_inicial date,
  -- calculados pelo banco a partir das evoluções válidas
  setor_atual           text,
  leito_atual           text,
  previsao_alta         date,
  pendencias_alta       text[] not null default '{}',
  data_baixa            date,
  tipo_alta             text check (tipo_alta in ('Curado','Melhorado','A pedido','Evasão','Transferência','Óbito','Outro')),
  -- autoria
  criado_em             timestamptz not null default now(),
  criado_por            uuid default auth.uid() references auth.users (id),
  criado_por_nome       text,
  criado_por_email      text,
  atualizado_em         timestamptz,
  atualizado_por        uuid references auth.users (id),
  atualizado_por_nome   text,
  atualizado_por_email  text,
  constraint internacoes_baixa_apos_entrada    check (data_baixa is null or data_baixa >= data_entrada),
  constraint internacoes_previsao_apos_entrada check (previsao_alta_inicial is null or previsao_alta_inicial >= data_entrada)
);

create index if not exists internacoes_paciente_idx on public.internacoes (paciente_id, data_entrada desc);
create unique index if not exists internacoes_uma_aberta_por_paciente
  on public.internacoes (paciente_id) where data_baixa is null;

alter table public.internacoes enable row level security;
drop policy if exists "logados leem internacoes" on public.internacoes;
create policy "logados leem internacoes" on public.internacoes for select to authenticated using (true);
drop policy if exists "logados abrem internacoes" on public.internacoes;
create policy "logados abrem internacoes" on public.internacoes for insert to authenticated with check (true);
drop policy if exists "logados editam internacoes" on public.internacoes;
create policy "logados editam internacoes" on public.internacoes for update to authenticated using (true) with check (true);
drop policy if exists "exige 2 etapas" on public.internacoes;
create policy "exige 2 etapas" on public.internacoes as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2') with check ((select auth.jwt()->>'aal') = 'aal2');

-- 3) Evoluções: internação e tipo de registro -------------------------------
alter table public.evolucoes
  add column if not exists internacao_id   uuid references public.internacoes (id),
  add column if not exists tipo            text not null default 'rotina',
  add column if not exists setor           text,
  add column if not exists leito           text,
  add column if not exists intercorrencia  text,
  add column if not exists tipo_alta       text,
  add column if not exists previsao_alta   date,
  add column if not exists pendencias_alta text[];

alter table public.evolucoes drop constraint if exists evolucoes_tipo_valido;
alter table public.evolucoes add constraint evolucoes_tipo_valido
  check (tipo in ('rotina', 'setor', 'intercorrencia', 'procedimento', 'alta'));
alter table public.evolucoes drop constraint if exists evolucoes_intercorrencia_valida;
alter table public.evolucoes add constraint evolucoes_intercorrencia_valida
  check (intercorrencia is null or intercorrencia in
    ('Queda','Piora clínica','Reação adversa a medicamento','Infecção relacionada à assistência','Lesão por pressão','Erro de medicação','Outra'));
alter table public.evolucoes drop constraint if exists evolucoes_tipo_alta_valido;
alter table public.evolucoes add constraint evolucoes_tipo_alta_valido
  check (tipo_alta is null or tipo_alta in ('Curado','Melhorado','A pedido','Evasão','Transferência','Óbito','Outro'));
alter table public.evolucoes drop constraint if exists evolucoes_tipo_coerente;
alter table public.evolucoes add constraint evolucoes_tipo_coerente check (
      (tipo <> 'setor' or setor is not null)
  and (tipo <> 'intercorrencia' or intercorrencia is not null)
  and (tipo <> 'alta' or tipo_alta is not null));

create index if not exists evolucoes_internacao_idx on public.evolucoes (internacao_id, data desc);

-- 4) Dados existentes: cada paciente vira uma internação --------------------
insert into public.internacoes
  (paciente_id, data_entrada, motivo, cids_entrada, data_baixa, tipo_alta,
   criado_em, criado_por, criado_por_nome, criado_por_email,
   atualizado_em, atualizado_por, atualizado_por_nome, atualizado_por_email)
select p.id, p.data_entrada, coalesce(p.motivo, '(não informado)'), coalesce(p.cids_entrada, '{}'),
       p.data_baixa, case when p.data_baixa is not null then coalesce(p.tipo_alta, 'Outro') end,
       p.criado_em, p.criado_por, p.criado_por_nome, p.criado_por_email,
       p.atualizado_em, p.atualizado_por, p.atualizado_por_nome, p.atualizado_por_email
  from public.pacientes p
 where not exists (select 1 from public.internacoes i where i.paciente_id = p.id);

update public.evolucoes e
   set internacao_id = i.id
  from public.internacoes i
 where i.paciente_id = e.paciente_id and e.internacao_id is null;

-- baixas antigas viram uma evolução de ALTA, claramente identificada
insert into public.evolucoes
  (internacao_id, paciente_id, data, tipo, tipo_alta, descricao,
   criado_em, criado_por, criado_por_nome, criado_por_email)
select i.id, i.paciente_id, i.data_baixa, 'alta', i.tipo_alta,
       'Alta registrada no cadastro antes da reorganização em internações (registro migrado automaticamente).',
       coalesce(i.atualizado_em, i.criado_em),
       coalesce(i.atualizado_por, i.criado_por),
       coalesce(i.atualizado_por_nome, i.criado_por_nome),
       coalesce(i.atualizado_por_email, i.criado_por_email)
  from public.internacoes i
 where i.data_baixa is not null
   and not exists (select 1 from public.evolucoes e where e.internacao_id = i.id and e.tipo = 'alta');

alter table public.evolucoes alter column internacao_id set not null;

-- colunas de episódio em "pacientes" deixam de ser obrigatórias (serão removidas depois)
alter table public.pacientes alter column motivo drop not null;

-- 5) Regras e cálculos ------------------------------------------------------
-- 5a) evolução: vincula à internação, valida e limpa campos que não são do tipo
create or replace function public.validar_evolucao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paciente uuid;
  v_entrada  date;
  v_baixa    date;
begin
  -- compatibilidade: versão antiga do app envia só paciente_id
  if new.internacao_id is null then
    select id into new.internacao_id from public.internacoes
     where paciente_id = new.paciente_id and data_baixa is null;
  end if;

  select paciente_id, data_entrada, data_baixa into v_paciente, v_entrada, v_baixa
    from public.internacoes where id = new.internacao_id;
  if not found then
    raise exception 'Internação não encontrada.';
  end if;
  new.paciente_id := v_paciente;

  if auth.uid() is not null then
    if v_baixa is not null then
      raise exception 'Esta internação já foi encerrada (alta em %). Para registrar, abra uma nova internação.', to_char(v_baixa, 'DD/MM/YYYY');
    end if;
    if new.data < v_entrada then
      raise exception 'A data da evolução não pode ser anterior à entrada (%).', to_char(v_entrada, 'DD/MM/YYYY');
    end if;
    if new.data > (now() at time zone 'America/Sao_Paulo')::date then
      raise exception 'A data da evolução não pode ser futura.';
    end if;
    if new.tipo = 'setor' and coalesce(trim(new.setor), '') = '' then
      raise exception 'Informe o setor para a mudança de setor/leito.';
    end if;
    if new.tipo = 'intercorrencia' and new.intercorrencia is null then
      raise exception 'Informe o tipo de intercorrência.';
    end if;
    if new.tipo = 'alta' and new.tipo_alta is null then
      raise exception 'Informe o tipo de alta.';
    end if;
    if new.previsao_alta is not null and new.previsao_alta < v_entrada then
      raise exception 'A previsão de alta não pode ser anterior à entrada.';
    end if;
  end if;

  if new.tipo <> 'setor' then new.setor := null; new.leito := null; end if;
  if new.tipo <> 'intercorrencia' then new.intercorrencia := null; end if;
  if new.tipo <> 'alta' then new.tipo_alta := null; end if;
  if new.tipo = 'alta' then new.previsao_alta := null; new.pendencias_alta := null; end if;
  return new;
end;
$$;

-- 5b) internação: calcula setor/leito atual, previsão, pendências e alta
create or replace function public.derivar_internacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_data  date;
  v_tipo  text;
  v_setor text;
  v_leito text;
  v_prev  date;
  v_pend  text[];
begin
  if tg_op = 'INSERT' then
    -- internação nova começa aberta; a alta só acontece por evolução
    new.setor_atual     := new.setor_entrada;
    new.leito_atual     := new.leito_entrada;
    new.previsao_alta   := new.previsao_alta_inicial;
    new.pendencias_alta := '{}';
    if auth.uid() is not null then
      new.data_baixa := null;
      new.tipo_alta  := null;
    end if;
    return new;
  end if;

  select e.data, e.tipo_alta into v_data, v_tipo
    from public.evolucoes e
   where e.internacao_id = new.id and e.anulada_em is null and e.tipo = 'alta'
   order by e.data desc, e.criado_em desc limit 1;
  new.data_baixa := v_data;
  new.tipo_alta  := v_tipo;

  select e.setor, e.leito into v_setor, v_leito
    from public.evolucoes e
   where e.internacao_id = new.id and e.anulada_em is null and e.tipo = 'setor'
   order by e.data desc, e.criado_em desc limit 1;
  if found then
    new.setor_atual := v_setor; new.leito_atual := v_leito;
  else
    new.setor_atual := new.setor_entrada; new.leito_atual := new.leito_entrada;
  end if;

  select e.previsao_alta into v_prev
    from public.evolucoes e
   where e.internacao_id = new.id and e.anulada_em is null and e.previsao_alta is not null
   order by e.data desc, e.criado_em desc limit 1;
  new.previsao_alta := case when found then v_prev else new.previsao_alta_inicial end;

  select e.pendencias_alta into v_pend
    from public.evolucoes e
   where e.internacao_id = new.id and e.anulada_em is null and e.pendencias_alta is not null
   order by e.data desc, e.criado_em desc limit 1;
  new.pendencias_alta := coalesce(v_pend, '{}');

  -- reabrir (anulação da alta) não pode deixar duas internações abertas
  if new.data_baixa is null and old.data_baixa is not null and exists (
       select 1 from public.internacoes o
        where o.paciente_id = new.paciente_id and o.id <> new.id and o.data_baixa is null) then
    raise exception 'Não é possível desfazer esta alta: o paciente já tem outra internação aberta.';
  end if;
  return new;
end;
$$;

-- 5c) evolução gravada/anulada: recalcula a internação
create or replace function public.recalcular_internacao_da_evolucao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.internacoes set atualizado_em = atualizado_em where id = new.internacao_id;
  return null;
end;
$$;

-- 5d) cadastro atômico: pessoa + primeira internação (respeita RLS: invoker)
create or replace function public.cadastrar_paciente(p_paciente jsonb, p_internacao jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.pacientes (nome, data_nascimento, sexo, telefone, documento, observacoes)
  values (trim(p_paciente->>'nome'),
          nullif(p_paciente->>'data_nascimento', '')::date,
          nullif(p_paciente->>'sexo', ''),
          nullif(trim(p_paciente->>'telefone'), ''),
          nullif(trim(p_paciente->>'documento'), ''),
          nullif(trim(p_paciente->>'observacoes'), ''))
  returning id into v_id;

  insert into public.internacoes
    (paciente_id, data_entrada, motivo, cids_entrada, setor_entrada, leito_entrada, previsao_alta_inicial)
  values (v_id,
          coalesce(nullif(p_internacao->>'data_entrada', '')::date, current_date),
          trim(p_internacao->>'motivo'),
          coalesce(array(select jsonb_array_elements_text(p_internacao->'cids_entrada')), '{}'),
          nullif(p_internacao->>'setor_entrada', ''),
          nullif(trim(p_internacao->>'leito_entrada'), ''),
          nullif(p_internacao->>'previsao_alta_inicial', '')::date);
  return v_id;
end;
$$;

revoke execute on function public.cadastrar_paciente(jsonb, jsonb) from public, anon;
grant  execute on function public.cadastrar_paciente(jsonb, jsonb) to authenticated;

revoke execute on function public.validar_evolucao()                  from public, anon, authenticated;
revoke execute on function public.derivar_internacao()                from public, anon, authenticated;
revoke execute on function public.recalcular_internacao_da_evolucao() from public, anon, authenticated;

-- 6) Triggers ---------------------------------------------------------------
drop trigger if exists internacoes_carimbar_criacao on public.internacoes;
create trigger internacoes_carimbar_criacao before insert on public.internacoes
  for each row execute function public.carimbar_criacao();
drop trigger if exists internacoes_carimbar_alteracao on public.internacoes;
create trigger internacoes_carimbar_alteracao before update on public.internacoes
  for each row execute function public.carimbar_alteracao_paciente();
drop trigger if exists internacoes_derivar on public.internacoes;
create trigger internacoes_derivar before insert or update on public.internacoes
  for each row execute function public.derivar_internacao();
drop trigger if exists internacoes_auditoria on public.internacoes;
create trigger internacoes_auditoria after insert or update on public.internacoes
  for each row execute function public.registrar_auditoria();

drop trigger if exists evolucoes_validar on public.evolucoes;
create trigger evolucoes_validar before insert on public.evolucoes
  for each row execute function public.validar_evolucao();
drop trigger if exists evolucoes_recalcular_internacao on public.evolucoes;
create trigger evolucoes_recalcular_internacao after insert or update on public.evolucoes
  for each row execute function public.recalcular_internacao_da_evolucao();

-- 7) Recalcula as internações migradas
update public.internacoes set atualizado_em = atualizado_em;
