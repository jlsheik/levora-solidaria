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
