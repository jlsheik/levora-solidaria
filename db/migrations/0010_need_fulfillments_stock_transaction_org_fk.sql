-- Fecha a lacuna de isolamento multi-tenant encontrada na auditoria
-- read-only da Fase 32→33 (ver docs/plano-implementacao.md, Fase 33): o
-- schema anterior permitia (comprovado por reprodução em transação
-- temporária, nada persistido) que um need_fulfillment de organization_id=A
-- referenciasse um stock_transaction cujo dono real fosse organization_id=B
-- — a FK simples (stock_transaction_id → stock_transactions.id) só garante
-- existência do id, nunca a mesma organização.
--
-- Investigação prévia (só leitura, sem alterar nada) confirmou:
--   - stock_transactions.organization_id existe, é NOT NULL (nunca foi
--     opcional desde a criação da tabela);
--   - stock_transactions.id já é PK (único) — (id, organization_id) é
--     trivialmente único, só falta o constraint explícito exigido pelo
--     Postgres para servir de lado referenciado de uma FK composta;
--   - dev DB não tem NENHUMA linha em need_fulfillments hoje (tabela
--     vazia) — não há dado histórico incompatível com a nova constraint,
--     confirmado por SELECT count(*) antes desta migration.
--
-- Solução: FK composta (stock_transaction_id, organization_id) →
-- stock_transactions(id, organization_id), substituindo a FK simples
-- anterior (que fica redundante — a composta já garante existência do id
-- E a mesma organização). Com MATCH SIMPLE (padrão do Postgres), a FK
-- composta é trivialmente satisfeita quando stock_transaction_id é NULL —
-- preserva sem nenhuma mudança o suporte a correction/reversal
-- interpretativos (sem movimento físico), que continuam sem exigir
-- stock_transaction_id.
ALTER TABLE stock_transactions
  ADD CONSTRAINT stock_transactions_id_organization_id_key UNIQUE (id, organization_id);

ALTER TABLE need_fulfillments
  DROP CONSTRAINT need_fulfillments_stock_transaction_id_fkey;

ALTER TABLE need_fulfillments
  ADD CONSTRAINT need_fulfillments_stock_transaction_org_fkey
    FOREIGN KEY (stock_transaction_id, organization_id)
    REFERENCES stock_transactions (id, organization_id)
    ON DELETE RESTRICT;

-- Compatibilidade FÍSICA (item/unidade/quantidade/direção do movimento) —
-- investigada, NÃO corrigida nesta migration, por decisão deliberada, não
-- omissão. A cadeia allocation → opportunity_registry / match_evaluations
-- não carrega item_id em nenhum ponto (opportunity_registry descreve o
-- item só como texto livre category/quantity/unit; opportunity_allocations
-- e match_evaluations não têm coluna de item nenhuma). needs.item_id
-- existe mas é NULLABLE e só é preenchido quando o need aponta para um
-- item de inventário específico — e need_fulfillments.need_id, por sua
-- vez, só é preenchido quando existe uma linha em match_evaluations para
-- aquela allocation (aliocations manuais nunca têm match_evaluations,
-- confirmado em needFulfillment.tsx). Ou seja: não existe, hoje, uma
-- fonte canônica e sempre presente do item/unidade/quantidade/direção
-- esperados para um need_fulfillment — depende de uma cadeia opcional
-- (need_id pode ser NULL; needs.item_id pode ser NULL mesmo quando
-- need_id não é NULL). Adicionar item_id a need_fulfillments só para
-- viabilizar essa constraint seria inventar uma coluna nova sem uma
-- necessidade de negócio comprovada — decisão explicitamente fora do
-- escopo desta migration; fica registrada como decisão arquitetural
-- futura (ver relatório da Fase 33), não como regra arbitrária aplicada
-- agora.
