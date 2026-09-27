-- Corrige achado de auditoria crítico da Fase 29: need_fulfillments é
-- append-only (trigger audit_log_block_mutation bloqueia UPDATE/DELETE),
-- mas nasceu com ON DELETE SET NULL (need_id) e ON DELETE CASCADE
-- (allocation_id, organization_id) — ações que exigem o Postgres executar
-- um UPDATE/DELETE interno na própria tabela para honrar a FK. O trigger
-- append-only intercepta essa operação interna e bloqueia, fazendo o
-- DELETE da linha-pai (needs/opportunity_allocations/organizations)
-- falhar inteiramente com um erro, em vez de silenciosamente apagar ou
-- alterar o histórico do fulfillment como as cláusulas prometiam.
-- Reproduzido e confirmado na auditoria (não hipotético).
--
-- Investigação confirmou (grep exaustivo, sem nenhum resultado): nenhum
-- endpoint em todo o projeto deleta linhas de organizations, needs ou
-- opportunity_allocations — a única rotina de "exclusão" relacionada
-- (LGPD, account-delete_POST.ts) anonimiza o USUÁRIO, nunca apaga a
-- organização. Trocar as 3 ações para RESTRICT não quebra nenhum fluxo
-- real hoje.
--
-- RESTRICT (em vez do NO ACTION padrão) segue o mesmo padrão já usado em
-- stock_transactions.item_id — a intenção "não permitir a exclusão
-- enquanto houver referência" fica explícita na própria FK.
ALTER TABLE need_fulfillments DROP CONSTRAINT need_fulfillments_need_id_fkey;
ALTER TABLE need_fulfillments
  ADD CONSTRAINT need_fulfillments_need_id_fkey
  FOREIGN KEY (need_id) REFERENCES needs(id) ON DELETE RESTRICT;

ALTER TABLE need_fulfillments DROP CONSTRAINT need_fulfillments_allocation_id_fkey;
ALTER TABLE need_fulfillments
  ADD CONSTRAINT need_fulfillments_allocation_id_fkey
  FOREIGN KEY (allocation_id) REFERENCES opportunity_allocations(id) ON DELETE RESTRICT;

ALTER TABLE need_fulfillments DROP CONSTRAINT need_fulfillments_organization_id_fkey;
ALTER TABLE need_fulfillments
  ADD CONSTRAINT need_fulfillments_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

-- Achado de performance da mesma auditoria: allocations-receive_POST.ts
-- (via createNeedFulfillment) resolve needId com
-- "SELECT need_id FROM match_evaluations WHERE allocation_id = ?" sem
-- nenhum índice dedicado nessa coluna. Cardinalidade reconfirmada: no
-- máximo uma match_evaluations por allocation_id (só é gravado uma vez,
-- no momento em que o motor cria aquela allocation específica, nunca
-- reaproveitado depois) — por isso um índice único, não um índice
-- simples, tanto acelera a busca quanto expressa essa garantia real no
-- próprio banco.
CREATE UNIQUE INDEX idx_match_evaluations_allocation_id ON match_evaluations(allocation_id) WHERE allocation_id IS NOT NULL;
