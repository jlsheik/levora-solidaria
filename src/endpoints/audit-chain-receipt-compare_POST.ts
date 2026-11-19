import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { compareReceipt } from "../helpers/auditChainReceipt.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./audit-chain-receipt-compare_POST.schema.js";
import superjson from "superjson";

/**
 * M39 — compara o estado atual da cadeia com um comprovante ANTERIOR (garantia B). Equipe da plataforma. Só lê a trilha; grava apenas o resultado da comparação
 * (códigos, ids e contagens). Um comprovante malformado, de outra versão/algoritmo ou de outro escopo recebe resposta 200 com o status explícito — nunca "conferido".
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const input = schema.parse(superjson.parse(await request.text()));
    const out: OutputType = await compareReceipt(input.receipt, user.id);
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao comparar o comprovante:", error);
    return buildErrorResponse(error, "Não foi possível comparar o comprovante");
  }
}
