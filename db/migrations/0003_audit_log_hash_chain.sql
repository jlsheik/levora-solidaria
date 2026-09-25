-- Ver docs/AUDIT.md — hash encadeado (master prompt, seção 12). Detecta
-- alteração retroativa mesmo por alguém com acesso direto ao Postgres
-- (o append-only por trigger já existente só protege contra UPDATE/DELETE
-- via sessão normal da aplicação, não contra reescrever a tabela inteira).
--
-- Cadeia única e global (não por organização): cada evento inclui o hash
-- do evento anterior na tabela inteira, na ordem de inserção (id). Uma
-- cadeia por organização exigiria decidir o que fazer com
-- organization_id NULL (eventos de sistema, ex. tarefas agendadas) e
-- complicaria a verificação sem ganho real de segurança — o objetivo é
-- só provar que a sequência de eventos não foi adulterada, não isolar
-- cadeias por tenant.
ALTER TABLE audit_log
  ADD COLUMN previous_event_hash TEXT,
  ADD COLUMN event_hash TEXT;

-- Linhas existentes (se houver, de antes desta migração) não têm como
-- entrar retroativamente numa cadeia verificável sem reescrever seu
-- próprio hash com dados que já foram calculados sem essa coluna — por
-- isso ficam com event_hash NULL, e a verificação da cadeia
-- (src/helpers/verifyAuditChain.tsx) trata isso como "início de uma nova
-- cadeia a partir daqui", não como corrupção.
