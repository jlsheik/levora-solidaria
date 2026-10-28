import { z } from "zod";
import superjson from "superjson";
import { positiveQuantity } from "../helpers/quantityRules.js";
import { DESTINATION_TYPES, isAttendanceType, NOTES_MIN_WHEN_REQUIRED, REASON_REQUIRED_TYPES, type RiskReason } from "../helpers/destinationRules.js";

/** Registro ATÔMICO de saída física + destinação (Fase 99E). A chave de idempotência é obrigatória: o cliente a gera uma vez por tentativa de registro e a reenvia no retry. */
export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    itemId: z.coerce.number().int().positive(),
    quantity: positiveQuantity("Informe a quantidade física que sairá do estoque"),
    destinationType: z.enum(DESTINATION_TYPES, { error: "Escolha uma das finalidades da lista" }),
    needId: z.coerce.number().int().positive().nullish(),
    /** Data efetiva (AAAA-MM-DD, calendário do fuso de negócio). */
    deliveredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Informe a data efetiva no formato AAAA-MM-DD"),
    peopleServed: z.coerce.number().int().min(0).max(10_000_000).nullish(),
    peopleUnit: z.enum(["familias", "pessoas"]).nullish(),
    notes: z.string().trim().max(1000, "No máximo 1000 caracteres").nullish(),
    lateRegistrationReason: z.string().trim().max(500).nullish(),
    /** Fase 99F: autoriza expressamente o EXCEDENTE sobre o que falta da necessidade (proprietário/administrador, com motivo). */
    authorizeSurplus: z.boolean().optional(),
    surplusReason: z.string().trim().max(500).nullish(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "Chave de idempotência inválida"),
  })
  .superRefine((v, ctx) => {
    const attendance = isAttendanceType(v.destinationType);
    if (v.needId != null && !attendance) ctx.addIssue({ code: "custom", path: ["needId"], message: "Só as finalidades de atendimento podem se vincular a uma necessidade" });
    if (v.peopleServed != null && !attendance) ctx.addIssue({ code: "custom", path: ["peopleServed"], message: "Pessoas atendidas só se aplica às finalidades de atendimento" });
    if ((v.peopleServed == null) !== (v.peopleUnit == null)) ctx.addIssue({ code: "custom", path: ["peopleUnit"], message: "Informe a quantidade de pessoas ou famílias junto com a unidade (famílias ou pessoas)" });
    if (REASON_REQUIRED_TYPES.includes(v.destinationType) && (v.notes ?? "").length < NOTES_MIN_WHEN_REQUIRED) {
      ctx.addIssue({ code: "custom", path: ["notes"], message: `Descreva o motivo (mínimo de ${NOTES_MIN_WHEN_REQUIRED} caracteres) para esta finalidade` });
    }
  });

export type InputType = z.input<typeof schema>;

export type OutputType =
  | { requiresApproval: false; replayed: boolean; destination: { id: string; destinationType: string; deliveredOn: string; isCountable: boolean }; transaction: { id: string; delta: number }; newStock: number; notice: string | null }
  | { requiresApproval: true; replayed: boolean; approvalRequestId: number; riskReasons: RiskReason[]; message: string };

export const postStockDestinations = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/stock-destinations`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar a destinação");
  }
  return superjson.parse<OutputType>(await result.text());
};
