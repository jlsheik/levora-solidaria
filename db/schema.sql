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

-- ============================================================
-- Fase 89 — Fundação de identidade (espelha db/migrations/0015_identity_foundation.sql, sem os trechos só de migração)
-- ============================================================
-- ------------------------------------------------------------
-- users.anonymized_at
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN anonymized_at TIMESTAMPTZ;


-- ------------------------------------------------------------
-- platform_access
-- ------------------------------------------------------------
CREATE TYPE platform_access_level AS ENUM ('owner', 'admin');
CREATE TYPE platform_access_status AS ENUM ('active', 'revoked');

CREATE TABLE platform_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  level platform_access_level NOT NULL,
  status platform_access_status NOT NULL DEFAULT 'active',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = não foi um usuário que concedeu (migração, bootstrap offline, seed sintético de staging).
  granted_by_user_id INTEGER REFERENCES users(id),
  grant_origin TEXT NOT NULL DEFAULT 'owner_grant',
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id INTEGER REFERENCES users(id),
  revoked_reason TEXT,
  CONSTRAINT platform_access_status_consistency CHECK ((status = 'active') = (revoked_at IS NULL))
);

-- INVARIANTE: no máximo UM Platform Owner ativo (mesmo sob concorrência).
CREATE UNIQUE INDEX platform_access_single_active_owner ON platform_access ((1)) WHERE level = 'owner' AND status = 'active';
CREATE INDEX idx_platform_access_active ON platform_access (level) WHERE status = 'active';

-- Singleton reservado para o bootstrap offline (Fase 90); preenchido pelo backfill quando já existe owner.
CREATE TABLE platform_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  owner_bootstrapped_at TIMESTAMPTZ
);
INSERT INTO platform_state (id) VALUES (1);

CREATE FUNCTION platform_access_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_access: linhas não são apagadas; use status = revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'platform_access: user_id é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER platform_access_guard BEFORE UPDATE OR DELETE ON platform_access FOR EACH ROW EXECUTE FUNCTION platform_access_guard();

-- Último owner: uma mudança que remove/rebaixa/revoga um owner ATIVO só é aceita se, no COMMIT, existir um owner ativo.
-- Deferido de propósito: a transferência (antigo → admin, novo → owner) acontece na MESMA transação.
CREATE FUNCTION platform_access_keep_owner() RETURNS trigger AS $$
BEGIN
  IF OLD.level = 'owner' AND OLD.status = 'active'
     AND NOT (TG_OP = 'UPDATE' AND NEW.level = 'owner' AND NEW.status = 'active') THEN
    IF NOT EXISTS (SELECT 1 FROM platform_access WHERE level = 'owner' AND status = 'active') THEN
      RAISE EXCEPTION 'platform_access: o último Platform Owner ativo não pode ser removido, rebaixado ou revogado' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER platform_access_keep_owner AFTER UPDATE OR DELETE ON platform_access
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_access_keep_owner();

-- ------------------------------------------------------------
-- Backfill: users.role = 'admin' → platform_access (determinístico; não adivinha)
-- ------------------------------------------------------------

-- users.role = 'admin' deixa de ser aceito: a autorização de plataforma é platform_access.
CREATE FUNCTION users_forbid_admin_role() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'admin' THEN
    RAISE EXCEPTION 'users.role = admin não é mais permitido; a autorização de plataforma é platform_access' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_forbid_admin_role BEFORE INSERT OR UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION users_forbid_admin_role();

-- Titular de platform_access ATIVO nunca é anonimizado (evita "admin sem identidade" e conta de plataforma apagada por LGPD).
CREATE FUNCTION users_protect_platform_holder() RETURNS trigger AS $$
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL
     AND EXISTS (SELECT 1 FROM platform_access WHERE user_id = NEW.id AND status = 'active') THEN
    RAISE EXCEPTION 'users: titular de platform_access ativo não pode ser anonimizado; revogue/transfira o acesso antes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_protect_platform_holder BEFORE UPDATE OF anonymized_at ON users FOR EACH ROW EXECUTE FUNCTION users_protect_platform_holder();

-- ------------------------------------------------------------
-- sessions
-- ------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN absolute_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  ADD COLUMN primary_method TEXT,
  ADD COLUMN mfa_verified_at TIMESTAMPTZ,
  ADD COLUMN last_reauth_at TIMESTAMPTZ;


-- ------------------------------------------------------------
-- user_passwords: 0..1 senha por usuário
-- ------------------------------------------------------------
ALTER TABLE user_passwords ADD CONSTRAINT user_passwords_user_id_key UNIQUE (user_id);

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

-- ============================================================
-- Fase 99D (0017) — chaves únicas (id, organization_id) em inventory_items e files
-- ============================================================
-- Fase 99D — pré-requisito estrutural da destinação: chaves únicas (id, organization_id) em inventory_items e files, para que as futuras tabelas de destinação referenciem item e
-- comprovante por FK COMPOSTA e o banco rejeite referência a registro de outra organização (mesmo padrão já usado em needs e stock_transactions). id já é a chave primária,
-- então (id, organization_id) é único por construção: nenhuma linha existente pode violar.
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_id_organization_id_key UNIQUE (id, organization_id);
ALTER TABLE files ADD CONSTRAINT files_id_organization_id_key UNIQUE (id, organization_id);

-- ============================================================
-- Fase 99D (0018) — stock_destinations (destinação estruturada de uma saída; eventos imutáveis)
-- ============================================================
-- Fase 99D — destinação estruturada de uma saída física de estoque (eventos IMUTÁVEIS). Só estrutura: nenhum endpoint grava aqui nesta fase e nenhuma saída histórica é
-- classificada (sem backfill). A saída continua sendo uma linha de stock_transactions; a destinação registra a FINALIDADE dela. O atendimento de uma necessidade será derivado
-- das destinações contabilizáveis em fases posteriores; need_fulfillments (suprimento recebido da rede) não é tocado.
--
-- Três espécies de evento (entry_type), todas append-only:
--   original   : a destinação de uma saída (ou, só para perda/descarte, a classificação de um ajuste negativo já existente);
--   correction : correção DOCUMENTAL de campos descritivos (data efetiva, pessoas atendidas, observações, comprovante), sem movimento e sem mexer em campos contábeis;
--   reversal   : desfaz quantidade já destinada — 'estorno_documental' (sem movimento), 'devolucao_fisica' (ligada a uma ENTRADA compensatória) ou 'correcao_quantidade'
--                (ligada a um AJUSTE positivo compensatório).
-- O que o banco GARANTE: isolamento por organização (FKs compostas), forma de cada espécie, finalidade fechada, unidade canônica do item copiada, quantidade igual à da saída,
-- vínculo de correções/reversões à destinação original da mesma organização, soma das reversões ≤ quantidade da original (sob trava) e uma só destinação ativa por saída.
-- O que fica para a TRANSAÇÃO da aplicação (99E em diante): saldo e atomicidade saída+destinação, regras de excedente e de data retroativa (fuso de negócio), situação da necessidade,
-- aprovações de risco, permissões e a leitura de comprovantes.
CREATE TABLE stock_destinations (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CONSTRAINT stock_destinations_entry_type_chk CHECK (entry_type IN ('original', 'correction', 'reversal')),
  item_id INTEGER NOT NULL,
  stock_transaction_id BIGINT,
  need_id INTEGER,
  destination_type TEXT CONSTRAINT stock_destinations_type_chk CHECK (destination_type IN ('atendimento_coletivo', 'distribuicao_familias', 'entrega_instituicao_parceira', 'uso_operacional_instituicao', 'doacao_a_terceiro', 'devolucao_ao_doador', 'perda', 'descarte')),
  quantity NUMERIC(12,3) CONSTRAINT stock_destinations_quantity_chk CHECK (quantity > 0),
  -- espelha UNIT_VOCABULARY (src/helpers/unitVocabulary.ts): só unidade canônica em destinação nova; test/stockDestinationsSchema.test.ts garante a paridade
  unit TEXT CONSTRAINT stock_destinations_unit_chk CHECK (unit IN ('kg', 'unidade', 'litro', 'ml', 'caixa')),
  is_countable BOOLEAN,
  delivered_on DATE,
  people_served INTEGER CONSTRAINT stock_destinations_people_served_chk CHECK (people_served >= 0),
  people_unit TEXT CONSTRAINT stock_destinations_people_unit_chk CHECK (people_unit IN ('familias', 'pessoas')),
  notes TEXT CONSTRAINT stock_destinations_notes_len_chk CHECK (char_length(notes) <= 1000),
  proof_file_id INTEGER,
  surplus_reason TEXT,
  late_registration_reason TEXT,
  authorized_by_user_id INTEGER REFERENCES users(id),
  reverses_destination_id BIGINT,
  reversal_kind TEXT CONSTRAINT stock_destinations_reversal_kind_chk CHECK (reversal_kind IN ('correcao_quantidade', 'devolucao_fisica', 'estorno_documental')),
  reason TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_destinations_id_organization_id_key UNIQUE (id, organization_id),
  CONSTRAINT stock_destinations_item_org_fkey FOREIGN KEY (item_id, organization_id) REFERENCES inventory_items (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT stock_destinations_stock_org_fkey FOREIGN KEY (stock_transaction_id, organization_id) REFERENCES stock_transactions (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT stock_destinations_need_org_fkey FOREIGN KEY (need_id, organization_id) REFERENCES needs (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT stock_destinations_proof_org_fkey FOREIGN KEY (proof_file_id, organization_id) REFERENCES files (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT stock_destinations_reverses_org_fkey FOREIGN KEY (reverses_destination_id, organization_id) REFERENCES stock_destinations (id, organization_id) ON DELETE RESTRICT,
  -- forma de cada espécie
  CONSTRAINT stock_destinations_original_shape_chk CHECK (
    entry_type <> 'original' OR (
      stock_transaction_id IS NOT NULL AND destination_type IS NOT NULL AND quantity IS NOT NULL AND unit IS NOT NULL AND is_countable IS NOT NULL AND delivered_on IS NOT NULL
      AND reverses_destination_id IS NULL AND reversal_kind IS NULL AND reason IS NULL
    )
  ),
  CONSTRAINT stock_destinations_correction_shape_chk CHECK (
    entry_type <> 'correction' OR (
      reverses_destination_id IS NOT NULL AND reason IS NOT NULL AND char_length(btrim(reason)) >= 5 AND reversal_kind IS NULL
      AND stock_transaction_id IS NULL AND quantity IS NULL AND unit IS NULL AND destination_type IS NULL AND need_id IS NULL AND is_countable IS NULL
      AND num_nonnulls(delivered_on, people_served, notes, proof_file_id) >= 1
    )
  ),
  CONSTRAINT stock_destinations_reversal_shape_chk CHECK (
    entry_type <> 'reversal' OR (
      reverses_destination_id IS NOT NULL AND reversal_kind IS NOT NULL AND reason IS NOT NULL AND char_length(btrim(reason)) >= 5 AND quantity IS NOT NULL AND unit IS NOT NULL
      AND destination_type IS NULL AND need_id IS NULL AND is_countable IS NULL AND people_served IS NULL AND surplus_reason IS NULL
      AND ((reversal_kind = 'estorno_documental') = (stock_transaction_id IS NULL))
    )
  ),
  -- finalidade × atendimento: só as três finalidades de atendimento aceitam necessidade, contagem e pessoas atendidas
  CONSTRAINT stock_destinations_need_only_attendance_chk CHECK (need_id IS NULL OR destination_type IN ('atendimento_coletivo', 'distribuicao_familias', 'entrega_instituicao_parceira')),
  CONSTRAINT stock_destinations_countable_chk CHECK (is_countable IS NOT TRUE OR (need_id IS NOT NULL AND destination_type IN ('atendimento_coletivo', 'distribuicao_familias', 'entrega_instituicao_parceira'))),
  CONSTRAINT stock_destinations_people_only_attendance_chk CHECK (people_served IS NULL OR destination_type IS NULL OR destination_type IN ('atendimento_coletivo', 'distribuicao_familias', 'entrega_instituicao_parceira')),
  CONSTRAINT stock_destinations_people_pair_chk CHECK ((people_served IS NULL) = (people_unit IS NULL)),
  CONSTRAINT stock_destinations_reason_required_chk CHECK (destination_type IS NULL OR destination_type NOT IN ('uso_operacional_instituicao', 'doacao_a_terceiro', 'devolucao_ao_doador', 'perda', 'descarte') OR (notes IS NOT NULL AND char_length(btrim(notes)) >= 10)),
  CONSTRAINT stock_destinations_authorization_chk CHECK ((surplus_reason IS NULL AND late_registration_reason IS NULL) OR authorized_by_user_id IS NOT NULL),
  -- data efetiva: sanidade ESTRUTURAL (nunca além de um dia à frente do registro em UTC); a regra de negócio (não futura no fuso de negócio; retroação ≤ 7 dias) é da aplicação
  CONSTRAINT stock_destinations_delivered_on_sane_chk CHECK (delivered_on IS NULL OR delivered_on <= ((created_at AT TIME ZONE 'UTC')::date + 1))
);
-- um movimento compensatório (entrada/ajuste) sustenta no máximo UMA reversão; a saída original é tratada pelo gatilho (permite nova destinação só depois de estorno TOTAL)
CREATE UNIQUE INDEX uq_stock_destinations_reversal_movement ON stock_destinations(stock_transaction_id) WHERE entry_type = 'reversal' AND stock_transaction_id IS NOT NULL;
CREATE INDEX idx_stock_destinations_exit ON stock_destinations(stock_transaction_id) WHERE entry_type = 'original';
CREATE INDEX idx_stock_destinations_reverses ON stock_destinations(reverses_destination_id) WHERE reverses_destination_id IS NOT NULL;
CREATE INDEX idx_stock_destinations_org_need ON stock_destinations(organization_id, need_id) WHERE need_id IS NOT NULL;
CREATE INDEX idx_stock_destinations_org_item ON stock_destinations(organization_id, item_id, created_at);

CREATE OR REPLACE FUNCTION stock_destination_validate() RETURNS TRIGGER AS $$
DECLARE
  st RECORD;
  orig RECORD;
  prior RECORD;
  item_unit TEXT;
  need_item INTEGER;
  reversed NUMERIC;
BEGIN
  IF NEW.entry_type = 'original' THEN
    -- trava a LINHA da saída: duas destinações concorrentes da mesma saída se serializam e a segunda enxerga a primeira
    SELECT id, organization_id, item_id, type, delta INTO st FROM stock_transactions WHERE id = NEW.stock_transaction_id FOR UPDATE;
    IF st.item_id IS DISTINCT FROM NEW.item_id THEN RAISE EXCEPTION 'stock_destinations: a movimentação não é do item informado'; END IF;
    IF st.type = 'saida' THEN
      NULL;
    ELSIF st.type = 'ajuste' AND st.delta < 0 AND NEW.destination_type IN ('perda', 'descarte') THEN
      NULL; -- classificação de um ajuste NEGATIVO já existente como perda/descarte (sem segunda baixa física)
    ELSE
      RAISE EXCEPTION 'stock_destinations: a destinação original exige uma saída física (entrada ou ajuste não são saída)';
    END IF;
    IF NEW.quantity <> -st.delta THEN RAISE EXCEPTION 'stock_destinations: a quantidade destinada deve ser igual à da saída'; END IF;
    SELECT unit INTO item_unit FROM inventory_items WHERE id = NEW.item_id;
    IF NEW.unit IS DISTINCT FROM item_unit THEN RAISE EXCEPTION 'stock_destinations: a unidade deve ser a unidade canônica do item (sem conversão)'; END IF;
    IF NEW.need_id IS NOT NULL THEN
      SELECT item_id INTO need_item FROM needs WHERE id = NEW.need_id;
      IF need_item IS NOT NULL AND need_item <> NEW.item_id THEN RAISE EXCEPTION 'stock_destinations: a necessidade é de outro item'; END IF;
    END IF;
    -- uma só destinação ATIVA por saída: outra original da mesma saída só é aceita se a anterior já foi estornada por inteiro
    FOR prior IN SELECT id, quantity FROM stock_destinations WHERE entry_type = 'original' AND stock_transaction_id = NEW.stock_transaction_id LOOP
      SELECT COALESCE(SUM(quantity), 0) INTO reversed FROM stock_destinations WHERE entry_type = 'reversal' AND reverses_destination_id = prior.id;
      IF reversed < prior.quantity THEN RAISE EXCEPTION 'stock_destinations: esta saída já tem uma destinação ativa'; END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  -- correction / reversal: referem a destinação ORIGINAL (nunca a outro evento), da mesma organização (a FK composta já garante), e do mesmo item
  SELECT id, entry_type, item_id, quantity, unit, destination_type INTO orig FROM stock_destinations WHERE id = NEW.reverses_destination_id FOR UPDATE;
  IF orig.entry_type IS DISTINCT FROM 'original' THEN RAISE EXCEPTION 'stock_destinations: correções e reversões referem a destinação ORIGINAL'; END IF;
  IF NEW.item_id <> orig.item_id THEN RAISE EXCEPTION 'stock_destinations: o item deve ser o da destinação original'; END IF;

  IF NEW.entry_type = 'correction' THEN
    IF NEW.people_served IS NOT NULL AND orig.destination_type NOT IN ('atendimento_coletivo', 'distribuicao_familias', 'entrega_instituicao_parceira') THEN
      RAISE EXCEPTION 'stock_destinations: pessoas atendidas só em finalidade de atendimento';
    END IF;
    RETURN NEW;
  END IF;

  -- reversal
  IF NEW.unit IS DISTINCT FROM orig.unit THEN RAISE EXCEPTION 'stock_destinations: a unidade da reversão deve ser a da original'; END IF;
  SELECT COALESCE(SUM(quantity), 0) INTO reversed FROM stock_destinations WHERE entry_type = 'reversal' AND reverses_destination_id = NEW.reverses_destination_id;
  IF reversed + NEW.quantity > orig.quantity THEN RAISE EXCEPTION 'stock_destinations: a soma das reversões excede a quantidade da destinação original'; END IF;
  IF NEW.reversal_kind <> 'estorno_documental' THEN
    SELECT id, item_id, type, delta INTO st FROM stock_transactions WHERE id = NEW.stock_transaction_id;
    IF st.item_id IS DISTINCT FROM NEW.item_id THEN RAISE EXCEPTION 'stock_destinations: o movimento compensatório não é do item da destinação'; END IF;
    IF NEW.reversal_kind = 'devolucao_fisica' AND NOT (st.type = 'entrada' AND st.delta = NEW.quantity) THEN
      RAISE EXCEPTION 'stock_destinations: a devolução física exige uma ENTRADA de estoque de igual quantidade';
    END IF;
    IF NEW.reversal_kind = 'correcao_quantidade' AND NOT (st.type = 'ajuste' AND st.delta = NEW.quantity) THEN
      RAISE EXCEPTION 'stock_destinations: a correção de quantidade exige um AJUSTE positivo de igual quantidade';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stock_destinations_validate BEFORE INSERT ON stock_destinations FOR EACH ROW EXECUTE FUNCTION stock_destination_validate();
CREATE TRIGGER stock_destinations_no_update BEFORE UPDATE ON stock_destinations FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER stock_destinations_no_delete BEFORE DELETE ON stock_destinations FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- ============================================================
-- Fase 99D (0019) — need_closures (encerramento de necessidade sem entrega total; eventos imutáveis)
-- ============================================================
-- Fase 99D — encerramento de necessidade SEM entrega total (eventos IMUTÁVEIS). need_resolutions só registra a resolução administrativa que leva a 'atendida' (UNIQUE need_id, sem
-- motivo nem saldo) e needs.status não guarda motivo estruturado nem o que foi pedido/atendido/faltou no momento: por isso este registro é necessário. Reusa o estado EXISTENTE
-- 'cancelada' de needs (não cria estado novo); a mudança de needs.status e o cálculo do atendido ficam para a 99F — aqui só a estrutura. Esta tabela NÃO tem referência a movimento
-- de estoque: encerrar nunca baixa estoque, e não apaga nem altera suprimentos ou destinações já registrados.
--
-- Duas espécies (entry_type): 'encerramento' (motivo estruturado + instantâneos de solicitado/atendido/saldo) e 'reabertura' (corrige um encerramento, que continua no histórico).
-- Banco: no máximo um encerramento ATIVO por necessidade (o próximo só depois de uma reabertura), reabertura só de um encerramento ativo, encerramento só de necessidade 'aberta'
-- (uma 'atendida' não é desfeita por encerramento administrativo), organização coerente por FK composta. Aplicação (99F): inserir o evento ANTES de mudar needs.status na mesma transação.
CREATE TABLE need_closures (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  need_id INTEGER NOT NULL,
  entry_type TEXT NOT NULL CONSTRAINT need_closures_entry_type_chk CHECK (entry_type IN ('encerramento', 'reabertura')),
  reason_code TEXT CONSTRAINT need_closures_reason_code_chk CHECK (reason_code IN ('recursos_insuficientes', 'necessidade_superada', 'duplicidade', 'desistencia_da_organizacao', 'outro')),
  reason_text TEXT CONSTRAINT need_closures_reason_text_len_chk CHECK (char_length(reason_text) <= 500),
  quantity_needed_snapshot NUMERIC(12,3) CONSTRAINT need_closures_needed_chk CHECK (quantity_needed_snapshot > 0),
  attended_snapshot NUMERIC(12,3) CONSTRAINT need_closures_attended_chk CHECK (attended_snapshot >= 0),
  remaining_snapshot NUMERIC(12,3) CONSTRAINT need_closures_remaining_chk CHECK (remaining_snapshot >= 0),
  corrects_closure_id BIGINT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT need_closures_id_organization_id_key UNIQUE (id, organization_id),
  CONSTRAINT need_closures_need_org_fkey FOREIGN KEY (need_id, organization_id) REFERENCES needs (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT need_closures_corrects_org_fkey FOREIGN KEY (corrects_closure_id, organization_id) REFERENCES need_closures (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT need_closures_closure_shape_chk CHECK (
    entry_type <> 'encerramento' OR (
      reason_code IS NOT NULL AND quantity_needed_snapshot IS NOT NULL AND attended_snapshot IS NOT NULL AND remaining_snapshot IS NOT NULL AND corrects_closure_id IS NULL
      AND (reason_code <> 'outro' OR (reason_text IS NOT NULL AND char_length(btrim(reason_text)) >= 10))
      AND (attended_snapshot = 0 OR (reason_text IS NOT NULL AND char_length(btrim(reason_text)) >= 5))
    )
  ),
  CONSTRAINT need_closures_reopen_shape_chk CHECK (
    entry_type <> 'reabertura' OR (
      corrects_closure_id IS NOT NULL AND reason_text IS NOT NULL AND char_length(btrim(reason_text)) >= 5 AND reason_code IS NULL
      AND quantity_needed_snapshot IS NULL AND attended_snapshot IS NULL AND remaining_snapshot IS NULL
    )
  )
);
-- cada encerramento é corrigido no máximo uma vez
CREATE UNIQUE INDEX uq_need_closures_corrected_once ON need_closures(corrects_closure_id) WHERE corrects_closure_id IS NOT NULL;
CREATE INDEX idx_need_closures_need ON need_closures(need_id, id);

CREATE OR REPLACE FUNCTION need_closure_validate() RETURNS TRIGGER AS $$
DECLARE
  need_status TEXT;
  target RECORD;
  active_id BIGINT;
BEGIN
  -- trava a necessidade: encerramentos/reaberturas concorrentes da mesma necessidade se serializam
  SELECT status::text INTO need_status FROM needs WHERE id = NEW.need_id FOR UPDATE;
  IF NEW.entry_type = 'encerramento' THEN
    IF need_status <> 'aberta' THEN RAISE EXCEPTION 'need_closures: só uma necessidade aberta pode ser encerrada (situação atual: %)', need_status; END IF;
    SELECT c.id INTO active_id FROM need_closures c WHERE c.need_id = NEW.need_id AND c.entry_type = 'encerramento'
      AND NOT EXISTS (SELECT 1 FROM need_closures r WHERE r.corrects_closure_id = c.id) LIMIT 1;
    IF active_id IS NOT NULL THEN RAISE EXCEPTION 'need_closures: esta necessidade já tem um encerramento ativo'; END IF;
    IF NEW.quantity_needed_snapshot IS NOT NULL AND NEW.attended_snapshot IS NOT NULL AND NEW.remaining_snapshot IS NOT NULL
       AND NEW.remaining_snapshot <> GREATEST(NEW.quantity_needed_snapshot - NEW.attended_snapshot, 0) THEN
      RAISE EXCEPTION 'need_closures: o saldo não atendido deve ser solicitado menos atendido';
    END IF;
    RETURN NEW;
  END IF;
  SELECT id, need_id, entry_type INTO target FROM need_closures WHERE id = NEW.corrects_closure_id;
  IF target.entry_type IS DISTINCT FROM 'encerramento' OR target.need_id <> NEW.need_id THEN
    RAISE EXCEPTION 'need_closures: a reabertura corrige um encerramento da mesma necessidade';
  END IF;
  IF need_status <> 'cancelada' THEN RAISE EXCEPTION 'need_closures: só uma necessidade cancelada pode ser reaberta (situação atual: %)', need_status; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER need_closures_validate BEFORE INSERT ON need_closures FOR EACH ROW EXECUTE FUNCTION need_closure_validate();
CREATE TRIGGER need_closures_no_update BEFORE UPDATE ON need_closures FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER need_closures_no_delete BEFORE DELETE ON need_closures FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- ============================================================
-- Fase 99E (0020) — stock_exit_requests (idempotência persistente do registro atômico de saída + destinação)
-- ============================================================
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

-- ============================================================
-- Fase 99F (0021) — quantidade aplicada × excedente na destinação; teto da soma aplicada por necessidade
-- ============================================================
-- Fase 99F — separa, NA DESTINAÇÃO IMUTÁVEL, a quantidade FÍSICA que saiu (quantity) da quantidade APLICADA ao atendimento da necessidade (applied_quantity) e do EXCEDENTE autorizado
-- (surplus_quantity = quantity − applied_quantity). Colunas novas NULLABLE, sem backfill: as linhas existentes ficam NULL e o cálculo trata applied NULL como "toda a quantidade" (as
-- únicas contabilizáveis anteriores a esta fase vêm de testes; nenhuma saída histórica é tocada). A autorização do excedente reaproveita as colunas já existentes (surplus_reason e
-- authorized_by_user_id) e passa a ser OBRIGATÓRIA quando há excedente. Um gatilho garante que a soma aplicada a uma necessidade nunca passa da quantidade solicitada, sob a trava da necessidade.
ALTER TABLE stock_destinations ADD COLUMN applied_quantity NUMERIC(12,3) CONSTRAINT stock_destinations_applied_quantity_chk CHECK (applied_quantity > 0);
ALTER TABLE stock_destinations ADD COLUMN surplus_quantity NUMERIC(12,3) CONSTRAINT stock_destinations_surplus_quantity_chk CHECK (surplus_quantity > 0);

-- applied só existe numa destinação ORIGINAL contabilizável e nunca passa da quantidade física
ALTER TABLE stock_destinations ADD CONSTRAINT stock_destinations_applied_shape_chk CHECK (
  applied_quantity IS NULL OR (entry_type = 'original' AND is_countable IS TRUE AND applied_quantity <= quantity)
);
-- excedente: quantidade = física − aplicada, com motivo (≥ 10 caracteres) e quem autorizou; sem excedente não há motivo de excedente
ALTER TABLE stock_destinations ADD CONSTRAINT stock_destinations_surplus_shape_chk CHECK (
  (surplus_quantity IS NULL AND surplus_reason IS NULL)
  OR (surplus_quantity IS NOT NULL AND applied_quantity IS NOT NULL AND surplus_quantity = quantity - applied_quantity
      AND surplus_reason IS NOT NULL AND char_length(btrim(surplus_reason)) >= 10 AND authorized_by_user_id IS NOT NULL)
);

-- Soma aplicada (líquida de reversões) de uma necessidade: cada original contabilizável contribui com LEAST(aplicada, física − revertida) — a reversão consome primeiro o excedente.
-- Correções não têm quantidade e nunca contam; reversões só reduzem.
CREATE OR REPLACE FUNCTION need_applied_total(p_need_id INTEGER) RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(LEAST(COALESCE(d.applied_quantity, d.quantity), d.quantity - COALESCE(r.reversed, 0))), 0)
  FROM stock_destinations d
  LEFT JOIN (
    SELECT reverses_destination_id AS id, SUM(quantity) AS reversed FROM stock_destinations WHERE entry_type = 'reversal' GROUP BY reverses_destination_id
  ) r ON r.id = d.id
  WHERE d.entry_type = 'original' AND d.need_id = p_need_id AND d.is_countable IS TRUE;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION stock_destination_need_cap() RETURNS TRIGGER AS $$
DECLARE
  needed NUMERIC;
  attended NUMERIC;
BEGIN
  IF NEW.entry_type = 'original' AND NEW.need_id IS NOT NULL AND NEW.is_countable IS TRUE THEN
    -- trava a necessidade (mesmo modo da aplicação): duas destinações concorrentes da mesma necessidade se serializam e a segunda enxerga a primeira
    SELECT quantity_needed INTO needed FROM needs WHERE id = NEW.need_id FOR NO KEY UPDATE;
    attended := need_applied_total(NEW.need_id);
    IF attended + COALESCE(NEW.applied_quantity, NEW.quantity) > needed THEN
      RAISE EXCEPTION 'stock_destinations: a quantidade aplicada excederia a quantidade solicitada da necessidade (o excedente exige autorização estruturada)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stock_destinations_need_cap BEFORE INSERT ON stock_destinations FOR EACH ROW EXECUTE FUNCTION stock_destination_need_cap();
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
-- Fase 99J — comprovantes de destinação. O arquivo é um registro de `files` (purpose 'comprovante_destinacao', privado) ligado à destinação por um EVENTO IMUTÁVEL em stock_destinations
-- (a coluna proof_file_id já existia desde a 99D, com FK composta (proof_file_id, organization_id) -> files). Anexar = evento `correction` apenas com o arquivo; REMOVER a referência = outro
-- evento `correction` com proof_removed = true apontando para o MESMO arquivo (a original e o evento de anexo permanecem; o arquivo no armazenamento NÃO é apagado). Substituir = remover + anexar.
-- O comprovante vigente de uma destinação é o evento de comprovante mais recente dela, se não for uma remoção.
-- O banco garante: evento de comprovante só com o arquivo (sem data/pessoas/observações), arquivo do propósito certo e da mesma organização (FK composta), um arquivo vincula-se no máximo
-- UMA vez (índice único; um arquivo removido não volta — envia-se outro) e só se remove o comprovante que está vigente (sob a trava da destinação original).
ALTER TABLE stock_destinations ADD COLUMN proof_removed BOOLEAN;
ALTER TABLE stock_destinations ADD CONSTRAINT stock_destinations_proof_removed_chk CHECK (
  proof_removed IS NULL OR (proof_removed IS TRUE AND entry_type = 'correction' AND proof_file_id IS NOT NULL AND delivered_on IS NULL AND people_served IS NULL AND notes IS NULL)
);
ALTER TABLE stock_destinations ADD CONSTRAINT stock_destinations_proof_only_chk CHECK (
  proof_file_id IS NULL OR entry_type <> 'correction' OR num_nonnulls(delivered_on, people_served, notes) = 0
);
CREATE UNIQUE INDEX uq_stock_destinations_proof_file ON stock_destinations(proof_file_id) WHERE proof_file_id IS NOT NULL AND proof_removed IS NOT TRUE;

CREATE OR REPLACE FUNCTION stock_destination_proof_validate() RETURNS TRIGGER AS $$
DECLARE
  file_purpose TEXT;
  active RECORD;
BEGIN
  IF NEW.proof_file_id IS NULL THEN RETURN NEW; END IF;
  SELECT purpose INTO file_purpose FROM files WHERE id = NEW.proof_file_id;
  IF file_purpose IS DISTINCT FROM 'comprovante_destinacao' THEN
    RAISE EXCEPTION 'stock_destinations: o arquivo do comprovante deve ter o propósito comprovante_destinacao';
  END IF;
  IF NEW.entry_type = 'correction' AND NEW.proof_removed IS TRUE THEN
    -- trava a destinação original: anexos/remoções concorrentes se serializam e a segunda lê o estado confirmado
    PERFORM 1 FROM stock_destinations WHERE id = NEW.reverses_destination_id FOR UPDATE;
    SELECT e.proof_file_id, e.proof_removed INTO active FROM stock_destinations e
      WHERE (e.id = NEW.reverses_destination_id OR e.reverses_destination_id = NEW.reverses_destination_id) AND e.proof_file_id IS NOT NULL
      ORDER BY e.id DESC LIMIT 1;
    IF active.proof_file_id IS NULL OR active.proof_removed IS TRUE OR active.proof_file_id <> NEW.proof_file_id THEN
      RAISE EXCEPTION 'stock_destinations: só o comprovante vigente da destinação pode ser removido';
    END IF;
  ELSIF NEW.entry_type = 'correction' THEN
    PERFORM 1 FROM stock_destinations WHERE id = NEW.reverses_destination_id FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stock_destinations_proof_validate BEFORE INSERT ON stock_destinations FOR EACH ROW EXECUTE FUNCTION stock_destination_proof_validate();
-- Hardening pós-99K — estado da ANÁLISE ANTIMALWARE de cada arquivo enviado. Um arquivo só é liberado para consulta depois de um resultado efetivo do scanner.
--   pendente                 : enviado, ainda sem resultado (inclui a janela entre o envio e a análise);
--   aprovado                 : o scanner analisou e não encontrou ameaça (scan_engine/scan_checked_at registram quem e quando);
--   infectado                : o scanner identificou ameaça (scan_signature); o objeto fica ISOLADO (não é apagado) e nunca é servido nem vinculável;
--   indisponivel             : o scanner não respondeu, estourou o tempo, não está configurado ou devolveu resposta inválida/inconclusiva — NUNCA vale como aprovação; pode ser reanalisado;
--   dispensado               : análise não exigida pelo ambiente (desenvolvimento/testes) — só existe quando a análise é desligada de forma explícita; em produção a análise é obrigatória;
--   legado_nao_analisado     : arquivos anteriores a esta migration (nunca analisados); servidos fora do modo obrigatório e BLOQUEADOS no modo obrigatório até serem reanalisados.
-- O banco garante: vocabulário fechado; estados finais (aprovado/infectado) imutáveis; um comprovante de destinação só pode ser VINCULADO a arquivo aprovado (ou dispensado), o que impede
-- contornar a análise por qualquer rota que escreva em stock_destinations.
ALTER TABLE files ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'legado_nao_analisado' CONSTRAINT files_scan_status_chk CHECK (scan_status IN ('pendente', 'aprovado', 'infectado', 'indisponivel', 'dispensado', 'legado_nao_analisado'));
ALTER TABLE files ALTER COLUMN scan_status SET DEFAULT 'pendente';
ALTER TABLE files ADD COLUMN scan_checked_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN scan_engine TEXT;
ALTER TABLE files ADD COLUMN scan_signature TEXT;
CREATE INDEX idx_files_org_scan_status ON files(organization_id, scan_status) WHERE scan_status <> 'aprovado';

CREATE OR REPLACE FUNCTION files_scan_status_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status AND OLD.scan_status IN ('aprovado', 'infectado') THEN
    RAISE EXCEPTION 'files: o resultado da análise (%) é final e não pode mudar', OLD.scan_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER files_scan_status_guard BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION files_scan_status_guard();

-- o vínculo de comprovante exige arquivo liberado pela análise (a remoção da referência não exige: é sobre um vínculo que já existia)
CREATE OR REPLACE FUNCTION stock_destination_proof_validate() RETURNS TRIGGER AS $$
DECLARE
  file_purpose TEXT;
  file_scan TEXT;
  active RECORD;
BEGIN
  IF NEW.proof_file_id IS NULL THEN RETURN NEW; END IF;
  SELECT purpose, scan_status INTO file_purpose, file_scan FROM files WHERE id = NEW.proof_file_id;
  IF file_purpose IS DISTINCT FROM 'comprovante_destinacao' THEN
    RAISE EXCEPTION 'stock_destinations: o arquivo do comprovante deve ter o propósito comprovante_destinacao';
  END IF;
  IF NEW.entry_type = 'correction' AND NEW.proof_removed IS TRUE THEN
    PERFORM 1 FROM stock_destinations WHERE id = NEW.reverses_destination_id FOR UPDATE;
    SELECT e.proof_file_id, e.proof_removed INTO active FROM stock_destinations e
      WHERE (e.id = NEW.reverses_destination_id OR e.reverses_destination_id = NEW.reverses_destination_id) AND e.proof_file_id IS NOT NULL
      ORDER BY e.id DESC LIMIT 1;
    IF active.proof_file_id IS NULL OR active.proof_removed IS TRUE OR active.proof_file_id <> NEW.proof_file_id THEN
      RAISE EXCEPTION 'stock_destinations: só o comprovante vigente da destinação pode ser removido';
    END IF;
    RETURN NEW;
  END IF;
  IF file_scan NOT IN ('aprovado', 'dispensado') THEN
    RAISE EXCEPTION 'stock_destinations: o arquivo do comprovante ainda não foi aprovado pela análise (situação: %)', file_scan;
  END IF;
  IF NEW.entry_type = 'correction' THEN
    PERFORM 1 FROM stock_destinations WHERE id = NEW.reverses_destination_id FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Hardening pós-99K — controle de NOVAS TENTATIVAS da análise antimalware, no próprio registro do arquivo (a fila é o estado: arquivos `pendente`/`indisponivel` elegíveis). Não há tabela de
-- fila: `background_task_runs` registra EXECUÇÕES da tarefa agendada, não o trabalho por arquivo, e `files` já é a fonte de verdade do estado. Colunas:
--   scan_attempts          tentativas automáticas já iniciadas (incrementa ao reivindicar, então um worker que morre no meio também consome tentativa);
--   scan_next_attempt_at   quando a próxima tentativa fica elegível (backoff); NULL = elegível já;
--   scan_lease_until       reivindicação temporária (lease): enquanto no futuro, nenhum outro worker pega o arquivo; vencida = tarefa abandonada, volta a ser elegível;
--   scan_exhausted_at      tentativas automáticas esgotadas: o arquivo CONTINUA bloqueado e só volta pela reanálise manual autorizada (POST /files-rescan);
--   scan_last_reason       último motivo de indisponibilidade (vocabulário fechado da aplicação, sem detalhes internos).
-- Nada aqui libera arquivo: o estado de liberação continua sendo scan_status.
ALTER TABLE files ADD COLUMN scan_attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT files_scan_attempts_chk CHECK (scan_attempts >= 0);
ALTER TABLE files ADD COLUMN scan_next_attempt_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN scan_lease_until TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN scan_exhausted_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN scan_last_reason TEXT;
CREATE INDEX idx_files_scan_queue ON files(scan_next_attempt_at NULLS FIRST, id) WHERE scan_status IN ('pendente', 'indisponivel') AND scan_exhausted_at IS NULL;
