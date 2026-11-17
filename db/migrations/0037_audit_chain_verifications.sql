-- M38 — Central de Auditoria: registro OPERACIONAL das verificações da cadeia de auditoria + índices de consulta.
--
--   * `audit_chain_verifications`: uma linha por verificação pedida pela interface (quem, quando, abrangência, resultado). É tabela operacional SEPARADA de `audit_log` DE PROPÓSITO:
--     gravar o resultado de uma verificação dentro da própria cadeia que acabou de ser considerada possivelmente comprometida seria circular (mesma regra da Fase 53). Ela NÃO é âncora
--     independente: quem tem escrita direta no banco também pode alterá-la — ver docs/AGENTES_PLATAFORMA.md (limites). Só guarda metadados seguros: contagens, ids e o MOTIVO técnico
--     da divergência; nunca hashes esperados/gravados, metadados de eventos nem dados pessoais.
--   * Máquina de estados: `em_andamento` → (`integra` | `inconsistencia` | `incompleta` | `falha_tecnica`). Linha final é imutável; DELETE é sempre recusado; no máximo UMA verificação
--     `em_andamento` por escopo (índice único parcial = limite operacional + idempotência do pedido). Em andamento só a abrangência (max_audit_id_at_start) é preenchida.
--   * Índices de consulta em `audit_log` (apenas índices — nenhuma linha, hash ou coluna da cadeia é alterada): paginação por cursor dentro da organização e busca por correlação.
--
-- Nenhum objeto desta migration existe antes dela. Preserva 0032–0036. Sem backfill.

CREATE TABLE audit_chain_verifications (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL CONSTRAINT audit_chain_verifications_scope_chk CHECK (scope IN ('global_chain')),
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'em_andamento' CONSTRAINT audit_chain_verifications_status_chk CHECK (status IN ('em_andamento', 'integra', 'inconsistencia', 'incompleta', 'falha_tecnica')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- Abrangência: a verificação cobre os eventos com id <= este valor, lido no INÍCIO. Eventos gravados depois não fazem parte do resultado.
  max_audit_id_at_start BIGINT,
  total_events INTEGER CONSTRAINT audit_chain_verifications_total_chk CHECK (total_events IS NULL OR total_events >= 0),
  verified_events INTEGER CONSTRAINT audit_chain_verifications_verified_chk CHECK (verified_events IS NULL OR verified_events >= 0),
  -- Eventos sem hash (anteriores à migração 0003): NÃO verificáveis. Entram como limitação de cobertura, nunca como verificados.
  unhashed_events INTEGER CONSTRAINT audit_chain_verifications_unhashed_chk CHECK (unhashed_events IS NULL OR unhashed_events >= 0),
  divergence_count INTEGER CONSTRAINT audit_chain_verifications_divergence_chk CHECK (divergence_count IS NULL OR divergence_count >= 0),
  -- Até 100 itens {id, reason}; o total real está em divergence_count. Sem hashes.
  divergences JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_kind TEXT CONSTRAINT audit_chain_verifications_error_kind_chk CHECK (error_kind IS NULL OR char_length(error_kind) <= 60),
  duration_ms INTEGER CONSTRAINT audit_chain_verifications_duration_chk CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT audit_chain_verifications_final_chk CHECK ((status = 'em_andamento') = (finished_at IS NULL)),
  CONSTRAINT audit_chain_verifications_result_chk CHECK (
    status NOT IN ('integra', 'inconsistencia') OR (total_events IS NOT NULL AND verified_events IS NOT NULL AND unhashed_events IS NOT NULL AND divergence_count IS NOT NULL)
  ),
  CONSTRAINT audit_chain_verifications_integra_chk CHECK (status <> 'integra' OR divergence_count = 0),
  CONSTRAINT audit_chain_verifications_inconsistencia_chk CHECK (status <> 'inconsistencia' OR divergence_count > 0)
);
CREATE UNIQUE INDEX uq_audit_chain_verifications_running ON audit_chain_verifications (scope) WHERE status = 'em_andamento';
CREATE INDEX idx_audit_chain_verifications_scope ON audit_chain_verifications (scope, id DESC);

CREATE OR REPLACE FUNCTION audit_chain_verifications_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_chain_verifications é append-only: remoção recusada' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- UPDATE: só a transição única de em_andamento para um estado final, sem trocar a identidade da linha.
  IF OLD.status <> 'em_andamento' THEN
    RAISE EXCEPTION 'audit_chain_verifications: verificação concluída é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.scope <> OLD.scope OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'audit_chain_verifications: identidade da verificação é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Enquanto em andamento só a abrangência (max_audit_id_at_start) pode ser preenchida; qualquer resultado exige a transição para um estado final.
  IF NEW.status = 'em_andamento' AND (NEW.finished_at IS NOT NULL OR NEW.total_events IS NOT NULL OR NEW.verified_events IS NOT NULL OR NEW.unhashed_events IS NOT NULL OR NEW.divergence_count IS NOT NULL OR NEW.divergences <> '[]'::jsonb OR NEW.error_kind IS NOT NULL OR NEW.duration_ms IS NOT NULL) THEN
    RAISE EXCEPTION 'audit_chain_verifications: resultado só pode ser gravado junto da transição para um estado final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_chain_verifications_guard_update BEFORE UPDATE ON audit_chain_verifications FOR EACH ROW EXECUTE FUNCTION audit_chain_verifications_guard();
CREATE TRIGGER audit_chain_verifications_guard_delete BEFORE DELETE ON audit_chain_verifications FOR EACH ROW EXECUTE FUNCTION audit_chain_verifications_guard();

-- Paginação por cursor (id) dentro da organização e busca por identificador de correlação (presente nos metadados dos eventos M36/M37). Somente índices.
CREATE INDEX idx_audit_log_org_id ON audit_log (organization_id, id DESC);
CREATE INDEX idx_audit_log_correlation ON audit_log ((metadata ->> 'correlacao')) WHERE metadata ? 'correlacao';
