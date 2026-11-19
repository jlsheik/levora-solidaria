-- M42 — HISTÓRICO DE EXECUÇÕES DO MATCHING (inclusive sem correspondência) e vínculo das avaliações com a execução que as gerou.
--
-- Problema: o motor (`runMatchingForOpportunity`) é centrado na OFERTA do Registro Central e só deixava rastro por necessidade quando um candidato era PONTUADO (linha em
-- `match_evaluations`). Necessidade sem relação com a oferta, ou execução que não achou nada, não deixava registro por necessidade — "executado sem resultado" era indistinguível de
-- "nunca avaliado". Nada aqui cria um segundo motor: o próprio motor passa a registrar o que já calcula.
--
--   * `matching_runs`: uma linha por execução do motor que AVALIOU (não por tentativa ignorada: oferta inexistente/inelegível/sem quantidade livre continua sem registro, porque
--     nada foi avaliado). `correlation_id` é a MESMA correlação do registro de auditoria `matching.executado` da execução (referência à auditoria). Contagens são NULL quando não foram
--     calculadas (execução com falha). `signature` é a assinatura do resultado (a mesma gravada na auditoria); `repeat_count` conta repetições AUTOMÁTICAS idênticas (varredura que
--     reconfirmou o mesmo resultado e, por desenho da Fase 95, não grava nada novo).
--   * `matching_run_needs`: quais necessidades abertas foram CONSIDERADAS na execução e com qual relação (`sem_relacao`: sem relação de categoria com a oferta, nem candidata;
--     `avaliada`: pontuada e persistida em `match_evaluations`; `avaliada_sem_registro`: pontuada, mas a execução parou antes de registrar a avaliação).
--   * `match_evaluations.matching_run_id` (nulo, FK): execução que gerou a avaliação. Avaliações anteriores ficam NULL — nenhuma execução é fabricada para o passado.
--
-- Nenhum objeto desta migration existe antes dela. Preserva 0032–0039. Sem backfill (as tabelas nascem vazias; a coluna nova nasce nula).

CREATE TABLE matching_runs (
  id BIGSERIAL PRIMARY KEY,
  correlation_id TEXT NOT NULL CONSTRAINT matching_runs_correlation_chk CHECK (correlation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  opportunity_registry_id INTEGER NOT NULL REFERENCES opportunity_registry(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CONSTRAINT matching_runs_origin_chk CHECK (origin IN ('varredura', 'manual', 'mudanca_de_estado', 'reabertura', 'expiracao', 'indeterminada')),
  triggered_by_user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL CONSTRAINT matching_runs_status_chk CHECK (status IN ('em_andamento', 'concluida_com_correspondencia', 'concluida_sem_correspondencia', 'falhou')),
  candidates_considered INTEGER CONSTRAINT matching_runs_considered_chk CHECK (candidates_considered IS NULL OR candidates_considered >= 0),
  candidates_related INTEGER CONSTRAINT matching_runs_related_chk CHECK (candidates_related IS NULL OR candidates_related >= 0),
  valid_matches INTEGER CONSTRAINT matching_runs_valid_chk CHECK (valid_matches IS NULL OR valid_matches >= 0),
  error_code TEXT CONSTRAINT matching_runs_error_code_chk CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_:]{1,60}$'),
  algorithm_version TEXT NOT NULL,
  signature TEXT,
  repeat_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT matching_runs_repeat_chk CHECK (repeat_count >= 0),
  last_repeated_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- coerência entre estado e dados: nada de "concluída" sem contagens, nem "falhou" sem código, nem "com correspondência" sem correspondência
  CONSTRAINT matching_runs_state_chk CHECK (
    (status = 'em_andamento' AND finished_at IS NULL)
    OR (status = 'falhou' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND valid_matches IS NULL)
    OR (status = 'concluida_sem_correspondencia' AND finished_at IS NOT NULL AND candidates_considered IS NOT NULL AND candidates_related IS NOT NULL AND valid_matches = 0)
    OR (status = 'concluida_com_correspondencia' AND finished_at IS NOT NULL AND candidates_considered IS NOT NULL AND candidates_related IS NOT NULL AND valid_matches > 0)
  )
);
CREATE INDEX idx_matching_runs_opportunity ON matching_runs (opportunity_registry_id, id DESC);
CREATE UNIQUE INDEX idx_matching_runs_correlation ON matching_runs (correlation_id);

CREATE TABLE matching_run_needs (
  run_id BIGINT NOT NULL REFERENCES matching_runs(id) ON DELETE CASCADE,
  need_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CONSTRAINT matching_run_needs_relation_chk CHECK (relation IN ('sem_relacao', 'avaliada', 'avaliada_sem_registro')),
  PRIMARY KEY (run_id, need_id),
  -- a necessidade registrada pertence SEMPRE à organização registrada (mesma garantia estrutural das atribuições)
  CONSTRAINT matching_run_needs_need_org_fkey FOREIGN KEY (need_id, organization_id) REFERENCES needs (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX idx_matching_run_needs_need ON matching_run_needs (need_id, run_id DESC);

ALTER TABLE match_evaluations ADD COLUMN matching_run_id BIGINT REFERENCES matching_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_match_evaluations_run ON match_evaluations (matching_run_id) WHERE matching_run_id IS NOT NULL;
