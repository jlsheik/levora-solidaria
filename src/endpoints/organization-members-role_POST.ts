import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { ConflictError, buildErrorResponse } from "../helpers/errorResponse.js";
import {
  lockOrganization,
  readActorUnderLock,
  readTargetUnderLock,
  assertAnotherActiveOwnerRemains,
  assertCanTouchOwner,
  roleRank,
} from "../helpers/membershipAdmin.js";
import { schema } from "./organization-members-role_POST.schema.js";
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

    await requirePermission(user.id, input.organizationId, "membros.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      await lockOrganization(trx, input.organizationId);
      const actor = await readActorUnderLock(trx, input.organizationId, user.id, "membros.gerencie");
      const target = await readTargetUnderLock(trx, input.organizationId, input.membershipId);
      if (!target) return null;

      // Autorização ANTES de conflito de estado (ver deactivate): quem não pode
      // tocar em proprietário recebe 403 sempre, independentemente do estado.
      if (target.role === "proprietario" || input.role === "proprietario") {
        assertCanTouchOwner(actor);
      }

      if (target.status !== "ativo") throw new ConflictError("Este membro já não está ativo");
      if (target.role === input.role) throw new ConflictError("Este membro já tem este papel");

      if (target.userId === actor.userId && roleRank(input.role) > roleRank(target.role)) {
        throw new ConflictError("Você só pode rebaixar o seu próprio papel");
      }

      if (target.role === "proprietario" && input.role !== "proprietario") {
        await assertAnotherActiveOwnerRemains(trx, input.organizationId);
      }

      const [updated] = await trx
        .updateTable("memberships")
        .set({ role: input.role, updatedAt: new Date() })
        .where("id", "=", target.id)
        .returning(["id as membershipId", "userId", "role", "status"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.membro_papel_alterado",
          entityType: "membership",
          entityId: String(target.id),
          metadata: { alvoUserId: target.userId, papelAnterior: target.role, papelNovo: input.role },
        },
        trx
      );

      return updated;
    });

    if (!result) {
      return new Response(superjson.stringify({ message: "Membro não encontrado nesta organização" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ member: result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao alterar papel do membro:", error);
    return buildErrorResponse(error, "Não foi possível alterar o papel do membro");
  }
}
