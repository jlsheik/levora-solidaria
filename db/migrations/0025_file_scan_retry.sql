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
