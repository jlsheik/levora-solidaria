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
