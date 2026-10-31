-- =====================================================================
-- Migração 07 — Anulação sem função exposta na API
--   Substitui a função anular_evolucao (SECURITY DEFINER chamável via
--   /rpc, apontada pelo verificador de segurança do Supabase) por:
--     * política de UPDATE: só o autor, só se ainda não anulada;
--     * trigger BEFORE UPDATE: a única mudança aceita é anular — exige
--       justificativa, carimba quem/quando e descarta qualquer outra
--       alteração enviada.
--   A exigência de 2 etapas (aal2) vem da política restritiva da migração 06.
-- =====================================================================

drop function if exists public.anular_evolucao(uuid, text);

create or replace function public.validar_anulacao_evolucao()
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
    raise exception 'Esta evolução já foi anulada.';
  end if;
  if old.criado_por is distinct from auth.uid() then
    raise exception 'Somente quem registrou a evolução pode anulá-la.';
  end if;
  if length(v_motivo) < 10 then
    raise exception 'Informe a justificativa da anulação (mínimo de 10 caracteres).';
  end if;

  select coalesce(nullif(trim(u.raw_user_meta_data->>'nome'), ''), u.email), u.email
    into v_nome, v_email from auth.users u where u.id = auth.uid();

  -- registro clínico é imutável: só os campos da anulação mudam
  new := old;
  new.anulada_em        := now();
  new.anulada_por       := auth.uid();
  new.anulada_por_nome  := v_nome;
  new.anulada_por_email := v_email;
  new.motivo_anulacao   := v_motivo;
  return new;
end;
$$;

revoke execute on function public.validar_anulacao_evolucao() from public, anon, authenticated;

drop trigger if exists evolucoes_anulacao on public.evolucoes;
create trigger evolucoes_anulacao
  before update on public.evolucoes
  for each row execute function public.validar_anulacao_evolucao();

drop policy if exists "autor anula sua evolucao" on public.evolucoes;
create policy "autor anula sua evolucao" on public.evolucoes
  for update to authenticated
  using (criado_por = (select auth.uid()) and anulada_em is null)
  with check (criado_por = (select auth.uid()));
