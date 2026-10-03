import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import { ConflictError } from "./errorResponse.js";
import { PlatformAccessError } from "./platformAccess.js";
import { lockPlatformAccessInOrder, lockUsersInOrder } from "./lockOrder.js";
import { recordAuditLogEntry } from "./auditLog.js";

/**
 * Operações internas sobre `platform_access` (Fase 89) — SEM endpoint HTTP e SEM step-up (isso é da Fase 90).
 * Existem para que a regra "último owner" e a ordem de locks sejam executadas e testadas por código de aplicação,
 * não só por trigger. Quem chama deve estar numa transação (`trx`) e NÃO ter travado nada fora da ordem canônica
 * (lockOrder.tsx). Auditoria sempre por último.
 *
 * Regras (§25.1/§25.3): só o owner ativo concede/revoga/transfere; o owner não revoga a si mesmo nem rebaixa-se sem
 * transferir; um owner nunca é revogado diretamente (usa-se a transferência); não existe promoção por cadastro.
 */

async function loadActorAndTarget(trx: Transaction<DB>, actorUserId: number, targetUserId: number) {
  await lockUsersInOrder(trx, [actorUserId, targetUserId]);
  const rows = await lockPlatformAccessInOrder(trx, [actorUserId, targetUserId]);
  const actor = rows.find((r) => r.userId === actorUserId);
  const target = rows.find((r) => r.userId === targetUserId);
  if (!actor || actor.status !== "active" || actor.level !== "owner") {
    throw new PlatformAccessError("Esta ação é restrita ao proprietário da plataforma");
  }
  return { actor, target };
}

async function assertTargetIsLiveUser(trx: Transaction<DB>, userId: number) {
  const user = await trx.selectFrom("users").select(["id", "anonymizedAt"]).where("id", "=", userId).executeTakeFirst();
  if (!user || user.anonymizedAt) throw new ConflictError("Usuário inexistente ou removido");
}

export async function grantPlatformAdmin(trx: Transaction<DB>, params: { actorUserId: number; targetUserId: number }) {
  const { actor, target } = await loadActorAndTarget(trx, params.actorUserId, params.targetUserId);
  if (params.actorUserId === params.targetUserId) throw new ConflictError("O proprietário já possui acesso de plataforma");
  await assertTargetIsLiveUser(trx, params.targetUserId);
  if (target?.status === "active") throw new ConflictError("Este usuário já possui acesso de plataforma ativo");

  if (target) {
    await trx
      .updateTable("platformAccess")
      .set({ level: "admin", status: "active", revokedAt: null, revokedByUserId: null, revokedReason: null, grantedAt: new Date(), grantedByUserId: actor.userId, grantOrigin: "owner_grant" })
      .where("userId", "=", params.targetUserId)
      .execute();
  } else {
    await trx
      .insertInto("platformAccess")
      .values({ userId: params.targetUserId, level: "admin", status: "active", grantedByUserId: actor.userId, grantOrigin: "owner_grant" })
      .execute();
  }
  await recordAuditLogEntry(
    { organizationId: null, actorUserId: actor.userId, action: "plataforma.admin_concedido", entityType: "user", entityId: String(params.targetUserId), metadata: {} },
    trx
  );
}

export async function revokePlatformAccess(trx: Transaction<DB>, params: { actorUserId: number; targetUserId: number; reason?: string }) {
  const { actor, target } = await loadActorAndTarget(trx, params.actorUserId, params.targetUserId);
  if (params.actorUserId === params.targetUserId) throw new ConflictError("O proprietário não pode revogar o próprio acesso; transfira a propriedade antes");
  if (!target || target.status !== "active") throw new ConflictError("Este usuário não possui acesso de plataforma ativo");
  if (target.level === "owner") throw new ConflictError("O proprietário não é revogado diretamente; use a transferência de propriedade");

  await trx
    .updateTable("platformAccess")
    .set({ status: "revoked", revokedAt: new Date(), revokedByUserId: actor.userId, revokedReason: params.reason ?? null })
    .where("userId", "=", params.targetUserId)
    .execute();
  // As sessões do ex-admin perdem o tier de plataforma na próxima validação (o poder é relido do banco a cada requisição).
  await recordAuditLogEntry(
    { organizationId: null, actorUserId: actor.userId, action: "plataforma.acesso_revogado", entityType: "user", entityId: String(params.targetUserId), metadata: { nivel: target.level } },
    trx
  );
}

/** Transferência de ownership: owner → admin e admin ativo → owner, NA MESMA transação (trigger deferido valida no commit). */
export async function transferPlatformOwnership(trx: Transaction<DB>, params: { actorUserId: number; targetUserId: number }) {
  const { actor, target } = await loadActorAndTarget(trx, params.actorUserId, params.targetUserId);
  if (params.actorUserId === params.targetUserId) throw new ConflictError("Informe outro usuário para receber a propriedade");
  if (!target || target.status !== "active" || target.level !== "admin") {
    throw new ConflictError("A propriedade só pode ser transferida a um administrador de plataforma ativo");
  }
  // Ordem importa: o índice único parcial é verificado por comando — primeiro libera o owner, depois promove.
  await trx.updateTable("platformAccess").set({ level: "admin" }).where("userId", "=", actor.userId).execute();
  await trx.updateTable("platformAccess").set({ level: "owner", grantedByUserId: actor.userId, grantOrigin: "ownership_transfer" }).where("userId", "=", params.targetUserId).execute();
  await recordAuditLogEntry(
    { organizationId: null, actorUserId: actor.userId, action: "plataforma.ownership_transferido", entityType: "user", entityId: String(params.targetUserId), metadata: { anteriorOwnerId: actor.userId } },
    trx
  );
}
