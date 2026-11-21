-- =====================================================================
-- Migração 10 — Anexos do paciente (PDF e fotos)
--   * Arquivos ficam no Storage, na área PRIVADA "anexos"
--     (caminho <paciente_id>/<id>.<ext>), até 10 MB, só PDF/JPG/PNG.
--   * Tabela "anexos": quem enviou, quando, nome, formato, tamanho.
--     Formato e tamanho vêm do próprio Storage (o app não consegue mentir).
--   * Nada se apaga: anexo errado é ANULADO com justificativa (qualquer
--     usuário), e continua no histórico. Arquivos nunca são substituídos.
--   * O app NÃO lê o Storage diretamente: para abrir, a função de servidor
--     "anexos" confere a permissão, registra quem abriu (auditoria, ação
--     "acesso") e devolve um link temporário.
--   * Mesmas exigências do resto do banco: 2 etapas (aal2) e usuário ativo.
-- =====================================================================

-- 1) Área de arquivos ---------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('anexos', 'anexos', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- envio: só para a pasta de um paciente existente; sem leitura, troca ou exclusão
drop policy if exists "anexos: envio pelo app" on storage.objects;
create policy "anexos: envio pelo app" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'anexos'
    and (select auth.jwt() ->> 'aal') = 'aal2'
    and (select public.usuario_ativo())
    and exists (select 1 from public.pacientes p where p.id::text = (storage.foldername(name))[1])
  );

-- 2) Tabela de anexos ---------------------------------------------------
create table if not exists public.anexos (
  id                uuid primary key default gen_random_uuid(),
  paciente_id       uuid not null references public.pacientes (id),
  caminho           text not null unique,
  nome_arquivo      text not null check (length(trim(nome_arquivo)) between 1 and 200),
  formato           text not null check (formato in ('application/pdf', 'image/jpeg', 'image/png')),
  tamanho           integer not null check (tamanho > 0 and tamanho <= 10485760),
  observacao        text check (observacao is null or length(observacao) <= 300),
  criado_em         timestamptz not null default now(),
  criado_por        uuid references auth.users (id),
  criado_por_nome   text,
  criado_por_email  text,
  anulada_em        timestamptz,
  anulada_por       uuid references auth.users (id),
  anulada_por_nome  text,
  anulada_por_email text,
  motivo_anulacao   text,
  constraint anexos_caminho_do_paciente check (caminho like paciente_id::text || '/%')
);

create index if not exists anexos_paciente_idx on public.anexos (paciente_id, criado_em desc);

alter table public.anexos enable row level security;

drop policy if exists "logados leem anexos" on public.anexos;
create policy "logados leem anexos" on public.anexos
  for select to authenticated using (true);

drop policy if exists "logados registram anexos" on public.anexos;
create policy "logados registram anexos" on public.anexos
  for insert to authenticated with check (true);

drop policy if exists "logados anulam anexos" on public.anexos;
create policy "logados anulam anexos" on public.anexos
  for update to authenticated
  using (anulada_em is null) with check (true);
-- sem política de DELETE: anexo não se apaga

drop policy if exists "exige 2 etapas" on public.anexos;
create policy "exige 2 etapas" on public.anexos as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "exige usuario ativo" on public.anexos;
create policy "exige usuario ativo" on public.anexos as restrictive for all to authenticated
  using ((select public.usuario_ativo()))
  with check ((select public.usuario_ativo()));

-- 3) Validação do registro: o arquivo precisa existir e ser de quem envia --
create or replace function public.validar_anexo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dono    text;
  v_meta    jsonb;
begin
  select o.owner_id, o.metadata into v_dono, v_meta
    from storage.objects o
   where o.bucket_id = 'anexos' and o.name = new.caminho;
  if not found then
    raise exception 'Arquivo do anexo não encontrado. Envie o arquivo de novo.';
  end if;
  if auth.uid() is not null and v_dono is distinct from auth.uid()::text then
    raise exception 'O arquivo do anexo não foi enviado por este usuário.';
  end if;

  -- formato e tamanho reais (do Storage), nunca os informados pelo app
  new.formato  := v_meta ->> 'mimetype';
  new.tamanho  := (v_meta ->> 'size')::integer;
  new.nome_arquivo := trim(new.nome_arquivo);
  new.observacao   := nullif(trim(coalesce(new.observacao, '')), '');
  -- anexo nasce válido
  new.anulada_em := null; new.anulada_por := null; new.anulada_por_nome := null;
  new.anulada_por_email := null; new.motivo_anulacao := null;
  return new;
end;
$$;

drop trigger if exists anexos_validar on public.anexos;
create trigger anexos_validar
  before insert on public.anexos
  for each row execute function public.validar_anexo();

drop trigger if exists anexos_carimbar_criacao on public.anexos;
create trigger anexos_carimbar_criacao
  before insert on public.anexos
  for each row execute function public.carimbar_criacao();

-- 4) Anulação (qualquer usuário, com justificativa; só ela é aceita) -----
create or replace function public.validar_anulacao_anexo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_motivo text := trim(coalesce(new.motivo_anulacao, ''));
  v_nome   text;
  v_email  text;
begin
  -- manutenção pelo administrador (SQL Editor / service role): sem restrição
  if auth.uid() is null then
    return new;
  end if;
  if old.anulada_em is not null then
    raise exception 'Este anexo já foi anulado.';
  end if;
  if length(v_motivo) < 10 then
    raise exception 'Informe a justificativa da anulação (mínimo de 10 caracteres).';
  end if;

  select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
    into v_nome, v_email from auth.users u where u.id = auth.uid();

  new := old;
  new.anulada_em        := now();
  new.anulada_por       := auth.uid();
  new.anulada_por_nome  := v_nome;
  new.anulada_por_email := v_email;
  new.motivo_anulacao   := v_motivo;
  return new;
end;
$$;

drop trigger if exists anexos_anulacao on public.anexos;
create trigger anexos_anulacao
  before update on public.anexos
  for each row execute function public.validar_anulacao_anexo();

-- 5) Trilha de auditoria: anexos + registro de quem abriu ----------------
alter table public.auditoria drop constraint if exists auditoria_acao_check;
alter table public.auditoria add constraint auditoria_acao_check
  check (acao in ('cadastro', 'alteracao', 'anulacao', 'acesso'));

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
    'id', 'paciente_id', 'internacao_id', 'caminho',
    'criado_em', 'criado_por', 'criado_por_nome', 'criado_por_email',
    'atualizado_em', 'atualizado_por', 'atualizado_por_nome', 'atualizado_por_email',
    'anulada_por', 'anulada_por_nome', 'anulada_por_email',
    'setor_atual', 'leito_atual', 'previsao_alta', 'pendencias_alta', 'data_baixa', 'tipo_alta'];
begin
  select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
    into v_nome, v_email from auth.users u where u.id = auth.uid();

  if tg_op = 'INSERT' then
    v_acao := 'cadastro';
    if tg_table_name in ('pacientes', 'internacoes', 'anexos') then
      select coalesce(jsonb_object_agg(k, jsonb_build_object('para', v)), '{}'::jsonb) into v_diff
        from jsonb_each(v_depois) as e(k, v)
       where k <> all (v_ignorar)
         and k not in ('anulada_em', 'motivo_anulacao')
         and v not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb);
    end if;
  else
    v_antes := to_jsonb(old);
    v_acao := case
      when tg_table_name in ('evolucoes', 'anexos')
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

drop trigger if exists anexos_auditoria on public.anexos;
create trigger anexos_auditoria
  after insert or update on public.anexos
  for each row execute function public.registrar_auditoria();

-- funções de trigger não são chamáveis pela API
revoke execute on function public.validar_anexo()          from public, anon, authenticated;
revoke execute on function public.validar_anulacao_anexo() from public, anon, authenticated;
revoke execute on function public.registrar_auditoria()    from public, anon, authenticated;
