import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type PolicyLimitView = {
  key: string;
  kind: "number" | "list";
  /** Padrão em código (referência). */
  defaultValue: number | string[];
  /** Valor global em vigor (padrão ou ajuste da plataforma). */
  globalValue: number | string[];
  /** Restrição própria da organização, se houver (`null` = só vale o global). */
  organizationValue: number | string[] | null;
  /** O mais restritivo entre global e organização: é este que as regras aplicam. */
  effectiveValue: number | string[];
};

export type PolicyLimitChange = { key: string; scope: "global" | "organizacao"; byName: string | null; at: string };

/** `history` (M34): as últimas alterações de limite que valem para esta organização (as dela e as globais), da mais recente para a mais antiga — só quem/quando/qual limite (a auditoria não guarda valores). Ausente em servidor antigo. */
export type OutputType = { limits: PolicyLimitView[]; history?: PolicyLimitChange[] };

export const getPolicyLimits = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/policy-limits?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os limites de política");
  }
  return superjson.parse<OutputType>(await result.text());
};
