-- M36 — reavaliação CONTROLADA de execuções do motor com `dados_insuficientes`. Cada pedido de nova análise vira uma linha aqui: quem pediu, quando, a decisão/explicação ANTERIOR (cópia,
-- nunca apagada), a origem verificável dos dados novos (tabela/registro/campo) e o resultado final. A execução original e o evento (imutável por gatilho) NÃO são reescritos: a nova avaliação é
-- registrada separadamente e vinculada à anterior por `run_id` + `correlation_id`.
--
-- Nenhum objeto desta migration existe antes dela; depende de agent_event_runs (0033), organizations e users. Preserva 0032–0034 (nenhuma reescrita). Sem backfill: nenhuma linha é criada
-- para execuções existentes. Sem ON DELETE CASCADE/SET NULL.
--
-- Garantias estruturais: a linha só pode ser atualizada UMA vez, de `iniciada` para um resultado final (o gatilho recusa qualquer outra mudança e qualquer DELETE).

CREATE TABLE agent_event_reevaluations (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES agent_event_runs(id),
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT CONSTRAINT agent_event_reevaluations_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 300),
  supplement JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_status TEXT NOT NULL,
  previous_decision TEXT,
  previous_explanation JSONB,
  outcome TEXT NOT NULL CONSTRAINT agent_event_reevaluations_outcome_chk CHECK (outcome IN ('iniciada', 'concluida', 'ainda_insuficiente', 'bloqueada')),
  new_status TEXT,
  new_decision TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_agent_event_reevaluations_run ON agent_event_reevaluations (run_id, id);
CREATE INDEX idx_agent_event_reevaluations_org ON agent_event_reevaluations (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION agent_event_reevaluations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_event_reevaluations é append-only: DELETE não é permitido';
  END IF;
  IF OLD.outcome <> 'iniciada' OR OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'agent_event_reevaluations: a linha já tem resultado final e não pode mais ser alterada';
  END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.organization_id <> OLD.organization_id OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.correlation_id <> OLD.correlation_id
     OR NEW.previous_status <> OLD.previous_status OR NEW.previous_decision IS DISTINCT FROM OLD.previous_decision OR NEW.previous_explanation IS DISTINCT FROM OLD.previous_explanation
     OR NEW.supplement IS DISTINCT FROM OLD.supplement OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'agent_event_reevaluations: só o resultado final (outcome, new_status, new_decision, finished_at) pode ser preenchido';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agent_event_reevaluations_no_delete BEFORE DELETE ON agent_event_reevaluations FOR EACH ROW EXECUTE FUNCTION agent_event_reevaluations_guard();
CREATE TRIGGER agent_event_reevaluations_guard_update BEFORE UPDATE ON agent_event_reevaluations FOR EACH ROW EXECUTE FUNCTION agent_event_reevaluations_guard();
