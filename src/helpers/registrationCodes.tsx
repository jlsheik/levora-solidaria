import { randomBytes } from "node:crypto";
import type { Transaction } from "kysely";
import { db } from "./db.js";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { acceptedPepperVersions, currentPepperVersion, hmacSecret } from "./identityKeys.js";
import { checkRateLimit } from "./rateLimit.js";

/**
 * Registration access codes (Fase 91; docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §25.4 e docs/IDENTIDADE_FASE91_AUDITORIA.md).
 *
 * O código é PROVISIONAMENTO de conta — nunca credencial: não loga, não recupera, não satisfaz MFA. Regra congelada: nenhuma conta
 * pública nasce sem um código válido emitido pela plataforma; 1 código → no máximo 1 usuário (transação + UPDATE condicional +
 * `users.registered_via_code_id UNIQUE`). Esta camada é INDEPENDENTE do método de autenticação: `provisionUserWithAccessCode`
 * recebe um `createUser` — hoje a senha; amanhã um `signup_attempt` validado de Google/Microsoft/Apple chama a MESMA função.
 *
 * Máquina de estados (derivada, nunca duplicada em booleans): active → redeemed | revoked | expired. `redeemed` e `revoked` são
 * terminais e exclusivos (CHECK no banco); `expired` é função de `expires_at` (sem scheduler); nada reativa um código.
 */

/** UMA resposta pública para qualquer código inutilizável (inexistente, formato impossível, expirado, revogado, já utilizado). */
export const ACCESS_CODE_UNAVAILABLE_MESSAGE = "Código de acesso inválido ou indisponível. Confira o código ou peça um novo à plataforma.";

// ---- formato e canonicalização -------------------------------------------------------------------------------------------

export const ACCESS_CODE_PREFIX = "LEV";
export const ACCESS_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: sem I, L, O, U
export const ACCESS_CODE_LENGTH = 20; // 20 símbolos × 5 bits = 100 bits de entropia

/** `LEV-XXXX-XXXX-XXXX-XXXX-XXXX` — 100 bits de `crypto.randomBytes` (sem contador, data, id ou sequência). */
export function generateAccessCode(): string {
  const bytes = randomBytes(ACCESS_CODE_LENGTH);
  let canonical = "";
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++) canonical += ACCESS_CODE_ALPHABET[bytes[i] % 32];
  return formatAccessCode(canonical);
}

export function formatAccessCode(canonical: string): string {
  return `${ACCESS_CODE_PREFIX}-${canonical.replace(/(.{4})/g, "$1-").replace(/-$/, "")}`;
}

/**
 * CANONICALIZAÇÃO (única, no servidor): maiúsculas; remove espaços e hífens; remove o prefixo `LEV` (só quando sobram exatamente 20
 * símbolos depois dele); mapeia I,L→1 e O→0 (equivalências do Crockford). Como o gerador NUNCA emite I, L, O nem U, duas
 * entradas só se tornam o mesmo código se forem a mesma grafia do mesmo código — nenhum código válido colide com outro. Qualquer
 * outro caractere ⇒ `null` (formato impossível; o chamador responde igual a qualquer código inválido).
 */
export function canonicalizeAccessCode(input: string): string | null {
  // Só ASCII: toUpperCase() é Unicode (ex.: "ı" vira "I", "ſ" vira "S") e criaria apelidos de entrada que não são grafias do código.
  if (/[^\u0000-\u007F]/.test(input.replace(/\s/g, ""))) return null;
  let s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.startsWith(ACCESS_CODE_PREFIX) && s.length === ACCESS_CODE_PREFIX.length + ACCESS_CODE_LENGTH) s = s.slice(ACCESS_CODE_PREFIX.length);
  s = s.replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(s) ? s : null;
}

export const maskAccessCode = (last4: string) => `${ACCESS_CODE_PREFIX}-••••-••••-••••-••••-${last4}`;

const hashFor = (canonical: string, version: number) => hmacSecret("access-code:v1:", canonical, version);
export const accessCodeHashes = (canonical: string) => acceptedPepperVersions().map((v) => hashFor(canonical, v));

// ---- validade e estado -----------------------------------------------------------------------------------------------------

export const MIN_VALIDITY_MS = 5 * 60 * 1000; // 5 minutos
export const MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

export type AccessCodeStatus = "active" | "redeemed" | "revoked" | "expired";

export function deriveCodeStatus(row: { redeemedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date = new Date()): AccessCodeStatus {
  if (row.redeemedAt) return "redeemed";
  if (row.revokedAt) return "revoked";
  // Limite exato: válido ⇔ now < expires_at (no instante expires_at o código já está expirado).
  if (now.getTime() >= row.expiresAt.getTime()) return "expired";
  return "active";
}

export class AccessCodeValidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessCodeValidityError";
  }
}

/** Resolve a validade pedida (relativa OU absoluta) em `expires_at` UTC, decidido pelo SERVIDOR. */
export function resolveExpiry(input: { expiresInMinutes?: number; expiresAt?: Date }, now: Date = new Date()): Date {
  if ((input.expiresInMinutes === undefined) === (input.expiresAt === undefined)) throw new AccessCodeValidityError("Informe a validade em minutos OU uma data/hora de expiração");
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + (input.expiresInMinutes as number) * 60 * 1000);
  const ms = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms < MIN_VALIDITY_MS) throw new AccessCodeValidityError("A validade mínima é de 5 minutos");
  if (ms > MAX_VALIDITY_MS) throw new AccessCodeValidityError("A validade máxima é de 90 dias");
  return expiresAt;
}

// ---- emissão e revogação (plataforma) -------------------------------------------------------------------------------------

/**
 * Emite um código. O texto puro é devolvido UMA vez e NUNCA é gravado (só HMAC + últimos 4). Auditoria como ÚLTIMO passo.
 * A autorização (platform admin) e o step-up são do endpoint; aqui só a regra de dados.
 */
export async function createAccessCode(trx: Transaction<DB>, params: { actorUserId: number; label: string | null; expiresAt: Date; now?: Date }) {
  const now = params.now ?? new Date();
  const code = generateAccessCode();
  const canonical = canonicalizeAccessCode(code)!;
  const version = currentPepperVersion();
  const row = await trx
    .insertInto("registrationAccessCodes")
    .values({
      codeHash: hashFor(canonical, version),
      pepperVersion: version,
      codeLast4: canonical.slice(-4),
      label: params.label,
      createdByUserId: params.actorUserId,
      createdAt: now,
      expiresAt: params.expiresAt,
    })
    .returning(["id", "codeLast4", "expiresAt"])
    .executeTakeFirstOrThrow();
  await recordAuditLogEntry(
    {
      organizationId: null,
      actorUserId: params.actorUserId,
      action: "codigo_acesso.criado",
      entityType: "registration_access_code",
      entityId: String(row.id),
      metadata: { codeId: row.id, validadeMinutos: Math.round((params.expiresAt.getTime() - now.getTime()) / 60000), temDescricao: params.label !== null },
    },
    trx
  );
  return { id: row.id, code, last4: row.codeLast4, expiresAt: row.expiresAt };
}

export type RevokeResult = { ok: true } | { ok: false; reason: "nao_encontrado" | "nao_ativo" };

/** Revoga SOMENTE código ativo (UPDATE condicional): resgatado/revogado/expirado ⇒ recusado; nunca reativa. */
export async function revokeAccessCode(trx: Transaction<DB>, params: { actorUserId: number; codeId: number; now?: Date }): Promise<RevokeResult> {
  const now = params.now ?? new Date();
  const updated = await trx
    .updateTable("registrationAccessCodes")
    .set({ revokedAt: now, revokedByUserId: params.actorUserId })
    .where("id", "=", params.codeId)
    .where("redeemedAt", "is", null)
    .where("revokedAt", "is", null)
    .where("expiresAt", ">", now)
    .returning("id")
    .executeTakeFirst();
  if (!updated) {
    const exists = await trx.selectFrom("registrationAccessCodes").select("id").where("id", "=", params.codeId).executeTakeFirst();
    return { ok: false, reason: exists ? "nao_ativo" : "nao_encontrado" };
  }
  await recordAuditLogEntry(
    { organizationId: null, actorUserId: params.actorUserId, action: "codigo_acesso.revogado", entityType: "registration_access_code", entityId: String(params.codeId), metadata: { codeId: params.codeId } },
    trx
  );
  return { ok: true };
}

// ---- consumo (provisionamento) --------------------------------------------------------------------------------------------

export type InvalidCodeReason = "inexistente" | "expirado" | "revogado" | "utilizado";
export type ProvisionResult = { ok: true; userId: number; codeId: number } | { ok: false; reason: InvalidCodeReason | "email_em_uso" | "identidade_em_uso" };

class RollbackProvision extends Error {}

/** Valida SEM consumir (UX do passo "informe o código"). Leitura pura: nada é gravado e o código continua livre. */
export async function checkAccessCode(rawCode: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: InvalidCodeReason }> {
  const canonical = canonicalizeAccessCode(rawCode);
  if (!canonical) return { ok: false, reason: "inexistente" };
  const row = await db.selectFrom("registrationAccessCodes").select(["redeemedAt", "revokedAt", "expiresAt"]).where("codeHash", "in", accessCodeHashes(canonical)).executeTakeFirst();
  if (!row) return { ok: false, reason: "inexistente" };
  const status = deriveCodeStatus(row, now);
  if (status === "active") return { ok: true };
  return { ok: false, reason: status === "redeemed" ? "utilizado" : status === "revoked" ? "revogado" : "expirado" };
}

/** Como `checkAccessCode`, mas devolve o id do código utilizável (o cadastro social guarda o id na tentativa OAuth; o texto nunca é guardado). */
export async function findUsableAccessCode(rawCode: string, now: Date = new Date()): Promise<{ ok: true; codeId: number } | { ok: false; reason: InvalidCodeReason }> {
  const canonical = canonicalizeAccessCode(rawCode);
  if (!canonical) return { ok: false, reason: "inexistente" };
  const row = await db.selectFrom("registrationAccessCodes").select(["id", "redeemedAt", "revokedAt", "expiresAt"]).where("codeHash", "in", accessCodeHashes(canonical)).executeTakeFirst();
  if (!row) return { ok: false, reason: "inexistente" };
  const status = deriveCodeStatus(row, now);
  if (status === "active") return { ok: true, codeId: row.id };
  return { ok: false, reason: status === "redeemed" ? "utilizado" : status === "revoked" ? "revogado" : "expirado" };
}

/**
 * CONSUMO ATÔMICO. Numa ÚNICA transação: trava a linha do código (FOR UPDATE) → confere que continua ativo → `createUser` (INSERT do
 * usuário com `registered_via_code_id`, mais a credencial do método escolhido) → UPDATE condicional do código
 * (`redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, 0 linhas ⇒ ROLLBACK de tudo) → auditoria (último passo, lock
 * global da hash-chain). Qualquer falha ⇒ ROLLBACK: nunca código queimado sem conta, nunca conta sem código consumido; o código
 * continua utilizável. Defesas em camadas no BANCO: lock da linha, UPDATE condicional, UNIQUE(users.registered_via_code_id) e CHECKs.
 *
 * `createUser` devolve o id do usuário criado, ou `null` quando NÃO deve criar (ex.: e-mail já cadastrado ⇒ nada é consumido).
 * Ordem de locks: registration_access_codes → (inserts) → audit_log.
 */
export async function provisionUserWithAccessCode(
  /** O texto do código (cadastro por senha) OU o id já resolvido (cadastro social: a tentativa OAuth guarda o id, nunca o texto). */
  target: string | { codeId: number },
  createUser: (trx: Transaction<DB>, context: { codeId: number }) => Promise<number | null>,
  now: Date = new Date(),
  hooks: { afterRedeem?: (trx: Transaction<DB>, context: { userId: number; codeId: number }) => Promise<void> } = {}
): Promise<ProvisionResult> {
  const codeIdTarget = typeof target === "string" ? null : target.codeId;
  let hashes: Buffer[] | null = null;
  if (typeof target === "string") {
    const canonical = canonicalizeAccessCode(target);
    if (!canonical) return { ok: false, reason: "inexistente" };
    hashes = accessCodeHashes(canonical);
  }

  try {
    return await db.transaction().execute(async (trx): Promise<ProvisionResult> => {
      const locator = trx.selectFrom("registrationAccessCodes").selectAll();
      const code = await (hashes ? locator.where("codeHash", "in", hashes) : locator.where("id", "=", codeIdTarget as number)).forUpdate().executeTakeFirst();
      if (!code) return { ok: false, reason: "inexistente" };
      const status = deriveCodeStatus(code, now);
      if (status !== "active") return { ok: false, reason: status === "redeemed" ? "utilizado" : status === "revoked" ? "revogado" : "expirado" };

      const userId = await createUser(trx, { codeId: code.id });
      if (userId === null) return { ok: false, reason: "email_em_uso" };

      const redeemed = await trx
        .updateTable("registrationAccessCodes")
        .set({ redeemedAt: now, redeemedByUserId: userId })
        .where("id", "=", code.id)
        .where("redeemedAt", "is", null)
        .where("revokedAt", "is", null)
        .where("expiresAt", ">", now)
        .returning("id")
        .executeTakeFirst();
      if (!redeemed) throw new RollbackProvision();
      if (hooks.afterRedeem) await hooks.afterRedeem(trx, { userId, codeId: code.id });

      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: userId,
          action: "codigo_acesso.consumido",
          entityType: "registration_access_code",
          entityId: String(code.id),
          // Quem criou, quem consumiu (actor), quando (created_at do evento) e QUAL código (id) — sem o segredo nem o hash.
          metadata: { codeId: code.id, criadoPorUserId: code.createdByUserId, usuarioId: userId },
        },
        trx
      );
      return { ok: true, userId, codeId: code.id };
    });
  } catch (error) {
    if (error instanceof RollbackProvision) return { ok: false, reason: "utilizado" };
    // Violação de unicidade DENTRO da transação (já revertida): do código (defesa final do banco) ou do e-mail (corrida de cadastro).
    if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
      const constraint = String((error as { constraint_name?: string }).constraint_name ?? "");
      return { ok: false, reason: constraint.includes("registered_via_code") ? "utilizado" : constraint.includes("user_identities") ? "identidade_em_uso" : "email_em_uso" };
    }
    throw error;
  }
}

// ---- auditoria de tentativas inválidas (volume limitado) --------------------------------------------------------------------

/**
 * Registra uma tentativa com código inválido/expirado/revogado/utilizado (o motivo exato SÓ vai para a auditoria, nunca para a
 * resposta pública). No máximo 1 evento por (motivo, rede) a cada 10 min — um atacante não infla nem serializa a hash-chain.
 * Nunca grava o código digitado, nem seu hash.
 */
export async function auditInvalidCodeAttempt(params: { reason: InvalidCodeReason; ipPrefix: string }): Promise<void> {
  const gate = checkRateLimit({ bucket: "access-code-invalid-audit", identifier: `${params.reason}:${params.ipPrefix}`, limit: 1, windowMs: 10 * 60 * 1000 });
  if (!gate.allowed) return;
  await db.transaction().execute((trx) =>
    recordAuditLogEntry(
      { organizationId: null, actorUserId: null, action: "codigo_acesso.tentativa_invalida", entityType: "registration_access_code", entityId: null, metadata: { motivo: params.reason, ipPrefix: params.ipPrefix } },
      trx
    )
  );
}
