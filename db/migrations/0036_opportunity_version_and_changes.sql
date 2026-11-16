-- M37 — correção AUTORIZADA da categoria de uma oportunidade com controle otimista de concorrência e histórico do recurso.
--
--   * `donation_opportunities.version`: contador de versão do registro. Toda mudança de conteúdo/estado incrementa. A edição envia a versão que o usuário viu (recusa se mudou) e a conclusão da
--     reavaliação do Risk Engine confere, SOB TRAVA DA LINHA, que a versão usada na decisão ainda é a atual — uma decisão nunca é apresentada como baseada na categoria atual se usou uma versão antiga.
--     Linhas existentes recebem 1 (nenhum dado de negócio é alterado nem reinterpretado).
--   * `opportunity_changes`: histórico append-only do RECURSO (quem, quando, campo, de/para, versões, correlação, motivo). A auditoria continua sem valores (minimização); os valores ficam aqui, onde
--     pertencem ao histórico da oportunidade. Eventos históricos NUNCA são reescritos.
--
-- Nenhum objeto desta migration existe antes dela. Preserva 0032–0035. Sem backfill de histórico. FK sem ON DELETE CASCADE/SET NULL contra tabela append-only.

ALTER TABLE donation_opportunities ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CONSTRAINT donation_opportunities_version_chk CHECK (version >= 1);

CREATE TABLE opportunity_changes (
  id BIGSERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES donation_opportunities(id),
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  field TEXT NOT NULL CONSTRAINT opportunity_changes_field_chk CHECK (field IN ('category')),
  previous_value TEXT,
  new_value TEXT,
  version_before INTEGER NOT NULL CHECK (version_before >= 1),
  version_after INTEGER NOT NULL CHECK (version_after > version_before),
  changed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  correlation_id TEXT NOT NULL,
  reason TEXT CONSTRAINT opportunity_changes_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_opportunity_changes_opportunity ON opportunity_changes (opportunity_id, id);
CREATE TRIGGER opportunity_changes_no_update BEFORE UPDATE ON opportunity_changes FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER opportunity_changes_no_delete BEFORE DELETE ON opportunity_changes FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
