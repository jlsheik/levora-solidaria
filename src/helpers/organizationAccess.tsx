import { db } from "./db";
import type { MembershipRole } from "./schema";

/**
 * Erro lançado quando o usuário autenticado não é membro ativo da
 * organização solicitada, ou não possui um dos papéis exigidos.
 *
 * Isso é o mecanismo central de isolamento entre organizações: toda rota
 * que lê ou escreve dados associados a uma organização deve chamar
 * requireOrganizationMembership antes de tocar nos dados, para garantir que
 * um usuário nunca acesse dados de uma organização da qual não participa.
 */
export class OrganizationAccessError extends Error {
  constructor(message = "Você não tem acesso a esta organização") {
    super(message);
    this.name = "OrganizationAccessError";
  }
}

export interface OrganizationMembership {
  organizationId: number;
  userId: number;
  role: MembershipRole;
}

/**
 * Garante que o usuário é membro ATIVO da organização e, se allowedRoles for
 * passado, que seu papel está entre os permitidos. Lança
 * OrganizationAccessError caso contrário — o chamador deve converter isso em
 * uma resposta HTTP 403.
 */
export async function requireOrganizationMembership(
  userId: number,
  organizationId: number,
  allowedRoles?: MembershipRole[]
): Promise<OrganizationMembership> {
  const membership = await db
    .selectFrom("memberships")
    .select(["organizationId", "userId", "role", "status"])
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .executeTakeFirst();

  if (!membership || membership.status !== "ativo") {
    throw new OrganizationAccessError();
  }

  if (allowedRoles && !allowedRoles.includes(membership.role)) {
    throw new OrganizationAccessError(
      "Seu papel nesta organização não permite esta ação"
    );
  }

  return {
    organizationId: membership.organizationId,
    userId: membership.userId,
    role: membership.role,
  };
}
