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
