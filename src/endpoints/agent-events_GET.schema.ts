import { z } from "zod";
import superjson from "superjson";
import type { AgentEventRunStatus } from "../helpers/schema.js";

export const STATUS_VALUES = ["recebido", "validado", "ignorado", "bloqueado_politica", "aguardando_aprovacao", "rejeitado", "autorizado_simulacao", "simulacao_concluida", "falha", "dados_insuficientes"] as const satisfies readonly AgentEventRunStatus[];

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  status: z.enum(STATUS_VALUES).optional(),
  eventType: z.string().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Paginação por cursor: execuções com id menor que este. */
  beforeId: z.string().regex(/^[0-9]{1,18}$/).optional(),
  /** Quando informado, devolve também o histórico de transições desta execução. */
  runId: z.string().regex(/^[0-9]{1,18}$/).optional(),
});

export type RunView = {
  id: string;
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string | null;
  agentName: string;
  status: AgentEventRunStatus;
  reasonCode: string | null;
  reason: string | null;
  ruleCode: string | null;
  exceptionId: string | null;
  attempts: number;
  /** M35: completude da análise (`completa`/`parcial`/`insuficiente`) e decisão resumida; ausentes em execuções anteriores à M35. */
  completeness: "completa" | "parcial" | "insuficiente" | null;
  decision: string | null;
  /** M36: true quando esta execução já teve nova análise solicitada (a decisão anterior continua no histórico). */
  reevaluated: boolean;
  /** Sempre true: o motor só simula. A tela nunca deve apresentar isto como ação real concluída. */
  simulated: true;
  createdAt: string;
  updatedAt: string;
};

/** Explicação estruturada da decisão (M35): só fatos numéricos/booleanos/ids, regras com resultado e motivo, limites, o que faltou e as regras previstas ainda não implementadas. */
export type Explanation = {
  contractVersion: 1 | 2;
  facts: Record<string, string | number | boolean | null>;
  missingRequired: string[];
  missingOptional: string[];
  completeness: "completa" | "parcial" | "insuficiente";
  rules: Array<{ code: string; title: string; result: "ok" | "violada" | "nao_avaliada" | "nao_se_aplica"; effect?: "require_review" | "dual_approval"; reason: string; limit?: string; optional?: boolean }>;
  limits: Record<string, number | string[]>;
  pendingRules: Array<{ code: string; title: string; why: string }>;
  decision: string;
  evaluatedAt: string;
  evaluationCount: number;
  previous: Array<{ decision: string; at: string }>;
  /** M36: dados complementares usados numa reavaliação, com a ORIGEM de cada um (tabela, registro, instante). */
  supplement?: { fields: Record<string, string | number | boolean>; sources: Array<{ field: string; label: string; table: string; recordId: string; recordedAt: string | null; value: string | number | boolean | null }>; requestedAt: string; correlationId: string };
  simulated: true;
};

export type ReevaluationInfo = {
  eligibility: { state: "elegivel" | "ainda_insuficiente" | "indisponivel" | "nao_aplicavel"; blockCode: string | null; message: string; availableData: Array<{ field: string; label: string; table: string; recordId: string; recordedAt: string | null; value: string | number | boolean | null }>; stillMissing: string[] };
  history: Array<{ id: string; requestedAt: string; requestedByName: string | null; outcome: "iniciada" | "concluida" | "ainda_insuficiente" | "bloqueada"; previousStatus: string; previousDecision: string | null; newStatus: string | null; newDecision: string | null; correlationId: string; reason: string | null }>;
};

/** M37 — a oportunidade relacionada à avaliação (só da MESMA organização): categoria atual × considerada, versão e a última correção, para navegação e para não confundir decisão antiga com dado atual. */
export type RelatedOpportunity = { id: number; title: string; status: string; currentCategory: string | null; version: number; categoryConsidered: string | null; categoryChangedSinceDecision: boolean; lastCategoryChange: null | { at: string; byName: string | null } };

export type OutputType = {
  summary: {
    total: number;
    byStatus: Partial<Record<AgentEventRunStatus, number>>;
    /** Eventos contratados que esperam por um agente LIGADO e ainda não foram recebidos pelo motor. */
    unprocessedEvents: number;
    enabledEngineAgents: number;
    /** M36: reavaliações permitidas agora (execuções em dados insuficientes com dados novos verificáveis, até 100) e concluídas. */
    reevaluationsAllowed?: number;
    reevaluationsDone?: number;
  };
  runs: RunView[];
  nextBeforeId: string | null;
  detail: null | { run: RunView; explanation: Explanation | null; reevaluation: ReevaluationInfo | null; related: RelatedOpportunity | null; history: Array<{ fromStatus: string | null; toStatus: string; reasonCode: string | null; actorType: "agent" | "system" | "user"; actorName: string | null; createdAt: string }> };
};

export const getAgentEvents = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(v.organizationId), limit: String(v.limit) });
  if (v.status) params.set("status", v.status);
  if (v.eventType) params.set("eventType", v.eventType);
  if (v.beforeId) params.set("beforeId", v.beforeId);
  if (v.runId) params.set("runId", v.runId);
  const result = await fetch(`/_api/v1/agent-events?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o processamento de eventos");
  }
  return superjson.parse<OutputType>(await result.text());
};
