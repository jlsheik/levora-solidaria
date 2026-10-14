import { z } from "zod";
import superjson from "superjson";
import type { AllocationStatus, OpportunityUrgency } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  allocations: Array<{
    id: number;
    status: AllocationStatus;
    quantityAllocated: number;
    notes: string | null;
    createdAt: string;
    /** Fase 98: vencimento do prazo de resposta (só atribuições automáticas criadas após a Fase 98; senão null). */
    responseDueAt: string | null;
    closedAt: string | null;
    /** Motivo do encerramento pelo sistema (prazo_expirado, reserva_expirada, oferta_*), ou null. */
    closedReason: string | null;
    /** Atribuição automática aguardando a primeira movimentação da organização, dentro do prazo ou vencida e ainda não processada. */
    pendingAction: boolean;
    opportunityId: number;
    opportunityTitle: string;
    opportunityDescription: string | null;
    opportunityCategory: string | null;
    opportunityUnit: string | null;
    opportunityUrgency: OpportunityUrgency;
    opportunityLocationCity: string | null;
    opportunityLocationState: string | null;
    sourceName: string;
  }>;
  pendingCount: number;
  /** Relógio do servidor (banco) no momento da consulta. */
  serverNow: string;
};

export const getOrganizationAllocations = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/organization-allocations?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as atribuições");
  }

  return superjson.parse<OutputType>(await result.text());
};
