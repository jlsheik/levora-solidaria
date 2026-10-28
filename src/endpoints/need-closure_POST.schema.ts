import { z } from "zod";
import superjson from "superjson";

export const CLOSURE_REASON_CODES = ["recursos_insuficientes", "necessidade_superada", "duplicidade", "desistencia_da_organizacao", "outro"] as const;
export const CLOSURE_REASON_LABELS: Record<(typeof CLOSURE_REASON_CODES)[number], string> = {
  recursos_insuficientes: "Recursos insuficientes",
  necessidade_superada: "Necessidade superada",
  duplicidade: "Duplicidade",
  desistencia_da_organizacao: "Desistência da organização",
  outro: "Outro motivo",
};

/** Encerra (cancela) uma necessidade SEM atendimento integral, com motivo estruturado, ou a reabre. Nenhuma das duas ações cria movimento de estoque. */
export const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("encerrar"),
    organizationId: z.coerce.number().int().positive(),
    needId: z.coerce.number().int().positive(),
    reasonCode: z.enum(CLOSURE_REASON_CODES, { error: "Escolha o motivo do encerramento" }),
    reasonText: z.string().trim().max(500).nullish(),
  }),
  z.object({
    action: z.literal("reabrir"),
    organizationId: z.coerce.number().int().positive(),
    needId: z.coerce.number().int().positive(),
    reasonText: z.string().trim().min(5, "Explique por que a necessidade está sendo reaberta").max(500),
  }),
]);

export type InputType = z.input<typeof schema>;
export type OutputType = { need: { id: number; status: string }; snapshot: { requested: number; attended: number; remaining: number } | null };

export const postNeedClosure = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/need-closure`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível concluir a operação");
  }
  return superjson.parse<OutputType>(await result.text());
};
