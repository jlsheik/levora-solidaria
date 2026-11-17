-- M39 — resultado EXPLÍCITO e correlação PERSISTIDA nos novos registros de auditoria + comprovantes locais da cadeia.
--
--   * `audit_log.outcome` (concluida | recusada | falhou | pendente): o desfecho REAL, gravado no ponto do código que o conhece (nunca derivado do nome da ação). NULL = "resultado não registrado"
--     (todo o histórico anterior): NÃO é presumido sucesso e NÃO é reescrito.
--   * `audit_log.correlation_id`: identificador de correlação gerado NO SERVIDOR na origem da operação e propagado (nunca aceito de cliente externo).
--   * `audit_log.record_version`: 1 = formato histórico (hash SEM outcome/correlação — todos os hashes já gravados continuam verificáveis, nada é recalculado);
--     2 = o hash canônico passa a cobrir outcome e correlation_id. A constraint amarra versão e colunas: um registro v1 não pode carregar outcome/correlação, e um v2 precisa de ao menos um.
--     ADD COLUMN com DEFAULT constante não reescreve a tabela e não dispara os gatilhos append-only (nenhuma linha existente é alterada).
--   * `correlation_id` também em `domain_events`, `agent_event_runs`, `exception_queue` e `donation_opportunities`: o MESMO identificador viaja operação → evento → execução → exceção → auditoria.
--     Linhas existentes ficam NULL (nenhuma correlação é fabricada para o passado).
--   * `audit_chain_receipts` / `audit_chain_receipt_comparisons`: comprovantes locais do estado da cadeia e o resultado das comparações. Append-only. São metadados mínimos (ids, contagem, digest);
--     NÃO são âncora independente: quem escreve no banco também escreve aqui — o comprovante só vale quando preservado FORA do alcance de quem pode alterar o banco.
--
-- Nenhum objeto desta migration existe antes dela. Preserva 0032–0037. Sem backfill.

ALTER TABLE audit_log
  ADD COLUMN record_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN outcome TEXT,
  ADD COLUMN correlation_id TEXT;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_outcome_chk CHECK (outcome IS NULL OR outcome IN ('concluida', 'recusada', 'falhou', 'pendente'));
ALTER TABLE audit_log ADD CONSTRAINT audit_log_correlation_chk CHECK (correlation_id IS NULL OR correlation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE audit_log ADD CONSTRAINT audit_log_record_version_chk CHECK (
  (record_version = 1 AND outcome IS NULL AND correlation_id IS NULL)
  OR (record_version = 2 AND (outcome IS NOT NULL OR correlation_id IS NOT NULL))
);
CREATE INDEX idx_audit_log_correlation_id ON audit_log (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_audit_log_org_outcome ON audit_log (organization_id, outcome, id DESC) WHERE outcome IS NOT NULL;

ALTER TABLE domain_events ADD COLUMN correlation_id TEXT CONSTRAINT domain_events_correlation_chk CHECK (correlation_id IS NULL OR correlation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE agent_event_runs ADD COLUMN correlation_id TEXT CONSTRAINT agent_event_runs_correlation_chk CHECK (correlation_id IS NULL OR correlation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE exception_queue ADD COLUMN correlation_id TEXT CONSTRAINT exception_queue_correlation_chk CHECK (correlation_id IS NULL OR correlation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE donation_opportunities ADD COLUMN correlation_id TEXT CONSTRAINT donation_opportunities_correlation_chk CHECK (correlation_id IS NULL OR correlation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
CREATE INDEX idx_domain_events_correlation ON domain_events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_agent_event_runs_correlation ON agent_event_runs (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_donation_opportunities_correlation ON donation_opportunities (correlation_id) WHERE correlation_id IS NOT NULL;

-- Comprovante local do estado da cadeia (ver docs/AUDITORIA_CENTRAL.md §Comprovantes). `canonical` é o texto determinístico exportado; `receipt_digest` = SHA-256 do corpo canônico SEM este campo.
CREATE TABLE audit_chain_receipts (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL CONSTRAINT audit_chain_receipts_scope_chk CHECK (scope IN ('global_chain')),
  format_version INTEGER NOT NULL CONSTRAINT audit_chain_receipts_format_chk CHECK (format_version = 1),
  algorithm TEXT NOT NULL CONSTRAINT audit_chain_receipts_algorithm_chk CHECK (algorithm = 'sha256'),
  verification_id BIGINT NOT NULL REFERENCES audit_chain_verifications(id),
  last_event_id BIGINT NOT NULL CONSTRAINT audit_chain_receipts_last_chk CHECK (last_event_id >= 1),
  event_count BIGINT NOT NULL CONSTRAINT audit_chain_receipts_count_chk CHECK (event_count >= 1),
  head_hash TEXT NOT NULL CONSTRAINT audit_chain_receipts_head_chk CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  receipt_digest TEXT NOT NULL CONSTRAINT audit_chain_receipts_digest_chk CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  canonical TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_chain_receipts_digest_key UNIQUE (receipt_digest)
);
CREATE INDEX idx_audit_chain_receipts_scope ON audit_chain_receipts (scope, id DESC);
CREATE TRIGGER audit_chain_receipts_no_update BEFORE UPDATE ON audit_chain_receipts FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_chain_receipts_no_delete BEFORE DELETE ON audit_chain_receipts FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- Resultado de cada comparação (inclusive de comprovantes malformados ou de outro escopo, cujo `receipt_id` fica nulo). Só códigos, ids e contagens — nunca hashes nem conteúdo de auditoria.
CREATE TABLE audit_chain_receipt_comparisons (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT REFERENCES audit_chain_receipts(id),
  receipt_digest TEXT CONSTRAINT audit_chain_receipt_comparisons_digest_chk CHECK (receipt_digest IS NULL OR receipt_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CONSTRAINT audit_chain_receipt_comparisons_status_chk CHECK (status IN ('conferido', 'divergencia', 'malformado', 'nao_suportado', 'escopo_diferente')),
  reason_code TEXT CONSTRAINT audit_chain_receipt_comparisons_reason_chk CHECK (reason_code IS NULL OR char_length(reason_code) <= 60),
  compared_up_to_event_id BIGINT,
  events_since_receipt BIGINT CONSTRAINT audit_chain_receipt_comparisons_since_chk CHECK (events_since_receipt IS NULL OR events_since_receipt >= 0),
  compared_by_user_id INTEGER NOT NULL REFERENCES users(id),
  compared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_chain_receipt_comparisons_conferido_chk CHECK (status <> 'conferido' OR reason_code IS NULL),
  CONSTRAINT audit_chain_receipt_comparisons_divergencia_chk CHECK (status <> 'divergencia' OR reason_code IS NOT NULL)
);
CREATE INDEX idx_audit_chain_receipt_comparisons_receipt ON audit_chain_receipt_comparisons (receipt_id, id DESC);
CREATE TRIGGER audit_chain_receipt_comparisons_no_update BEFORE UPDATE ON audit_chain_receipt_comparisons FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_chain_receipt_comparisons_no_delete BEFORE DELETE ON audit_chain_receipt_comparisons FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
