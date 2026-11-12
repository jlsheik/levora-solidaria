import { z } from "zod";
import superjson from "superjson";

export const NEED_STATUSES = ["aberta", "atendida", "cancelada"] as const;
export const JOURNEY_KINDS = ["necessidade", "oferta_local", "atribuicao_rede"] as const;
export const JOURNEY_LINKS = ["com_necessidade", "sem_necessidade"] as const;
/** Situações aceitas no filtro: as de cada tipo (necessidade, oferta local, atribuição). O servidor aplica cada valor só ao tipo a que ele pertence. */
export const STATUS_FILTERS = ["aberta", "atendida", "cancelada", "registrada", "em_contato", "confirmada", "recebida", "proposta", "aceita", "recusada", "em_coleta", "em_transporte"] as const;
export const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[1-3]_\d{1,12}$/;

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  /** Busca textual (servidor): título, descrição, doador, categoria, identificador (#12) e correlação — apenas nos registros que o papel já pode ler. */
  q: z.string().trim().max(80).optional(),
  tipo: z.enum(JOURNEY_KINDS).optional(),
  vinculo: z.enum(JOURNEY_LINKS).optional(),
  status: z.enum(STATUS_FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Cursor opaco da página seguinte (ordenação estável: criado em ↓, tipo ↑, id ↓). */
  cursor: z.string().regex(CURSOR_RE, "Cursor inválido").optional(),
});

export type StepState = "concluida" | "em_andamento" | "pendente" | "sem_dados" | "nao_se_aplica" | "restrita" | "executado_sem_resultado";
export type StepKey = "necessidade" | "correspondencia" | "atribuicao" | "recebimento" | "destinacao" | "atendimento" | "prestacao";
export type JourneyStepView = { key: StepKey; label: string; state: StepState; detail: string };
export type OfferStepKey = "oferta" | "vinculo" | "correspondencia" | "atribuicao" | "recebimento" | "destinacao" | "prestacao";
export type OfferStepView = { key: OfferStepKey; label: string; state: StepState; detail: string };
export type JourneyListItemView = {
  kind: "necessidade";
  needId: number; title: string; priority: string; status: "aberta" | "atendida" | "cancelada"; unit: string; quantityNeeded: number; createdAt: string;
  /** SUPRIMENTO: recebido da rede (ledger de atendimento). */
  supply: { fulfilled: number; requiredRemaining: number; surplus: number };
  /** ATENDIMENTO final: derivado das destinações. */
  attendance: { requested: number; attended: number; remaining: number; percent: number; physicalDestined: number; surplus: number; unitIncompatibleDestined: number; state: string };
  counts: { evaluations: number | null; allocations: Record<string, number> | null; receipts: number; destinations: number; localOffers: number | null; allocationOrigins?: { matching: number; manual: number; naoVerificavel: number } | null;
    matching?: { runs: number; runsNoRelation: number; evalValid: number; evalNoQuantity: number; evalDiscarded: number; lastAt: string | null; lastOrigin: string | null } | null };
  steps: JourneyStepView[]; next: string | null; hasCorrelation: boolean;
};
export type OfferJourneyListItemView = {
  kind: "oferta_local" | "atribuicao_rede"; id: number; title: string; status: string; statusLabel: string; quantity: number | null; unit: string | null; createdAt: string;
  sourceLabel: string; originLabel: string | null; steps: OfferStepView[]; next: string | null;
};
export type JourneyEntryView = JourneyListItemView | OfferJourneyListItemView;
export type OutputType = {
  items: JourneyEntryView[];
  nextCursor: string | null;
  /** Quais partes o seu papel consulta (o servidor é a autoridade; a tela só reflete). */
  access: { network: boolean; stock: boolean; opportunities: boolean; report: boolean; audit: boolean };
};

export const getJourneys = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(v.organizationId), limit: String(v.limit) });
  for (const k of ["q", "tipo", "vinculo", "status", "cursor"] as const) { const x = v[k]; if (x) params.set(k, x); }
  const result = await fetch(`/_api/v1/journeys?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as jornadas");
  }
  return superjson.parse<OutputType>(await result.text());
};
