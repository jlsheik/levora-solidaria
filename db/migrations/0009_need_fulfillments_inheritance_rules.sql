-- Fecha as lacunas de integridade encontradas na auditoria definitiva do
-- Modelo B (ver docs/plano-implementacao.md, Fase 32): a documentação da
-- Fase 31 afirmava garantias que o trigger não impunha de fato. Esta
-- migration não muda o conceito do Modelo B (correction/reversal/cadeias
-- continuam permitidos) — só torna estrutural o que antes era só
-- intenção documentada.
--
-- Regras novas, todas reforçadas em `need_fulfillments_validate_entry`
-- (nunca só na camada TypeScript):
--
-- 1) organization_id de uma correction/reversal precisa ser IGUAL ao
--    organization_id da linha referenciada — um evento derivado nunca
--    pode aparentar pertencer a outra organização.
-- 2) need_id de uma correction/reversal é HERDADO da linha referenciada,
--    nunca escolhido livremente (target.need_id=NULL → novo precisa ser
--    NULL; target.need_id=123 → novo precisa ser 123). unit continua
--    livre para correction (é exatamente o campo que uma correction pode
--    precisar mudar para consertar uma incompatibilidade original).
-- 3) reversal, especificamente, herda TUDO do alvo — unit, quantity,
--    is_countable (além de organization_id/allocation_id/need_id já
--    exigidos para ambos os tipos) — reversal é definido como "a reversão
--    direta do evento apontado", nunca um evento com dados próprios. O
--    único efeito diferente é o sinal contábil (-quantity em vez de
--    +quantity), nunca representado como valor negativo na coluna
--    (quantity continua sempre positiva, CHECK inalterado).
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
    -- 'correction' e 'reversal': SEMPRE exigem reverses_fulfillment_id
    -- (não é opcional para nenhum dos dois — achado de auditoria: a
    -- documentação da Fase 31 dizia o contrário para 'correction', mas o
    -- trigger sempre exigiu; agora a documentação foi corrigida para
    -- refletir o comportamento real, não o inverso).
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

    -- Nunca referenciar (corrigir/reverter) uma linha que já é reversal —
    -- reversões de reversões não têm significado de negócio claro; para
    -- "desfazer" uma reversal, uma nova correction aponta de volta para o
    -- evento original/correction que a motivou.
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

-- Impede duas reversões DIRETAS da mesma linha — a proteção precisa estar
-- no banco (constraint), não só numa checagem de aplicação (achado de
-- auditoria: duas reversões concorrentes idênticas eram ambas aceitas
-- antes desta migration). Correções continuam sem limite — só reversal é
-- restrito, porque reverter a mesma linha duas vezes não tem significado
-- de negócio (a segunda reversão duplicaria o efeito contábil).
CREATE UNIQUE INDEX idx_need_fulfillments_one_reversal_per_target
  ON need_fulfillments(reverses_fulfillment_id) WHERE entry_type = 'reversal';

-- Índice geral por allocation_id (histórico completo: original +
-- corrections + reversals) — o índice único parcial existente
-- (idx_need_fulfillments_one_original_per_allocation) só cobre linhas
-- 'original', então uma consulta que precise de TODAS as linhas de uma
-- allocation não tinha suporte de índice completo. Mantém o índice de
-- unicidade da original intocado.
CREATE INDEX idx_need_fulfillments_allocation_history ON need_fulfillments(allocation_id, created_at);
