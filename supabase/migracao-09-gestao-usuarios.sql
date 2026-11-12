-- =====================================================================
-- Migração 09 — Gestão de usuários pelo próprio sistema
--   * papéis: "admin" (administrador) e "operador" (todos os demais),
--     guardados em app_metadata.papel do Supabase Auth (só o servidor altera);
--   * o banco consulta a situação ATUAL do usuário em auth.users a cada
--     consulta (não a cópia guardada no token de acesso, que vale até 1 h):
--       - desativado (ban) → não lê nem grava nada, na hora;
--       - sessão encerrada pelo administrador → o token antigo para de valer;
--       - senha temporária ainda não trocada → sem acesso aos dados;
--       - rebaixado a operador → perde os poderes de administrador na hora;
--   * trilha das ações de administração (cadastro, papel, desativação…).
--
--   O cadastro, a desativação e a troca de papel são feitos pela função de
--   servidor "usuarios" (supabase/functions/usuarios), que usa a chave de
--   serviço — essa chave nunca vai para o app.
-- =====================================================================

-- 1) Usuário ativo, com sessão válida e sem senha temporária pendente
--    (lê auth.users/auth.sessions, por isso security definer)
create or replace function public.usuario_ativo()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.users u
      join auth.sessions s
        on s.user_id = u.id
       and s.id = nullif(auth.jwt()->>'session_id', '')::uuid
     where u.id = auth.uid()
       and (u.banned_until is null or u.banned_until <= now())
       and u.deleted_at is null
       and coalesce(u.raw_app_meta_data->>'trocar_senha', 'false') <> 'true'
  );
$$;

revoke execute on function public.usuario_ativo() from public, anon;
grant  execute on function public.usuario_ativo() to authenticated;

-- 2) Administrador AGORA (não o papel copiado no token)
create or replace function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
     where u.id = auth.uid()
       and u.raw_app_meta_data->>'papel' = 'admin'
  );
$$;

revoke execute on function public.eh_admin() from public, anon;
grant  execute on function public.eh_admin() to authenticated;

-- 3) Encerrar todas as sessões de um usuário (só a função de servidor chama)
create or replace function public.encerrar_sessoes(p_usuario uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  delete from auth.sessions where user_id = p_usuario;  -- refresh tokens saem em cascata
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.encerrar_sessoes(uuid) from public, anon, authenticated;
grant  execute on function public.encerrar_sessoes(uuid) to service_role;

-- 4) Regra RESTRITIVA em todas as tabelas: só usuário ativo lê ou grava
--    ("select" envolvendo a função = avaliada uma vez por consulta)
do $$
declare t text;
begin
  foreach t in array array['pacientes', 'internacoes', 'evolucoes', 'auditoria', 'setores'] loop
    execute format('drop policy if exists "exige usuario ativo" on public.%I', t);
    execute format(
      'create policy "exige usuario ativo" on public.%I as restrictive for all to authenticated
         using ((select public.usuario_ativo())) with check ((select public.usuario_ativo()))', t);
  end loop;
end $$;

-- 5) Setores: poder de administrador conferido no banco, não no token
drop policy if exists "admin cadastra setores" on public.setores;
create policy "admin cadastra setores" on public.setores for insert to authenticated
  with check ((select public.eh_admin()));
drop policy if exists "admin edita setores" on public.setores;
create policy "admin edita setores" on public.setores for update to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

-- 6) Trilha das ações de administração de usuários
create table if not exists public.auditoria_usuarios (
  id           bigint generated always as identity primary key,
  ocorrido_em  timestamptz not null default now(),
  admin_id     uuid not null,
  admin_email  text,
  alvo_id      uuid,
  alvo_email   text,
  acao         text not null check (acao in
                 ('cadastro', 'papel', 'desativacao', 'reativacao', 'senha_temporaria',
                  'remocao_2_etapas', 'troca_senha_temporaria')),
  situacao     text not null default 'iniciada' check (situacao in ('iniciada', 'concluida', 'falhou', 'desfeita')),
  detalhes     jsonb not null default '{}'::jsonb
);
create index if not exists auditoria_usuarios_alvo_idx on public.auditoria_usuarios (alvo_id, ocorrido_em desc);

alter table public.auditoria_usuarios enable row level security;

-- só administradores leem; ninguém grava pelo app (quem grava é a função de servidor)
drop policy if exists "admin le auditoria de usuarios" on public.auditoria_usuarios;
create policy "admin le auditoria de usuarios" on public.auditoria_usuarios
  for select to authenticated
  using ((select public.eh_admin()));
drop policy if exists "exige 2 etapas" on public.auditoria_usuarios;
create policy "exige 2 etapas" on public.auditoria_usuarios
  as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');
drop policy if exists "exige usuario ativo" on public.auditoria_usuarios;
create policy "exige usuario ativo" on public.auditoria_usuarios
  as restrictive for all to authenticated
  using ((select public.usuario_ativo())) with check ((select public.usuario_ativo()));

revoke all on public.auditoria_usuarios from anon;
revoke insert, update, delete, truncate on public.auditoria_usuarios from authenticated;
