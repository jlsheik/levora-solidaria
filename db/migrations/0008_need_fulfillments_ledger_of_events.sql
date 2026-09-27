-- Evolui need_fulfillments de "uma linha por allocation" para um ledger de
-- EVENTOS de atendimento (Modelo B, aprovado após a investigação
-- arquitetural desta sessão) — permite registrar correções/reversões como
-- novas linhas (append-only continua intacto: nunca UPDATE/DELETE),
-- resolvendo o conflito estrutural encontrado entre append-only e os
-- UNIQUE originais (ver auditoria: uma correção não conseguia ser
-- inserida enquanto UNIQUE(allocation_id) valia para TODA linha).
--
-- entry_type: taxonomia mínima suficiente (analisada, não assumida):
--   'original'   — o recebimento físico real que deu origem ao evento.
--                  Não pode referenciar outra linha (reverses_fulfillment_id
--                  NULL) e sempre precisa de um stock_transaction_id real
--                  (nunca é especulativo). No máximo UMA por allocation_id
--                  (índice único parcial abaixo).
--   'correction' — adiciona um valor novo/corrigido. Pode referenciar a
--                  linha que motivou a correção (contexto), mas isso é
--                  opcional quando a linha original nunca contou (ex.:
--                  is_countable=false por incompatibilidade de unidade —
--                  nesse caso a correção só PRECISA existir, não precisa
--                  desfazer nada numericamente, porque o original já
--                  contribuía 0). Contribui +quantity na soma.
--   'reversal'   — desfaz numericamente uma contribuição anterior
--                  específica. SEMPRE precisa de reverses_fulfillment_id.
--                  Contribui -quantity na soma.
-- 'correction' e 'reversal' só podem referenciar (reverses_fulfillment_id)
-- uma linha com entry_type IN ('original','correction') da MESMA
-- allocation_id — nunca uma 'reversal' (reverter uma reversão não tem
-- significado de negócio claro; para "desfazer uma reversão" o caminho é
-- uma nova 'correction' apontando de volta para o evento original).
-- Ciclos são estruturalmente impossíveis: reverses_fulfillment_id só pode
-- apontar para uma linha que já existe (id menor, já commitada) no
-- momento do INSERT — uma auto-referência circular exigiria que uma linha
-- apontasse para outra que ainda não existe.
--
-- is_countable é independente de entry_type (uma linha 'original' pode
-- ter is_countable=false por incompatibilidade de unidade, preservando
-- need_id em vez de descartá-lo — a mudança central desta fase).
--
-- stock_transaction_id vira NULLABLE: uma correção que é só de
-- interpretação/metadado (need_id/is_countable errados, mas o item físico
-- recebido já estava certo) não tem motivo de negócio para inventar um
-- novo lançamento de estoque. 'original' continua exigindo um valor real
-- (validado pelo trigger abaixo, não pela coluna) porque todo evento
-- original É, por definição, um recebimento físico.
ALTER TABLE need_fulfillments ALTER COLUMN stock_transaction_id DROP NOT NULL;

ALTER TABLE need_fulfillments ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'original';
ALTER TABLE need_fulfillments
  ADD CONSTRAINT need_fulfillments_entry_type_chk
  CHECK (entry_type IN ('original', 'correction', 'reversal'));

-- DEFAULT true é correto para todas as linhas já existentes: sob o modelo
-- anterior, uma incompatibilidade de unidade sempre resultava em
-- need_id=NULL (nunca "need_id preenchido + não contável") — não existe
-- nenhum registro histórico que precise, de fato, de is_countable=false.
-- Confirmado por consulta direta antes desta migration: 0 linhas com
-- unit_mismatch_note preenchido em qualquer ambiente já migrado.
ALTER TABLE need_fulfillments ADD COLUMN is_countable BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE need_fulfillments
  ADD COLUMN reverses_fulfillment_id BIGINT REFERENCES need_fulfillments(id) ON DELETE RESTRICT;
CREATE INDEX idx_need_fulfillments_reverses ON need_fulfillments(reverses_fulfillment_id) WHERE reverses_fulfillment_id IS NOT NULL;

-- Substitui UNIQUE(allocation_id) — incompatível com o novo modelo, já que
-- correções/reversões PRECISAM repetir a allocation_id da linha original —
-- por um índice único parcial: no máximo UMA linha 'original' por
-- allocation, sem limite para 'correction'/'reversal'.
ALTER TABLE need_fulfillments DROP CONSTRAINT need_fulfillments_allocation_id_key;
CREATE UNIQUE INDEX idx_need_fulfillments_one_original_per_allocation
  ON need_fulfillments(allocation_id) WHERE entry_type = 'original';

-- UNIQUE(stock_transaction_id) não precisa mudar: Postgres já trata
-- múltiplos NULL como não-conflitantes entre si, então correções sem novo
-- movimento físico (stock_transaction_id=NULL) nunca colidem entre si, e
-- qualquer linha (original OU correção) que de fato tenha um
-- stock_transaction_id real continua protegida contra reaproveitamento —
-- um movimento físico nunca deveria financiar duas linhas do ledger.

-- Validação cruzada de linhas (não expressável só com CHECK/FK simples):
-- só pode ser reforçada com um trigger, mesmo padrão de
-- audit_log_block_mutation (BEFORE INSERT, não BEFORE UPDATE — a tabela
-- continua append-only, esta validação só se aplica à criação).
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

    SELECT allocation_id, entry_type INTO target FROM need_fulfillments WHERE id = NEW.reverses_fulfillment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'need_fulfillments: reverses_fulfillment_id % não encontrado', NEW.reverses_fulfillment_id;
    END IF;
    IF target.allocation_id IS DISTINCT FROM NEW.allocation_id THEN
      RAISE EXCEPTION 'need_fulfillments: reverses_fulfillment_id precisa pertencer à mesma allocation_id';
    END IF;
    IF target.entry_type = 'reversal' THEN
      RAISE EXCEPTION 'need_fulfillments: não é permitido referenciar (corrigir/reverter) uma linha que já é entry_type=reversal';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER need_fulfillments_validate_entry_trigger
  BEFORE INSERT ON need_fulfillments
  FOR EACH ROW EXECUTE FUNCTION need_fulfillments_validate_entry();
