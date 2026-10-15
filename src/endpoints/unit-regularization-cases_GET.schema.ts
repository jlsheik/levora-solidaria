import { z } from "zod";
import superjson from "superjson";

const statuses = ["ativos", "todos", "aberto", "conferido", "resolvido", "corrigido", "encerrado"] as const;
const sources = ["allocation", "local_donation"] as const;
const categories = ["a_classificar", "erro_cadastral", "conferencia_fisica", "conversao_nao_suportada", "informacao_insuficiente"] as const;

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  status: z.enum(statuses).default("ativos"),
  source: z.enum(sources).optional(),
  category: z.enum(categories).optional(),
  /** antigos = mais antigos primeiro (prioridade operacional: o que espera há mais tempo). */
  order: z.enum(["antigos", "recentes"]).default("antigos"),
});

export type InputType = z.input<typeof schema>;

export type RegularizationCase = {
  id: number;
  status: "aberto" | "conferido" | "resolvido" | "corrigido" | "encerrado";
  statusLabel: string;
  sourceType: "allocation" | "local_donation";
  sourceLabel: string;
  divergenceKind: "unidade_ausente" | "unidade_diferente" | "unidade_nao_classificada";
  divergenceLabel: string;
  category: (typeof categories)[number];
  blockedStage: string;
  resourceTitle: string;
  itemName: string;
  itemUnit: string;
  offeredQuantity: number | null;
  offeredUnit: string | null;
  informedQuantity: number;
  checkedQuantity: number | null;
  checkedUnit: string | null;
  divergenceReason: string | null;
  openedAt: string;
  openedByName: string | null;
  conferredByName: string | null;
  validatedByName: string | null;
  withoutSecondValidation: boolean;
  closedReason: string | null;
  nextAction: string;
  /** Quem pode agir (decidido pelo servidor com o papel de quem consulta; o servidor recusa a ação de quem não pode). */
  canConfer: boolean;
  canValidate: boolean;
  canClose: boolean;
  canCorrect: boolean;
  events: Array<{ id: number; eventType: string; actorName: string | null; fieldRef: string | null; previousValue: string | null; newValue: string | null; quantityBefore: number | null; quantityAfter: number | null; reason: string | null; createdAt: string }>;
};

export type OutputType = { cases: RegularizationCase[]; activeCount: number; truncated: boolean };

export const getUnitRegularizationCases = async (params: InputType, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(params);
  const search = new URLSearchParams({ organizationId: String(validated.organizationId), status: validated.status, order: validated.order });
  if (validated.source) search.set("source", validated.source);
  if (validated.category) search.set("category", validated.category);
  const result = await fetch(`/_api/v1/unit-regularization-cases?${search.toString()}`, {
    method: "GET",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as pendências de unidade");
  }
  return superjson.parse<OutputType>(await result.text());
};
