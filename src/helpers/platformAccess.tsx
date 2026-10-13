import { db } from "./db.js";
import type { PlatformAccessLevel } from "./schema.js";

/**
 * Erro lançado quando o usuário autenticado não possui acesso de plataforma (Levora).
 *
 * Fase 89: o poder de plataforma é uma CONCESSÃO separada da identidade — tabela `platform_access`
 * (`level`: owner | admin; `status`: active | revoked), com no máximo 1 owner ativo imposto por índice único parcial.
 * `users.role = 'admin'` deixou de ser fonte de autorização (um trigger recusa esse valor). Ver
 * docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §25.1. Endpoints do Registro Central de Oportunidades e do Registro
 * de Fontes exigem isso, porque essas entidades não pertencem a nenhuma organização.
 */
export class PlatformAccessError extends Error {
  constructor(message = "Esta ação é restrita à equipe operadora da Levora Solidária") {
    super(message);
    this.name = "PlatformAccessError";
  }
}

/** Nível de plataforma ATIVO do usuário (relido do banco), ou null. */
export async function getPlatformLevel(userId: number): Promise<PlatformAccessLevel | null> {
  const row = await db
    .selectFrom("platformAccess")
    .select("level")
    .where("userId", "=", userId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return row?.level ?? null;
}

/** Owner OU admin de plataforma. */
export async function requirePlatformAdmin(userId: number): Promise<void> {
  if ((await getPlatformLevel(userId)) === null) {
    throw new PlatformAccessError();
  }
}

/** Somente o Platform Owner (concessão de admins, transferência de ownership). */
export async function requirePlatformOwner(userId: number): Promise<void> {
  if ((await getPlatformLevel(userId)) !== "owner") {
    throw new PlatformAccessError("Esta ação é restrita ao proprietário da plataforma");
  }
}
