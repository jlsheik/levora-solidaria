-- Fase 74 (Fase 1 de docs/AGENTES_ESPECIFICACAO.md) — plataforma de agentes. M33: reconciliada com a `master` e RENUMERADA (o rascunho local era `0014_agent_platform.sql`;
-- o número 0014 já pertence a `0014_allocation_response_deadline.sql`, e a sequência contígua 0001–0031 está publicada — o próximo número livre é 0032). Conteúdo conferido
-- contra o schema atual: nenhum objeto desta migration existe antes dela (tabelas, tipos, colunas e índices abaixo são todos novos).
-- Nenhum agente existe ainda: esta migration cria só a fundação (agente como
-- principal não humano, barramento de eventos, limites de política,
-- controles de pausa/emergência, alertas de integridade e fila de exceções).
--
-- Regra herdada do incidente da Fase 66/need_fulfillments: nenhuma FK nova
-- usa ON DELETE CASCADE/SET NULL contra tabelas append-only, porque o
-- trigger audit_log_block_mutation bloquearia a ação referencial.

-- ---------------------------------------------------------------
-- Agente como principal não humano
-- ---------------------------------------------------------------
CREATE TABLE agent_principals (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  -- NULL = agente global (opera em qualquer organização, sempre explícita
  -- no pedido); preenchido = agente restrito àquela organização.
  organization_id INTEGER REFERENCES organizations(id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_agent_principals_scope ON agent_principals (name, COALESCE(organization_id, 0));
CREATE TRIGGER agent_principals_set_updated_at BEFORE UPDATE ON agent_principals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------
-- audit_log: quem agiu (usuário, agente ou sistema)
-- ---------------------------------------------------------------
CREATE TYPE audit_actor_type AS ENUM ('user', 'agent', 'system');
ALTER TABLE audit_log
  ADD COLUMN actor_type audit_actor_type NOT NULL DEFAULT 'user',
  ADD COLUMN actor_agent_principal_id INTEGER REFERENCES agent_principals(id);
CREATE INDEX idx_audit_log_agent ON audit_log(actor_agent_principal_id) WHERE actor_agent_principal_id IS NOT NULL;

-- ---------------------------------------------------------------
-- Barramento de eventos (outbox no Postgres)
-- ---------------------------------------------------------------
CREATE TABLE domain_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  organization_id INTEGER REFERENCES organizations(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  -- Só fatos mínimos e ids; nunca dado pessoal.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON domain_events FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE INDEX idx_domain_events_type ON domain_events(event_type, id);

CREATE TABLE domain_event_consumptions (
  event_id BIGINT NOT NULL REFERENCES domain_events(id),
  consumer TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'erro')),
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

-- ---------------------------------------------------------------
-- Limites de política (seção 79 do master prompt)
-- ---------------------------------------------------------------
CREATE TABLE policy_limits (
  id SERIAL PRIMARY KEY,
  -- NULL = limite global; preenchido = restrição da organização, que só
  -- pode ser mais restritiva que o global (validado na aplicação).
  organization_id INTEGER REFERENCES organizations(id),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_policy_limits_scope ON policy_limits (COALESCE(organization_id, 0), key);

-- ---------------------------------------------------------------
-- Pausar automação / modo emergência (seções 91-92)
-- ---------------------------------------------------------------
CREATE TABLE automation_controls (
  id SERIAL PRIMARY KEY,
  -- NULL = global.
  organization_id INTEGER REFERENCES organizations(id),
  paused BOOLEAN NOT NULL DEFAULT false,
  emergency BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  changed_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT emergency OR paused)
);
CREATE UNIQUE INDEX idx_automation_controls_scope ON automation_controls (COALESCE(organization_id, 0));

-- ---------------------------------------------------------------
-- Centro de alertas de integridade (seção 42)
-- ---------------------------------------------------------------
CREATE TYPE integrity_alert_level AS ENUM ('alto_risco', 'operacional', 'seguranca');
CREATE TYPE integrity_alert_status AS ENUM ('aberto', 'reconhecido', 'resolvido', 'descartado');

CREATE TABLE integrity_alerts (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  level integrity_alert_level NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_type TEXT,
  entity_id TEXT,
  -- Evita alerta duplicado enquanto o anterior ainda está aberto/reconhecido.
  dedupe_key TEXT,
  status integrity_alert_status NOT NULL DEFAULT 'aberto',
  created_by_agent_principal_id INTEGER REFERENCES agent_principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by_user_id INTEGER REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  resolved_by_user_id INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);
CREATE UNIQUE INDEX idx_integrity_alerts_dedupe_open
  ON integrity_alerts (COALESCE(organization_id, 0), dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('aberto', 'reconhecido');
CREATE INDEX idx_integrity_alerts_org_status ON integrity_alerts(organization_id, status, created_at DESC);

-- ---------------------------------------------------------------
-- Fila de exceções (seção 45): a automação parou por uma regra de proteção
-- ---------------------------------------------------------------
CREATE TYPE exception_status AS ENUM ('pendente', 'aprovada', 'rejeitada');

CREATE TABLE exception_queue (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  agent_principal_id INTEGER NOT NULL REFERENCES agent_principals(id),
  tool_name TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  -- 1 = revisão simples; 2 = dupla autorização (duas pessoas diferentes).
  approvals_required INTEGER NOT NULL DEFAULT 1 CHECK (approvals_required IN (1, 2)),
  request JSONB NOT NULL,
  request_hash TEXT NOT NULL,
  status exception_status NOT NULL DEFAULT 'pendente',
  -- Preenchido quando o agente reexecuta a ação já aprovada (uso único).
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exception_queue_org_status ON exception_queue(organization_id, status, created_at DESC);

CREATE TABLE exception_decisions (
  exception_id BIGINT NOT NULL REFERENCES exception_queue(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('aprovar', 'rejeitar')),
  notes TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (exception_id, user_id)
);
CREATE TRIGGER exception_decisions_no_update BEFORE UPDATE ON exception_decisions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER exception_decisions_no_delete BEFORE DELETE ON exception_decisions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
