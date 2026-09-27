-- Levora Solidária — schema Postgres completo (portado do Floot)
-- Nomenclatura: snake_case no banco, camelCase no código (Kysely CamelCasePlugin faz a tradução).
-- Este arquivo é a fonte da verdade para recriar o banco fora do Floot.
-- Gerar com: psql "$DATABASE_URL" -f db/schema.sql

BEGIN;

-- ============================================================
-- Extensões
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Função utilitária: bloqueia UPDATE/DELETE em tabelas append-only
-- ============================================================
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Esta tabela é append-only: UPDATE e DELETE são proibidos (tentativa de % em %)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Fase 1 — Fundação: auth, organizações, membros, auditoria
-- ============================================================
CREATE TYPE user_role AS ENUM ('admin', 'user');

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  role user_role NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_passwords (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_accessed TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE login_attempts (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  success BOOLEAN DEFAULT false,
  attempted_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, attempted_at DESC);

CREATE TYPE organization_type AS ENUM ('igreja', 'organizacao_social', 'ponto_distribuicao');
CREATE TYPE organization_status AS ENUM ('ativa', 'em_analise', 'suspensa');
CREATE TYPE membership_role AS ENUM ('proprietario', 'administrador', 'operador', 'voluntario');
CREATE TYPE membership_status AS ENUM ('ativo', 'convidado', 'inativo');

CREATE TABLE organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type organization_type NOT NULL,
  status organization_status NOT NULL DEFAULT 'em_analise',
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  document_id TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'ativo',
  invited_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Hash encadeado (master prompt, seção 12; ver docs/AUDIT.md) — cadeia
  -- única e global, na ordem de inserção (id). Nulo é só o estado antes
  -- de recordAuditLogEntry preencher (nunca deveria acontecer em uso
  -- normal, já que a função sempre calcula os dois).
  previous_event_hash TEXT,
  event_hash TEXT
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE INDEX idx_audit_log_org ON audit_log(organization_id, created_at DESC);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- ============================================================
-- Fase 21 — Configuração de organização para matching automático
-- (capacidade por categoria, logística/horários, área de atendimento)
-- Ver docs/plano-implementacao.md, Fase 21/22, e opportunityMatching.tsx
-- (os 4 critérios que hoje ficam "nao_aplicavel" por falta destes dados).
-- ============================================================

-- Teto DECLARADO de capacidade por categoria — nunca um contador que sobe
-- e desce sozinho. "Disponível" é sempre calculado em tempo real como
-- max_capacity menos o saldo já existente em stock_transactions/
-- inventory_items da mesma categoria — de propósito, para não criar um
-- segundo sistema de estoque paralelo ao que já existe (e já é auditado).
-- category/unit são texto livre, na mesma convenção de inventory_items —
-- não existe uma taxonomia normalizada em nenhum lugar do sistema hoje;
-- comparação por categoria no matching usa normalize()/keywordScore(),
-- o mesmo mecanismo fuzzy já usado para comparar oportunidade x necessidade.
CREATE TABLE organization_capacities (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  max_capacity NUMERIC(12,3) NOT NULL CHECK (max_capacity >= 0),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, category, unit)
);
CREATE TRIGGER organization_capacities_set_updated_at BEFORE UPDATE ON organization_capacities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_organization_capacities_org ON organization_capacities(organization_id);

-- 1:1 com organizations — agrupa configuração de logística/horários para
-- matching num único lugar, sem alterar a tabela organizations em si
-- (que nunca teve um fluxo de edição pós-criação). raio_coleta_km e
-- observacoes_horarios são guardados desde já mas ainda não entram em
-- nenhum cálculo de distância real (sem geocodificação configurada) —
-- só para não exigir nova migration quando isso for implementado.
CREATE TABLE organization_matching_settings (
  organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  realiza_coleta BOOLEAN NOT NULL DEFAULT false,
  raio_coleta_km INTEGER CHECK (raio_coleta_km IS NULL OR raio_coleta_km > 0),
  observacoes_logisticas TEXT,
  observacoes_horarios TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER organization_matching_settings_set_updated_at BEFORE UPDATE ON organization_matching_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Municípios atendidos ALÉM da sede (organizations.city/state, que conta
-- implicitamente). Texto livre em pares (mesma convenção de
-- organizations.city/state e opportunity_registry.location_city/state) —
-- de propósito, não uma lista textual solta nem uma tabela de municípios
-- normalizada (não existe uma em nenhum outro lugar do sistema hoje).
CREATE TABLE organization_service_areas (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_organization_service_areas_org ON organization_service_areas(organization_id);
CREATE INDEX idx_organization_service_areas_location ON organization_service_areas(city, state);
CREATE UNIQUE INDEX idx_organization_service_areas_unique ON organization_service_areas(organization_id, lower(city), state);

-- ============================================================
-- Fase 2 — Inventário e necessidades
-- ============================================================
CREATE TYPE stock_transaction_type AS ENUM ('entrada', 'saida', 'ajuste');
CREATE TYPE need_priority AS ENUM ('baixa', 'media', 'alta', 'critica');
CREATE TYPE need_status AS ENUM ('aberta', 'atendida', 'cancelada');

CREATE TABLE inventory_items (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  category TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER inventory_items_set_updated_at BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_transactions (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  type stock_transaction_type NOT NULL,
  delta NUMERIC(12,3) NOT NULL CHECK (delta <> 0),
  reason TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_transactions_type_sign_chk CHECK (
    (type = 'entrada' AND delta > 0) OR (type = 'saida' AND delta < 0) OR (type = 'ajuste')
  )
);
CREATE TRIGGER stock_transactions_no_update BEFORE UPDATE ON stock_transactions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER stock_transactions_no_delete BEFORE DELETE ON stock_transactions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE INDEX idx_stock_transactions_item ON stock_transactions(item_id);
CREATE INDEX idx_stock_transactions_org ON stock_transactions(organization_id, created_at DESC);

CREATE TABLE needs (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  quantity_needed NUMERIC(12,3) NOT NULL CHECK (quantity_needed > 0),
  unit TEXT NOT NULL,
  priority need_priority NOT NULL DEFAULT 'media',
  status need_status NOT NULL DEFAULT 'aberta',
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER needs_set_updated_at BEFORE UPDATE ON needs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_needs_org ON needs(organization_id, status);

-- ============================================================
-- Fase 3 — Oportunidades de doação (modelo legado por-organização,
-- mantido por compatibilidade; substituído em uso real pelo
-- Registro Central de Oportunidades da Fase 4)
-- ============================================================
CREATE TYPE opportunity_status AS ENUM ('registrada', 'em_contato', 'confirmada', 'recebida', 'cancelada');

CREATE TABLE donation_opportunities (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  quantity_offered NUMERIC(12,3),
  unit TEXT,
  donor_name TEXT NOT NULL,
  donor_contact TEXT,
  linked_need_id INTEGER REFERENCES needs(id) ON DELETE SET NULL,
  status opportunity_status NOT NULL DEFAULT 'registrada',
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER donation_opportunities_set_updated_at BEFORE UPDATE ON donation_opportunities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Fase 4 — Registro Central de Oportunidades, Fontes e Conectores
-- ============================================================
CREATE TYPE source_type AS ENUM ('manual', 'site_publico', 'pesquisa_externa', 'pagina_empresarial', 'facebook_meta', 'x_twitter', 'email_autorizado', 'formulario', 'outro');
CREATE TYPE source_status AS ENUM ('ativa', 'pausada', 'nao_configurada', 'erro', 'desativada');

CREATE TABLE sources (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type source_type NOT NULL,
  connector_key TEXT NOT NULL,
  endpoint_or_address TEXT,
  access_method TEXT,
  status source_status NOT NULL DEFAULT 'nao_configurada',
  credential_ref TEXT,
  authorizing_organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  rate_limit_per_run INTEGER,
  policy_notes TEXT,
  connection_state TEXT NOT NULL DEFAULT 'nao_conectado',
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  run_frequency_minutes INTEGER,
  recent_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_validated_at TIMESTAMPTZ,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER sources_set_updated_at BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE opportunity_registry_status AS ENUM (
  'descoberta', 'em_verificacao', 'validada', 'aguardando_destinacao',
  'reservada', 'atribuida', 'aguardando_coleta', 'em_transporte', 'recebida', 'concluida',
  'recusada', 'expirada', 'cancelada', 'bloqueada', 'duplicada'
);
CREATE TYPE opportunity_urgency AS ENUM ('baixa', 'media', 'alta', 'critica');

CREATE TABLE opportunity_registry (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  discovered_by_user_id INTEGER REFERENCES users(id),
  discovery_agent TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  -- Mesma proteção que quantity_needed (needs) e quantity_allocated
  -- (opportunity_allocations) já têm — nula (quantidade desconhecida) é
  -- permitida, mas zero/negativa nunca é uma quantidade real de doação.
  -- Fecha uma lacuna estrutural: antes só a validação do Zod em
  -- opportunity-registry_POST.schema.ts impedia isso, sem constraint no
  -- banco (achado de auditoria do motor de matching, fase 22).
  quantity NUMERIC(12,3) CONSTRAINT opportunity_registry_quantity_positive_chk CHECK (quantity IS NULL OR quantity > 0),
  unit TEXT,
  condition TEXT,
  location_city TEXT,
  location_state TEXT,
  availability TEXT,
  origin_reference TEXT,
  origin_contact TEXT,
  urgency opportunity_urgency NOT NULL DEFAULT 'media',
  evidence_url TEXT,
  confidence SMALLINT CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  status opportunity_registry_status NOT NULL DEFAULT 'descoberta',
  status_reason TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER opportunity_registry_set_updated_at BEFORE UPDATE ON opportunity_registry FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_opportunity_registry_status ON opportunity_registry(status);
CREATE INDEX idx_opportunity_registry_source ON opportunity_registry(source_id);

CREATE TYPE allocation_status AS ENUM ('proposta', 'aceita', 'recusada', 'em_coleta', 'em_transporte', 'recebida', 'cancelada');

CREATE TABLE opportunity_allocations (
  id SERIAL PRIMARY KEY,
  opportunity_registry_id INTEGER NOT NULL REFERENCES opportunity_registry(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quantity_allocated NUMERIC(12,3) NOT NULL CHECK (quantity_allocated > 0),
  status allocation_status NOT NULL DEFAULT 'proposta',
  decided_by_user_id INTEGER REFERENCES users(id),
  notes TEXT,
  reserved_until TIMESTAMPTZ,
  auto_matched BOOLEAN NOT NULL DEFAULT false,
  match_evaluation_id INTEGER, -- FK adicionada após criação de match_evaluations (ver abaixo)
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER opportunity_allocations_set_updated_at BEFORE UPDATE ON opportunity_allocations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_opportunity_allocations_registry ON opportunity_allocations(opportunity_registry_id);
CREATE INDEX idx_opportunity_allocations_org ON opportunity_allocations(organization_id, status);
CREATE INDEX idx_opportunity_allocations_reserved_until ON opportunity_allocations(reserved_until) WHERE reserved_until IS NOT NULL;

-- ============================================================
-- Fase 5 — Motor de tarefas de fundo e Motor de correspondência
-- ============================================================
CREATE TYPE background_task_status AS ENUM ('pendente', 'executando', 'concluida', 'falhou', 'cancelada');

CREATE TABLE background_task_runs (
  id BIGSERIAL PRIMARY KEY,
  task_name TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status background_task_status NOT NULL DEFAULT 'pendente',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  priority INTEGER NOT NULL DEFAULT 0,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error JSONB,
  result JSONB,
  triggered_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER background_task_runs_set_updated_at BEFORE UPDATE ON background_task_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_background_task_runs_status ON background_task_runs(status, scheduled_for);
CREATE INDEX idx_background_task_runs_task_name ON background_task_runs(task_name, status);

CREATE TABLE match_evaluations (
  id BIGSERIAL PRIMARY KEY,
  opportunity_registry_id INTEGER NOT NULL REFERENCES opportunity_registry(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  need_id INTEGER REFERENCES needs(id) ON DELETE SET NULL,
  criteria JSONB NOT NULL,
  final_score NUMERIC(5,2) NOT NULL,
  algorithm_version TEXT NOT NULL,
  ai_model_used TEXT,
  decision TEXT NOT NULL,
  allocation_id INTEGER REFERENCES opportunity_allocations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_match_evaluations_registry ON match_evaluations(opportunity_registry_id);
CREATE INDEX idx_match_evaluations_org ON match_evaluations(organization_id);

ALTER TABLE opportunity_allocations
  ADD CONSTRAINT opportunity_allocations_match_evaluation_fk
  FOREIGN KEY (match_evaluation_id) REFERENCES match_evaluations(id) ON DELETE SET NULL;

-- ============================================================
-- Fase 29 — Ledger de atendimento de necessidades (need_fulfillments)
-- Ver db/migrations/0006_need_fulfillments.sql para o comentário completo.
-- ============================================================
CREATE TABLE need_fulfillments (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  need_id INTEGER REFERENCES needs(id) ON DELETE SET NULL,
  allocation_id INTEGER NOT NULL REFERENCES opportunity_allocations(id) ON DELETE CASCADE,
  stock_transaction_id BIGINT NOT NULL REFERENCES stock_transactions(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
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

-- ============================================================
-- Fase 6 — Logística (coleta, transporte, entrega)
-- ============================================================
CREATE TYPE logistics_event_type AS ENUM ('coleta_agendada', 'coleta_concluida', 'transporte_iniciado', 'entrega_confirmada', 'cancelado');

CREATE TABLE logistics_events (
  id BIGSERIAL PRIMARY KEY,
  opportunity_allocation_id INTEGER NOT NULL REFERENCES opportunity_allocations(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  event_type logistics_event_type NOT NULL,
  scheduled_for TIMESTAMPTZ,
  notes TEXT,
  proof_url TEXT,
  actor_user_id INTEGER REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER logistics_events_no_update BEFORE UPDATE ON logistics_events FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER logistics_events_no_delete BEFORE DELETE ON logistics_events FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE INDEX idx_logistics_events_allocation ON logistics_events(opportunity_allocation_id);

-- ============================================================
-- Fase 7 — Dupla autorização
-- ============================================================
CREATE TYPE approval_status AS ENUM ('pendente', 'aprovada', 'rejeitada', 'expirada');

CREATE TABLE approval_requests (
  id SERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  reason TEXT NOT NULL,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  status approval_status NOT NULL DEFAULT 'pendente',
  decided_by_user_id INTEGER REFERENCES users(id),
  decision_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX idx_approval_requests_status ON approval_requests(status, organization_id);

-- ============================================================
-- Fase 9 — Convite de membros por e-mail
-- ============================================================
-- Tabela própria em vez de reaproveitar memberships.status='convidado':
-- memberships.user_id é NOT NULL, então um convite só poderia ser
-- pré-criado ali se a pessoa convidada já tivesse conta — o que reduziria
-- o escopo do fluxo pedido (convidar qualquer e-mail, com ou sem conta
-- ainda existente). O token nunca é armazenado em texto puro (mesmo
-- princípio dos códigos de ativação de organização, seção 9 do master
-- prompt), só o hash.
CREATE TYPE organization_invite_status AS ENUM ('pendente', 'aceito', 'expirado', 'revogado');

CREATE TABLE organization_invites (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role membership_role NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status organization_invite_status NOT NULL DEFAULT 'pendente',
  invited_by_user_id INTEGER NOT NULL REFERENCES users(id),
  accepted_by_user_id INTEGER REFERENCES users(id),
  revoked_by_user_id INTEGER REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_organization_invites_org ON organization_invites(organization_id, status);
-- Impede reenviar um convite pendente duplicado para o mesmo e-mail na
-- mesma organização (o endpoint revoga o antigo antes de criar um novo).
CREATE UNIQUE INDEX idx_organization_invites_pending_unique ON organization_invites(organization_id, lower(email)) WHERE status = 'pendente';

-- ============================================================
-- Fase 11 — Upload real de arquivo (comprovação de entrega)
-- ============================================================
CREATE TABLE files (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  storage_provider TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_files_org ON files(organization_id);

COMMIT;
