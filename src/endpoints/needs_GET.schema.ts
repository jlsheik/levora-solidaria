import { z } from "zod";
import superjson from "superjson";
import type { NeedPriority, NeedStatus } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  needs: Array<{
    id: number;
    title: string;
    description: string | null;
    itemId: number | null;
    itemName: string | null;
    quantityNeeded: number;
    unit: string;
    priority: NeedPriority;
    status: NeedStatus;
    createdByDisplayName: string;
    createdAt: string;
    // Progresso derivado do Modelo B (Fase 42) — nunca persistido, nunca
    // sincronizado com `status`. `fulfilled` é só o saldo contábil dos
    // recebimentos da rede (need_fulfillments), nunca inclui resolução
    // administrativa por estoque próprio (need_resolutions).
    fulfilled: number;
    requiredRemaining: number;
    surplus: number;
    /**
     * Fase 99F — ATENDIMENTO FINAL derivado das destinações (nunca do ledger de suprimento acima; as duas medidas não se somam):
     * `attended` = quantidade aplicada (só as 3 finalidades de atendimento, unidade compatível, líquida de reversões); `surplus` = excedente físico autorizado (não conta);
     * `unitIncompatibleDestined` = físico destinado em unidade incompatível (não conta). `state`: sem_atendimento | parcial | atendida | atendida_historica | cancelada.
     */
    attendance: {
      requested: number;
      attended: number;
      remaining: number;
      percent: number;
      physicalDestined: number;
      surplus: number;
      unitIncompatibleDestined: number;
      state: "sem_atendimento" | "parcial" | "atendida" | "atendida_historica" | "cancelada";
    };
    /** Encerramento ativo (só em necessidade cancelada com evento): motivo estruturado e instantâneo do momento. */
    closure: {
      reasonCode: string | null;
      reasonText: string | null;
      quantityNeededSnapshot: number | null;
      attendedSnapshot: number | null;
      remainingSnapshot: number | null;
      closedAt: string;
    } | null;
  }>;
};

export const getNeeds = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/needs?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as necessidades");
  }

  return superjson.parse<OutputType>(await result.text());
};
