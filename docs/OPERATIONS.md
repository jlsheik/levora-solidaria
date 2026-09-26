# Operação

Master prompt, seção 142 (documentação obrigatória) e seções 56-58 (backup,
recuperação de desastre, filas/tarefas assíncronas).

## Tarefas de fundo (o que roda sozinho)

`src/helpers/scheduler.tsx` dispara, dentro do próprio processo Node
(`node-cron`, sem infraestrutura externa):

| Tarefa | Frequência | O que faz |
|---|---|---|
| `runMatchingSweep` | a cada 15 min | reavalia matching para oportunidades aguardando destinação |
| `expireReservations` | a cada 10 min | libera atribuições propostas cuja reserva de 30 min venceu |
| `expireOpportunities` | a cada hora | expira oportunidades vencidas |
| `expireApprovalRequests` | a cada hora | expira pedidos de dupla autorização parados há mais de `APPROVAL_REQUEST_EXPIRATION_DAYS` dias |

Configuração em `src/static/__dev/scheduled-jobs.json`. Cada execução fica
registrada em `background_task_runs` (status, tentativas, erro) —
consultável via `GET /_api/v1/background-tasks` e reprocessável
manualmente (só platform admin) via `POST /_api/v1/background-tasks-retry`
quando falha.

**Limitação conhecida em múltiplas instâncias**: ver
`docs/DEPLOYMENT.md`, "Múltiplas instâncias" — cada instância roda o
agendador de forma independente hoje.

### Idempotência de `background_task_runs` — achado de auditoria (RESOLVIDO parcialmente)

Auditoria de segurança encontrou dois pontos:

1. **`idempotencyKey` nunca é usado por nenhum chamador real** — as 4
   tarefas agendadas chamam `claimTaskRun({ taskName })` sem essa chave.
   A proteção real contra duplicação hoje vem das cláusulas
   `WHERE status = ...` de cada tarefa (cada uma naturalmente idempotente
   por conta própria — ver testes em `test/idempotency.test.ts`), não do
   mecanismo de idempotência dedicado. Isso é suficiente para o padrão
   atual (nenhuma tarefa hoje precisa de deduplicação por uma chave de
   negócio específica), mas o mecanismo de `idempotencyKey` continua sendo
   "capacidade não usada" — decisão registrada aqui, não corrigida
   silenciosamente: usar essa chave nas tarefas agendadas exigiria decidir
   a granularidade de deduplicação (por tick de cron? por dia?), o que é
   uma escolha de produto, não um bug.
2. **Corrida real corrigida**: `claimTaskRun` fazia SELECT-then-INSERT
   dentro de uma transação; sob concorrência genuína com a MESMA
   `idempotencyKey`, duas chamadas podiam ambas ver "não existe" (READ
   COMMITTED não impede isso) e uma delas recebia uma exceção de violação
   de unicidade não tratada, em vez do mesmo `claimed: false` que o
   caminho normal devolve. Corrigido capturando a violação e reconsultando
   a linha vencedora — `src/helpers/backgroundTasks.tsx`. Testado com
   chamadas concorrentes reais em `test/idempotency.test.ts`.

## Monitoramento

- `GET /_api/__health` — status do processo e contagem de endpoints
  montados. Não versionado de propósito (ver `docs/VERSIONAMENTO_API.md`).
- **Sem métricas nem dashboards** — não há Prometheus/Grafana/equivalente
  configurado. Observabilidade real (seção 6 do master prompt) não
  implementada além de logs de processo e `background_task_runs`.
- **Sem alertas** — ver `docs/INCIDENT_RESPONSE.md`.

## Backup

**Não configurado neste repositório.** Não há script de backup, não há
teste de restauração, não há RPO/RTO definido. Isto é responsabilidade de
infraestrutura no ambiente de produção real (ex.: backup automático do
provedor de Postgres gerenciado), não algo que este código faz sozinho.

Quando configurado, a seção 56 do master prompt pede: backup automático
diário, retenção múltipla, backup de banco E de storage crítico (arquivos
enviados — ver `docs/UPLOAD_DE_ARQUIVOS.md`, relevante especialmente para
quem usa disco local em vez de S3), backup de configuração, e — o ponto
mais frequentemente esquecido — teste de restauração real e registrado
("tem backup" não é suficiente sem já ter restaurado pelo menos uma vez).

## Recuperação de desastre

**Não documentado nem testado ainda.** Pontos que precisam de decisão
quando isso for formalizado:

- RPO/RTO — nenhum definido.
- Troca de secrets após um incidente (`JWT_SECRET` novo invalida todas as
  sessões existentes de uma vez — isso é o comportamento correto em caso
  de comprometimento, mas precisa ser uma decisão consciente, não uma
  surpresa).
- Reprocessamento de tarefas assíncronas após restauração — as tarefas já
  são idempotentes o bastante (`background_task_runs.idempotency_key`,
  `claimTaskRun`) para rodar de novo sem duplicar efeito, na maioria dos
  casos (ver `docs/DEPLOYMENT.md`, "múltiplas instâncias" para a mesma
  lógica aplicada a concorrência em vez de restauração).
- Reconciliação com provedores externos (e-mail, S3, IA) após um período
  de indisponibilidade — não implementada; hoje uma falha desses
  provedores é só logada e a operação continua sem eles (modo "não
  configurado" para e-mail, erro explícito para IA — nenhum dos dois
  bloqueia o resto do sistema).

## Rotina operacional do dia a dia

- Revisar `background_task_runs` com `status = 'falhou'` periodicamente —
  não há alerta automático para isso ainda (ver
  `docs/INCIDENT_RESPONSE.md`).
- Revisar organizações com `status = 'em_analise'` pendentes de aprovação
  (`GET /_api/v1/platform-organizations`) — sem isso, uma organização pode
  ficar "em análise" indefinidamente enquanto já opera normalmente (ver
  `docs/ACCESS_CODES.md`, lacuna de controle por status de organização).
- Revisar `approval_requests` pendentes antes de expirarem sozinhas (ver
  Fase 12 do plano de implementação) — a expiração automática existe para
  não deixar um pedido parado para sempre, mas não substitui alguém
  realmente decidindo a tempo.
