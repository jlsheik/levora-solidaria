import type { Transaction } from "kysely";
import type { DB, ExceptionStatus } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { ConflictError } from "./errorResponse.js";
import { syncRunsAfterDecision } from "./agentEventRuns.js";

/**
 * Decisão humana sobre uma exceção criada por uma regra de proteção (master
 * prompt, seção 45). Revisão simples exige uma aprovação; dupla autorização
 * exige duas pessoas DIFERENTES (a chave primária de `exception_decisions`
 * impede a mesma pessoa de contar duas vezes). Qualquer rejeição encerra
 * a exceção na hora. Aprovar não executa nada: o agente reexecuta a ação,
 * citando a exceção aprovada, e ela é consumida uma única vez
 * (agentTools.tsx).
 */

export async function decideException(
  trx: Transaction<DB>,
  input: { organizationId: number; exceptionId: string; userId: number; decision: "aprovar" | "rejeitar"; notes?: string | null }
): Promise<{ status: ExceptionStatus; approvals: number; approvalsRequired: number } | null> {
  const exception = await trx
    .selectFrom("exceptionQueue")
    .select(["id", "status", "approvalsRequired", "toolName", "ruleCode", "correlationId"])
    .where("id", "=", input.exceptionId)
    .where("organizationId", "=", input.organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!exception) return null;

  if (exception.status !== "pendente") {
    throw new ConflictError("Esta exceção já foi decidida");
  }

  const already = await trx
    .selectFrom("exceptionDecisions")
    .select("userId")
    .where("exceptionId", "=", exception.id)
    .where("userId", "=", input.userId)
    .executeTakeFirst();
  if (already) throw new ConflictError("Você já decidiu esta exceção; a dupla autorização exige outra pessoa");

  await trx
    .insertInto("exceptionDecisions")
    .values({
      exceptionId: exception.id,
      userId: input.userId,
      decision: input.decision,
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 500) : null,
    })
    .execute();

  const approvalsRow = await trx
    .selectFrom("exceptionDecisions")
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .where("exceptionId", "=", exception.id)
    .where("decision", "=", "aprovar")
    .executeTakeFirstOrThrow();
  const approvals = Number(approvalsRow.total);

  let status: ExceptionStatus = "pendente";
  if (input.decision === "rejeitar") status = "rejeitada";
  else if (approvals >= exception.approvalsRequired) status = "aprovada";

  if (status !== "pendente") {
    await trx.updateTable("exceptionQueue").set({ status }).where("id", "=", exception.id).execute();
  }

  await recordAuditLogEntry(
    {
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "automacao.excecao_decidida",
      outcome: "concluida", // a DECISÃO humana foi registrada (aprovar/rejeitar está em metadata); o efeito sobre a execução é outro passo
      correlationId: exception.correlationId,
      entityType: "exception",
      entityId: String(exception.id),
      metadata: {
        decisao: input.decision,
        statusResultante: status,
        ferramenta: exception.toolName,
        regra: exception.ruleCode,
      },
    },
    trx
  );

  // M34: a execução do motor de eventos ligada a esta exceção acompanha a decisão (mesma transação).
  await syncRunsAfterDecision(trx, { organizationId: input.organizationId, exceptionId: String(exception.id), status, userId: input.userId });

  return { status, approvals, approvalsRequired: exception.approvalsRequired };
}
