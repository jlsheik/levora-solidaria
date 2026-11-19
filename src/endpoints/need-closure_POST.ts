import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { needCorrelation, allocationCorrelation, destinationCorrelation } from "../helpers/journeyCorrelation.js";
import { computeAttendanceProgress, getNeedAttendance } from "../helpers/needAttendance.js";
import { schema, type OutputType } from "./need-closure_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Fase 99F — encerramento e reabertura de necessidade, ATÔMICOS com o evento em `need_closures` (Fase 99D) e SEM nenhum movimento de estoque. Encerrar = estado existente `cancelada`
 * + motivo estruturado + instantâneo (solicitado, atendido, saldo não atendido); as destinações e os suprimentos já registrados permanecem intactos. Reabrir = evento `reabertura`
 * que corrige o encerramento (o original continua no histórico) e devolve a necessidade a `aberta`; o progresso é sempre RECALCULADO das destinações, nunca reiniciado.
 * O evento é inserido ANTES de mudar `needs.status` (o gatilho do banco exige a situação anterior). Ordem de travas: necessidade → eventos → auditoria (última).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "necessidades.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      const need = await trx
        .selectFrom("needs")
        .select(["id", "title", "status", "quantityNeeded"])
        .where("id", "=", input.needId)
        .where("organizationId", "=", input.organizationId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!need) return { type: "not_found" as const };

      const attendance = await getNeedAttendance(trx, need.id);
      const progress = computeAttendanceProgress(Number(need.quantityNeeded), attendance, need.status);

      const active = await trx
        .selectFrom("needClosures as c")
        .select(["c.id", "c.reasonCode"])
        .where("c.needId", "=", need.id)
        .where("c.entryType", "=", "encerramento")
        .where((eb) => eb.not(eb.exists(eb.selectFrom("needClosures as r").select("r.id").whereRef("r.correctsClosureId", "=", "c.id"))))
        .executeTakeFirst();

      if (input.action === "encerrar") {
        if (need.status === "atendida") return { type: "conflict" as const, code: "necessidade_atendida", message: "Esta necessidade já foi atendida por inteiro: ela não é encerrada como \"não será atendida\"" };
        if (need.status === "cancelada") return { type: "conflict" as const, code: "ja_encerrada", message: "Esta necessidade já está encerrada" };
        if (progress.attended > 0 && (!input.reasonText || input.reasonText.trim().length < 5)) {
          return { type: "invalid" as const, message: "Como já há atendimento parcial, descreva o motivo do encerramento (mínimo de 5 caracteres)" };
        }
        if (input.reasonCode === "outro" && (!input.reasonText || input.reasonText.trim().length < 10)) {
          return { type: "invalid" as const, message: "Para \"outro motivo\", descreva-o (mínimo de 10 caracteres)" };
        }
        await trx
          .insertInto("needClosures")
          .values({
            organizationId: input.organizationId,
            needId: need.id,
            entryType: "encerramento",
            reasonCode: input.reasonCode,
            reasonText: input.reasonText && input.reasonText.length > 0 ? input.reasonText : null,
            quantityNeededSnapshot: progress.requested,
            attendedSnapshot: progress.attended,
            remainingSnapshot: progress.remaining,
            createdByUserId: user.id,
          })
          .execute();
        await trx.updateTable("needs").set({ status: "cancelada", updatedAt: new Date() }).where("id", "=", need.id).execute();
        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "necessidade.encerrada",
            outcome: "concluida",
            correlationId: await needCorrelation(trx, need.id),
            entityType: "need",
            entityId: String(need.id),
            metadata: { titulo: need.title, motivo: input.reasonCode, descricao: input.reasonText ?? null, solicitado: progress.requested, atendido: progress.attended, naoAtendido: progress.remaining, nenhumMovimentoDeEstoque: true },
          },
          trx
        );
        return { type: "ok" as const, status: "cancelada", snapshot: { requested: progress.requested, attended: progress.attended, remaining: progress.remaining } };
      }

      // reabrir
      if (need.status !== "cancelada") return { type: "conflict" as const, code: "nao_encerrada", message: "Só uma necessidade encerrada pode ser reaberta" };
      if (!active) return { type: "conflict" as const, code: "sem_evento_de_encerramento", message: "Esta necessidade foi cancelada antes do registro de encerramentos; reabra-a pela alteração de situação" };
      await trx
        .insertInto("needClosures")
        .values({ organizationId: input.organizationId, needId: need.id, entryType: "reabertura", correctsClosureId: active.id, reasonText: input.reasonText, createdByUserId: user.id })
        .execute();
      await trx.updateTable("needs").set({ status: "aberta", updatedAt: new Date() }).where("id", "=", need.id).execute();
      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.reaberta",
          outcome: "concluida",
          correlationId: await needCorrelation(trx, need.id),
          entityType: "need",
          entityId: String(need.id),
          metadata: { titulo: need.title, encerramentoCorrigidoId: String(active.id), motivo: input.reasonText, atendidoAtual: progress.attended, restante: progress.remaining },
        },
        trx
      );
      return { type: "ok" as const, status: "aberta", snapshot: null };
    });

    if (result.type === "not_found") return json(404, { message: "Necessidade não encontrada nesta organização" });
    if (result.type === "invalid") return json(422, { message: result.message });
    if (result.type === "conflict") return json(409, { message: result.message, code: result.code });
    return json(200, { need: { id: input.needId, status: result.status }, snapshot: result.snapshot } satisfies OutputType);
  } catch (error: unknown) {
    console.error("Erro ao encerrar/reabrir necessidade:", error);
    return buildErrorResponse(error, "Não foi possível concluir a operação");
  }
}
