-- Fase 99E — idempotência PERSISTENTE do registro atômico de saída + destinação. Cada pedido de saída carrega uma chave de idempotência (por organização); esta tabela guarda a chave, o hash do
-- conteúdo e o desfecho (executada, ou pendente de segunda aprovação). O banco garante UNICIDADE da chave por organização: o mesmo pedido repetido nunca cria duas saídas, e a mesma chave
-- com conteúdo diferente é detectada pelo hash. Só tabela nova (sem backfill); stock_transactions e stock_destinations não mudam.
CREATE TABLE stock_exit_requests (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CONSTRAINT stock_exit_requests_key_len_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CONSTRAINT stock_exit_requests_status_chk CHECK (status IN ('pendente_aprovacao', 'executada', 'rejeitada')),
  approval_request_id INTEGER REFERENCES approval_requests(id) ON DELETE RESTRICT,
  stock_transaction_id BIGINT,
  stock_destination_id BIGINT,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_exit_requests_org_key_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT stock_exit_requests_stock_org_fkey FOREIGN KEY (stock_transaction_id, organization_id) REFERENCES stock_transactions (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT stock_exit_requests_destination_org_fkey FOREIGN KEY (stock_destination_id, organization_id) REFERENCES stock_destinations (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT stock_exit_requests_executed_chk CHECK (status <> 'executada' OR (stock_transaction_id IS NOT NULL AND stock_destination_id IS NOT NULL)),
  CONSTRAINT stock_exit_requests_pending_chk CHECK (status <> 'pendente_aprovacao' OR (approval_request_id IS NOT NULL AND stock_transaction_id IS NULL AND stock_destination_id IS NULL)),
  CONSTRAINT stock_exit_requests_rejected_chk CHECK (status <> 'rejeitada' OR (stock_transaction_id IS NULL AND stock_destination_id IS NULL))
);
CREATE INDEX idx_stock_exit_requests_approval ON stock_exit_requests(approval_request_id) WHERE approval_request_id IS NOT NULL;
CREATE TRIGGER stock_exit_requests_set_updated_at BEFORE UPDATE ON stock_exit_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A chave, o hash, o autor e a organização de um pedido nunca mudam; só o desfecho (pendente -> executada | rejeitada) e os vínculos dele.
CREATE OR REPLACE FUNCTION stock_exit_request_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id THEN
    RAISE EXCEPTION 'stock_exit_requests: chave, conteúdo, autor e pedido de aprovação são imutáveis';
  END IF;
  IF OLD.status <> 'pendente_aprovacao' THEN
    RAISE EXCEPTION 'stock_exit_requests: o pedido já tem desfecho (%) e não muda', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stock_exit_requests_guard BEFORE UPDATE ON stock_exit_requests FOR EACH ROW EXECUTE FUNCTION stock_exit_request_guard();
CREATE TRIGGER stock_exit_requests_no_delete BEFORE DELETE ON stock_exit_requests FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
