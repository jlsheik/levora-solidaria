-- Fase 99G — idempotência PERSISTENTE das correções documentais e das reversões de destinação (estorno documental, devolução física, correção de quantidade). Cada pedido carrega uma
-- chave por organização; esta tabela guarda a chave, o hash do conteúdo e o evento resultante (a correção ou a reversão em stock_destinations). O banco garante UNICIDADE da chave por
-- organização e que um mesmo evento nunca é produto de duas chaves: o mesmo pedido repetido nunca cria dois eventos nem duas entradas físicas, e a mesma chave com conteúdo
-- diferente é detectada pelo hash. Só tabela nova (sem backfill); stock_destinations e stock_transactions não mudam. Não há aprovação nesta fase (a especificação só exige segunda
-- aprovação para ajuste NEGATIVO; todos os movimentos compensatórios aqui são positivos), portanto o único desfecho é 'executada', gravado na mesma transação do evento.
CREATE TABLE destination_correction_requests (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CONSTRAINT destination_correction_requests_key_len_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  payload_hash TEXT NOT NULL,
  stock_destination_id BIGINT NOT NULL,
  event_destination_id BIGINT NOT NULL,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT destination_correction_requests_org_key_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT destination_correction_requests_event_unique UNIQUE (event_destination_id),
  CONSTRAINT destination_correction_requests_target_org_fkey FOREIGN KEY (stock_destination_id, organization_id) REFERENCES stock_destinations (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT destination_correction_requests_event_org_fkey FOREIGN KEY (event_destination_id, organization_id) REFERENCES stock_destinations (id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX idx_destination_correction_requests_target ON destination_correction_requests(stock_destination_id);
-- imutável: o pedido é gravado já com o desfecho
CREATE TRIGGER destination_correction_requests_no_update BEFORE UPDATE ON destination_correction_requests FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER destination_correction_requests_no_delete BEFORE DELETE ON destination_correction_requests FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
