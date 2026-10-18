import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { buildFileScanOperations } from "../helpers/fileScanOperations.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Indicadores GLOBAIS da análise antimalware (saúde do clamd e da base carregada, backlog, tentativas, worker, alertas). Somente administração da plataforma — a mesma fronteira de
 * `background-tasks`: um usuário de organização não vê contagens de outras organizações. Somente leitura; só números e estados (nunca nome de arquivo, chave de armazenamento ou conteúdo).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    return new Response(superjson.stringify(await buildFileScanOperations()), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao montar indicadores da análise de arquivos:", error);
    return buildErrorResponse(error, "Não foi possível carregar os indicadores");
  }
}
