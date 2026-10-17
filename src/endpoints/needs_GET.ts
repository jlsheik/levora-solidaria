import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requireOrganizationMembership } from "../helpers/organizationAccess.js";
import { getNeedFulfillmentBalanceBatch, computeNeedProgress } from "../helpers/needFulfillment.js";
import { computeAttendanceProgress, getNeedAttendanceBatch } from "../helpers/needAttendance.js";
import { schema } from "./needs_GET.schema.js";
import { sql } from "kysely";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
    });

    await requireOrganizationMembership(user.id, input.organizationId);

    const rows = await db
      .selectFrom("needs")
      .innerJoin("users", "users.id", "needs.createdByUserId")
      .leftJoin("inventoryItems", "inventoryItems.id", "needs.itemId")
      .select([
        "needs.id",
        "needs.title",
        "needs.description",
        "needs.itemId",
        "inventoryItems.name as itemName",
        "needs.quantityNeeded",
        "needs.unit",
        "needs.priority",
        "needs.status",
        "users.displayName as createdByDisplayName",
        "needs.createdAt",
      ])
      .where("needs.organizationId", "=", input.organizationId)
      .orderBy(
        sql`case "needs"."priority" when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end`
      )
      .orderBy("needs.createdAt", "desc")
      .execute();

    // Progresso derivado do Modelo B (Fase 42) — uma única query em lote
    // (GROUP BY need_id) para todas as needs desta listagem, nunca um SUM
    // por linha (evita N+1). `needs.status` nunca é lido nem alterado aqui;
    // o progresso é puramente informativo, calculado à parte.
    const balances = await getNeedFulfillmentBalanceBatch(db, rows.map((r) => r.id));
    // Fase 99F: ATENDIMENTO FINAL (derivado das destinações) em lote — nunca somado ao suprimento acima — e o encerramento ativo (evento em need_closures) de cada necessidade
    // cancelada, em uma só consulta. Tudo escopado pelos ids desta organização.
    const attendance = await getNeedAttendanceBatch(db, rows.map((r) => r.id));
    const cancelledIds = rows.filter((r) => r.status === "cancelada").map((r) => r.id);
    const closures = new Map<number, { reasonCode: string | null; reasonText: string | null; quantityNeededSnapshot: number | null; attendedSnapshot: number | null; remainingSnapshot: number | null; closedAt: string }>();
    if (cancelledIds.length > 0) {
      const closureRows = await db
        .selectFrom("needClosures as c")
        .select(["c.needId", "c.reasonCode", "c.reasonText", "c.quantityNeededSnapshot", "c.attendedSnapshot", "c.remainingSnapshot", "c.createdAt"])
        .where("c.organizationId", "=", input.organizationId)
        .where("c.needId", "in", cancelledIds)
        .where("c.entryType", "=", "encerramento")
        .where((eb) => eb.not(eb.exists(eb.selectFrom("needClosures as r").select("r.id").whereRef("r.correctsClosureId", "=", "c.id"))))
        .execute();
      for (const c of closureRows) {
        closures.set(c.needId, {
          reasonCode: c.reasonCode,
          reasonText: c.reasonText,
          quantityNeededSnapshot: c.quantityNeededSnapshot === null ? null : Number(c.quantityNeededSnapshot),
          attendedSnapshot: c.attendedSnapshot === null ? null : Number(c.attendedSnapshot),
          remainingSnapshot: c.remainingSnapshot === null ? null : Number(c.remainingSnapshot),
          closedAt: c.createdAt.toISOString(),
        });
      }
    }

    return new Response(
      superjson.stringify({
        needs: rows.map((r) => {
          const quantityNeeded = Number(r.quantityNeeded);
          const progress = computeNeedProgress(quantityNeeded, balances.get(r.id) ?? 0);
          return {
            id: r.id,
            title: r.title,
            description: r.description,
            itemId: r.itemId,
            itemName: r.itemName,
            quantityNeeded,
            unit: r.unit,
            priority: r.priority,
            status: r.status,
            createdByDisplayName: r.createdByDisplayName,
            createdAt: r.createdAt.toString(),
            fulfilled: progress.fulfilled,
            requiredRemaining: progress.requiredRemaining,
            surplus: progress.surplus,
            attendance: computeAttendanceProgress(quantityNeeded, attendance.get(r.id) ?? { physicalNet: 0, appliedNet: 0, surplusNet: 0, unitIncompatiblePhysical: 0, destinationCount: 0 }, r.status),
            closure: closures.get(r.id) ?? null,
          };
        }),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar necessidades:", error);
    return buildErrorResponse(error, "Falha ao carregar necessidades");
  }
}
