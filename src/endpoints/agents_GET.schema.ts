import { z } from "zod";
import superjson from "superjson";
import type { ToolClass } from "../helpers/agentTools.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type AgentOverview = {
  name: string;
  label: string;
  purpose: string;
  /** Versão do código; `null` não existe: toda definição tem versão. */
  version: string;
  /** `nao_registrado`: a definição existe no código, mas ainda não há linha de principal no banco (nunca foi usado). */
  scope: "global" | "organizacao" | "nao_registrado";
  registered: boolean;
  /** `null` quando não registrado (sem principal não há interruptor para mostrar). */
  enabled: boolean | null;
  tools: Array<{ name: string; klass: ToolClass }>;
  /** M34: tipos de evento interno que este agente avalia no motor (vazio = ainda não ligado a nenhum evento). */
  eventTypes: string[];
  openAlerts: number;
  pendingExceptions: number;
  lastActionAt: string | null;
};

export type OutputType = {
  agents: AgentOverview[];
  summary: { total: number; registered: number; enabled: number; disabled: number; withOpenAlerts: number; withPendingExceptions: number };
  automation: { paused: boolean; emergency: boolean; /** M34: de onde vem o bloqueio e o motivo registrado (ausente = servidor antigo). */ global?: { paused: boolean; emergency: boolean; reason: string | null }; organization?: { paused: boolean; emergency: boolean; reason: string | null } };
  /** M34: totais REAIS da organização (para os indicadores de navegação). */
  totals?: { pendingExceptions: number; openAlerts: number };
  /** Consumo de eventos de negócio por agentes: vazio hoje (nenhum agente consome eventos ainda). */
  eventConsumers: Array<{ consumer: string; processed: number; failed: number; lastProcessedAt: string | null }>;
};

export const getAgents = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/agents?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os agentes");
  }
  return superjson.parse<OutputType>(await result.text());
};
