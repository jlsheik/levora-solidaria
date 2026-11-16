import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./opportunity-changes_GET.schema.js";
import superjson from "superjson";

/** M37 — histórico do RECURSO (alterações de categoria: quem, quando, de/para, versões, correlação, motivo). Leitura (`oportunidades.leia`), sempre filtrada pela organização do pedido. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId"), opportunityId: url.searchParams.get("opportunityId") });
    await requirePermissionToRead(user.id, input.organizationId, "oportunidades.leia");
    const exists = await db.selectFrom("donationOpportunities").select("id").where("id", "=", input.opportunityId).where("organizationId", "=", input.organizationId).executeTakeFirst();
    if (!exists) return new Response(superjson.stringify({ message: "Oportunidade não encontrada nesta organização" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const rows = await db
      .selectFrom("opportunityChanges as c")
      .leftJoin("users as u", "u.id", "c.changedByUserId")
      .select(["c.id", "c.field", "c.previousValue", "c.newValue", "c.versionBefore", "c.versionAfter", "u.displayName", "c.correlationId", "c.reason", "c.createdAt"])
      .where("c.opportunityId", "=", input.opportunityId)
      .where("c.organizationId", "=", input.organizationId)
      .orderBy("c.id", "desc")
      .limit(50)
      .execute();
    const out: OutputType = { changes: rows.map((r) => ({ id: String(r.id), field: r.field, previousValue: r.previousValue, newValue: r.newValue, versionBefore: r.versionBefore, versionAfter: r.versionAfter, changedByName: r.displayName, correlationId: r.correlationId, reason: r.reason, createdAt: r.createdAt.toISOString() })) };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao carregar o histórico da oportunidade:", error);
    return buildErrorResponse(error, "Não foi possível carregar o histórico da oportunidade");
  }
}
