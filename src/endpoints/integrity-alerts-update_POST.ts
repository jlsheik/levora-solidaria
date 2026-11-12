import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { ConflictError, buildErrorResponse } from "../helpers/errorResponse.js";
import type { IntegrityAlertStatus } from "../helpers/schema.js";
import { schema } from "./integrity-alerts-update_POST.schema.js";
import superjson from "superjson";

const TARGET_STATUS = {
  reconhecer: "reconhecido",
  resolver: "resolvido",
  descartar: "descartado",
} as const satisfies Record<string, IntegrityAlertStatus>;

const ALLOWED_FROM: Record<IntegrityAlertStatus, readonly IntegrityAlertStatus[]> = {
  reconhecido: ["aberto"],
  resolvido: ["aberto", "reconhecido"],
  descartado: ["aberto", "reconhecido"],
  aberto: [],
};

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "automacao.gerencie");

    const target = TARGET_STATUS[input.action];

    const result = await db.transaction().execute(async (trx) => {
      const alert = await trx
        .selectFrom("integrityAlerts")
        .select(["id", "status"])
        .where("id", "=", input.alertId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!alert) return null;

      if (!ALLOWED_FROM[target].includes(alert.status)) {
        throw new ConflictError("Este alerta já está em um estado que não permite esta ação");
      }

      const now = new Date();
      await trx
        .updateTable("integrityAlerts")
        .set(
          target === "reconhecido"
            ? { status: target, acknowledgedByUserId: user.id, acknowledgedAt: now }
            : { status: target, resolvedByUserId: user.id, resolvedAt: now, resolutionNote: input.note || null }
        )
        .where("id", "=", alert.id)
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "automacao.alerta_atualizado",
          entityType: "integrity_alert",
          entityId: String(alert.id),
          metadata: { de: alert.status, para: target },
        },
        trx
      );

      return { id: String(alert.id), status: target };
    });

    if (!result) {
      return new Response(superjson.stringify({ message: "Alerta não encontrado nesta organização" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ alert: result }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao atualizar alerta de integridade:", error);
    return buildErrorResponse(error, "Não foi possível atualizar o alerta");
  }
}
