import { db } from "./db.js";

/**
 * Erro lançado quando o usuário autenticado não é operador de plataforma
 * (Levora). Reaproveita o papel global `users.role === 'admin'` já criado
 * pela fundação de autenticação — não existe um sistema de papéis de
 * plataforma separado. Endpoints do Registro Central de Oportunidades e do
 * Registro de Fontes exigem isso, porque essas entidades não pertencem a
 * nenhuma organização.
 */
export class PlatformAccessError extends Error {
  constructor(message = "Esta ação é restrita à equipe operadora da Levora Solidária") {
    super(message);
    this.name = "PlatformAccessError";
  }
}

export async function requirePlatformAdmin(userId: number): Promise<void> {
  const user = await db
    .selectFrom("users")
    .select(["id", "role"])
    .where("id", "=", userId)
    .executeTakeFirst();

  if (!user || user.role !== "admin") {
    throw new PlatformAccessError();
  }
}
