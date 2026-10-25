-- =====================================================================
-- Migração 03 — Dados para DRG
--   pacientes.sexo, pacientes.tipo_alta
--   evolucoes.cids_tipos (comorbidade x complicação dos CIDs secundários)
--   evolucoes.procedimentos (lista de {codigo, descricao})
-- Rode SOMENTE se você já tinha executado o schema.sql antes desta versão.
-- =====================================================================

alter table public.pacientes add column if not exists sexo text
  check (sexo in ('F', 'M'));

alter table public.pacientes add column if not exists tipo_alta text
  check (tipo_alta in ('Curado', 'Melhorado', 'A pedido', 'Evasão', 'Transferência', 'Óbito', 'Outro'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pacientes_tipo_alta_com_baixa') then
    alter table public.pacientes
      add constraint pacientes_tipo_alta_com_baixa
      check (tipo_alta is null or data_baixa is not null);
  end if;
end $$;

-- { "E11.9": "comorbidade", "N17.9": "complicacao" } — o 1º CID (principal) não é classificado
alter table public.evolucoes add column if not exists cids_tipos jsonb not null default '{}'::jsonb;

-- [ { "codigo": "0303010037", "descricao": "Tratamento de pneumonia" }, ... ]
alter table public.evolucoes add column if not exists procedimentos jsonb not null default '[]'::jsonb;
