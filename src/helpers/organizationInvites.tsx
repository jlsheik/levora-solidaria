import { randomBytes, createHash } from "node:crypto";
import type { Transaction } from "kysely";
import { db } from "./db";
import { recordAuditLogEntry } from "./auditLog";
import type { DB } from "./schema";

export const INVITE_EXPIRATION_DAYS = 7;

/** Token de convite: gerado uma vez, mostrado uma vez (mesmo princípio dos códigos de ativação, seção 9 do master prompt). */
export function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function buildInviteAcceptUrl(token: string): string {
  const base = process.env.APP_PUBLIC_URL || "http://localhost:5173";
  return `${base.replace(/\/$/, "")}/convites/${token}`;
}

interface ExpirableInvite {
  id: number;
  organizationId: number;
  email: string;
  status: string;
  expiresAt: Date;
}

/**
 * Único ponto de verdade para "este convite pendente venceu?" e para o que
 * fazer quando vence: marcar `expirado` e gravar o evento em audit_log —
 * toda outra expiração automática do sistema (reservas, oportunidades,
 * pedidos de aprovação) já grava auditoria quando expira sozinha; convites
 * era a única exceção, por descuido, não por decisão. `actorUserId: null`
 * porque ninguém decidiu isso — foi só o tempo passando.
 *
 * Recebe `trx` porque todo chamador já está dentro de uma transação que
 * tem a linha do convite travada (`forUpdate`) ou prestes a lê-la.
 */
export async function expireInviteIfPast(trx: Transaction<DB>, invite: ExpirableInvite): Promise<boolean> {
  if (invite.status !== "pendente" || invite.expiresAt.getTime() >= Date.now()) {
    return false;
  }

  await trx.updateTable("organizationInvites").set({ status: "expirado" }).where("id", "=", invite.id).execute();

  await recordAuditLogEntry(
    {
      organizationId: invite.organizationId,
      actorUserId: null,
      action: "organizacao.convite_expirado_automaticamente",
      entityType: "organization_invite",
      entityId: String(invite.id),
      metadata: { email: invite.email },
    },
    trx
  );

  return true;
}

/**
 * Varre e expira, com auditoria, todos os convites pendentes vencidos de
 * uma organização — usado ao listar convites (organization-invites_GET),
 * o mesmo padrão oportunista de "expira na leitura" já usado para sessões.
 */
export async function expirePendingInvitesForOrganization(organizationId: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const pending = await trx
      .selectFrom("organizationInvites")
      .select(["id", "organizationId", "email", "status", "expiresAt"])
      .where("organizationId", "=", organizationId)
      .where("status", "=", "pendente")
      .where("expiresAt", "<", new Date())
      .forUpdate()
      .execute();

    for (const invite of pending) {
      await expireInviteIfPast(trx, invite);
    }
  });
}
