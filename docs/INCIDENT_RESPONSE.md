# Resposta a incidentes

Master prompt, seção 142 (documentação obrigatória). Este documento é o
procedimento real que existe hoje — deliberadamente curto, porque a
maioria das ferramentas que um procedimento maduro de resposta a
incidentes assume (alertas automáticos, runbook por tipo de incidente,
rotação de on-call) não existe neste projeto ainda. Documentar isso
honestamente é melhor do que um procedimento longo que descreve
ferramentas inexistentes.

## O que existe para investigar um incidente

- **Trilha de auditoria** (`docs/AUDIT.md`) — quem fez o quê, quando, em
  qual organização. Primeiro lugar a olhar para reconstruir uma sequência
  de eventos.
- **`background_task_runs`** — histórico de execução de tarefas de fundo,
  com erro registrado (`failTaskRun`) quando uma falha.
- **Logs do processo** (`console.error` em todo `catch` de endpoint, e no
  agendador) — só stdout/stderr do processo Node hoje, sem agregação
  centralizada (ver "o que não existe" abaixo).
- **`approval_requests`** — toda ação de alto risco que passou por dupla
  autorização, com quem pediu, quem decidiu, e o motivo.

## Categorias de incidente e o que fazer hoje

### Suspeita de conta comprometida

1. Revogar a sessão: apagar a linha correspondente em `sessions`
   (`DELETE FROM sessions WHERE user_id = ?`) — não há endpoint para isso
   ainda, é uma operação direta no banco. Todas as sessões daquele usuário
   caem imediatamente (próxima requisição retorna 401).
2. Revisar `audit_log` filtrando por `actor_user_id` para o período
   suspeito.
3. Se a conta tiver acesso a alguma organização com ação de alto valor
   recente (ajuste de estoque grande, aprovação), revisar `approval_requests`
   e `stock_transactions` daquele período.

### Divergência de inventário / suspeita de desvio

1. `stock_transactions` é append-only e nunca editável — a fonte de
   verdade nunca foi alterada, então a investigação é sempre possível.
2. Somar `stock_transactions.delta` por item e comparar com contagem
   física — é exatamente o mecanismo que a seção 34 do master prompt pede
   (Agente de Estoque), que ainda não existe como automação (ver
   `docs/AI_AGENTS.md`), então essa comparação hoje é manual.
3. Ajustes negativos grandes já exigiram dupla autorização no momento em
   que aconteceram (`src/endpoints/stock-transactions_POST.ts`,
   `HIGH_RISK_ADJUSTMENT_ABSOLUTE`/`RATIO`) — `approval_requests` mostra
   quem pediu e quem aprovou cada um.

### Vazamento de dado entre organizações (falha de isolamento)

1. Isso seria uma falha crítica de `requireOrganizationMembership`/
   `requirePermission` (`docs/ARCHITECTURE.md`) — parar e revisar o
   endpoint específico envolvido imediatamente, não só o incidente pontual.
2. `docs/TESTING.md` tem testes de isolamento entre organizações para os
   domínios cobertos — se um incidente real revelar um caminho não
   coberto, o primeiro passo da correção é adicionar o teste que teria
   pego isso, antes de considerar o incidente encerrado.

### Uso indevido do storage de arquivos ou da IA

- Rate limiting já existe para upload (`docs/RATE_LIMITING.md`) — um
  incidente de abuso de volume é, na prática, um sinal de que o limite
  configurado (30/hora) está baixo demais ou o rate limiting foi
  contornado (verificar se `x-client-ip-verified`/sessão realmente
  identificou o agressor).
- Custo de IA (Anthropic) não tem limite configurado no aplicativo (ver
  `docs/AI_AGENTS.md`, "tabela de custo... não existe") — hoje o único
  controle é o limite de billing configurado diretamente na conta do
  provedor, fora deste sistema.

## O que NÃO existe ainda (registrado para priorização, não fingido)

- Alertas automáticos (nenhum e-mail/notificação dispara sozinho quando
  algo suspeito acontece — seção 42 do master prompt, "Centro de
  Alertas", não implementado).
- Runbook por tipo de incidente além do que está escrito acima.
- Rotação de on-call / plano de comunicação com usuários afetados.
- Log centralizado/agregado (hoje é só stdout do processo).
- RPO/RTO definidos (depende de `docs/OPERATIONS.md`, que também não tem
  backup configurado ainda).
