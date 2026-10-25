-- =====================================================================
-- Migração 02 — CID-10 na entrada e em cada evolução
-- Rode SOMENTE se você já tinha executado o schema.sql antes desta versão.
-- (Quem está criando o banco agora: basta rodar o schema.sql atualizado.)
-- =====================================================================

alter table public.pacientes add column if not exists cids_entrada text[] not null default '{}';
alter table public.evolucoes add column if not exists cids         text[] not null default '{}';
