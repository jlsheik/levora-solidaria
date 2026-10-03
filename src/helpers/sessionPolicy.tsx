/**
 * Política de sessão (Fase 89; docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §25.15).
 *
 * A LINHA em `sessions` é a autoridade — o JWT do cookie é só transporte do id. Duas imposições independentes:
 *   - ocioso (idle): `last_accessed` mais antigo que o limite do tier ⇒ sessão encerrada;
 *   - absoluto: teto de vida desde a criação, NUNCA estendido por uso, por renovação do cookie nem por rotação.
 *
 * Dois tiers. O tier "platform" vale para quem tem `platform_access` ATIVO (owner ou admin) no momento da validação;
 * o papel dentro de organização não muda o tier (evita consulta de membership a cada requisição).
 * Constantes num único lugar: ajustar valores não muda a arquitetura.
 */
export type SessionTier = "standard" | "platform";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SESSION_POLICY = {
  // Mantém o ocioso que já existia (7 dias) e acrescenta o teto absoluto que faltava.
  standard: { idleMs: 7 * DAY, absoluteMs: 30 * DAY },
  platform: { idleMs: 60 * MINUTE, absoluteMs: 8 * HOUR },
} as const satisfies Record<SessionTier, { idleMs: number; absoluteMs: number }>;

export type SessionEvaluation =
  | { valid: true; effectiveAbsoluteExpiresAt: Date }
  | { valid: false; reason: "idle" | "absolute" };

export interface SessionRowTimes {
  tier: SessionTier;
  createdAt: Date | null;
  lastAccessed: Date | null;
  /** Teto absoluto gravado na linha (preenchido na criação; preservado na rotação). */
  absoluteExpiresAt: Date;
  now: Date;
}

export function evaluateSession(input: SessionRowTimes): SessionEvaluation {
  const policy = SESSION_POLICY[input.tier];
  const created = input.createdAt ?? input.lastAccessed ?? input.now;
  // O tier de plataforma também limita a vida absoluta por `created_at` (a linha guarda o teto "standard").
  const tierCap = new Date(created.getTime() + policy.absoluteMs);
  const effective = new Date(Math.min(input.absoluteExpiresAt.getTime(), tierCap.getTime()));
  if (input.now.getTime() >= effective.getTime()) return { valid: false, reason: "absolute" };
  const last = input.lastAccessed ?? created;
  if (input.now.getTime() - last.getTime() >= policy.idleMs) return { valid: false, reason: "idle" };
  return { valid: true, effectiveAbsoluteExpiresAt: effective };
}

/** Teto absoluto gravado numa sessão nova (o tier de plataforma aplica o seu próprio teto na validação). */
export function absoluteExpiryForNewSession(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_POLICY.standard.absoluteMs);
}
