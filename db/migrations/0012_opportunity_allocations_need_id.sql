-- Fase 45 — allocation manual pode carregar uma need_id opcional,
-- explicitamente escolhida pelo platformAdmin no momento da criação (ver
-- docs/plano-implementacao.md, Fase 44: análise read-only que concluiu que
-- isso deveria ser possível, sem inferência automática).
--
-- need_id em opportunity_allocations é a fonte de INTENÇÃO/DECISÃO
-- ("esta allocation destina-se a esta need") — nunca escrita pelo Modelo B
-- em si. need_fulfillments.need_id continua sendo a fonte de FATO físico
-- do recebimento (Modelo B, congelado, intocado por esta migration).
-- createNeedFulfillment passa a ter uma segunda origem legítima para
-- resolver need_id (allocation.need_id, quando não houver
-- match_evaluations — nunca as duas fontes ao mesmo tempo, porque
-- allocations manuais nunca geram match_evaluations).
--
-- (needs.id, needs.organization_id) único: needs.id já é PK (único), mas
-- o Postgres exige um UNIQUE explícito nas colunas exatas para servir de
-- lado referenciado de uma FK composta — mesmo mecanismo já usado na
-- Fase 33 para stock_transactions.
ALTER TABLE needs
  ADD CONSTRAINT needs_id_organization_id_key UNIQUE (id, organization_id);

ALTER TABLE opportunity_allocations
  ADD COLUMN need_id INTEGER;

-- FK composta: garante estruturalmente que uma allocation nunca referencie
-- uma need de OUTRA organização — nunca só confiar na validação de
-- aplicação (mesmo princípio da Fase 33). MATCH SIMPLE (padrão do
-- Postgres) satisfaz trivialmente quando need_id é NULL — preserva sem
-- nenhuma mudança o comportamento de allocations sem need (automáticas ou
-- manuais sem vínculo).
ALTER TABLE opportunity_allocations
  ADD CONSTRAINT opportunity_allocations_need_org_fkey
    FOREIGN KEY (need_id, organization_id)
    REFERENCES needs (id, organization_id)
    ON DELETE RESTRICT;

CREATE INDEX idx_opportunity_allocations_need ON opportunity_allocations(need_id) WHERE need_id IS NOT NULL;
