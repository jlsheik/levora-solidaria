import { z } from "zod";

export const movementSchema = z.object({
  type: z.enum(["entrada", "ajuste"], { error: "Selecione o tipo de movimentação" }), // saída física: registro de destinação (Fase 99E)
  quantity: z.coerce.number().refine((v) => v !== 0, "Informe uma quantidade diferente de zero"),
  reason: z.string().min(2, "Descreva o motivo"),
});
