import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildImpactReport } from "../helpers/impactReport.js";
import { schema } from "./impact-report_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
      itemId: url.searchParams.get("itemId"),
      needId: url.searchParams.get("needId"),
      eventType: url.searchParams.get("eventType"),
      destinationDateBasis: url.searchParams.get("destinationDateBasis"),
      destinationType: url.searchParams.get("destinationType"),
    });

    // Prestação de contas é dado sensível: só quem tem relatorios.leia (proprietário/administrador hoje), não qualquer
    // membro — e NÃO por poder ver o histórico de recebimento (logistica.leia). É leitura: não exige organização já
    // aprovada. A autorização é do servidor; todas as consultas filtram organization_id no SQL.
    await requirePermissionToRead(user.id, input.organizationId, "relatorios.leia");

    const report = await buildImpactReport(db, {
      organizationId: input.organizationId,
      startDate: input.startDate,
      endDate: input.endDate,
      itemId: input.itemId ?? null,
      needId: input.needId ?? null,
      eventType: input.eventType ?? null,
      destinationDateBasis: input.destinationDateBasis,
      destinationType: input.destinationType ?? null,
    });

    return new Response(superjson.stringify(report), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao gerar prestação de contas:", error);
    return buildErrorResponse(error, "Falha ao gerar a prestação de contas");
  }
}
