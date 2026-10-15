import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { scanFile, scanMessage } from "../helpers/fileScan.js";
import { schema, type OutputType } from "./files-rescan_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Reanalisa um arquivo retido (pendente, análise indisponível ou anterior à análise). Idempotente: arquivo com resultado final (aprovado/infectado) devolve o estado gravado, sem nova análise.
 * Quem enviou o arquivo ou proprietário/administrador (`organizacao.gerencie`), sempre dentro da organização do arquivo.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    const limit = checkRateLimit({ bucket: "files-rescan", identifier: String(user.id), limit: 60, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas de análise em pouco tempo. Aguarde antes de tentar de novo.");
    const membership = await requirePermission(user.id, input.organizationId, "arquivos.envie");
    const file = await db.selectFrom("files").select(["id", "uploadedByUserId"]).where("id", "=", input.fileId).where("organizationId", "=", input.organizationId).executeTakeFirst();
    if (!file) return json(404, { message: "Arquivo não encontrado" });
    if (file.uploadedByUserId !== user.id && !roleHasPermission(membership.role, "organizacao.gerencie")) return json(403, { message: "Somente quem enviou o arquivo, ou proprietário/administrador, pode reanalisá-lo" });
    const result = await scanFile(file.id, input.organizationId, user.id);
    return json(200, { file: { id: file.id, scanStatus: result.status, scanMessage: scanMessage(result.status), released: result.released } } satisfies OutputType);
  } catch (error: unknown) {
    console.error("Erro ao reanalisar arquivo:", error);
    return buildErrorResponse(error, "Não foi possível reanalisar o arquivo");
  }
}
