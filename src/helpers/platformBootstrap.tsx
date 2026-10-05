import { randomBytes } from "node:crypto";
import type { Transaction } from "kysely";
import { sql } from "kysely";
import { db } from "./db.js";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { acceptedPepperVersions, currentPepperVersion, hmacSecret } from "./identityKeys.js";
import { base32Encode } from "./totp.js";
import { BOOTSTRAP_CHALLENGE_TTL_MS, createChallenge } from "./authChallenges.js";

/**
 * Bootstrap offline do Platform Owner (Fase 90; §25.2 da especificação). Nenhuma rota pública cria owner: o token nasce
 * num CLI executado por quem tem acesso ao servidor/banco, é entregue por canal humano, vale 15 min, uso único, e só o HMAC
 * (pepper versionado) fica no banco.
 */

export const BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000;
export const BOOTSTRAP_TOKEN_PREFIX = "LEVB-";

export class BootstrapError extends Error {
  constructor(message: string, readonly code: "owner_ja_existe" | "sem_owner" | "email_em_uso" | "email_invalido" | "alvo_invalido") {
    super(message);
    this.name = "BootstrapError";
  }
}

/** `LEVB-` + 256 bits em base32 (52 símbolos) em grupos de 4 — só para leitura humana. */
export function generateBootstrapToken(): string {
  const body = base32Encode(randomBytes(32)).replace(/(.{4})/g, "$1-").replace(/-$/, "");
  return BOOTSTRAP_TOKEN_PREFIX + body;
}

/** Normaliza o que foi digitado/colado (caixa, hífens/espaços). Não é validação de segurança. */
export function normalizeBootstrapToken(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

const tokenHash = (normalized: string, version: number) => hmacSecret("bootstrap:v1:", normalized, version);

const activeOwner = (trx: Transaction<DB>) =>
  trx.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").executeTakeFirst();

/** Revoga o token pendente (idempotente). Devolve quantos foram revogados. */
export async function revokePendingBootstrapTokens(trx: Transaction<DB>, issuedBy: string, now: Date = new Date()): Promise<number> {
  const rows = await trx
    .updateTable("platformBootstrapTokens")
    .set({ revokedAt: now })
    .where("usedAt", "is", null)
    .where("revokedAt", "is", null)
    .returning("id")
    .execute();
  if (rows.length > 0) {
    await recordAuditLogEntry(
      { organizationId: null, actorUserId: null, action: "plataforma.bootstrap_revogado", entityType: "platform_bootstrap", entityId: null, metadata: { origem: "cli", quantidade: rows.length, emitidoPor: issuedBy } },
      trx
    );
  }
  return rows.length;
}

/**
 * Emite um token. Serializa os emissores (lock da linha de `platform_state`); emitir revoga o pendente anterior, de modo que
 * existe SEMPRE no máximo 1 token pendente (índice único parcial é a barreira final). O token em texto puro é devolvido UMA
 * vez e nunca é gravado nem registrado em log/audit.
 */
export async function issueBootstrapToken(params: {
  purpose: "owner" | "owner_recovery";
  email?: string;
  issuedBy: string;
  ttlMs?: number;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date; purpose: "owner" | "owner_recovery"; email: string }> {
  const now = params.now ?? new Date();
  const ttl = Math.min(params.ttlMs ?? BOOTSTRAP_TOKEN_TTL_MS, 30 * 60 * 1000);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT 1 FROM platform_state WHERE id = 1 FOR UPDATE`.execute(trx);
    const owner = await activeOwner(trx);

    let expectedEmail: string | null = null;
    let targetUserId: number | null = null;
    if (params.purpose === "owner") {
      if (owner) throw new BootstrapError("Já existe um Platform Owner ativo. Use a recuperação do owner (owner_recovery) se o acesso foi perdido.", "owner_ja_existe");
      const email = (params.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BootstrapError("Informe um e-mail válido para o owner.", "email_invalido");
      const taken = await trx.selectFrom("users").select("id").where(sql`LOWER(email)`, "=", email).executeTakeFirst();
      if (taken) throw new BootstrapError("Este e-mail já pertence a uma conta existente; o owner nasce de uma identidade nova (nunca promove uma conta comum).", "email_em_uso");
      expectedEmail = email;
    } else {
      if (!owner) throw new BootstrapError("Não existe Platform Owner para recuperar.", "sem_owner");
      const target = await trx.selectFrom("users").select(["id", "email"]).where("id", "=", owner.userId).executeTakeFirstOrThrow();
      targetUserId = target.id;
      expectedEmail = target.email;
    }

    await revokePendingBootstrapTokens(trx, params.issuedBy, now);

    const token = generateBootstrapToken();
    const version = currentPepperVersion();
    const expiresAt = new Date(now.getTime() + ttl);
    await trx
      .insertInto("platformBootstrapTokens")
      .values({
        purpose: params.purpose,
        tokenHash: tokenHash(normalizeBootstrapToken(token), version),
        pepperVersion: version,
        expectedEmail,
        targetUserId,
        createdAt: now,
        expiresAt,
        issuedBy: params.issuedBy,
      })
      .execute();
    await recordAuditLogEntry(
      {
        organizationId: null,
        actorUserId: null,
        action: "plataforma.bootstrap_emitido",
        entityType: "platform_bootstrap",
        entityId: null,
        metadata: { origem: "cli", finalidade: params.purpose, emitidoPor: params.issuedBy, validadeMinutos: Math.round(ttl / 60000) },
      },
      trx
    );
    return { token, expiresAt, purpose: params.purpose, email: expectedEmail! };
  });
}

export type ActivationResult =
  | { ok: true; challengeSecret: string; challengeExpiresAt: Date; purpose: "owner" | "owner_recovery"; email: string }
  | { ok: false };

/**
 * Ativação: valida o token no servidor e abre o challenge de bootstrap. O "claim" é atômico — um só navegador avança; um
 * segundo uso (replay, aba paralela, outro processo) vê o token já reivindicado e recebe a mesma recusa genérica.
 * Token inexistente / de outro ambiente (pepper/banco diferentes) / expirado / usado / revogado ⇒ `{ ok:false }` idêntico.
 */
export async function activateBootstrapToken(rawToken: string, now: Date = new Date()): Promise<ActivationResult> {
  const normalized = normalizeBootstrapToken(rawToken);
  if (!/^LEVB[A-Z2-7]{52}$/.test(normalized)) return { ok: false };
  const hashes = acceptedPepperVersions().map((v) => tokenHash(normalized, v));
  class Abort extends Error {}
  try {
    return await db.transaction().execute(async (trx): Promise<ActivationResult> => {
    const token = await trx.selectFrom("platformBootstrapTokens").selectAll().where("tokenHash", "in", hashes).forUpdate().executeTakeFirst();
    if (!token) return { ok: false };
    if (token.usedAt || token.revokedAt || token.claimedAt || token.expiresAt.getTime() <= now.getTime()) return { ok: false };

    const ttl = Math.min(BOOTSTRAP_CHALLENGE_TTL_MS, token.expiresAt.getTime() - now.getTime());
    const challenge = await createChallenge(trx, {
      purpose: token.purpose === "owner" ? "bootstrap_owner" : "owner_recovery",
      userId: token.targetUserId,
      primaryMethod: "password",
      ttlMs: ttl,
      bootstrapTokenId: token.id,
      now,
    });
    const claimed = await trx
      .updateTable("platformBootstrapTokens")
      .set({ claimedAt: now, claimedChallengeId: challenge.id })
      .where("id", "=", token.id)
      .where("claimedAt", "is", null)
      .where("usedAt", "is", null)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", now)
      .returning("id")
      .executeTakeFirst();
    // 0 linhas ⇒ perdeu a corrida: ABORTA a transação (o challenge recém-criado também some).
    if (!claimed) throw new Abort();
    return { ok: true, challengeSecret: challenge.secret, challengeExpiresAt: challenge.expiresAt, purpose: token.purpose, email: token.expectedEmail ?? "" };
    });
  } catch (error) {
    if (error instanceof Abort) return { ok: false };
    throw error;
  }
}
