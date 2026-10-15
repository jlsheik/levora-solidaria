import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching.js";
import { reopenOpportunityIfNoActiveAllocations } from "../helpers/reopenOpportunity.js";
import { concludeOpportunityIfAllTerminalAndReceived } from "../helpers/concludeOpportunity.js";
import { schema } from "./allocations-logistics_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// De onde para onde cada evento pode levar o status da atribuição. Registrar
// um evento fora daqui é rejeitado — a linha do tempo de logística não é
// só um log, ela decide o estado real.
const TRANSITIONS: Record<string, Record<string, string>> = {
  aceita: { coleta_agendada: "em_coleta", cancelado: "cancelada" },
  em_coleta: { coleta_concluida: "em_coleta", transporte_iniciado: "em_transporte", cancelado: "cancelada" },
  em_transporte: { cancelado: "cancelada" },
};

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "logistica.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      const allocation = await trx
        .selectFrom("opportunityAllocations")
        .select(["id", "status", "opportunityRegistryId"])
        .where("id", "=", input.allocationId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!allocation) return { type: "not_found" as const };

      const nextStatus = TRANSITIONS[allocation.status]?.[input.eventType];
      if (!nextStatus) {
        return { type: "invalid_transition" as const, from: allocation.status };
      }

      // Fase 99C: o recurso foi apresentado e aguarda regularização de unidade; cancelar a atribuição agora esconderia um recebimento físico. Resolva ou encerre o caso antes.
      if (input.eventType === "cancelado") {
        const pending = await trx.selectFrom("unitRegularizationCases").select("id").where("allocationId", "=", allocation.id).where("status", "in", ["aberto", "conferido"]).executeTakeFirst();
        if (pending) return { type: "pending_regularization" as const };
      }

      if (nextStatus !== allocation.status) {
        await trx
          .updateTable("opportunityAllocations")
          .set({ status: nextStatus as never, updatedAt: new Date() })
          .where("id", "=", input.allocationId)
          .execute();
      }

      await trx
        .insertInto("logisticsEvents")
        .values({
          opportunityAllocationId: input.allocationId,
          organizationId: input.organizationId,
          eventType: input.eventType,
          scheduledFor: input.scheduledFor ?? null,
          notes: input.notes ?? null,
          actorUserId: user.id,
        })
        .execute();

      // reopenOpportunityIfNoActiveAllocations trava a linha da oportunidade
      // ANTES de contar atribuições-irmãs ainda ativas (achado de auditoria:
      // esta escrita antes era incondicional quanto ao status da
      // oportunidade, e a contagem não travava as linhas-irmãs — as duas
      // coisas corrigidas aqui). A escrita agora só acontece, de forma
      // atômica, se o status atual for "reservada" ou "atribuida" — os
      // únicos dois de onde uma reabertura por cancelamento logístico pode
      // legitimamente partir (ver comentário no helper).
      //
      // Chamado ANTES de recordAuditLogEntry de propósito — não é só estilo.
      // recordAuditLogEntry trava um advisory lock GLOBAL (a cadeia de
      // auditoria) até o commit desta transação; se este bloco travasse a
      // oportunidade DEPOIS do audit log, uma segunda transação que também
      // precisa travar a MESMA oportunidade antes de gravar SEU próprio
      // audit log (ex.: allocations-decide_POST) podia formar um ciclo
      // (A trava auditoria→espera linha da oportunidade; B trava a linha da
      // oportunidade→espera auditoria) — exatamente o deadlock que a
      // auditoria pediu para evitar. Travar recursos "próprios" primeiro e
      // deixar o audit log sempre por último é o mesmo padrão já usado em
      // needs-status_POST.ts e em todo o resto do código.
      // Cancelar pode CONCLUIR a oportunidade (se já existir uma allocation
      // irmã "recebida" e este cancelamento fizer todas ficarem terminais —
      // achado de auditoria: antes, só allocations-receive_POST checava
      // essa condição) ou REABRIR (se nenhuma foi recebida ainda). Tenta
      // concluir primeiro; só tenta reabrir se não concluiu — ver o mesmo
      // padrão em allocations-decide_POST.ts.
      let reopenOpportunityId: number | null = null;
      let concludedOpportunityId: number | null = null;
      if (input.eventType === "cancelado") {
        const concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, allocation.opportunityRegistryId);
        if (concluded) {
          concludedOpportunityId = allocation.opportunityRegistryId;
        } else {
          const didReopen = await reopenOpportunityIfNoActiveAllocations(trx, allocation.opportunityRegistryId);
          if (didReopen) reopenOpportunityId = allocation.opportunityRegistryId;
        }
      }

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: `logistica.${input.eventType}`,
          entityType: "opportunity_allocation",
          entityId: String(input.allocationId),
          metadata: { statusAnterior: allocation.status, statusNovo: nextStatus },
        },
        trx
      );

      if (concludedOpportunityId) {
        await recordAuditLogEntry(
          {
            organizationId: null,
            actorUserId: user.id,
            action: "descoberta_central.concluida",
            entityType: "opportunity_registry",
            entityId: String(concludedOpportunityId),
            metadata: {},
          },
          trx
        );
      }

      return { type: "success" as const, status: nextStatus, reopenOpportunityId };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Atribuição não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "pending_regularization") {
      return new Response(
        superjson.stringify({ message: "Esta atribuição tem um recebimento pendente de regularização de unidade. Resolva ou encerre o caso na fila de pendências antes de cancelar." }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "invalid_transition") {
      return new Response(
        superjson.stringify({ message: `Não é possível registrar "${input.eventType}" com a atribuição em status "${result.from}"` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.reopenOpportunityId) {
      await runMatchingForOpportunity(result.reopenOpportunityId, user.id);
    }

    return new Response(superjson.stringify({ allocation: { id: input.allocationId, status: result.status } }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao registrar evento de logística:", error);
    return buildErrorResponse(error, "Não foi possível registrar o evento");
  }
}
