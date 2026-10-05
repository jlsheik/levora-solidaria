import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { checkRateLimit } from "./rateLimit.js";

/**
 * Auditoria de autenticação (Fase 89; docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §15).
 * NUNCA grava senha, hash, token, cookie, JWT nem o e-mail digitado: para tentativa sem usuário identificável só
 * `{motivo, ipPrefix}`. O IP completo não é gravado (prefixo /24 em IPv4, /48 em IPv6).
 */

/** Reduz o IP a um prefixo (privacidade + agregação). Valores desconhecidos/ não-IP passam como estão. */
export function ipPrefix(ip: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) {
    const groups = ip.replace(/^::ffff:/i, "").split(":").filter((g, i, a) => g !== "" || i === 0 || i === a.length - 1);
    return groups.slice(0, 3).join(":") + "::/48";
  }
  return ip;
}

/** Falhas somadas de VÁRIAS redes contra a mesma conta: alerta (no máximo 1 por conta por hora), nunca bloqueio. */
export async function auditLoginSuspicious(trx: Transaction<DB>, params: { userId: number }) {
  const gate = checkRateLimit({ bucket: "login-suspicious-audit", identifier: String(params.userId), limit: 1, windowMs: 60 * 60 * 1000 });
  if (!gate.allowed) return;
  await recordAuditLogEntry(
    {
      organizationId: null,
      actorUserId: params.userId,
      action: "usuario.login_suspeito",
      entityType: "user",
      entityId: String(params.userId),
      metadata: { motivo: "falhas_de_varias_redes" },
    },
    trx
  );
}

export type LoginMethod = "senha" | "google" | "microsoft" | "apple";

/** Login bem-sucedido. Chamar como ÚLTIMO passo da transação (a hash-chain toma um advisory lock global). */
export async function auditLoginSuccess(trx: Transaction<DB>, params: { userId: number; method: LoginMethod; ip: string }) {
  await recordAuditLogEntry(
    {
      organizationId: null,
      actorUserId: params.userId,
      action: "usuario.login_realizado",
      entityType: "user",
      entityId: String(params.userId),
      metadata: { metodo: params.method, ipPrefix: ipPrefix(params.ip) },
    },
    trx
  );
}

/**
 * Falha de login. Volume limitado: só a PRIMEIRA falha de cada MOTIVO por (e-mail, IP) a cada 10 min vira evento (a falha comum não suprime o evento de bloqueio) — um ataque de força
 * bruta não pode inflar nem serializar a hash-chain. `userId` é conhecido internamente quando o e-mail existe, mas o
 * e-mail digitado nunca é gravado.
 */
export async function auditLoginFailure(
  trx: Transaction<DB>,
  params: { userId: number | null; email: string; ip: string; method: LoginMethod; reason: "credenciais_invalidas" | "bloqueio_temporario" }
) {
  const emailDigest = createHash("sha256").update(params.email.toLowerCase()).digest("hex").slice(0, 16);
  const gate = checkRateLimit({ bucket: "login-failure-audit", identifier: `${params.reason}:${emailDigest}:${ipPrefix(params.ip)}`, limit: 1, windowMs: 10 * 60 * 1000 });
  if (!gate.allowed) return;
  await recordAuditLogEntry(
    {
      organizationId: null,
      actorUserId: params.userId,
      action: "usuario.login_falhou",
      entityType: "user",
      entityId: params.userId === null ? null : String(params.userId),
      metadata: { metodo: params.method, motivo: params.reason, ipPrefix: ipPrefix(params.ip) },
    },
    trx
  );
}
