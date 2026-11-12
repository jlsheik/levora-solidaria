import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import { z } from "zod";
import { db } from "./db.js";
import type { DB, IntegrityAlertLevel, Json } from "./schema.js";
import { IntegrityAlertLevelArrayValues } from "./schema.js";
import { recordAuditLogEntry, stableStringify } from "./auditLog.js";
import { ConflictError } from "./errorResponse.js";
import { AGENT_DEFINITIONS, getAgentPrincipal, type AgentPrincipal, type ToolName } from "./agentRegistry.js";
import { getAutomationState } from "./automationControls.js";
import { getEffectivePolicyLimits } from "./policyLimits.js";
import { evaluatePolicy, type PolicyContext } from "./policyRules.js";
import { createIntegrityAlert } from "./integrityAlerts.js";
import { transitionRun } from "./agentEventRuns.js";
import { fenceForDecision } from "./policyFence.js";

/**
 * Ganchos SÓ para testes determinísticos de concorrência (M36): permitem pausar a conclusão DEPOIS de a cerca ser tomada e ANTES de ela gravar, para provar a ordem imposta pelo banco. Em produção
 * ficam vazios e não têm efeito.
 */
export const TOOL_TEST_HOOKS: { afterFence?: (info: { runId: string; organizationId: number }) => Promise<void> } = {};

/**
 * Camada de ferramentas dos agentes (master prompt, seções 43, 44 e 72).
 *
 * Um agente NUNCA toca o banco: ele pede uma ferramenta por nome, e este
 * módulo, nesta ordem fixa, (1) confere se o agente está ligado, (2) se a
 * ferramenta está na matriz dele, (3) valida a entrada, (4) confere o escopo
 * de organização, (5) respeita pausar/emergência, (6) aplica o motor de
 * regras — que pode mandar a ação para a fila de exceções — e só então (7)
 * executa dentro de uma transação, com auditoria do agente como autor.
 *
 * Classes: "read" lê; "alert" só cria alertas (continua valendo em
 * emergência); "simulate" (M34) registra a avaliação de um evento nas tabelas do motor e
 * NUNCA executa ação externa nem altera dado de negócio (barrada em pausa e emergência);
 * "mutate" muda dados (barrada em pausa e emergência; nenhuma existe hoje).
 */

export type ToolClass = "read" | "alert" | "simulate" | "mutate";

export type BlockReason =
  | "agent_disabled"
  | "tool_not_allowed"
  | "invalid_input"
  | "organization_mismatch"
  | "automation_paused"
  | "automation_emergency"
  | "exception_not_valid";

export type AgentToolResult<T = unknown> =
  | { status: "ok"; result: T }
  | { status: "blocked"; reason: BlockReason; message: string }
  | { status: "needs_review"; exceptionId: string; ruleCode: string; approvalsRequired: 1 | 2; message: string };

interface ToolContext<I> {
  trx: Transaction<DB>;
  principal: AgentPrincipal;
  organizationId: number | null;
  input: I;
  /** M35: true quando uma exceção aprovada foi consumida NESTA transação (a política exigia revisão e as aprovações cobrem a exigência atual). */
  approvedException: boolean;
  /** M35: contexto de política da entrada (para revalidar dentro da transação). */
  policyContext: PolicyContext | null;
  /** M36: número de aprovações que a exceção consumida tinha exigido (null se nenhuma foi consumida). */
  approvedApprovalsRequired: number | null;
}

interface AuditSpec {
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Json;
}

export interface ToolDefinition<I extends { organizationId: number | null }, O> {
  name: ToolName;
  klass: ToolClass;
  input: z.ZodType<I>; // zod 4 (a base antiga usava zod 3: z.ZodTypeDef não existe mais)
  policyContext?: (input: I) => PolicyContext;
  run: (ctx: ToolContext<I>) => Promise<O>;
  audit?: (input: I, output: O) => AuditSpec | null;
}

export function defineTool<I extends { organizationId: number | null }, O>(def: ToolDefinition<I, O>) {
  return def;
}

const organizationIdField = z.number().int().positive().nullable();

const createIntegrityAlertTool = defineTool({
  name: "create_integrity_alert",
  klass: "alert",
  input: z.object({
    organizationId: organizationIdField,
    level: z.enum(IntegrityAlertLevelArrayValues),
    category: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, "categoria deve usar a-z, 0-9 e _"),
    title: z.string().min(1).max(200),
    detail: z
      .record(z.string(), z.unknown())
      .default({})
      .refine((value) => JSON.stringify(value).length <= 4000, "detail grande demais"),
    entityType: z.string().max(80).nullish(),
    entityId: z.string().max(120).nullish(),
    dedupeKey: z.string().max(200).nullish(),
  }),
  run: async ({ trx, principal, input }) => {
    const level: IntegrityAlertLevel = input.level;
    return createIntegrityAlert(trx, {
      organizationId: input.organizationId,
      level,
      category: input.category,
      title: input.title,
      detail: input.detail as Json,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      agentPrincipalId: principal.id,
    });
  },
  // O próprio createIntegrityAlert já audita (autor = agente); não duplica.
});

const listOpenAlertsTool = defineTool({
  name: "list_open_alerts",
  klass: "read",
  input: z.object({
    organizationId: organizationIdField,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  run: async ({ trx, input }) => {
    const rows = await trx
      .selectFrom("integrityAlerts")
      .select(["id", "level", "category", "title", "status", "entityType", "entityId", "createdAt"])
      .where("organizationId", input.organizationId === null ? "is" : "=", input.organizationId)
      .where("status", "in", ["aberto", "reconhecido"])
      .orderBy("id", "desc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({ ...row, id: String(row.id) }));
  },
});

const getPolicyLimitsTool = defineTool({
  name: "get_policy_limits",
  klass: "read",
  input: z.object({ organizationId: organizationIdField }),
  run: async ({ trx, input }) => getEffectivePolicyLimits(trx, input.organizationId),
});

/**
 * M34 — avaliação SIMULADA de um evento interno. A entrada traz só ids e a categoria; o motor (agentEventEngine.tsx) cria a execução (`agent_event_runs`) e esta ferramenta a conclui. A
 * categoria alimenta o motor de regras (R-CATEGORIA-*): se a política exigir revisão, a invocação vira exceção ANTES de `run`. `run` confere que a execução é desta organização e deste
 * agente (isolamento entre organizações) e só então avança o estado, com compare-and-set: duas conclusões simultâneas não passam.
 */
const assessEventTool = defineTool({
  name: "assess_event",
  klass: "simulate",
  input: z.object({
    organizationId: z.number().int().positive(),
    runId: z.string().regex(/^[0-9]{1,18}$/),
    category: z.string().trim().toLowerCase().min(1).max(80).nullish(),
    // Fatos opcionais do evento que alimentam as regras EXISTENTES (valor, distância, custo). Ausentes = a regra correspondente simplesmente não se aplica.
    estimatedValue: z.number().finite().min(0).nullish(),
    distanceKm: z.number().finite().min(0).nullish(),
    logisticsCost: z.number().finite().min(0).nullish(),
    // M35 (Sentinela): fatos booleanos verificáveis do evento. Ausente = DESCONHECIDO (a regra correspondente não dispara nem "passa").
    negativeBalance: z.boolean().nullish(),
    itemAdjustedAfterDistribution: z.boolean().nullish(),
    receiptQuantityMismatch: z.boolean().nullish(),
    // M37: quando a avaliação usou dado LIDO do registro da oportunidade (reavaliação), a conclusão confere que a versão ainda é a mesma.
    opportunityId: z.number().int().positive().nullish(),
    opportunityVersion: z.number().int().min(1).nullish(),
  }),
  policyContext: (input: { category?: string | null; estimatedValue?: number | null; distanceKm?: number | null; logisticsCost?: number | null; negativeBalance?: boolean | null; itemAdjustedAfterDistribution?: boolean | null; receiptQuantityMismatch?: boolean | null }) => ({
    category: input.category ?? undefined,
    estimatedValue: input.estimatedValue ?? undefined,
    distanceKm: input.distanceKm ?? undefined,
    logisticsCost: input.logisticsCost ?? undefined,
    negativeBalance: input.negativeBalance ?? undefined,
    itemAdjustedAfterDistribution: input.itemAdjustedAfterDistribution ?? undefined,
    receiptQuantityMismatch: input.receiptQuantityMismatch ?? undefined,
  }),
  run: async ({ trx, principal, input, approvedException, approvedApprovalsRequired, policyContext }) => {
    // M36 — CERCA DE POLÍTICA: antes de ler pausa/agente/limites, toma a trava compartilhada (global → organização). Quem altera qualquer um deles toma a exclusiva do mesmo nível, então o banco ORDENA
    // estritamente conclusão × alteração (ver policyFence.tsx). A leitura abaixo vem DEPOIS da trava: enxerga tudo o que já confirmou e nada pode confirmar entre a leitura e o commit desta transação.
    await fenceForDecision(trx, input.organizationId);
    if (TOOL_TEST_HOOKS.afterFence) await TOOL_TEST_HOOKS.afterFence({ runId: input.runId, organizationId: input.organizationId });
    // M37 — a decisão não pode se apresentar como baseada na categoria ATUAL se usou uma versão antiga: trava a linha da oportunidade (FOR SHARE: quem edita usa FOR UPDATE e espera/é esperado) e confere a versão.
    if (input.opportunityId && input.opportunityVersion) {
      const rec = await trx.selectFrom("donationOpportunities").select("version").where("id", "=", input.opportunityId).where("organizationId", "=", input.organizationId).forShare().executeTakeFirst();
      if (!rec || rec.version !== input.opportunityVersion) throw new ConflictError("revalidar: a oportunidade mudou desde a leitura dos dados");
    }
    const state = await getAutomationState(trx, input.organizationId);
    if (state.paused || state.emergency) throw new ConflictError("revalidar: automação pausada");
    const fresh = await trx.selectFrom("agentPrincipals").select("enabled").where("id", "=", principal.id).executeTakeFirst();
    if (!fresh?.enabled) throw new ConflictError("revalidar: agente desligado");
    if (policyContext) {
      const decision = evaluatePolicy(policyContext, await getEffectivePolicyLimits(trx, input.organizationId));
      if (decision.effect !== "allow" && !approvedException) throw new ConflictError("revalidar: a política passou a exigir revisão");
      if (decision.effect !== "allow" && approvedException && approvedApprovalsRequired !== null && decision.approvalsRequired > approvedApprovalsRequired) throw new ConflictError("revalidar: a aprovação existente não cobre a política atual");
    }
    const run = await trx
      .selectFrom("agentEventRuns")
      .select(["id", "status", "organizationId", "agentPrincipalId"])
      .where("id", "=", input.runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run || run.organizationId !== input.organizationId || run.agentPrincipalId !== principal.id) {
      throw new ConflictError("Execução inexistente para este agente nesta organização");
    }
    if (run.status !== "validado" && run.status !== "autorizado_simulacao") {
      throw new ConflictError("A execução já avançou ou não está pronta");
    }
    if (run.status === "validado") {
      await transitionRun(trx, { runId: input.runId, from: "validado", to: "autorizado_simulacao", reasonCode: "politica_permite", reason: "Nenhuma regra de proteção interrompeu o evento; autorizado somente para simulação.", actor: { type: "agent", agentPrincipalId: principal.id } });
    }
    await transitionRun(trx, { runId: input.runId, from: "autorizado_simulacao", to: "simulacao_concluida", reasonCode: "simulacao_concluida", reason: "Simulação concluída: nada foi executado fora do sistema.", actor: { type: "agent", agentPrincipalId: principal.id } });
    return { runId: input.runId, simulated: true as const };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: Record<ToolName, ToolDefinition<any, any>> = {
  assess_event: assessEventTool,
  create_integrity_alert: createIntegrityAlertTool,
  list_open_alerts: listOpenAlertsTool,
  get_policy_limits: getPolicyLimitsTool,
};

/** Classe (read/alert/mutate) de cada ferramenta, para a tela de operação mostrar o que cada agente PODE fazer (a fonte continua sendo o registro em código). */
export const TOOL_CLASS_BY_NAME: Record<ToolName, ToolClass> = {
  create_integrity_alert: TOOLS.create_integrity_alert.klass,
  list_open_alerts: TOOLS.list_open_alerts.klass,
  get_policy_limits: TOOLS.get_policy_limits.klass,
  assess_event: TOOLS.assess_event.klass,
};

function blocked(reason: BlockReason, message: string): AgentToolResult<never> {
  return { status: "blocked", reason, message };
}

function requestHash(toolName: string, organizationId: number | null, input: unknown): string {
  return createHash("sha256").update(stableStringify({ toolName, organizationId, input })).digest("hex");
}

async function reportDeniedTool(principal: AgentPrincipal, toolName: string): Promise<void> {
  await db.transaction().execute((trx) =>
    createIntegrityAlert(trx, {
      organizationId: principal.organizationId,
      level: "seguranca",
      category: "agente_ferramenta_negada",
      title: `Agente ${principal.name} tentou usar uma ferramenta fora da sua matriz`,
      detail: { agente: principal.name, ferramenta: toolName.slice(0, 80) },
      dedupeKey: `deny:${principal.id}:${toolName.slice(0, 80)}`,
    })
  );
}

export interface InvokeAgentToolArgs {
  principalId: number;
  toolName: string;
  input: unknown;
  /** Exceção já aprovada por humanos que autoriza esta mesma ação, uma única vez. */
  approvedExceptionId?: string;
  /** M39: correlação da execução de origem (herdada do evento). Propagada à exceção e à auditoria; nunca vem de entrada externa. */
  correlationId?: string | null;
}

/**
 * Configuração injetável: a matriz de agentes e o conjunto de ferramentas.
 * Em produção é sempre a do registro (invokeAgentTool); testes montam uma
 * própria para exercitar caminhos (ex.: regras de política) que as
 * ferramentas reais da Fase 74 ainda não têm.
 */
export interface ToolInvokerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, ToolDefinition<any, any>>;
  definitions: Record<string, { readonly tools: readonly string[] }>;
}

const DEFAULT_CONFIG: ToolInvokerConfig = { tools: TOOLS, definitions: AGENT_DEFINITIONS };

export function createToolInvoker(config: ToolInvokerConfig) {
  return (args: InvokeAgentToolArgs): Promise<AgentToolResult> => invokeWithConfig(config, args);
}

export function invokeAgentTool(args: InvokeAgentToolArgs): Promise<AgentToolResult> {
  return invokeWithConfig(DEFAULT_CONFIG, args);
}

async function invokeWithConfig(config: ToolInvokerConfig, args: InvokeAgentToolArgs): Promise<AgentToolResult> {
  const principal = await getAgentPrincipal(db, args.principalId);
  if (!principal) throw new Error("Principal de agente inexistente");
  if (!principal.enabled) return blocked("agent_disabled", "Este agente está desligado");

  const definition = config.definitions[principal.name] ?? null;
  const tool = config.tools[args.toolName] as ToolDefinition<{ organizationId: number | null }, unknown> | undefined;
  const allowed = definition ? definition.tools.includes(args.toolName) : false;
  if (!definition || !tool || !allowed) {
    await reportDeniedTool(principal, args.toolName);
    return blocked("tool_not_allowed", "Esta ferramenta não está permitida para este agente");
  }

  const parsed = tool.input.safeParse(args.input);
  if (!parsed.success) {
    return blocked("invalid_input", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  const input = parsed.data;
  const organizationId = input.organizationId;

  if (principal.organizationId !== null && organizationId !== principal.organizationId) {
    return blocked("organization_mismatch", "Este agente só pode agir na sua própria organização");
  }
  if (organizationId !== null) {
    const exists = await db.selectFrom("organizations").select("id").where("id", "=", organizationId).executeTakeFirst();
    if (!exists) return blocked("organization_mismatch", "Organização inexistente");
  }

  const control = await getAutomationState(db, organizationId);
  if (control.emergency && tool.klass !== "alert") {
    return blocked("automation_emergency", "Modo emergência ativo: só alertas são permitidos");
  }
  if (control.paused && (tool.klass === "mutate" || tool.klass === "simulate")) {
    return blocked("automation_paused", "Automação pausada: esta ação não pode executar agora");
  }

  const hash = requestHash(args.toolName, organizationId, input);
  let exceptionToConsume: string | null = null;
  let approvedApprovalsRequired: number | null = null;

  if (tool.policyContext) {
    const limits = await getEffectivePolicyLimits(db, organizationId);
    const decision = evaluatePolicy(tool.policyContext(input), limits);

    if (decision.effect !== "allow") {
      if (args.approvedExceptionId) {
        const exception = await db
          .selectFrom("exceptionQueue")
          .select(["id", "status", "consumedAt", "agentPrincipalId", "toolName", "requestHash", "approvalsRequired"])
          .where("id", "=", args.approvedExceptionId)
          .executeTakeFirst();
        const valid =
          exception &&
          exception.status === "aprovada" &&
          exception.consumedAt === null &&
          exception.agentPrincipalId === principal.id &&
          exception.toolName === args.toolName &&
          exception.requestHash === hash &&
          exception.approvalsRequired >= decision.approvalsRequired;
        if (!valid) return blocked("exception_not_valid", "A exceção informada não autoriza esta ação");
        exceptionToConsume = String(exception.id);
        approvedApprovalsRequired = exception.approvalsRequired;
      } else {
        const exceptionId = await db.transaction().execute(async (trx) => {
          const pending = await trx
            .selectFrom("exceptionQueue")
            .select("id")
            .where("agentPrincipalId", "=", principal.id)
            .where("requestHash", "=", hash)
            .where("status", "=", "pendente")
            .executeTakeFirst();
          if (pending) return String(pending.id);

          const created = await trx
            .insertInto("exceptionQueue")
            .values({
              organizationId,
              agentPrincipalId: principal.id,
              toolName: args.toolName,
              ruleCode: decision.ruleCode,
              approvalsRequired: decision.approvalsRequired,
              request: input as Json,
              requestHash: hash,
              correlationId: args.correlationId ?? null,
            })
            .returning("id")
            .executeTakeFirstOrThrow();

          await recordAuditLogEntry(
            {
              organizationId,
              actorUserId: null,
              actorType: "agent",
              actorAgentPrincipalId: principal.id,
              action: "agente.excecao_criada",
              outcome: "pendente", // a exceção aguarda decisão humana; o desfecho vem depois
              correlationId: args.correlationId ?? null,
              entityType: "exception",
              entityId: String(created.id),
              metadata: {
                agente: principal.name,
                ferramenta: args.toolName,
                regra: decision.ruleCode,
                aprovacoesNecessarias: decision.approvalsRequired,
              },
            },
            trx
          );
          return String(created.id);
        });
        return {
          status: "needs_review",
          exceptionId,
          ruleCode: decision.ruleCode,
          approvalsRequired: decision.approvalsRequired,
          message: "A automação foi interrompida por uma regra de proteção",
        };
      }
    }
  }

  try {
    const result = await db.transaction().execute(async (trx) => {
      if (exceptionToConsume) {
        const consumed = await trx
          .updateTable("exceptionQueue")
          .set({ consumedAt: new Date() })
          .where("id", "=", exceptionToConsume)
          .where("consumedAt", "is", null)
          .where("status", "=", "aprovada")
          .returning("id")
          .executeTakeFirst();
        if (!consumed) throw new ConflictError("exception_not_valid");
      }

      const output = await tool.run({ trx, principal, organizationId, input, approvedException: exceptionToConsume !== null, approvedApprovalsRequired, policyContext: tool.policyContext ? tool.policyContext(input) : null });

      const audit = tool.audit?.(input, output);
      if (audit) {
        await recordAuditLogEntry(
          {
            organizationId,
            actorUserId: null,
            actorType: "agent",
            actorAgentPrincipalId: principal.id,
            action: audit.action,
            outcome: "concluida", // a auditoria da ferramenta está na MESMA transação de tool.run: se ela falhar/reverter, este registro some junto
            correlationId: args.correlationId ?? null,
            entityType: audit.entityType,
            entityId: audit.entityId ?? null,
            metadata: { agente: principal.name, versaoAgente: principal.version, ...((audit.metadata as object) ?? {}) },
          },
          trx
        );
      }
      return output;
    });
    return { status: "ok", result };
  } catch (error) {
    if (error instanceof ConflictError && error.message === "exception_not_valid") {
      return blocked("exception_not_valid", "A exceção já foi usada ou deixou de ser válida");
    }
    throw error;
  }
}
