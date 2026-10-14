# Auditoria

Master prompt, seção 142 (documentação obrigatória) e seção 12 (auditoria
imutável, hash encadeado).

## O que existe

`audit_log` (`db/schema.sql`):

```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_event_hash TEXT,
  event_hash TEXT
);
```

- **Append-only de verdade, aplicado pelo banco**: triggers
  (`audit_log_no_update`/`audit_log_no_delete`) bloqueiam `UPDATE` e
  `DELETE` na tabela — não é uma convenção de aplicação que um bug
  poderia violar, o próprio Postgres recusa a operação.
- **Único caminho de escrita**: `recordAuditLogEntry`
  (`src/helpers/auditLog.tsx`) — sempre dentro da mesma transação da ação
  de negócio que está sendo registrada, para nunca ficar fora de sincronia
  com o que realmente aconteceu (ex.: se a transação de negócio falhar e
  reverter, o registro de auditoria reverte junto).
- **Leitura restrita por permissão** (`auditoria.leia`, ver
  `docs/RBAC_PERMISSOES.md`) — hoje só proprietário/administrador,
  filtrada por organização.
- **Cobertura real**: toda ação de escrita relevante deste sistema grava
  uma entrada — criação/aprovação/revogação de convite, lançamento de
  estoque, mudança de status de necessidade/oportunidade/atribuição,
  decisão de aprovação, upload/download de arquivo, expiração automática
  de reserva/oportunidade/aprovação pendente (rodada pelo agendador, ver
  `src/helpers/scheduler.tsx`, com `actor_user_id = null` quando o sistema
  agiu sozinho, nunca atribuído a uma pessoa que não agiu).

## Hash encadeado (RESOLVIDO)

Cada evento inclui, em `previous_event_hash`, o `event_hash` do evento
imediatamente anterior na tabela (ordem de `id`) — uma cadeia única e
global, não uma por organização (eventos de sistema com
`organization_id = NULL`, como expiração automática de reserva, também
entram na mesma cadeia). `event_hash` é
`SHA256(organization_id | actor_user_id | action | entity_type | entity_id | metadata | created_at | previous_event_hash)`,
calculado em `computeAuditEventHash` (`src/helpers/auditLog.tsx`).

- **Concorrência**: `recordAuditLogEntry` toma um advisory lock
  (`pg_advisory_xact_lock`) antes de ler o último `event_hash` e inserir —
  serializa toda escrita na cadeia, mesmo entre organizações diferentes,
  para que duas transações concorrentes nunca leiam o mesmo "hash anterior"
  e bifurquem a cadeia.
- **Verificação**: `verifyAuditLogChain` (`src/helpers/verifyAuditChain.tsx`)
  percorre a tabela inteira e recalcula cada hash a partir dos campos
  gravados, comparando com o valor salvo — isso é o mecanismo real de
  "evidência de adulteração" que a seção 12 pede, exposto via
  `GET /_api/v1/audit-log-verify` (restrito a admin de plataforma, porque a
  cadeia é global, não de uma organização).
- **Linhas de antes desta migração** (sem `event_hash`) não contam como
  corrupção — a verificação trata isso como "a cadeia recomeça a partir
  daqui", nunca como uma divergência.
- **Pega de verdade um dado real de JSONB**: a primeira versão desta
  implementação tinha um bug — `JSON.stringify(metadata)` direto é sensível
  à ordem das chaves, e o Postgres `jsonb` não garante preservar a ordem de
  inserção ao devolver o dado. Isso gerava falso positivo de "adulteração"
  para um evento que nunca tinha sido alterado — descoberto rodando a
  verificação contra o banco de desenvolvimento de verdade. Corrigido
  serializando `metadata` com chaves ordenadas recursivamente
  (`stableStringify` em `auditLog.tsx`) antes de calcular o hash, nos dois
  lugares (escrita e verificação). Coberto por teste de regressão
  (`test/auditChain.test.ts`).

O que a proteção cobre agora: além do append-only por trigger (protege
contra alteração pela aplicação normal), a cadeia de hash prova
matematicamente se a sequência de eventos foi adulterada por alguém com
acesso direto ao Postgres — qualquer alteração retroativa quebra o hash a
partir daquele ponto, detectável rodando `verifyAuditLogChain`.

**RESOLVIDO (Fase 53)**: a verificação deixou de depender só de alguém
lembrar de chamar o endpoint sob demanda. `verifyAuditChainScheduled`
(`src/helpers/verifyAuditChainTask.tsx`) reutiliza o MESMO verificador
canônico (`verifyAuditLogChain`, nenhuma segunda implementação do
algoritmo) dentro da infraestrutura de tarefa agendada já existente
(`scheduler.tsx` + `scheduled-jobs.json` + `TASK_HANDLERS`), a cada 6 horas
(custo medido: ~0,004ms/evento de CPU pura, mesmo em 100 mil eventos
sintéticos — a frequência não é limitada por custo, escolhida por ser um
intervalo operacional razoável para um processo interno, não por
necessidade de performance).

Protegida contra execução concorrente pelo MESMO mecanismo que as outras 4
tarefas agendadas já usam (`withScheduledTaskLock`, advisory lock de
SESSÃO do Postgres — não um `boolean` em memória, que não protegeria entre
processos caso o deployment um dia tenha mais de uma instância) —
provado empiricamente com duas execuções simultâneas reais em
`test/verifyAuditChainTaskMocked.test.ts`: a segunda nunca chega a chamar
o verificador.

Três resultados distintos, nunca confundidos: `integrity_valid` (sucesso),
`integrity_invalid` (divergência real — tratado como FALHA operacional de
propósito, reaproveitando a rotina já documentada "revisar
background_task_runs com status=falhou periodicamente" e o painel
administrativo já existente, `GET /_api/v1/background-tasks` consumido por
`plataforma.tsx` — nenhuma tela nova), e `verification_error` (erro de
infraestrutura ao RODAR a verificação, nunca confundido com corrupção
real). O resultado é persistido em `background_task_runs` (tabela
operacional já existente, nunca uma segunda "audit log") — a verificação
NUNCA escreve de volta em `audit_log`, mesmo para registrar a própria
falha, para nunca contaminar a cadeia que acabou de ser considerada
possivelmente comprometida.

**Continua sem canal de alerta externo** (e-mail/webhook/SMS) — não existe
infraestrutura de notificação neste projeto hoje (ver
`docs/INCIDENT_RESPONSE.md`), e não foi criada artificialmente só para
esta fase. O ponto de integração para um alerta futuro fica claramente
preparado: `error.kind === "integrity_invalid"` em qualquer linha de
`background_task_runs` é o sinal inequívoco a observar.

## Correção de erro (não é exclusão)

Consistente com a seção 12 do master prompt: nenhum fluxo deste sistema
tem uma operação de "editar o passado". Uma correção sempre é um evento
novo referenciando o anterior (ex.: `needs-status_POST` grava
`statusAnterior`/`statusNovo` no `metadata`, nunca sobrescreve o registro
anterior). `stock_transactions` e `logistics_events` seguem o mesmo
princípio — append-only, também com triggers de banco bloqueando
`UPDATE`/`DELETE`.
