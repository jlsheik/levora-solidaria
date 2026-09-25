import { db } from "./db";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks";
import { recordAuditLogEntry } from "./auditLog";

export const APPROVAL_REQUEST_EXPIRATION_DAYS = Number(process.env.APPROVAL_REQUEST_EXPIRATION_DAYS ?? 7);

/**
 * Tarefa agendada: um pedido de dupla autorização (ver src/helpers/approvals.tsx)
 * que ninguém decide vira risco por conta própria — alguém pode estar
 * esperando essa decisão para agir, ou o pedido pode ter sido esquecido
 * silenciosamente sem que ninguém perceba. Depois de
 * APPROVAL_REQUEST_EXPIRATION_DAYS sem decisão, o pedido expira. Isso NÃO
 * aplica a ação pendente automaticamente nem a rejeita — só marca que o
 * pedido não é mais válido, exatamente como uma reserva de matching vencida
 * (ver expireReservations.tsx). Quem precisar da ação original tem que
 * pedir de novo.
 */
export async function expireApprovalRequests() {
  const claim = await claimTaskRun({ taskName: "expireApprovalRequests" });
  if (!claim.claimed) return;

  try {
    const cutoff = new Date(Date.now() - APPROVAL_REQUEST_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

    const expired = await db
      .updateTable("approvalRequests")
      .set({ status: "expirada", decidedAt: new Date(), decisionNotes: `Expirado automaticamente após ${APPROVAL_REQUEST_EXPIRATION_DAYS} dias sem decisão` })
      .where("status", "=", "pendente")
      .where("createdAt", "<", cutoff)
      .returning(["id", "organizationId", "actionType", "requestedByUserId"])
      .execute();

    // Uma única transação (e uma única aquisição do advisory lock da
    // cadeia de auditoria) para toda a varredura, em vez de uma por pedido
    // expirado — uma varredura com muitos pedidos vencidos não devia gerar
    // uma transação isolada por item.
    if (expired.length > 0) {
      await db.transaction().execute(async (trx) => {
        for (const req of expired) {
          await recordAuditLogEntry(
            {
              organizationId: req.organizationId,
              actorUserId: null,
              action: "aprovacao.expirada",
              entityType: "approval_request",
              entityId: String(req.id),
              metadata: { actionType: req.actionType, requestedByUserId: req.requestedByUserId, diasAteExpirar: APPROVAL_REQUEST_EXPIRATION_DAYS },
            },
            trx
          );
        }
      });
    }

    await finishTaskRun(claim.runId, { pedidosExpirados: expired.length });
  } catch (err) {
    await failTaskRun(claim.runId, err);
    throw err;
  }
}
