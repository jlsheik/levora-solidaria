-- Fase 99C — regularização auditável de unidades. Quando o recebimento de uma oferta tem unidade sem equivalência comprovada com a unidade canônica do item, NADA é lançado no
-- estoque nem no ledger: nasce um CASO que preserva o que foi apresentado (quantidade e unidade ofertadas, quantidade informada por quem recebeu) até que uma pessoa autorizada
-- o resolva por conferência física (quantidade contada na unidade do item), por correção cadastral comprovada ou o encerre sem resolução. Só tabelas novas (sem backfill).
--
-- Estado do caso (cabeçalho) + eventos append-only (histórico): os fatos de origem são imutáveis por gatilho; só o estado e o resultado evoluem, por transições permitidas.
CREATE TABLE unit_regularization_cases (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CONSTRAINT unit_regularization_cases_source_type_chk CHECK (source_type IN ('allocation', 'local_donation')),
  allocation_id INTEGER REFERENCES opportunity_allocations(id) ON DELETE RESTRICT,
  donation_opportunity_id INTEGER REFERENCES donation_opportunities(id) ON DELETE RESTRICT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  divergence_kind TEXT NOT NULL CONSTRAINT unit_regularization_cases_divergence_chk CHECK (divergence_kind IN ('unidade_diferente', 'unidade_nao_classificada')),
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
