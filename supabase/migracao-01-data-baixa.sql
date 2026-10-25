-- =====================================================================
-- Migração 01 — Data da baixa do paciente
-- Rode SOMENTE se você já tinha executado o schema.sql antes desta versão.
-- (Quem está criando o banco agora: basta rodar o schema.sql atualizado.)
-- Supabase > SQL Editor > New query > cole e clique em Run
-- =====================================================================

alter table public.pacientes add column if not exists data_baixa date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pacientes_baixa_apos_entrada') then
    alter table public.pacientes
      add constraint pacientes_baixa_apos_entrada
      check (data_baixa is null or data_baixa >= data_entrada);
  end if;
end $$;
