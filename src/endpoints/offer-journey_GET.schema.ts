import { z } from "zod";
import superjson from "superjson";
import type { OfferStepView, StepState } from "./journeys_GET.schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  kind: z.enum(["oferta_local", "atribuicao_rede"]),
  id: z.coerce.number().int().positive(),
});

export type TimelineEventView = { at: string; kind: string; title: string; detail: string | null; actor: string | null; ref: { type: string; id: string } | null };
export type OutputType = {
  kind: "oferta_local" | "atribuicao_rede"; id: number; title: string; status: string; statusLabel: string; quantity: number | null; unit: string | null; createdAt: string;
  sourceLabel: string; originLabel: string | null; steps: Array<OfferStepView & { state: StepState }>; next: string | null;
  description: string | null; category: string | null; createdByName: string | null; donorName: string | null;
  evaluation: { id: string; finalScore: number; decision: string; algorithmVersion: string; createdAt: string } | null;
  logistics: Array<{ id: string; eventType: string; scheduledFor: string | null; occurredAt: string; actorName: string | null }>;
  receipts: Array<{ id: string; allocationId: number; entryType: string; quantity: number; unit: string; isCountable: boolean; unitMismatchNote: string | null; stockTransactionId: string | null; createdAt: string; createdByName: string | null }>;
  decidedByName: string | null;
  timeline: TimelineEventView[]; pendings: string[];
  /** Por que NÃO existe "vincular a uma necessidade" aqui (decisão de negócio pendente) e quais ações já existem. */
  linking: { available: false; reason: string; alternatives: Array<{ label: string; href: string }> };
  audit: { correlationId: string | null; entries: number | null; path: string | null; note: string } | null;
  access: { network: boolean; stock: boolean; opportunities: boolean; report: boolean; audit: boolean };
  notes: string[];
};

export const getOfferJourney = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const result = await fetch(`/_api/v1/offer-journey?${new URLSearchParams({ organizationId: String(v.organizationId), kind: v.kind, id: String(v.id) }).toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a oferta");
  }
  return superjson.parse<OutputType>(await result.text());
};
