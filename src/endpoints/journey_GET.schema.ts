import { z } from "zod";
import superjson from "superjson";
import type { JourneyListItemView } from "./journeys_GET.schema.js";

export const schema = z.object({ organizationId: z.coerce.number().int().positive(), needId: z.coerce.number().int().positive() });

export type TimelineKind = "necessidade" | "oferta_local" | "correspondencia" | "atribuicao" | "logistica" | "recebimento" | "destinacao" | "encerramento";
export type TimelineEventView = { at: string; kind: TimelineKind; title: string; detail: string | null; actor: string | null; ref: { type: string; id: string } | null };
export type MatchingStateView = "restrita" | "executado_com_correspondencia" | "executado_sem_correspondencia" | "historico_nao_verificavel" | "atribuicao_manual" | "nao_executado";
export type MatchingRunView = { id: string; origin: string; originLabel: string; finishedAt: string | null; repeatCount: number; lastRepeatedAt: string | null; outcome: "com_correspondencia" | "elegivel_sem_quantidade" | "avaliada_descartada" | "sem_relacao" | "avaliada_sem_registro" };
export type MatchingSectionView = { state: MatchingStateView; runs: MatchingRunView[]; note: string };
export type EvaluationView = {
  id: string; createdAt: string; decision: string; finalScore: number; algorithmVersion: string; allocationId: number | null;
  opportunity: { id: number; title: string; category: string | null; quantity: number | null; unit: string | null } | null;
  criteria: Array<{ key: string; score: number | null; weight: number; detail: string | null }>; notApplicable: string[];
};
export type AllocationView = {
  id: number; status: string; quantityAllocated: number; autoMatched: boolean; origin: "matching" | "manual" | "nao_verificavel"; evaluationId: string | null; createdAt: string; responseDueAt: string | null; reservedUntil: string | null; closedAt: string | null; closedReason: string | null;
  decidedByName: string | null; opportunity: { id: number; title: string; unit: string | null };
  logistics: Array<{ id: string; eventType: string; scheduledFor: string | null; occurredAt: string; actorName: string | null }>;
};
export type ReceiptView = { id: string; allocationId: number; entryType: string; quantity: number; unit: string; isCountable: boolean; unitMismatchNote: string | null; stockTransactionId: string | null; createdAt: string; createdByName: string | null };
export type DestinationSummary = { id: string; itemName: string; destinationType: string; quantity: number; unit: string; isCountable: boolean; state: string; reversedQuantity: number; proof: { name: string } | null; createdByDisplayName: string; createdAt: string };

export type OutputType = Omit<JourneyListItemView, "hasCorrelation"> & {
  description: string | null; itemName: string | null; closure: { reasonCode: string | null; closedAt: string } | null;
  evaluations: EvaluationView[] | null; matching: MatchingSectionView | null; allocations: AllocationView[] | null; receipts: ReceiptView[];
  /** Resumo das destinações (o histórico completo, com correções e estornos, continua na página Destinação). null = papel sem acesso. */
  destinations: DestinationSummary[] | null;
  /** Saídas de destinação aguardando a segunda aprovação (nada saiu do estoque). null = papel sem acesso ao estoque. */
  pendingApprovals: Array<{ id: number; quantity: number; unit: string | null; requestedAt: string }> | null;
  localOffers: Array<{ id: number; title: string; status: string; quantityOffered: number | null; unit: string | null; createdAt: string }> | null;
  timeline: TimelineEventView[]; pendings: string[];
  audit: { correlationId: string | null; entries: number | null; path: string | null; note: string } | null;
  access: { network: boolean; stock: boolean; opportunities: boolean; report: boolean; audit: boolean };
  notes: string[];
};

export const getJourney = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const result = await fetch(`/_api/v1/journey?${new URLSearchParams({ organizationId: String(v.organizationId), needId: String(v.needId) }).toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a jornada");
  }
  return superjson.parse<OutputType>(await result.text());
};
