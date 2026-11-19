import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requireOrganizationMembership } from "../helpers/organizationAccess.js";
import { schema } from "./organization-allocations_GET.schema.js";
import superjson from "superjson";
import { sql } from "kysely";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    await requireOrganizationMembership(user.id, input.organizationId);

    const rows = await db
      .selectFrom("opportunityAllocations")
      .innerJoin("opportunityRegistry", "opportunityRegistry.id", "opportunityAllocations.opportunityRegistryId")
      .innerJoin("sources", "sources.id", "opportunityRegistry.sourceId")
      .select([
        "opportunityAllocations.id",
        "opportunityAllocations.status",
        "opportunityAllocations.quantityAllocated",
        "opportunityAllocations.notes",
        "opportunityAllocations.createdAt",
        "opportunityAllocations.autoMatched",
        "opportunityAllocations.decidedByUserId",
        "opportunityAllocations.responseDueAt",
        "opportunityAllocations.closedAt",
        "opportunityAllocations.closedReason",
        "opportunityRegistry.id as opportunityId",
        "opportunityRegistry.title as opportunityTitle",
        "opportunityRegistry.description as opportunityDescription",
        "opportunityRegistry.category as opportunityCategory",
        "opportunityRegistry.unit as opportunityUnit",
        "opportunityRegistry.urgency as opportunityUrgency",
        "opportunityRegistry.locationCity as opportunityLocationCity",
        "opportunityRegistry.locationState as opportunityLocationState",
        "sources.name as sourceName",
        // M40: a necessidade da atribuição — a escolhida explicitamente OU a da avaliação de matching que a criou (as duas fontes nunca coexistem) — para a navegação até a jornada.
        sql<number | null>`COALESCE(opportunity_allocations.need_id, (SELECT m.need_id FROM match_evaluations m WHERE m.allocation_id = opportunity_allocations.id ORDER BY m.id LIMIT 1))`.as("needId"),
        // Fase 99C: recebimento físico pendente de regularização de unidade (caso ativo desta atribuição), sem consulta extra por linha.
        sql<number | null>`(SELECT c.id FROM unit_regularization_cases c WHERE c.allocation_id = opportunity_allocations.id AND c.status IN ('aberto', 'conferido') LIMIT 1)`.as("pendingRegularizationCaseId"),
      ])
      .where("opportunityAllocations.organizationId", "=", input.organizationId)
      .orderBy("opportunityAllocations.createdAt", "desc")
      .execute();

    // Fonte ÚNICA da pendência (a tela e o contador usam este mesmo dado): atribuição AUTOMÁTICA 'aceita' que ninguém decidiu e que tem prazo de resposta gravado
    // (response_due_at é gravado só na criação automática; linhas antigas/manuais ficam sem prazo e nunca aparecem como pendência). `serverNow` é o relógio do BANCO,
    // para a tela calcular o tempo restante sem depender do relógio do navegador.
    const nowRow = await sql<{ now: Date }>`SELECT now() AS now`.execute(db);
    const mapped = rows.map(({ autoMatched, decidedByUserId, responseDueAt, closedAt, ...r }) => ({
      ...r,
      quantityAllocated: Number(r.quantityAllocated),
      createdAt: r.createdAt.toString(),
      responseDueAt: responseDueAt ? responseDueAt.toISOString() : null,
      closedAt: closedAt ? closedAt.toISOString() : null,
      pendingAction: r.status === "aceita" && autoMatched && decidedByUserId === null && responseDueAt !== null && r.pendingRegularizationCaseId == null,
    }));
    return new Response(
      superjson.stringify({
        allocations: mapped,
        pendingCount: mapped.filter((a) => a.pendingAction).length,
        serverNow: nowRow.rows[0].now.toISOString(),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar atribuições da organização:", error);
    return buildErrorResponse(error, "Falha ao carregar atribuições");
  }
}
