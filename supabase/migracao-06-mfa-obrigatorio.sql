-- =====================================================================
-- Migração 06 — Verificação em 2 etapas (MFA) obrigatória para todos
--   Políticas RESTRITIVAS: além das regras existentes, toda leitura e
--   gravação exige sessão com 2º fator verificado (aal2).
--   Ref.: https://supabase.com/docs/guides/auth/auth-mfa
--
--   ATENÇÃO na ordem de implantação: publique ANTES a versão do app com
--   a tela de verificação em 2 etapas; só depois aplique esta migração.
--   Recuperação: se alguém perder o celular, um administrador remove o
--   fator em Supabase > Authentication > Users > (usuário) > MFA.
-- =====================================================================

drop policy if exists "exige 2 etapas" on public.pacientes;
create policy "exige 2 etapas" on public.pacientes
  as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

drop policy if exists "exige 2 etapas" on public.evolucoes;
create policy "exige 2 etapas" on public.evolucoes
  as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

drop policy if exists "exige 2 etapas" on public.auditoria;
create policy "exige 2 etapas" on public.auditoria
  as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

-- A anulação roda como "security definer" (ignora RLS): a exigência vai na função.
create or replace function public.anular_evolucao(p_id uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_autor   uuid;
  v_anulada timestamptz;
  v_nome    text;
  v_email   text;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado.';
  end if;
  if coalesce(auth.jwt()->>'aal', '') <> 'aal2' then
    raise exception 'Verificação em 2 etapas necessária.';
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
