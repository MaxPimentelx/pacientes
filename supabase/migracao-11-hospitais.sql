-- =====================================================================
-- Migração 11 — Hospitais (admissão e readmissão em hospitais diferentes)
--   * Lista de hospitais mantida pelo ADMINISTRADOR (como os setores).
--     Hospital desativado some das opções, mas continua no histórico.
--   * Cada internação (admissão/readmissão) registra o hospital.
--     O banco só aceita um hospital que esteja na lista e ativo.
--   * Readmissão (volta em até 30 dias após a alta) é calculada pelo app
--     e vale em qualquer hospital.
-- =====================================================================

-- 1) Lista de hospitais ------------------------------------------------------
create table if not exists public.hospitais (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null check (length(trim(nome)) between 2 and 120),
  ordem     int  not null default 100,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);
-- sem nomes repetidos, ignorando maiúsculas e espaços nas pontas
create unique index if not exists hospitais_nome_unico on public.hospitais (lower(trim(nome)));

alter table public.hospitais enable row level security;

drop policy if exists "logados leem hospitais" on public.hospitais;
create policy "logados leem hospitais" on public.hospitais
  for select to authenticated using (true);

drop policy if exists "admin cadastra hospitais" on public.hospitais;
create policy "admin cadastra hospitais" on public.hospitais
  for insert to authenticated with check ((select public.eh_admin()));

drop policy if exists "admin edita hospitais" on public.hospitais;
create policy "admin edita hospitais" on public.hospitais
  for update to authenticated
  using ((select public.eh_admin())) with check ((select public.eh_admin()));
-- sem política de DELETE: hospital não se apaga, só se desativa

drop policy if exists "exige 2 etapas" on public.hospitais;
create policy "exige 2 etapas" on public.hospitais as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "exige usuario ativo" on public.hospitais;
create policy "exige usuario ativo" on public.hospitais as restrictive for all to authenticated
  using ((select public.usuario_ativo()))
  with check ((select public.usuario_ativo()));

-- 2) Hospital da internação ---------------------------------------------------
alter table public.internacoes add column if not exists hospital text;

create or replace function public.validar_hospital_internacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.hospital := nullif(trim(coalesce(new.hospital, '')), '');
  -- manutenção pelo administrador (SQL Editor / service role): sem restrição
  if auth.uid() is null or new.hospital is null then
    return new;
  end if;
  -- só confere quando o hospital é informado ou trocado
  if tg_op = 'UPDATE' and new.hospital is not distinct from old.hospital then
    return new;
  end if;
  if not exists (select 1 from public.hospitais h
                  where h.nome = new.hospital and h.ativo) then
    raise exception 'Hospital fora da lista de hospitais ativos. Escolha um hospital da lista.';
  end if;
  return new;
end;
$$;

drop trigger if exists internacoes_hospital on public.internacoes;
create trigger internacoes_hospital
  before insert or update on public.internacoes
  for each row execute function public.validar_hospital_internacao();

revoke execute on function public.validar_hospital_internacao() from public, anon, authenticated;

-- 3) Cadastro do paciente + 1ª internação: passa a gravar o hospital -----------
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
    (paciente_id, data_entrada, motivo, cids_entrada, hospital, setor_entrada, leito_entrada, previsao_alta_inicial)
  values (v_id,
          coalesce(nullif(p_internacao->>'data_entrada', '')::date, current_date),
          trim(p_internacao->>'motivo'),
          coalesce(array(select jsonb_array_elements_text(p_internacao->'cids_entrada')), '{}'),
          nullif(trim(p_internacao->>'hospital'), ''),
          nullif(p_internacao->>'setor_entrada', ''),
          nullif(trim(p_internacao->>'leito_entrada'), ''),
          nullif(p_internacao->>'previsao_alta_inicial', '')::date);
  return v_id;
end;
$$;
revoke execute on function public.cadastrar_paciente(jsonb, jsonb) from public, anon;
grant  execute on function public.cadastrar_paciente(jsonb, jsonb) to authenticated;
