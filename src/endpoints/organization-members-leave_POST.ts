import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requireOrganizationMembership } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { ConflictError, buildErrorResponse } from "../helpers/errorResponse.js";
import { lockOrganization, readActorUnderLock, countActiveOwners } from "../helpers/membershipAdmin.js";
import { schema } from "./organization-members-leave_POST.schema.js";
import superjson from "superjson";

const USER_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);

    const userLimit = checkRateLimit({ bucket: "organization-members", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.retryAfterSeconds, "Muitas alterações de equipe em pouco tempo. Aguarde antes de tentar de novo.");
    }

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    // Sair não depende de a organização estar "ativa": basta ser membro ativo.
    await requireOrganizationMembership(user.id, input.organizationId);

    await db.transaction().execute(async (trx) => {
      await lockOrganization(trx, input.organizationId);
      const actor = await readActorUnderLock(trx, input.organizationId, user.id);

      if (actor.role === "proprietario" && (await countActiveOwners(trx, input.organizationId)) < 2) {
        throw new ConflictError("Promova outro proprietário antes de sair da organização");
      }

      await trx
        .updateTable("memberships")
        .set({ status: "inativo", updatedAt: new Date() })
        .where("id", "=", actor.id)
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.membro_saiu",
          entityType: "membership",
          entityId: String(actor.id),
          metadata: { papelNoMomento: actor.role },
        },
        trx
      );
    });

    return new Response(superjson.stringify({ left: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao sair da organização:", error);
    return buildErrorResponse(error, "Não foi possível sair da organização");
  }
}
