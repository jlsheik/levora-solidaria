import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { startAuditChainVerification } from "../helpers/auditChainVerification.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./audit-chain-verify_POST.schema.js";
import superjson from "superjson";

/**
 * M38 — pede a verificação da cadeia de auditoria (REUSA `verifyAuditLogChain`). A cadeia é global: somente a equipe da plataforma executa. Responde 202 de imediato; o resultado é lido em
 * `audit-chain-verifications`. No máximo uma verificação por vez (409 `verificacao_em_andamento`). Nunca repara nada: só lê.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const text = await request.text();
    schema.parse(text ? superjson.parse(text) : {});
    const started = await startAuditChainVerification(user.id);
    const out: OutputType = { id: started.id, startedAt: started.startedAt, status: "em_andamento" };
    return new Response(superjson.stringify(out), { status: 202, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao iniciar a verificação da trilha:", error);
    return buildErrorResponse(error, "Não foi possível iniciar a verificação da trilha");
  }
}
