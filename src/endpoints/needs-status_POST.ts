import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { computeAttendanceProgress, getNeedAttendance } from "../helpers/needAttendance.js";
import { schema } from "./needs-status_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Alteração MANUAL da situação de uma necessidade (Fase 99F: a regra é derivada das destinações, nunca de um clique).
 *  - `atendida`: só se o atendimento CONTABILIZÁVEL (destinações válidas, unidade compatível, líquido de reversões) alcança a quantidade solicitada — recalculado aqui, com a necessidade
 *    travada, e nunca a partir de números vindos do navegador. Senão 409 com o progresso real. Normalmente a transição é AUTOMÁTICA, na transação da destinação que completa a necessidade.
 *    Nunca cria saída de estoque (desde a 99E) nem resolução administrativa nova.
 *  - `cancelada`: não por aqui — o encerramento exige motivo estruturado e evento (POST /need-closure).
 *  - `aberta`: só de `atendida` por registro HISTÓRICO (sem destinação que a comprove) ou de `cancelada` anterior ao registro de encerramentos; necessidade atendida por destinações é
 *    corrigida por reversão (99G) e necessidade encerrada é reaberta pelo evento de reabertura.
 * Ordem de travas: necessidade → auditoria (última).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));

    await requirePermission(user.id, input.organizationId, "necessidades.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      // FOR NO KEY UPDATE (Fases 35/81): serializa mudanças da MESMA necessidade (e destinações/encerramentos dela) sem fechar ciclo com o recebimento (item → FK → need).
      const existing = await trx
        .selectFrom("needs")
        .select(["id", "status", "title", "quantityNeeded"])
        .where("id", "=", input.needId)
        .where("organizationId", "=", input.organizationId)
        .forNoKeyUpdate()
        .executeTakeFirst();

      if (!existing) return { type: "not_found" as const };
      if (existing.status === input.status) return { type: "success" as const, need: { id: existing.id, status: existing.status } }; // idempotente

      const attendance = await getNeedAttendance(trx, existing.id);
      const progress = computeAttendanceProgress(Number(existing.quantityNeeded), attendance, existing.status);

      if (input.status === "cancelada") {
        return { type: "conflict" as const, code: "encerramento_exige_motivo", message: "Para encerrar uma necessidade sem atendimento integral use \"Encerrar necessidade\", que registra o motivo e preserva o atendimento parcial", progress };
      }

      if (input.status === "atendida") {
        if (progress.remaining > 0) {
          return {
            type: "conflict" as const,
            code: "atendimento_insuficiente",
            message: `Não é possível marcar como atendida: o atendimento contabilizável é ${progress.attended} de ${progress.requested} (faltam ${progress.remaining}). Registre as destinações (entregas) da necessidade; quando o total alcançar a quantidade solicitada ela passa a atendida automaticamente`,
            progress,
          };
        }
      } else if (existing.status === "atendida" && progress.remaining === 0) {
        return { type: "conflict" as const, code: "atendida_por_destinacao", message: "Esta necessidade foi atendida por destinações registradas; para corrigir esse atendimento use correção ou reversão da destinação", progress };
      } else if (existing.status === "cancelada") {
        const active = await trx
          .selectFrom("needClosures as c")
          .select("c.id")
          .where("c.needId", "=", existing.id)
          .where("c.entryType", "=", "encerramento")
          .where((eb) => eb.not(eb.exists(eb.selectFrom("needClosures as r").select("r.id").whereRef("r.correctsClosureId", "=", "c.id"))))
          .executeTakeFirst();
        if (active) return { type: "conflict" as const, code: "reabertura_exige_evento", message: "Esta necessidade foi encerrada com motivo registrado; use \"Reabrir necessidade\" para preservar o histórico do encerramento", progress };
      }

      const [updated] = await trx.updateTable("needs").set({ status: input.status, updatedAt: new Date() }).where("id", "=", input.needId).returning(["id", "status"]).execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.status_alterado",
          entityType: "need",
          entityId: String(input.needId),
          metadata: { title: existing.title, statusAnterior: existing.status, statusNovo: input.status, baixaEstoqueAutomatica: false, atendidoContabilizavel: progress.attended, solicitado: progress.requested },
        },
        trx
      );

      return { type: "success" as const, need: updated };
    });

    if (result.type === "not_found") return json(404, { message: "Necessidade não encontrada nesta organização" });
    if (result.type === "conflict") return json(409, { message: result.message, code: result.code, progress: result.progress });
    return json(200, { need: result.need });
  } catch (error: unknown) {
    console.error("Erro ao atualizar necessidade:", error);
    return buildErrorResponse(error, "Não foi possível atualizar a necessidade");
  }
}
