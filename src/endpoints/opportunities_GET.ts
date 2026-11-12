import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requireOrganizationMembership } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { isCategoryEditable, listCategorySuggestions } from "../helpers/opportunityCategory.js";
import { evaluateEligibility } from "../helpers/agentReevaluation.js";
import { schema, type OpportunityAssessment } from "./opportunities_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
    });

    const membership = await requireOrganizationMembership(user.id, input.organizationId);
    const canManage = roleHasPermission(membership.role, "oportunidades.gerencie");
    const canSeeAssessment = roleHasPermission(membership.role, "automacao.leia");

    const rows = await db
      .selectFrom("donationOpportunities")
      .innerJoin("users", "users.id", "donationOpportunities.createdByUserId")
      .leftJoin("needs", "needs.id", "donationOpportunities.linkedNeedId")
      .select([
        "donationOpportunities.id",
        "donationOpportunities.title",
        "donationOpportunities.description",
        "donationOpportunities.category",
        "donationOpportunities.quantityOffered",
        "donationOpportunities.unit",
        "donationOpportunities.donorName",
        "donationOpportunities.donorContact",
        "donationOpportunities.linkedNeedId",
        "needs.title as linkedNeedTitle",
        "donationOpportunities.status",
        "users.displayName as createdByDisplayName",
        "donationOpportunities.createdAt",
        "donationOpportunities.version",
      ])
      .where("donationOpportunities.organizationId", "=", input.organizationId)
      .orderBy("donationOpportunities.createdAt", "desc")
      .execute();

    // M37 — avaliação do Risk Engine por oportunidade (só para quem lê a automação): a execução mais recente de cada oferta DESTA organização.
    const assessments = new Map<number, OpportunityAssessment>();
    if (canSeeAssessment && rows.length > 0) {
      const runs = await db
        .selectFrom("agentEventRuns as r")
        .innerJoin("domainEvents as e", "e.id", "r.eventId")
        .select(["r.id", "r.status", "r.detail", "e.entityId"])
        .where("r.organizationId", "=", input.organizationId)
        .where("e.eventType", "=", "opportunity.created")
        .where("e.entityId", "in", rows.map((r) => String(r.id)))
        .orderBy("r.id", "desc")
        .execute();
      let evaluated = 0;
      for (const run of runs) {
        const oppId = Number(run.entityId);
        if (assessments.has(oppId)) continue;
        const d = (run.detail ?? {}) as { completeness?: OpportunityAssessment["completeness"]; decision?: string; facts?: { categoria?: string | null } };
        let reevaluation: OpportunityAssessment["reevaluation"] = null; let blockCode: string | null = null;
        if (run.status === "dados_insuficientes" && evaluated < 50) { evaluated += 1; const el = await evaluateEligibility(db, input.organizationId, String(run.id)); reevaluation = el?.state ?? null; blockCode = el?.blockCode ?? null; }
        assessments.set(oppId, { runId: String(run.id), status: run.status, completeness: d.completeness ?? null, decision: d.decision ?? null, reevaluation, blockCode, categoryConsidered: d.facts?.categoria ?? null });
      }
    }
    const categorySuggestions = canManage || canSeeAssessment ? await listCategorySuggestions(db, input.organizationId) : [];

    return new Response(
      superjson.stringify({
        categorySuggestions,
        canSeeAssessment,
        opportunities: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          category: r.category,
          quantityOffered: r.quantityOffered !== null ? Number(r.quantityOffered) : null,
          unit: r.unit,
          donorName: r.donorName,
          donorContact: r.donorContact,
          linkedNeedId: r.linkedNeedId,
          linkedNeedTitle: r.linkedNeedTitle,
          status: r.status,
          createdByDisplayName: r.createdByDisplayName,
          createdAt: r.createdAt.toString(),
          version: r.version,
          canEditCategory: canManage && isCategoryEditable(r.status),
          assessment: assessments.get(r.id) ?? null,
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar oportunidades:", error);
    return buildErrorResponse(error, "Falha ao carregar oportunidades");
  }
}
