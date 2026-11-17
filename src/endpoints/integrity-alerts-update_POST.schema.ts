import { z } from "zod";
import superjson from "superjson";
import type { IntegrityAlertStatus } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  alertId: z.string().regex(/^\d{1,18}$/, "Identificador de alerta inválido"),
  action: z.enum(["reconhecer", "resolver", "descartar"]),
  // Sem dados pessoais: a nota fica visível a todos que leem o alerta.
  note: z.string().trim().max(500).optional(),
});

export type OutputType = {
  alert: { id: string; status: IntegrityAlertStatus };
};

export const postIntegrityAlertsUpdate = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/integrity-alerts-update`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível atualizar o alerta");
  }

  return superjson.parse<OutputType>(await result.text());
};
