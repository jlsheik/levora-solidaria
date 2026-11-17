import type { Kysely } from "kysely";
import type { DB } from "./schema.js";

/**
 * Registro de agentes e matriz de ferramentas permitidas (master prompt,
 * seção 44), em código versionado: mudar o que um agente pode fazer é uma
 * mudança de código revisada, nunca um valor editável em tela.
 *
 * Fase 74: os agentes da Camada A (guardiões) só ganham, por enquanto,
 * ferramentas de LEITURA e de ALERTA. Nenhuma ferramenta que mude estoque,
 * permissão, aprovação ou dinheiro existe, e portanto nenhum agente a tem
 * (invariantes 2 e 4 de docs/AGENTES_ESPECIFICACAO.md).
 */

export const TOOL_NAMES = ["create_integrity_alert", "list_open_alerts", "get_policy_limits", "assess_event"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const GUARDIAN_TOOLS: readonly ToolName[] = ["create_integrity_alert", "list_open_alerts", "get_policy_limits"];
/** M34: os dois agentes que o motor de eventos aciona (docs/AGENTES_ESPECIFICACAO.md §4) ganham `assess_event` — classe "simulate": registra a avaliação do evento, NUNCA executa ação externa. */
const EVENT_ENGINE_TOOLS: readonly ToolName[] = [...GUARDIAN_TOOLS, "assess_event"];

/**
 * `label`/`purpose` vêm da tabela de agentes da Camada A de docs/AGENTES_ESPECIFICACAO.md (M33: usados pela tela de operação; nenhuma capacidade nova é declarada aqui — a lista de
 * ferramentas continua a única fonte do que o agente PODE fazer).
 */
export const AGENT_DEFINITIONS = {
  "sentinela-integridade": { version: "0.1.0", tools: EVENT_ENGINE_TOOLS, label: "Sentinela de Integridade", purpose: "Vigia divergências entre o físico e o sistema, rajadas de ajustes e padrões incomuns de movimentação, e avisa uma pessoa." },
  "risk-engine": { version: "0.1.0", tools: EVENT_ENGINE_TOOLS, label: "Risk Engine", purpose: "Procura sinais de fraude (volume súbito, conta nova com alto valor, quantidade declarada diferente da recebida) e pede revisão." },
  "conflito-interesse": { version: "0.1.0", tools: GUARDIAN_TOOLS, label: "Conflito de Interesse", purpose: "Quando um usuário declara ligação com doador, fornecedor ou beneficiário, bloqueia a ação e pede revisão." },
  "agente-estoque": { version: "0.1.0", tools: GUARDIAN_TOOLS, label: "Agente de Estoque", purpose: "Aponta estoque parado, validade próxima e sugestões de remanejamento, como alerta operacional." },
  "vigia-prazos": { version: "0.1.0", tools: GUARDIAN_TOOLS, label: "Vigia de Prazos", purpose: "Avisa sobre coleta atrasada, reserva ou aprovação expirando e necessidade urgente." },
} as const satisfies Record<string, { version: string; tools: readonly ToolName[]; label: string; purpose: string }>;

export type AgentName = keyof typeof AGENT_DEFINITIONS;

export function isAgentName(name: string): name is AgentName {
  return name in AGENT_DEFINITIONS;
}

export interface AgentPrincipal {
  id: number;
  name: string;
  version: string;
  organizationId: number | null;
  enabled: boolean;
}

/**
 * Garante a linha do principal do agente (global ou de uma organização) e
 * sincroniza a versão com a do código. Nunca reativa um agente que alguém
 * desligou: `enabled` só muda por decisão humana.
 */
export async function ensureAgentPrincipal(
  executor: Kysely<DB>,
  name: AgentName,
  organizationId: number | null = null
): Promise<AgentPrincipal> {
  const definition = AGENT_DEFINITIONS[name];

  const existing = await executor
    .selectFrom("agentPrincipals")
    .select(["id", "name", "version", "organizationId", "enabled"])
    .where("name", "=", name)
    .where("organizationId", organizationId === null ? "is" : "=", organizationId)
    .executeTakeFirst();

  if (existing) {
    if (existing.version !== definition.version) {
      await executor
        .updateTable("agentPrincipals")
        .set({ version: definition.version })
        .where("id", "=", existing.id)
        .execute();
      return { ...existing, version: definition.version };
    }
    return existing;
  }

  const inserted = await executor
    .insertInto("agentPrincipals")
    .values({ name, version: definition.version, organizationId })
    .onConflict((oc) => oc.doNothing())
    .returning(["id", "name", "version", "organizationId", "enabled"])
    .executeTakeFirst();
  if (inserted) return inserted;

  // Perdeu a corrida contra outro processo: relê o que ele criou.
  return executor
    .selectFrom("agentPrincipals")
    .select(["id", "name", "version", "organizationId", "enabled"])
    .where("name", "=", name)
    .where("organizationId", organizationId === null ? "is" : "=", organizationId)
    .executeTakeFirstOrThrow();
}

export async function getAgentPrincipal(executor: Kysely<DB>, principalId: number): Promise<AgentPrincipal | null> {
  const row = await executor
    .selectFrom("agentPrincipals")
    .select(["id", "name", "version", "organizationId", "enabled"])
    .where("id", "=", principalId)
    .executeTakeFirst();
  return row ?? null;
}
