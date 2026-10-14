import { verifyAuditLogChain } from "./verifyAuditChain.js";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";
import type { Json } from "./schema.js";

/**
 * Fase 53 — fecha SEC-06 da auditoria de segurança (Fase 47): a
 * verificação da hash-chain de `audit_log` existia só sob demanda
 * (`GET /_api/v1/audit-log-verify`), sem nenhuma rotina periódica. Esta
 * tarefa agendada reutiliza o MESMO verificador canônico
 * (`verifyAuditLogChain`, `src/helpers/verifyAuditChain.tsx`) — nenhuma
 * segunda implementação do algoritmo — e a MESMA infraestrutura de tarefa
 * agendada já usada pelas outras 4 tarefas (`claimTaskRun`/
 * `finishTaskRun`/`failTaskRun` em `backgroundTasks.tsx`,
 * `withScheduledTaskLock` em `scheduledTaskLock.tsx`, registro em
 * `scheduled-jobs.json` via `scheduler.tsx`) — nenhuma tabela nova, nenhum
 * mecanismo de lock novo.
 *
 * Três resultados distintos, nunca confundidos (o ponto central desta
 * fase):
 *   - `integrity_valid` — cadeia íntegra. `finishTaskRun` (status
 *     "concluida"), com contagem/duração no `result`.
 *   - `integrity_invalid` — divergência real encontrada. Tratado via
 *     `failTaskRun` (status "falhou") DE PROPÓSITO, mesmo não sendo um
 *     erro de infraestrutura: é o sinal mais forte que o mecanismo
 *     operacional já existente oferece hoje sem precisar de nenhuma
 *     infraestrutura de alerta nova — "revisar background_task_runs com
 *     status=falhou periodicamente" já é a rotina documentada em
 *     docs/OPERATIONS.md, e `GET /_api/v1/background-tasks` (consumido
 *     por plataforma.tsx) já é o painel administrativo onde isso fica
 *     visível, sem nenhuma tela nova. O campo `kind` no JSON de erro
 *     distingue isto de um erro de infraestrutura comum.
 *   - `verification_error` — a verificação em si não rodou até o fim
 *     (banco indisponível, timeout, exceção inesperada). Também
 *     `failTaskRun`, mas sem `kind: "integrity_invalid"` — é o catch
 *     externo, igual às outras 4 tarefas.
 *
 * Nunca escreve o resultado (nem uma falha) de volta em `audit_log` — isso
 * mudaria a própria cadeia que acabou de ser considerada possivelmente
 * comprometida (arquitetura circular explicitamente proibida nesta fase).
 * `background_task_runs` é uma tabela operacional separada, já existente,
 * nunca lida pela verificação da cadeia.
 */
export async function verifyAuditChainScheduled(): Promise<void> {
  await withScheduledTaskLock("verifyAuditChain", () => runVerifyAuditChain());
}

async function runVerifyAuditChain(): Promise<void> {
  const claim = await claimTaskRun({ taskName: "verifyAuditChain" });
  if (!claim.claimed) return;

  const startedAt = Date.now();
  try {
    const result = await verifyAuditLogChain();
    const duracaoMs = Date.now() - startedAt;

    if (result.integra) {
      await finishTaskRun(claim.runId, {
        kind: "integrity_valid",
        totalEventos: result.totalEventos,
        eventosVerificados: result.eventosVerificados,
        eventosPreExistentesSemHash: result.eventosPreExistentesSemHash,
        duracaoMs,
      });
      return;
    }

    await failTaskRun(
      claim.runId,
      new Error(
        `Integridade da audit chain comprometida: ${result.divergencias.length} divergência(s) em ${result.totalEventos} evento(s) verificado(s).`
      ),
      {
        kind: "integrity_invalid",
        totalEventos: result.totalEventos,
        eventosVerificados: result.eventosVerificados,
        divergencias: result.divergencias as unknown as Json,
        duracaoMs,
      }
    );
  } catch (err) {
    // A verificação em si não terminou (erro de infraestrutura/aplicação,
    // não uma divergência de hash encontrada) — distinto do bloco acima.
    await failTaskRun(claim.runId, err, { kind: "verification_error" });
    throw err;
  }
}
