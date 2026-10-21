import { db } from "../../helpers/db.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { generatePasswordHash } from "../../helpers/generatePasswordHash.js";
import { loadPendingChallengeForUpdate, peekChallengeUserId, readChallengeSecret } from "../../helpers/authChallenges.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { invalidChallengeResponse, jsonResponse } from "../../helpers/authResponses.js";
import { schema } from "./bootstrap-credentials_POST.schema.js";
import superjson from "superjson";

const LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

/**
 * Passo de credencial do bootstrap/recuperação: guarda nome e hash da senha NO CHALLENGE (nada vira usuário/credencial antes
 * da transação final). Só aceita um challenge de bootstrap_owner (nome+senha obrigatórios) ou owner_recovery (senha opcional).
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: "bootstrap-credentials", identifier: ip, ...LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas. Aguarde antes de tentar de novo.");
    const secret = readChallengeSecret(request);
    if (!secret) return invalidChallengeResponse();
    const input = schema.parse(superjson.parse(await request.text()));
    const now = new Date();
    // O hash (bcrypt) é calculado ANTES da transação (nenhum lock segurado durante ele).
    const passwordHash = input.password ? await generatePasswordHash(input.password) : null;

    const outcome = await db.transaction().execute(async (trx) => {
      const ownerId = await peekChallengeUserId(trx, secret);
      if (ownerId === undefined) return "invalido" as const;
      if (ownerId !== null) await lockUsersInOrder(trx, [ownerId]);
      const challenge = await loadPendingChallengeForUpdate(trx, secret, ["bootstrap_owner", "owner_recovery"], now);
      if (!challenge) return "invalido" as const;
      const displayName = input.displayName ?? challenge.pendingDisplayName;
      const hash = passwordHash ?? challenge.pendingPasswordHash;
      if (challenge.purpose === "bootstrap_owner" && (!hash || !displayName)) return "incompleto" as const;
      await trx.updateTable("authChallenges").set({ pendingDisplayName: displayName, pendingPasswordHash: hash }).where("id", "=", challenge.id).execute();
      return "ok" as const;
    });
    if (outcome === "invalido") return invalidChallengeResponse();
    if (outcome === "incompleto") return jsonResponse(400, { message: "Informe nome e senha.", code: "credenciais_incompletas" });
    return jsonResponse(200, { ok: true });
  } catch (error: unknown) {
    console.error("Erro nas credenciais do bootstrap:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível salvar as credenciais");
  }
}
