import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requireOrganizationMembership } from "../helpers/organizationAccess.js";
import { schema } from "./organization-matching-config_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Leitura aberta a qualquer membro ativo (mesmo papel voluntário) — é
 * configuração institucional, não dado sensível de outra organização.
 * Nenhuma escrita aqui, por isso não exige `organizacao.gerencie` nem
 * organização "ativa" (mesmo padrão de requireOrganizationMembership usado
 * em outras leituras abertas do sistema).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    await requireOrganizationMembership(user.id, input.organizationId);

    const [capacities, settings, serviceAreas] = await Promise.all([
      db
        .selectFrom("organizationCapacities")
        .select(["id", "category", "unit", "maxCapacity"])
        .where("organizationId", "=", input.organizationId)
        .orderBy("category", "asc")
        .execute(),
      db
        .selectFrom("organizationMatchingSettings")
        .select(["realizaColeta", "raioColetaKm", "observacoesLogisticas", "observacoesHorarios"])
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst(),
      db
        .selectFrom("organizationServiceAreas")
        .select(["id", "city", "state"])
        .where("organizationId", "=", input.organizationId)
        .orderBy("city", "asc")
        .execute(),
    ]);

    return new Response(
      superjson.stringify({
        capacities: capacities.map((c) => ({ ...c, maxCapacity: Number(c.maxCapacity) })),
        settings: settings ?? null,
        serviceAreas,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao carregar configuração de matching:", error);
    return buildErrorResponse(error, "Não foi possível carregar a configuração de matching");
  }
}
