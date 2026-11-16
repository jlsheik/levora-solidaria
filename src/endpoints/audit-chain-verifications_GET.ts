import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { getPlatformLevel, requirePlatformAdmin } from "../helpers/platformAccess.js";
import { listVerifications } from "../helpers/auditChainVerification.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./audit-chain-verifications_GET.schema.js";
import superjson from "superjson";

/** M38 — últimos resultados da verificação da cadeia. Equipe da plataforma: tudo (ids dos eventos divergentes, quem pediu). Organização (`auditoria.leia`): estado, abrangência, contagens e quantas divergências tocam os eventos DELA. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
    if (input.organizationId === undefined) await requirePlatformAdmin(user.id);
    else await requirePermissionToRead(user.id, input.organizationId, "auditoria.leia");
    const isPlatformAdmin = (await getPlatformLevel(user.id)) !== null;
    const verifications = await listVerifications({ limit: input.limit, isPlatformAdmin, viewerOrganizationId: input.organizationId ?? null });
    const out: OutputType = { canRun: isPlatformAdmin, isPlatformAdmin, scope: "global_chain", verifications };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao carregar as verificações da trilha:", error);
    return buildErrorResponse(error, "Não foi possível carregar as verificações da trilha");
  }
}
