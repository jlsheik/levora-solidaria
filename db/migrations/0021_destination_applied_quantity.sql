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
