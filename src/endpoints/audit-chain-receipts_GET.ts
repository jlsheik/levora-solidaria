import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { getPlatformLevel, requirePlatformAdmin } from "../helpers/platformAccess.js";
import { listReceipts } from "../helpers/auditChainReceipt.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./audit-chain-receipts_GET.schema.js";
import superjson from "superjson";

/** M39 — comprovantes locais gerados e o último resultado de comparação de cada um. Plataforma: com hashes e digest. Organização (`auditoria.leia`): só existência, data e estado. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
    if (input.organizationId === undefined) await requirePlatformAdmin(user.id);
    else await requirePermissionToRead(user.id, input.organizationId, "auditoria.leia");
    const isPlatformAdmin = (await getPlatformLevel(user.id)) !== null;
    const out: OutputType = { canManage: isPlatformAdmin, receipts: await listReceipts({ limit: input.limit, isPlatformAdmin }), independentAnchorConfigured: false };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao listar os comprovantes:", error);
    return buildErrorResponse(error, "Não foi possível carregar os comprovantes");
  }
}
