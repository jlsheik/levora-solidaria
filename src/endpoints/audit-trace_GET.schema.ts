import { z } from "zod";
import superjson from "superjson";
import type { AuditEntryView } from "./audit-center_GET.schema.js";

/** Exatamente UM ponto de partida. */
export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    opportunityId: z.coerce.number().int().positive().optional(),
    runId: z.string().regex(/^[0-9]{1,18}$/).optional(),
    exceptionId: z.string().regex(/^[0-9]{1,18}$/).optional(),
    correlationId: z.string().regex(/^[0-9a-fA-F-]{36}$/).optional(),
  })
  .refine((v) => [v.opportunityId, v.runId, v.exceptionId, v.correlationId].filter((x) => x !== undefined).length === 1, { message: "Informe exatamente um ponto de partida (oportunidade, execução, exceção ou correlação)" });

export type TraceStepKey = "oportunidade" | "evento" | "transicao" | "decisao" | "excecao" | "revisao_humana" | "reavaliacao" | "alteracao_categoria";
export type LinkKind = "direta" | "correlacao";
/** Registro de auditoria da visão de rastreabilidade: `link` diz POR QUE ele está aqui. direta = mesma entidade; correlacao = mesma correlação persistida de outra entidade. */
export type TraceAuditEntryView = AuditEntryView & { link: LinkKind };
export type TraceStepView = { key: TraceStepKey; at: string; title: string; detail: string | null; actor: string | null; ref: { kind: "oportunidade" | "evento" | "execucao" | "excecao" | "reavaliacao"; id: string } | null; correlationId: string | null; auditEntryId: string | null; /** Tipo do vínculo com o registro de auditoria; null = sem vínculo verificável. */ linkKind: LinkKind | null };
export type HistoricalDecisionView = {
  runId: string; agentName: string; status: string; decision: string | null; reason: string | null; ruleCode: string | null; evaluatedAt: string; evaluationCount: number;
  policy: { rules: Array<{ code: string; title: string; result: string; reason: string }>; limits: Record<string, unknown> } | null;
  categoryConsidered: string | null; categoryOrigin: string | null; versionConsidered: number | null;
  currentCategory: string | null; currentVersion: number | null; categoryDiffers: boolean | null;
  laterChanges: Array<{ id: string; at: string; byName: string | null; previousValue: string | null; newValue: string | null; versionAfter: number; correlationId: string; auditEntryId: string | null }>;
  recalculated: false;
};
export type OutputType = {
  subject: { kind: "oportunidade" | "execucao" | "excecao" | "correlacao"; id: string };
  opportunity: { id: number; title: string; status: string; currentCategory: string | null; version: number } | null;
  steps: TraceStepView[];
  decisions: HistoricalDecisionView[];
  auditEntries: TraceAuditEntryView[];
  /** Correlação persistida da jornada (herdada da origem); null = jornada sem correlação (anterior à M39). */
  journey: { correlationId: string | null };
  limits: string[];
};

export const getAuditTrace = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams();
  for (const [k, val] of Object.entries(v)) if (val !== undefined) params.set(k, String(val));
  const result = await fetch(`/_api/v1/audit-trace?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a rastreabilidade");
  }
  return superjson.parse<OutputType>(await result.text());
};
