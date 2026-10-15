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

-- Fase 48: UNIQUE(email) acima é case-sensível — sem isto, "Teste@x.com" e
-- "teste@x.com" coexistiam como identidades diferentes (achado SEC-02 da
-- auditoria de segurança). Mesmo padrão já usado em
-- idx_organization_invites_pending_unique abaixo, para o mesmo problema
-- noutro contexto (ver db/migrations/0013_users_email_case_insensitive.sql).
CREATE UNIQUE INDEX idx_users_email_lower ON users (LOWER(email));

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
  ),
  -- Fase 33 (0010): (id, organization_id) único — id já é PK, mas o
  -- Postgres exige um UNIQUE explícito nas colunas exatas para servir de
  -- lado referenciado de uma FK composta (ver need_fulfillments abaixo,
  -- que usa isso para garantir que um fulfillment nunca referencie
  -- fisicamente um stock_transaction de outra organização).
  CONSTRAINT stock_transactions_id_organization_id_key UNIQUE (id, organization_id)
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Fase 45 (0012): suporta a FK composta de opportunity_allocations.need_id
  -- (garante que uma allocation nunca referencie a need de outra
  -- organização) — id já é PK (único), só falta o UNIQUE explícito nas
  -- colunas exatas exigido pelo Postgres para ser o lado referenciado.
  CONSTRAINT needs_id_organization_id_key UNIQUE (id, organization_id)
);
CREATE TRIGGER needs_set_updated_at BEFORE UPDATE ON needs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_needs_org ON needs(organization_id, status);

-- ============================================================
-- Fase 40 (0011) — need_resolutions: resolução ADMINISTRATIVA da própria
-- need via needs-status_POST (consumo do estoque PRÓPRIO da organização,
-- ou uma declaração puramente administrativa quando a need não tem item
-- vinculado). NÃO é o Modelo B — need_fulfillments continua exclusivamente
-- sobre recebimentos de doações da REDE Levora, sempre ligados a uma
-- allocation; need_resolutions nunca tem allocation nenhuma, nunca é
-- gerada pelo motor de matching.
--
-- Achado de auditoria (Fase 38, reproduzido deterministicamente): sem
-- esta entidade, needs-status_POST só olhava o status IMEDIATAMENTE
-- anterior para decidir se dava baixa de estoque — o ciclo
-- aberta→atendida→aberta→atendida gerava uma SEGUNDA baixa de estoque
-- próprio para a mesma necessidade, porque nada registrava "isto já
-- aconteceu" de forma estrutural. Investigação da Fase 39 confirmou (pela
-- documentação original da Fase 10) que a intenção sempre foi UMA
-- resolução por necessidade, nunca uma por ciclo de status — o
-- comportamento repetível era uma lacuna, não um design intencional.
--
-- UNIQUE(need_id): no máximo uma resolução por need, por toda a vida da
-- necessidade — garante estruturalmente que reabrir e reatender
-- (needs.status continua livre, nunca uma máquina de estados) nunca
-- produz uma segunda baixa, não importa quantos ciclos administrativos
-- aconteçam depois.
--
-- Multi-tenancy: sem organization_id redundante — need_id já aponta para
-- uma need, que já pertence a uma organização (única fonte de verdade).
--
-- stock_transaction_id NULLABLE: NULL quando a need não tem item
-- vinculado (resolução puramente declarativa); índice único parcial
-- garante que o mesmo movimento físico nunca seja reaproveitado por duas
-- resoluções.
--
-- Append-only (mesma trigger audit_log_block_mutation de
-- audit_log/stock_transactions/need_fulfillments): uma resolução, uma vez
-- criada, nunca é alterada nem apagada.
-- ============================================================
CREATE TABLE need_resolutions (
  id SERIAL PRIMARY KEY,
  need_id INTEGER NOT NULL REFERENCES needs(id) ON DELETE RESTRICT,
  stock_transaction_id BIGINT REFERENCES stock_transactions(id) ON DELETE RESTRICT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (need_id)
);
CREATE UNIQUE INDEX idx_need_resolutions_stock_transaction ON need_resolutions(stock_transaction_id) WHERE stock_transaction_id IS NOT NULL;
CREATE TRIGGER need_resolutions_no_update BEFORE UPDATE ON need_resolutions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER need_resolutions_no_delete BEFORE DELETE ON need_resolutions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Fase 45 (0012): need_id opcional, escolhida explicitamente pelo
  -- platformAdmin no momento da criação de uma allocation MANUAL (nunca
  -- inferida). É a fonte de INTENÇÃO ("esta allocation destina-se a esta
  -- need") — createNeedFulfillment passa a resolver need_id também a
  -- partir daqui quando não houver match_evaluations (allocations
  -- automáticas continuam usando match_evaluations; as duas fontes nunca
  -- coexistem para a mesma allocation). FK adicionada abaixo, depois de
  -- needs já existir.
  need_id INTEGER,
  -- Fase 98 (0014): prazo de resposta da atribuição AUTOMÁTICA (gravado na criação; NULL = sem prazo) e motivo/instante do encerramento pelo sistema.
  response_due_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closed_reason TEXT CONSTRAINT opportunity_allocations_closed_reason_chk CHECK (closed_reason IS NULL OR closed_reason IN (
    'prazo_expirado', 'reserva_expirada', 'oferta_cancelada_admin', 'oferta_expirada_admin', 'oferta_expirada_automatica', 'oferta_encerrada'
  ))
);
CREATE TRIGGER opportunity_allocations_set_updated_at BEFORE UPDATE ON opportunity_allocations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_opportunity_allocations_registry ON opportunity_allocations(opportunity_registry_id);
CREATE INDEX idx_opportunity_allocations_response_due ON opportunity_allocations(response_due_at) WHERE response_due_at IS NOT NULL AND status = 'aceita';
CREATE INDEX idx_opportunity_allocations_org ON opportunity_allocations(organization_id, status);
CREATE INDEX idx_opportunity_allocations_need ON opportunity_allocations(need_id) WHERE need_id IS NOT NULL;
-- FK composta (Fase 45): garante estruturalmente que uma allocation nunca
-- referencie a need de outra organização — nunca só validado em
-- TypeScript (mesmo princípio da FK composta de
-- need_fulfillments.stock_transaction_id, Fase 33). MATCH SIMPLE (padrão
-- do Postgres) satisfaz trivialmente quando need_id é NULL.
ALTER TABLE opportunity_allocations
  ADD CONSTRAINT opportunity_allocations_need_org_fkey
  FOREIGN KEY (need_id, organization_id) REFERENCES needs (id, organization_id) ON DELETE RESTRICT;
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
-- Único (não só indexado): confirmado por auditoria que uma allocation_id
-- nunca aparece em mais de uma linha (gravado só no momento em que o
-- motor cria aquela allocation específica) — acelera a resolução de
-- needId em need_fulfillments (Fase 29) e expressa essa garantia real.
CREATE UNIQUE INDEX idx_match_evaluations_allocation_id ON match_evaluations(allocation_id) WHERE allocation_id IS NOT NULL;

ALTER TABLE opportunity_allocations
  ADD CONSTRAINT opportunity_allocations_match_evaluation_fk
  FOREIGN KEY (match_evaluation_id) REFERENCES match_evaluations(id) ON DELETE SET NULL;

-- ============================================================
-- Fase 29 — Ledger de atendimento de necessidades (need_fulfillments)
-- Fase 30 — FKs RESTRICT (0007) e evolução para ledger de EVENTOS (0008)
-- Fase 32 — Regras de herança/integridade do Modelo B (0009)
-- Fase 33 — Isolamento multi-tenant do lastro físico (0010)
-- Ver db/migrations/0006_need_fulfillments.sql, 0007_need_fulfillments_fk_restrict.sql,
-- 0008_need_fulfillments_ledger_of_events.sql, 0009_need_fulfillments_inheritance_rules.sql
-- e 0010_need_fulfillments_stock_transaction_org_fk.sql para os comentários completos.
--
-- RESTRICT (não CASCADE/SET NULL) em organization_id/need_id/allocation_id:
-- need_fulfillments é append-only (trigger audit_log_block_mutation), e uma
-- ação de FK que exigisse o Postgres alterar/apagar a própria linha do
-- ledger para honrar a exclusão de uma linha-pai seria bloqueada por esse
-- mesmo trigger, fazendo o DELETE da linha-pai falhar por inteiro —
-- confirmado por reprodução. RESTRICT torna essa incompatibilidade
-- explícita na própria FK.
--
-- entry_type ('original'/'correction'/'reversal') + is_countable +
-- reverses_fulfillment_id: permitem registrar correções/reversões como
-- novas linhas (nunca UPDATE/DELETE) sem perder a relação com a need —
-- inclusive quando a unidade do recebimento é incompatível
-- (is_countable=false, need_id preservado, nunca NULL). Validação cruzada
-- de entry_type/reverses_fulfillment_id feita por trigger BEFORE INSERT
-- (need_fulfillments_validate_entry) — não expressável só com CHECK/FK
-- simples. stock_transaction_id é NULLABLE porque uma correção
-- puramente de metadado (need_id/is_countable errados, item físico já
-- certo) não tem motivo de negócio para um novo lançamento de estoque;
-- 'original' continua exigindo um valor real, validado pelo trigger.
--
-- Semântica exata (confirmada estrutural, não só documentada):
--   'original'   — não referencia nada; exige stock_transaction_id real.
--   'correction' — SEMPRE exige reverses_fulfillment_id (nunca opcional);
--                  pode referenciar 'original' ou 'correction' (nunca
--                  'reversal'); herda organization_id/need_id do alvo;
--                  unit/quantity/is_countable ficam LIVRES (é exatamente
--                  o que uma correction pode precisar mudar).
--   'reversal'   — SEMPRE exige reverses_fulfillment_id; mesmas regras de
--                  referência de 'correction'; além de organization_id/
--                  need_id, herda TAMBÉM unit/quantity/is_countable do
--                  alvo — um reversal é definido como "a reversão direta
--                  do evento apontado", nunca um evento com dados
--                  próprios. Só uma reversal direta é permitida por alvo
--                  (índice único parcial abaixo). O sinal contábil
--                  (-quantity) nunca é armazenado como valor negativo —
--                  quantity continua sempre positiva (CHECK inalterado);
--                  o sinal é sempre derivado de entry_type por quem lê.
-- Cadeias (correction→correction, reversal→correction) são permitidas
-- deliberadamente — não é imposta uma topologia "estrela" (tudo apontando
-- só para o original), porque isso dificultaria reverter uma correction
-- específica. Ciclos são estruturalmente impossíveis: reverses_fulfillment_id
-- só pode apontar para uma linha que já existe no momento do INSERT, e o
-- append-only impede qualquer linha já commitada de ser alterada depois
-- para apontar "para trás" — confirmado por reprodução, não só por
-- argumento lógico.
--
-- Fase 33 — lastro físico (stock_transaction_id): FK composta
-- (stock_transaction_id, organization_id) → stock_transactions(id,
-- organization_id) garante ESTRUTURALMENTE que o movimento físico
-- referenciado pertence à mesma organização do fulfillment — antes disso
-- (Fases 29-32) só a FK simples (id) existia, e nada impedia
-- estruturalmente um fulfillment de organization_id=A referenciar um
-- stock_transaction de organization_id=B (achado de auditoria,
-- confirmado por reprodução em transação temporária). UNIQUE
-- (stock_transaction_id) continua garantindo que um mesmo movimento
-- físico só possa ser usado por UMA linha do ledger; múltiplos NULL
-- continuam permitidos nativamente pelo Postgres.
--
-- Compatibilidade FÍSICA além da organização (item, unidade, quantidade,
-- direção do movimento) permanece SEM validação estrutural — investigado
-- e documentado como lacuna conhecida, não como omissão: a cadeia
-- allocation → opportunity_registry / match_evaluations não carrega
-- item_id em nenhum ponto (opportunity_registry só descreve o item como
-- texto livre category/quantity/unit); needs.item_id existe mas é
-- NULLABLE; e need_fulfillments.need_id só é preenchido quando existe uma
-- linha em match_evaluations para aquela allocation (nunca para
-- allocations manuais). Não existe, hoje, uma fonte canônica e sempre
-- presente do item/unidade/quantidade/direção esperados para validar
-- contra o stock_transaction referenciado — adicionar isso exigiria uma
-- nova coluna (ex.: item_id em need_fulfillments) sem necessidade de
-- negócio comprovada; fica registrado como decisão arquitetural futura,
-- não implementada por instrução explícita.
-- ============================================================
CREATE TABLE need_fulfillments (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  need_id INTEGER REFERENCES needs(id) ON DELETE RESTRICT,
  allocation_id INTEGER NOT NULL REFERENCES opportunity_allocations(id) ON DELETE RESTRICT,
  stock_transaction_id BIGINT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  unit_mismatch_note TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_type TEXT NOT NULL DEFAULT 'original' CONSTRAINT need_fulfillments_entry_type_chk CHECK (entry_type IN ('original', 'correction', 'reversal')),
  is_countable BOOLEAN NOT NULL DEFAULT true,
  reverses_fulfillment_id BIGINT REFERENCES need_fulfillments(id) ON DELETE RESTRICT,
  UNIQUE (stock_transaction_id),
  -- Fase 33 (0010): FK composta (não mais uma FK simples em
  -- stock_transaction_id sozinho) — garante estruturalmente que o
  -- stock_transaction referenciado pertence à MESMA organização deste
  -- fulfillment (nunca só validado em TypeScript). Com MATCH SIMPLE
  -- (padrão do Postgres), é trivialmente satisfeita quando
  -- stock_transaction_id é NULL — não afeta em nada o suporte a
  -- correction/reversal interpretativos (sem movimento físico).
  CONSTRAINT need_fulfillments_stock_transaction_org_fkey
    FOREIGN KEY (stock_transaction_id, organization_id)
    REFERENCES stock_transactions (id, organization_id)
    ON DELETE RESTRICT
);
CREATE TRIGGER need_fulfillments_no_update BEFORE UPDATE ON need_fulfillments FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER need_fulfillments_no_delete BEFORE DELETE ON need_fulfillments FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE INDEX idx_need_fulfillments_need ON need_fulfillments(need_id);
CREATE INDEX idx_need_fulfillments_org ON need_fulfillments(organization_id, created_at DESC);
CREATE INDEX idx_need_fulfillments_reverses ON need_fulfillments(reverses_fulfillment_id) WHERE reverses_fulfillment_id IS NOT NULL;
-- No máximo UMA linha 'original' por allocation — correções/reversões
-- repetem a mesma allocation_id livremente (ver comentário acima).
CREATE UNIQUE INDEX idx_need_fulfillments_one_original_per_allocation ON need_fulfillments(allocation_id) WHERE entry_type = 'original';
-- No máximo UMA reversal direta por linha revertida — impede duas
-- reversões (sequenciais OU concorrentes) do mesmo alvo; o banco é a
-- última barreira, não só uma checagem de aplicação.
CREATE UNIQUE INDEX idx_need_fulfillments_one_reversal_per_target ON need_fulfillments(reverses_fulfillment_id) WHERE entry_type = 'reversal';
-- Histórico completo por allocation (original + corrections + reversals)
-- — o índice único parcial acima só cobre a linha 'original'.
CREATE INDEX idx_need_fulfillments_allocation_history ON need_fulfillments(allocation_id, created_at);

CREATE OR REPLACE FUNCTION need_fulfillments_validate_entry() RETURNS TRIGGER AS $$
DECLARE
  target RECORD;
BEGIN
  IF NEW.entry_type = 'original' THEN
    IF NEW.reverses_fulfillment_id IS NOT NULL THEN
      RAISE EXCEPTION 'need_fulfillments: entry_type=original não pode ter reverses_fulfillment_id';
    END IF;
    IF NEW.stock_transaction_id IS NULL THEN
      RAISE EXCEPTION 'need_fulfillments: entry_type=original exige stock_transaction_id (representa um recebimento físico real)';
    END IF;
  ELSE
    IF NEW.reverses_fulfillment_id IS NULL THEN
      RAISE EXCEPTION 'need_fulfillments: entry_type=% exige reverses_fulfillment_id', NEW.entry_type;
    END IF;

    SELECT organization_id, allocation_id, need_id, entry_type, unit, quantity, is_countable
      INTO target
      FROM need_fulfillments
      WHERE id = NEW.reverses_fulfillment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'need_fulfillments: reverses_fulfillment_id % não encontrado', NEW.reverses_fulfillment_id;
    END IF;

    IF target.entry_type = 'reversal' THEN
      RAISE EXCEPTION 'need_fulfillments: não é permitido referenciar (corrigir/reverter) uma linha que já é entry_type=reversal';
    END IF;

    IF target.allocation_id IS DISTINCT FROM NEW.allocation_id THEN
      RAISE EXCEPTION 'need_fulfillments: reverses_fulfillment_id precisa pertencer à mesma allocation_id';
    END IF;

    IF target.organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'need_fulfillments: organization_id precisa ser igual ao da linha referenciada por reverses_fulfillment_id';
    END IF;

    IF target.need_id IS DISTINCT FROM NEW.need_id THEN
      RAISE EXCEPTION 'need_fulfillments: need_id é herdado da linha referenciada (reverses_fulfillment_id), nunca escolhido livremente';
    END IF;

    IF NEW.entry_type = 'reversal' THEN
      IF NEW.unit IS DISTINCT FROM target.unit THEN
        RAISE EXCEPTION 'need_fulfillments: reversal precisa ter a mesma unit da linha revertida';
      END IF;
      IF NEW.quantity IS DISTINCT FROM target.quantity THEN
        RAISE EXCEPTION 'need_fulfillments: reversal precisa ter a mesma quantity da linha revertida';
      END IF;
      IF NEW.is_countable IS DISTINCT FROM target.is_countable THEN
        RAISE EXCEPTION 'need_fulfillments: reversal precisa ter o mesmo is_countable da linha revertida';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER need_fulfillments_validate_entry_trigger
  BEFORE INSERT ON need_fulfillments
  FOR EACH ROW EXECUTE FUNCTION need_fulfillments_validate_entry();

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

-- ============================================================
-- Fase 98 (0015) — configuração GLOBAL do prazo das atribuições automáticas (linha única; sem linha = 72 h)
-- ============================================================
CREATE TABLE platform_assignment_settings (
  id SMALLINT PRIMARY KEY CONSTRAINT platform_assignment_settings_singleton_chk CHECK (id = 1),
  response_deadline_hours INTEGER NOT NULL DEFAULT 72 CONSTRAINT platform_assignment_settings_hours_chk CHECK (response_deadline_hours BETWEEN 1 AND 720),
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Fase 99C (0016) — regularização auditável de unidades (casos + eventos append-only)
-- ============================================================
CREATE TABLE unit_regularization_cases (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CONSTRAINT unit_regularization_cases_source_type_chk CHECK (source_type IN ('allocation', 'local_donation')),
  allocation_id INTEGER REFERENCES opportunity_allocations(id) ON DELETE RESTRICT,
  donation_opportunity_id INTEGER REFERENCES donation_opportunities(id) ON DELETE RESTRICT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  divergence_kind TEXT NOT NULL CONSTRAINT unit_regularization_cases_divergence_chk CHECK (divergence_kind IN ('unidade_ausente', 'unidade_diferente', 'unidade_nao_classificada')),
  offered_quantity NUMERIC(12,3) CONSTRAINT unit_regularization_cases_offered_qty_chk CHECK (offered_quantity IS NULL OR offered_quantity > 0),
  offered_unit TEXT,
  informed_quantity NUMERIC(12,3) NOT NULL CONSTRAINT unit_regularization_cases_informed_qty_chk CHECK (informed_quantity > 0),
  item_unit TEXT NOT NULL,
  receipt_notes TEXT,
  category TEXT NOT NULL DEFAULT 'a_classificar' CONSTRAINT unit_regularization_cases_category_chk CHECK (category IN ('a_classificar', 'erro_cadastral', 'conferencia_fisica', 'conversao_nao_suportada', 'informacao_insuficiente')),
  status TEXT NOT NULL DEFAULT 'aberto' CONSTRAINT unit_regularization_cases_status_chk CHECK (status IN ('aberto', 'conferido', 'resolvido', 'corrigido', 'encerrado')),
  opened_by_user_id INTEGER NOT NULL REFERENCES users(id),
  checked_quantity NUMERIC(12,3) CONSTRAINT unit_regularization_cases_checked_qty_chk CHECK (checked_quantity IS NULL OR checked_quantity > 0),
  checked_unit TEXT,
  divergence_reason TEXT,
  conferred_by_user_id INTEGER REFERENCES users(id),
  conferred_at TIMESTAMPTZ,
  validated_by_user_id INTEGER REFERENCES users(id),
  validated_at TIMESTAMPTZ,
  without_second_validation BOOLEAN NOT NULL DEFAULT false,
  resolved_stock_transaction_id BIGINT,
  closed_reason TEXT,
  closed_by_user_id INTEGER REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unit_regularization_cases_id_organization_id_key UNIQUE (id, organization_id),
  CONSTRAINT unit_regularization_cases_stock_org_fkey FOREIGN KEY (resolved_stock_transaction_id, organization_id) REFERENCES stock_transactions (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT unit_regularization_cases_source_ref_chk CHECK (
    (source_type = 'allocation' AND allocation_id IS NOT NULL AND donation_opportunity_id IS NULL)
    OR (source_type = 'local_donation' AND donation_opportunity_id IS NOT NULL AND allocation_id IS NULL)
  ),
  CONSTRAINT unit_regularization_cases_resolved_chk CHECK (
    status <> 'resolvido' OR (checked_quantity IS NOT NULL AND checked_unit IS NOT NULL AND divergence_reason IS NOT NULL AND conferred_by_user_id IS NOT NULL AND validated_by_user_id IS NOT NULL AND resolved_stock_transaction_id IS NOT NULL)
  ),
  CONSTRAINT unit_regularization_cases_conferred_chk CHECK (
    status <> 'conferido' OR (checked_quantity IS NOT NULL AND checked_unit IS NOT NULL AND divergence_reason IS NOT NULL AND conferred_by_user_id IS NOT NULL)
  ),
  CONSTRAINT unit_regularization_cases_closed_chk CHECK (
    status NOT IN ('encerrado', 'corrigido') OR (closed_reason IS NOT NULL AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL)
  )
);
-- No máximo UM caso ativo (aberto ou conferido) por atribuição e por doação local: é a garantia de idempotência do recebimento com divergência.
CREATE UNIQUE INDEX uq_unit_regularization_active_allocation ON unit_regularization_cases(allocation_id) WHERE allocation_id IS NOT NULL AND status IN ('aberto', 'conferido');
CREATE UNIQUE INDEX uq_unit_regularization_active_donation ON unit_regularization_cases(donation_opportunity_id) WHERE donation_opportunity_id IS NOT NULL AND status IN ('aberto', 'conferido');
CREATE INDEX idx_unit_regularization_org_status ON unit_regularization_cases(organization_id, status, created_at);
CREATE TRIGGER unit_regularization_cases_set_updated_at BEFORE UPDATE ON unit_regularization_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION unit_regularization_case_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'aberto' THEN RAISE EXCEPTION 'unit_regularization_cases: um caso nasce aberto'; END IF;
    IF NEW.allocation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM opportunity_allocations a WHERE a.id = NEW.allocation_id AND a.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'unit_regularization_cases: a atribuição não pertence à organização do caso';
    END IF;
    IF NEW.donation_opportunity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM donation_opportunities d WHERE d.id = NEW.donation_opportunity_id AND d.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'unit_regularization_cases: a doação não pertence à organização do caso';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inventory_items i WHERE i.id = NEW.item_id AND i.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'unit_regularization_cases: o item não pertence à organização do caso';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: os fatos de origem não mudam nunca
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.allocation_id IS DISTINCT FROM OLD.allocation_id OR NEW.donation_opportunity_id IS DISTINCT FROM OLD.donation_opportunity_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.divergence_kind IS DISTINCT FROM OLD.divergence_kind
     OR NEW.offered_quantity IS DISTINCT FROM OLD.offered_quantity OR NEW.offered_unit IS DISTINCT FROM OLD.offered_unit
     OR NEW.informed_quantity IS DISTINCT FROM OLD.informed_quantity OR NEW.item_unit IS DISTINCT FROM OLD.item_unit
     OR NEW.receipt_notes IS DISTINCT FROM OLD.receipt_notes
     OR NEW.opened_by_user_id IS DISTINCT FROM OLD.opened_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'unit_regularization_cases: os fatos de origem do caso são imutáveis';
  END IF;
  IF OLD.status IN ('resolvido', 'corrigido', 'encerrado') THEN
    RAISE EXCEPTION 'unit_regularization_cases: caso % é terminal e não muda', OLD.status;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'aberto' AND NEW.status IN ('conferido', 'resolvido', 'corrigido', 'encerrado'))
    OR (OLD.status = 'conferido' AND NEW.status IN ('aberto', 'resolvido', 'corrigido', 'encerrado'))
  ) THEN
    RAISE EXCEPTION 'unit_regularization_cases: transição % -> % não permitida', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER unit_regularization_cases_guard BEFORE INSERT OR UPDATE ON unit_regularization_cases FOR EACH ROW EXECUTE FUNCTION unit_regularization_case_guard();
CREATE TRIGGER unit_regularization_cases_no_delete BEFORE DELETE ON unit_regularization_cases FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE TABLE unit_regularization_events (
  id BIGSERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CONSTRAINT unit_regularization_events_type_chk CHECK (event_type IN ('aberto', 'correcao_cadastral', 'conferencia_registrada', 'conferencia_devolvida', 'validada_resolvida', 'encerrado')),
  actor_user_id INTEGER REFERENCES users(id),
  field_ref TEXT,
  previous_value TEXT,
  new_value TEXT,
  quantity_before NUMERIC(12,3),
  quantity_after NUMERIC(12,3),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unit_regularization_events_case_fkey FOREIGN KEY (case_id, organization_id) REFERENCES unit_regularization_cases (id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX idx_unit_regularization_events_case ON unit_regularization_events(case_id, id);
CREATE TRIGGER unit_regularization_events_no_update BEFORE UPDATE ON unit_regularization_events FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER unit_regularization_events_no_delete BEFORE DELETE ON unit_regularization_events FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
