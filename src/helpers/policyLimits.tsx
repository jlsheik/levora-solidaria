import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { newCorrelationId } from "./correlation.js";
import { ConflictError } from "./errorResponse.js";
import { fenceForChange } from "./policyFence.js";

/**
 * Limites de autonomia (master prompt, seção 79). Valores padrão em código,
 * conservadores (docs/AGENTES_ESPECIFICACAO.md, D4): tudo acima do limite vai
 * para revisão/dupla autorização. Um limite global pode ser sobrescrito pela
 * plataforma; uma organização só pode ser MAIS restritiva, nunca menos
 * segura que o global — e a leitura aplica o mais restritivo dos dois mesmo
 * que o banco contenha um valor frouxo.
 *
 * Os valores padrão abaixo são ponto de partida: o dono do projeto deve
 * revisá-los antes de qualquer agente que aceite oportunidades ser ligado.
 */

type NumberDef = { kind: "number"; default: number; moreRestrictive: "lower" };
type ListDef = { kind: "list"; default: string[]; moreRestrictive: "superset" };

export const POLICY_LIMIT_DEFS = {
  AUTO_ACCEPT_MAX_VALUE: { kind: "number", default: 500, moreRestrictive: "lower" } as NumberDef,
  AUTO_PICKUP_MAX_DISTANCE_KM: { kind: "number", default: 50, moreRestrictive: "lower" } as NumberDef,
  AUTO_LOGISTICS_MAX_COST: { kind: "number", default: 0, moreRestrictive: "lower" } as NumberDef,
  FINANCIAL_APPROVAL_THRESHOLD: { kind: "number", default: 0, moreRestrictive: "lower" } as NumberDef,
  HIGH_RISK_CATEGORIES: {
    kind: "list",
    default: ["medicamento", "alimento_perecivel", "item_perigoso", "dinheiro"],
    moreRestrictive: "superset",
  } as ListDef,
  MANUAL_REVIEW_REQUIRED_CATEGORIES: { kind: "list", default: ["medicamento"], moreRestrictive: "superset" } as ListDef,
} as const;

export type PolicyLimitKey = keyof typeof POLICY_LIMIT_DEFS;
export const POLICY_LIMIT_KEYS = Object.keys(POLICY_LIMIT_DEFS) as PolicyLimitKey[];

export type PolicyLimitValue = number | string[];
export type EffectivePolicyLimits = {
  AUTO_ACCEPT_MAX_VALUE: number;
  AUTO_PICKUP_MAX_DISTANCE_KM: number;
  AUTO_LOGISTICS_MAX_COST: number;
  FINANCIAL_APPROVAL_THRESHOLD: number;
  HIGH_RISK_CATEGORIES: string[];
  MANUAL_REVIEW_REQUIRED_CATEGORIES: string[];
};

const numberSchema = z.number().finite().min(0);
const listSchema = z.array(z.string().trim().toLowerCase().min(1).max(60)).max(100);

function parseValue(key: PolicyLimitKey, raw: unknown): PolicyLimitValue {
  const def = POLICY_LIMIT_DEFS[key];
  return def.kind === "number" ? numberSchema.parse(raw) : [...new Set(listSchema.parse(raw))].sort();
}

// Valores guardados como { v: ... }: um array JS cru num JSONB seria enviado
// pelo driver como array do Postgres, não como JSON.
function unwrap(stored: unknown): unknown {
  return stored !== null && typeof stored === "object" ? (stored as { v?: unknown }).v : undefined;
}

function mostRestrictive(key: PolicyLimitKey, a: PolicyLimitValue, b: PolicyLimitValue): PolicyLimitValue {
  const def = POLICY_LIMIT_DEFS[key];
  if (def.kind === "number") return Math.min(a as number, b as number);
  return [...new Set([...(a as string[]), ...(b as string[])])].sort();
}

function isAtLeastAsRestrictive(key: PolicyLimitKey, candidate: PolicyLimitValue, baseline: PolicyLimitValue): boolean {
  const def = POLICY_LIMIT_DEFS[key];
  if (def.kind === "number") return (candidate as number) <= (baseline as number);
  const set = new Set(candidate as string[]);
  return (baseline as string[]).every((item) => set.has(item));
}

async function readOverrides(executor: Kysely<DB>, organizationId: number | null) {
  const rows = await executor
    .selectFrom("policyLimits")
    .select(["key", "value"])
    .where("organizationId", organizationId === null ? "is" : "=", organizationId)
    .execute();
  const result = new Map<PolicyLimitKey, PolicyLimitValue>();
  for (const row of rows) {
    if (!(row.key in POLICY_LIMIT_DEFS)) continue;
    const key = row.key as PolicyLimitKey;
    const parsed = (() => {
      try {
        return parseValue(key, unwrap(row.value));
      } catch {
        return null; // valor corrompido no banco: ignora e cai no padrão (mais seguro que quebrar)
      }
    })();
    if (parsed !== null) result.set(key, parsed);
  }
  return result;
}

/** Limites globais efetivos: padrão do código + sobrescritas da plataforma. */
export async function getGlobalPolicyLimits(executor: Kysely<DB>): Promise<EffectivePolicyLimits> {
  const overrides = await readOverrides(executor, null);
  const result: Record<string, PolicyLimitValue> = {};
  for (const key of POLICY_LIMIT_KEYS) {
    result[key] = overrides.get(key) ?? POLICY_LIMIT_DEFS[key].default;
  }
  return result as EffectivePolicyLimits;
}

/** Limites efetivos de uma organização: o mais restritivo entre global e organização. */
export async function getEffectivePolicyLimits(
  executor: Kysely<DB>,
  organizationId: number | null
): Promise<EffectivePolicyLimits> {
  const global = await getGlobalPolicyLimits(executor);
  if (organizationId === null) return global;
  const orgOverrides = await readOverrides(executor, organizationId);
  const result: Record<string, PolicyLimitValue> = { ...global };
  for (const key of POLICY_LIMIT_KEYS) {
    const orgValue = orgOverrides.get(key);
    if (orgValue !== undefined) result[key] = mostRestrictive(key, global[key], orgValue);
  }
  return result as EffectivePolicyLimits;
}

export async function setPolicyLimit(
  executor: Transaction<DB>,
  input: { organizationId: number | null; key: string; value: unknown; userId: number }
): Promise<PolicyLimitValue> {
  if (!Object.hasOwn(POLICY_LIMIT_DEFS, input.key)) {
    throw new ConflictError("Limite de política desconhecido");
  }
  // M36: cerca de política — a alteração do limite é ordenada, pelo banco, em relação às conclusões que o leem; também serializa duas pessoas alterando a mesma política (ver policyFence.tsx).
  await fenceForChange(executor, input.organizationId);
  const key = input.key as PolicyLimitKey;
  const value = parseValue(key, input.value);

  if (input.organizationId !== null) {
    const global = await getGlobalPolicyLimits(executor);
    if (!isAtLeastAsRestrictive(key, value, global[key])) {
      throw new ConflictError("Uma organização só pode tornar este limite mais restritivo que o global");
    }
  }

  const stored = { v: value };
  const existing = await executor
    .selectFrom("policyLimits")
    .select(["id", "value"])
    .where("organizationId", input.organizationId === null ? "is" : "=", input.organizationId)
    .where("key", "=", key)
    .forUpdate()
    .executeTakeFirst();

  if (existing) {
    await executor
      .updateTable("policyLimits")
      .set({ value: stored, updatedByUserId: input.userId, updatedAt: new Date() })
      .where("id", "=", existing.id)
      .execute();
  } else {
    await executor
      .insertInto("policyLimits")
      .values({ organizationId: input.organizationId, key, value: stored, updatedByUserId: input.userId })
      .execute();
  }

  await recordAuditLogEntry(
    {
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "politica.limite_alterado",
      outcome: "concluida", // mesma transação da alteração
      correlationId: newCorrelationId(),
      entityType: "policy_limit",
      entityId: key,
      // Decisão anterior (testada): a auditoria guarda só chave e escopo, nunca o valor. O histórico exibido na tela usa só isto (quem, quando, qual limite).
      metadata: { chave: key, escopo: input.organizationId === null ? "global" : "organizacao" },
    },
    executor
  );
  return value;
}
