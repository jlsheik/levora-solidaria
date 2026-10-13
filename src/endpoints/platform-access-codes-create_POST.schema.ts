import { z } from "zod";
import { apiRequest } from "../helpers/authClient.js";

/** Validade: relativa (`expiresInMinutes`) OU absoluta (`expiresAt`, instante UTC) — exatamente uma. Limites (5 min … 90 dias) são do SERVIDOR. */
export const schema = z
  .object({
    label: z
      .string()
      .trim()
      .max(120, "A descrição pode ter no máximo 120 caracteres")
      .optional()
      .transform((v) => (v ? v : undefined)),
    expiresInMinutes: z.number().int().positive().max(60 * 24 * 365).optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict()
  .refine((v) => (v.expiresInMinutes === undefined) !== (v.expiresAt === undefined), { message: "Informe a validade em minutos OU uma data/hora de expiração" });

/** `code` é o ÚNICO momento em que o segredo completo existe fora do banco de hashes: exibido uma vez e nunca recuperável. */
export type OutputType = { id: number; code: string; masked: string; last4: string; expiresAt: Date; status: "active" };

export const postPlatformAccessCodesCreate = (body: z.input<typeof schema>) => apiRequest<OutputType>("POST", "platform-access-codes-create", schema.parse(body));
