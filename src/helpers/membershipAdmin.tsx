import type { Transaction } from "kysely";
import type { DB, MembershipRole } from "./schema.js";
import { OrganizationAccessError } from "./organizationAccess.js";
import { ConflictError } from "./errorResponse.js";
import { roleHasPermission, type Permission } from "./permissions.js";

/**
 * Regras de ciclo de vida dos membros (docs/MEMBROS_ESPECIFICACAO.md).
 * Toda mutação de membros de uma organização é serializada pelo lock da
 * linha da organização; ator e alvo são relidos SOB o lock e todas as
 * regras são revalidadas com o estado relido (nunca com o que o guard leu
 * antes). Ordem global de locks: organizations → memberships (id
 * crescente) → organization_invites.
 */

export const NO_OWNER_MESSAGE = "A organização precisa ter ao menos um proprietário ativo";
export const OWNER_ONLY_MESSAGE = "Somente proprietários podem alterar quem é proprietário";

const ROLE_RANK: Record<MembershipRole, number> = {
  voluntario: 0,
  operador: 1,
  administrador: 2,
  proprietario: 3,
};

export function roleRank(role: MembershipRole): number {
  return ROLE_RANK[role];
}

export async function lockOrganization(trx: Transaction<DB>, organizationId: number): Promise<void> {
  const organization = await trx
    .selectFrom("organizations")
    .select("id")
    .where("id", "=", organizationId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!organization) throw new OrganizationAccessError();
}

/** Trava a organização de cada id, sempre em ordem crescente (evita deadlock entre transações). */
export async function lockOrganizationsInOrder(trx: Transaction<DB>, organizationIds: number[]): Promise<void> {
  for (const id of [...new Set(organizationIds)].sort((a, b) => a - b)) {
    await lockOrganization(trx, id);
  }
}

export interface LockedMembership {
  id: number;
  userId: number;
  role: MembershipRole;
  status: "ativo" | "convidado" | "inativo";
}

/** Relê a membership do ator sob o lock; recusa (403) se deixou de ser ativa. */
export async function readActorUnderLock(
  trx: Transaction<DB>,
  organizationId: number,
  userId: number,
  requiredPermission?: Permission
): Promise<LockedMembership> {
  const actor = await trx
    .selectFrom("memberships")
    .select(["id", "userId", "role", "status"])
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .forUpdate()
    .executeTakeFirst();

  if (!actor || actor.status !== "ativo") throw new OrganizationAccessError();
  if (requiredPermission && !roleHasPermission(actor.role, requiredPermission)) {
    throw new OrganizationAccessError("Seu papel nesta organização não permite esta ação");
  }
  return actor;
}

/** Lê a membership-alvo (sempre filtrada pela organização) sob o lock. `null` se não existir nela. */
export async function readTargetUnderLock(
  trx: Transaction<DB>,
  organizationId: number,
  membershipId: number
): Promise<LockedMembership | null> {
  const target = await trx
    .selectFrom("memberships")
    .select(["id", "userId", "role", "status"])
    .where("id", "=", membershipId)
    .where("organizationId", "=", organizationId)
    .forUpdate()
    .executeTakeFirst();
  return target ?? null;
}

export async function countActiveOwners(trx: Transaction<DB>, organizationId: number): Promise<number> {
  const row = await trx
    .selectFrom("memberships")
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .where("organizationId", "=", organizationId)
    .where("role", "=", "proprietario")
    .where("status", "=", "ativo")
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

/** I1: tirar um proprietário ativo exige que sobre outro. */
export async function assertAnotherActiveOwnerRemains(trx: Transaction<DB>, organizationId: number): Promise<void> {
  if ((await countActiveOwners(trx, organizationId)) < 2) {
    throw new ConflictError(NO_OWNER_MESSAGE);
  }
}

/** Qualquer operação que envolva proprietário (alvo ou novo papel) exige `propriedade.gerencie`. */
export function assertCanTouchOwner(actor: LockedMembership): void {
  if (!roleHasPermission(actor.role, "propriedade.gerencie")) {
    throw new OrganizationAccessError(OWNER_ONLY_MESSAGE);
  }
}
