-- Ledger de atendimento de necessidades (fundação de rastreabilidade —
-- ver docs/plano-implementacao.md, Fase 29, e a investigação arquitetural
-- entregue no chat desta sessão). Registra o FATO FÍSICO de que um
-- recebimento de doação contribuiu para uma necessidade declarada, sem
-- transformar needs.quantity_needed num contador mutável (needs.*
-- permanece com a mesma semântica de sempre).
--
-- Append-only, mesmo padrão de stock_transactions/audit_log/logistics_events
-- (audit_log_block_mutation já existe em db/schema.sql).
--
-- need_id é NULLABLE de propósito: allocations criadas manualmente (ver
-- opportunity-allocations_POST.ts) nunca passam por match_evaluations,
-- então não há como saber a necessidade pretendida — NULL é o valor
-- correto e honesto nesse caso, não uma lacuna a preencher depois.
--
-- allocation_id é obrigatório e único: uma allocation só pode ser recebida
-- uma vez (allocations-receive_POST.ts rejeita com 409 qualquer status
-- diferente de aceita/em_coleta/em_transporte, e "recebida" não tem
-- nenhuma transição de volta) — não existe hoje suporte a múltiplos
-- recebimentos para a mesma allocation, então o ledger não inventa esse
-- suporte. stock_transaction_id também é único pelo mesmo motivo (cada
-- recebimento gera exatamente uma stock_transaction).
CREATE TABLE need_fulfillments (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  need_id INTEGER REFERENCES needs(id) ON DELETE SET NULL,
  allocation_id INTEGER NOT NULL REFERENCES opportunity_allocations(id) ON DELETE CASCADE,
  stock_transaction_id BIGINT NOT NULL REFERENCES stock_transactions(id) ON DELETE RESTRICT,
  -- Quantidade EFETIVAMENTE recebida (quantityReceived), nunca a alocada
  -- nem a necessária — este ledger registra o fato físico, não a
  -- expectativa. Ver comentário completo em src/helpers/needFulfillment.tsx.
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  -- Preenchido só quando existe uma need candidata (via match_evaluations)
  -- mas a unidade recebida diverge da unidade declarada pela need — nesse
  -- caso need_id fica NULL de propósito (nunca somamos unidades
  -- incompatíveis), e este campo torna essa decisão identificável nos
  -- dados, em vez de um NULL silencioso e ambíguo com o caso "allocation
  -- manual sem need".
  unit_mismatch_note TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (allocation_id),
  UNIQUE (stock_transaction_id)
);
CREATE TRIGGER need_fulfillments_no_update BEFORE UPDATE ON need_fulfillments FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER need_fulfillments_no_delete BEFORE DELETE ON need_fulfillments FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE INDEX idx_need_fulfillments_need ON need_fulfillments(need_id);
CREATE INDEX idx_need_fulfillments_org ON need_fulfillments(organization_id, created_at DESC);
