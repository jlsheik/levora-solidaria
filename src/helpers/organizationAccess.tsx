import { db } from "./db";
import type { MembershipRole } from "./schema";
import { roleHasPermission, type Permission } from "./permissions";

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
 * Garante que o usuário é membro ATIVO da organização, sem exigir nenhuma
 * permissão específica — para leituras que qualquer membro pode fazer
 * (ex.: ver o próprio inventário, a própria lista de necessidades). Para
 * ações restritas por papel, use `requirePermission` abaixo: nenhum
 * endpoint deveria checar `membership.role` "na unha" com uma lista de
 * papéis solta — isso é exatamente o que espalha regra de autorização
 * por dezenas de arquivos em vez de ter uma fonte única de verdade
 * (ver src/helpers/permissions.tsx).
 */
export async function requireOrganizationMembership(
  userId: number,
  organizationId: number
): Promise<OrganizationMembership> {
  const membership = await getActiveMembershipOrThrow(userId, organizationId);
  return membership;
}

/**
 * Garante que o usuário é membro ATIVO da organização E que o papel dele
 * tem a permissão nomeada — SEM exigir que a organização já esteja
 * aprovada ("ativa"). Use para LEITURAS restritas por papel (ex.: só
 * proprietário/administrador veem a trilha de auditoria) — o dono de uma
 * organização "em análise" continua podendo ver os próprios dados
 * restritos enquanto espera aprovação, exatamente como já acontece com
 * leituras abertas via `requireOrganizationMembership`. Para escrita/ação
 * restrita por permissão, use `requirePermission` abaixo, não esta.
 */
export async function requirePermissionToRead(
  userId: number,
  organizationId: number,
  permission: Permission
): Promise<OrganizationMembership> {
  const membership = await getActiveMembershipOrThrow(userId, organizationId);
  if (!roleHasPermission(membership.role, permission)) {
    throw new OrganizationAccessError("Seu papel nesta organização não permite esta ação");
  }
  return membership;
}

/**
 * Garante que o usuário é membro ATIVO da organização, que a organização já
 * foi aprovada pela plataforma (status "ativa"), E que o papel do membro
 * tem a permissão nomeada (ver src/helpers/permissions.tsx para o catálogo
 * e o mapeamento papel→permissões). Lança OrganizationAccessError caso
 * contrário — os endpoints já convertem essa exceção em 403 (checam
 * `message.includes("papel")`/`"acesso"` no catch).
 *
 * Só para ESCRITA/AÇÃO restrita por permissão (lançar estoque, convidar
 * membro, aprovar pedido, etc.) — nunca para leitura. Isso importa: uma
 * versão anterior desta função checava `organizations.status` aqui mesmo
 * sendo chamada por endpoints de LEITURA (audit-log, impact-report,
 * approval-requests GET), bloqueando por engano o dono de uma organização
 * "em análise" de ver os próprios dados — contradizendo a intenção
 * original documentada abaixo. Corrigido separando leitura
 * (`requirePermissionToRead`, sem checar status) de escrita (esta função,
 * que checa). Ver docs/ACCESS_CODES.md — a checagem de status em si fecha
 * uma lacuna de segurança real: antes dela, qualquer organização
 * recém-criada podia operar normalmente mesmo sem nunca ter sido aprovada.
 */
export async function requirePermission(
  userId: number,
  organizationId: number,
  permission: Permission
): Promise<OrganizationMembership> {
  const membership = await requirePermissionToRead(userId, organizationId, permission);

  const organization = await db
    .selectFrom("organizations")
    .select(["status"])
    .where("id", "=", organizationId)
    .executeTakeFirst();

  if (organization?.status !== "ativa") {
    throw new OrganizationAccessError(
      "Esta organização ainda não tem acesso liberado — aguardando aprovação da equipe da Levora Solidária."
    );
  }

  return membership;
}

async function getActiveMembershipOrThrow(userId: number, organizationId: number): Promise<OrganizationMembership> {
  const membership = await db
    .selectFrom("memberships")
    .select(["organizationId", "userId", "role", "status"])
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .executeTakeFirst();

  if (!membership || membership.status !== "ativo") {
    throw new OrganizationAccessError();
  }

  return {
    organizationId: membership.organizationId,
    userId: membership.userId,
    role: membership.role,
  };
}
