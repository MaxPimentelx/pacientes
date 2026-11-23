-- =====================================================================
-- Migração 12 — Pedidos de acesso ("Solicitar acesso" na tela de login)
--   * Quem não tem conta envia nome, e-mail e função. O pedido NÃO cria
--     conta: só o administrador, ao aprovar, cadastra o usuário (senha
--     temporária + verificação em 2 etapas, como no cadastro normal).
--   * A tabela não é acessível pelo app (nem leitura, nem gravação):
--     tudo passa pela função de servidor "usuarios", que limita a
--     quantidade de pedidos e não revela quais e-mails já têm conta.
--   * Aprovação e recusa ficam na trilha "auditoria_usuarios".
-- =====================================================================

create table if not exists public.solicitacoes_acesso (
  id                 uuid primary key default gen_random_uuid(),
  criado_em          timestamptz not null default now(),
  nome               text not null check (length(trim(nome)) between 2 and 80),
  email              text not null check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(email) <= 254),
  funcao             text not null check (length(trim(funcao)) between 2 and 80),
  mensagem           text check (mensagem is null or length(mensagem) <= 300),
  situacao           text not null default 'pendente' check (situacao in ('pendente', 'aprovada', 'recusada')),
  decidido_em        timestamptz,
  decidido_por       uuid references auth.users (id),
  decidido_por_email text,
  usuario_id         uuid references auth.users (id)
);

-- um pedido pendente por e-mail
create unique index if not exists solicitacoes_acesso_pendente_por_email
  on public.solicitacoes_acesso (lower(email)) where situacao = 'pendente';
create index if not exists solicitacoes_acesso_criado_idx on public.solicitacoes_acesso (criado_em desc);

alter table public.solicitacoes_acesso enable row level security;
-- sem políticas: só a função de servidor (chave de serviço) lê e grava
revoke all on public.solicitacoes_acesso from anon, authenticated;

-- trilha de administração de usuários: nova ação "recusa_solicitacao"
alter table public.auditoria_usuarios drop constraint if exists auditoria_usuarios_acao_check;
alter table public.auditoria_usuarios add constraint auditoria_usuarios_acao_check
  check (acao in ('cadastro', 'papel', 'desativacao', 'reativacao', 'senha_temporaria',
                  'remocao_2_etapas', 'troca_senha_temporaria', 'recusa_solicitacao'));
