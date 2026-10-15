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
