import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { schema, type OutputType } from "./matching-runs_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * M42 — execuções do matching de UMA oferta do Registro Central (incluindo as sem correspondência e as que falharam). Só a plataforma: a oferta e as contagens entre organizações pertencem ao
 * Registro Central; a organização vê, na jornada, apenas o que o motor registrou para a SUA necessidade. Somente leitura.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const url = new URL(request.url);
    const input = schema.parse({ opportunityId: url.searchParams.get("opportunityId"), limit: url.searchParams.get("limit") ?? undefined });
    const rows = await db.selectFrom("matchingRuns as r").leftJoin("users as u", "u.id", "r.triggeredByUserId")
      .select(["r.id", "r.correlationId", "r.origin", "r.status", "r.startedAt", "r.finishedAt", "r.candidatesConsidered", "r.candidatesRelated", "r.validMatches", "r.errorCode", "r.algorithmVersion", "r.repeatCount", "r.lastRepeatedAt", "u.displayName as triggeredByName"])
      .where("r.opportunityRegistryId", "=", input.opportunityId).orderBy("r.id", "desc").limit(input.limit).execute();
    const out: OutputType = {
      runs: rows.map((r) => ({
        id: String(r.id), correlationId: r.correlationId, origin: r.origin, status: r.status as OutputType["runs"][number]["status"], startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        candidatesConsidered: r.candidatesConsidered, candidatesRelated: r.candidatesRelated, validMatches: r.validMatches, errorCode: r.errorCode, algorithmVersion: r.algorithmVersion, repeatCount: r.repeatCount,
        lastRepeatedAt: r.lastRepeatedAt ? r.lastRepeatedAt.toISOString() : null, triggeredByName: r.triggeredByName,
      })),
    };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao carregar as execuções de matching:", error);
    return buildErrorResponse(error, "Falha ao carregar as execuções de matching");
  }
}
