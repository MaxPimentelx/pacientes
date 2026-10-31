-- =====================================================================
-- Migração 05 — Anulação de evoluções e trilha de auditoria
--   * Registro clínico não se apaga: evolução passa a ser ANULADA com
--     justificativa (somente pelo autor), continuando visível.
--   * Tabela "auditoria": toda criação, alteração e anulação, com o que
--     mudou (de → para), quem e quando. Só o banco escreve nela.
-- =====================================================================

-- 1) Anulação de evolução --------------------------------------------
alter table public.evolucoes
  add column if not exists anulada_em        timestamptz,
  add column if not exists anulada_por       uuid references auth.users (id),
  add column if not exists anulada_por_nome  text,
  add column if not exists anulada_por_email text,
  add column if not exists motivo_anulacao   text;

-- nada se apaga: remove qualquer permissão de exclusão de evolução
drop policy if exists "autor exclui sua evolucao" on public.evolucoes;
drop policy if exists "logados excluem evolucoes" on public.evolucoes;

create or replace function public.anular_evolucao(p_id uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_autor  uuid;
  v_anulada timestamptz;
  v_nome   text;
  v_email  text;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado.';
  end if;
  if coalesce(length(trim(p_motivo)), 0) < 10 then
    raise exception 'Informe a justificativa da anulação (mínimo de 10 caracteres).';
  end if;

  select criado_por, anulada_em into v_autor, v_anulada
    from public.evolucoes where id = p_id for update;
  if not found then
    raise exception 'Evolução não encontrada.';
  end if;
  if v_anulada is not null then
    raise exception 'Esta evolução já foi anulada.';
  end if;
  if v_autor is distinct from auth.uid() then
    raise exception 'Somente quem registrou a evolução pode anulá-la.';
  end if;

  select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
    into v_nome, v_email from auth.users u where u.id = auth.uid();

  update public.evolucoes
     set anulada_em = now(), anulada_por = auth.uid(),
         anulada_por_nome = v_nome, anulada_por_email = v_email,
         motivo_anulacao = trim(p_motivo)
   where id = p_id;
end;
$$;

revoke execute on function public.anular_evolucao(uuid, text) from public, anon;
grant  execute on function public.anular_evolucao(uuid, text) to authenticated;

-- 2) Trilha de auditoria ----------------------------------------------
create table if not exists public.auditoria (
  id            bigint generated always as identity primary key,
  ocorrido_em   timestamptz not null default now(),
  tabela        text not null,
  registro_id   uuid not null,
  paciente_id   uuid not null,
  acao          text not null check (acao in ('cadastro', 'alteracao', 'anulacao')),
  usuario_id    uuid,
  usuario_nome  text,
  usuario_email text,
  alteracoes    jsonb not null default '{}'::jsonb   -- { campo: { "de": ..., "para": ... } }
);

create index if not exists auditoria_paciente_idx on public.auditoria (paciente_id, ocorrido_em desc);

alter table public.auditoria enable row level security;
drop policy if exists "logados leem auditoria" on public.auditoria;
create policy "logados leem auditoria" on public.auditoria
  for select to authenticated using (true);
-- sem políticas de insert/update/delete: só o trigger abaixo grava

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
    'id', 'paciente_id',
    'criado_em', 'criado_por', 'criado_por_nome', 'criado_por_email',
    'atualizado_em', 'atualizado_por', 'atualizado_por_nome', 'atualizado_por_email',
    'anulada_por', 'anulada_por_nome', 'anulada_por_email'];
begin
  select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
    into v_nome, v_email from auth.users u where u.id = auth.uid();

  if tg_op = 'INSERT' then
    v_acao := 'cadastro';
    if tg_table_name = 'pacientes' then
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
      return null; -- nada relevante mudou
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

revoke execute on function public.registrar_auditoria() from public, anon, authenticated;

drop trigger if exists pacientes_auditoria on public.pacientes;
create trigger pacientes_auditoria
  after insert or update on public.pacientes
  for each row execute function public.registrar_auditoria();

drop trigger if exists evolucoes_auditoria on public.evolucoes;
create trigger evolucoes_auditoria
  after insert or update on public.evolucoes
  for each row execute function public.registrar_auditoria();

-- 3) Registros que já existiam entram na trilha como "cadastro" ---------
insert into public.auditoria (ocorrido_em, tabela, registro_id, paciente_id, acao, usuario_id, usuario_nome, usuario_email)
select p.criado_em, 'pacientes', p.id, p.id, 'cadastro', p.criado_por, p.criado_por_nome, p.criado_por_email
  from public.pacientes p
 where not exists (select 1 from public.auditoria a where a.registro_id = p.id and a.acao = 'cadastro');

insert into public.auditoria (ocorrido_em, tabela, registro_id, paciente_id, acao, usuario_id, usuario_nome, usuario_email)
select e.criado_em, 'evolucoes', e.id, e.paciente_id, 'cadastro', e.criado_por, e.criado_por_nome, e.criado_por_email
  from public.evolucoes e
 where not exists (select 1 from public.auditoria a where a.registro_id = e.id and a.acao = 'cadastro');
