-- M34 — motor de eventos dos agentes (simulado). Registro durável do processamento de cada evento interno por cada agente:
-- `agent_event_runs` guarda o estado ATUAL (recebido → validado → ... → simulação concluída) e `agent_event_run_history` guarda cada TRANSIÇÃO (append-only, nunca apagada).
--
-- Nenhum objeto desta migration existe antes dela (tabelas e índices são novos); depende só de objetos criados antes: domain_events, exception_queue, agent_principals,
-- organizations, users e o tipo audit_actor_type (0032), e da função audit_log_block_mutation (já usada pelos gatilhos de imutabilidade).
--
-- Garantias estruturais (não dependem de a aplicação "lembrar"):
--   * `simulated` é sempre true (CHECK): não existe linha de "execução real" — nesta fase o motor NUNCA executa ação externa.
--   * UNIQUE (event_id, agent_principal_id): um evento é avaliado por um agente uma única vez (idempotência), mesmo sob concorrência.
--   * O histórico não aceita UPDATE nem DELETE (gatilho), então tentar de novo não apaga a decisão anterior.
-- Sem ON DELETE CASCADE/SET NULL contra tabelas append-only (regra herdada do incidente da Fase 66).

CREATE TABLE agent_event_runs (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES domain_events(id),
  agent_principal_id INTEGER NOT NULL REFERENCES agent_principals(id),
  -- NULL só para evento malformado sem organização (fica 'ignorado'); a tela da organização nunca o enxerga.
  organization_id INTEGER REFERENCES organizations(id),
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recebido', 'validado', 'ignorado', 'bloqueado_politica', 'aguardando_aprovacao', 'rejeitado', 'autorizado_simulacao', 'simulacao_concluida', 'falha')),
  reason_code TEXT,
  reason TEXT,
  rule_code TEXT,
  exception_id BIGINT REFERENCES exception_queue(id),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  simulated BOOLEAN NOT NULL DEFAULT true CHECK (simulated),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_event_runs_event_agent_key UNIQUE (event_id, agent_principal_id)
);
CREATE INDEX idx_agent_event_runs_org_status ON agent_event_runs (organization_id, status, id DESC);
CREATE INDEX idx_agent_event_runs_exception ON agent_event_runs (exception_id) WHERE exception_id IS NOT NULL;
CREATE TRIGGER agent_event_runs_set_updated_at BEFORE UPDATE ON agent_event_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agent_event_run_history (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES agent_event_runs(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason_code TEXT,
  actor_type audit_actor_type NOT NULL DEFAULT 'agent',
  actor_user_id INTEGER REFERENCES users(id),
  exception_id BIGINT REFERENCES exception_queue(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_event_run_history_run ON agent_event_run_history (run_id, id);
CREATE TRIGGER agent_event_run_history_no_update BEFORE UPDATE ON agent_event_run_history FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER agent_event_run_history_no_delete BEFORE DELETE ON agent_event_run_history FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
