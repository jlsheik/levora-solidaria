/**
 * M33 — apresentação e validação (PURAS, sem React nem servidor) da tela de operação da plataforma de agentes.
 * Regras de leitura: todo estado tem rótulo em TEXTO (não só cor); nada aqui inventa capacidade de agente — as ferramentas e as classes vêm do servidor (registro em código); a validação
 * de limites no cliente apenas ESPELHA a regra do servidor ("uma organização só pode tornar o limite mais restritivo"); o servidor continua sendo a autoridade.
 */

export type Tone = "ok" | "attention" | "info" | "neutral";

export const TOOL_LABEL: Record<string, string> = {
  create_integrity_alert: "Criar alerta de integridade",
  list_open_alerts: "Listar alertas em aberto",
  get_policy_limits: "Consultar limites de política",
  assess_event: "Avaliar evento (simulação)",
};
export const TOOL_CLASS_LABEL: Record<string, { label: string; help: string }> = {
  read: { label: "Leitura", help: "Só consulta dados." },
  alert: { label: "Alerta", help: "Só cria avisos para uma pessoa; não altera dados de negócio." },
  simulate: { label: "Simula", help: "Registra a avaliação de um evento. Não executa nada fora do sistema nem altera dados de negócio; bloqueada em pausa/emergência." },
  mutate: { label: "Altera dados", help: "Muda dados — bloqueada quando a automação está pausada." },
};

export const RULE_LABEL: Record<string, { title: string; help: string }> = {
  "R-SENTINELA-SALDO-NEGATIVO": { title: "Saldo negativo", help: "O saldo do item ficou negativo depois do lançamento: violação de integridade que exige revisão." },
  "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO": { title: "Ajuste de item já distribuído", help: "Ajustar o estoque de um item que já teve saída/distribuição exige revisão de uma pessoa." },
  "R-SENTINELA-DIVERGENCIA-RECEBIMENTO": { title: "Divergência no recebimento", help: "A quantidade recebida difere da atribuída: exige revisão (a tolerância ainda não foi definida)." },
  "R-FINANCEIRO-DUPLA": { title: "Valor financeiro", help: "Qualquer movimentação financeira exige a aprovação de duas pessoas diferentes." },
  "R-VALOR-ALTO-DUPLA": { title: "Valor acima do aceite automático", help: "O valor estimado passa do limite de aceite automático: exige duas pessoas diferentes." },
  "R-CATEGORIA-ALTO-RISCO": { title: "Categoria de alto risco", help: "A categoria do bem é de alto risco: exige revisão de uma pessoa." },
  "R-CATEGORIA-REVISAO-MANUAL": { title: "Revisão manual obrigatória", help: "A categoria do bem sempre passa por revisão humana." },
  "R-DISTANCIA-COLETA": { title: "Distância de coleta", help: "A distância passa do limite automático: exige revisão de uma pessoa." },
  "R-CUSTO-LOGISTICO": { title: "Custo logístico", help: "O custo de logística passa do limite automático: exige revisão de uma pessoa." },
};
export const ruleLabel = (code: string) => RULE_LABEL[code] ?? { title: code, help: "Regra de proteção sem descrição cadastrada." };

export const EXCEPTION_STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  pendente: { label: "Pendente de decisão", tone: "attention" },
  aprovada: { label: "Aprovada", tone: "ok" },
  rejeitada: { label: "Rejeitada", tone: "neutral" },
};

export const ALERT_LEVEL_LABEL: Record<string, { label: string; tone: Tone }> = {
  alto_risco: { label: "Alto risco", tone: "attention" },
  seguranca: { label: "Segurança", tone: "attention" },
  operacional: { label: "Operacional", tone: "info" },
};
export const ALERT_STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  aberto: { label: "Aberto", tone: "attention" },
  reconhecido: { label: "Reconhecido", tone: "info" },
  resolvido: { label: "Resolvido", tone: "ok" },
  descartado: { label: "Descartado", tone: "neutral" },
};

export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
};

/** Quantas decisões de aprovação ainda faltam (0 se não pendente). */
export const approvalsMissing = (e: { status: string; approvals: number; approvalsRequired: number }) => (e.status === "pendente" ? Math.max(0, e.approvalsRequired - e.approvals) : 0);

/**
 * Resumo SEGURO do pedido de uma exceção: só chaves escalares conhecidas e curtas; nunca despeja o JSON inteiro (pode ter campos grandes). Valores longos são truncados.
 */
export function summarizeRequest(request: unknown, max = 8): Array<{ key: string; value: string }> {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(request as Record<string, unknown>)) {
    if (out.length >= max) break;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") { out.push({ key, value: Array.isArray(value) ? `${value.length} item(ns)` : "objeto" }); continue; }
    const text = String(value);
    out.push({ key, value: text.length > 80 ? `${text.slice(0, 77)}…` : text });
  }
  return out;
}

// ---------------------------------------------------------------- limites de política
export const LIMIT_COPY: Record<string, { label: string; help: string; unit: string | null; effect: string }> = {
  AUTO_ACCEPT_MAX_VALUE: { label: "Valor máximo de aceite automático", help: "Acima deste valor, uma oferta não é aceita automaticamente.", unit: "R$", effect: "dupla autorização" },
  FINANCIAL_APPROVAL_THRESHOLD: { label: "Valor financeiro que exige aprovação", help: "Acima deste valor, qualquer movimentação financeira exige aprovação.", unit: "R$", effect: "dupla autorização" },
  AUTO_PICKUP_MAX_DISTANCE_KM: { label: "Distância máxima de coleta automática", help: "Acima desta distância, a coleta precisa de revisão humana.", unit: "km", effect: "revisão humana" },
  AUTO_LOGISTICS_MAX_COST: { label: "Custo logístico máximo automático", help: "Acima deste custo, a logística precisa de revisão humana.", unit: "R$", effect: "revisão humana" },
  HIGH_RISK_CATEGORIES: { label: "Categorias de alto risco", help: "Bens dessas categorias passam por revisão humana.", unit: null, effect: "revisão humana" },
  MANUAL_REVIEW_REQUIRED_CATEGORIES: { label: "Categorias com revisão manual obrigatória", help: "Bens dessas categorias sempre passam por revisão humana.", unit: null, effect: "revisão humana" },
};

export type LimitValue = number | string[];
export const fmtLimit = (v: LimitValue, unit: string | null) => (Array.isArray(v) ? (v.length ? v.join(", ") : "nenhuma") : unit === "R$" ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : `${v.toLocaleString("pt-BR")}${unit ? ` ${unit}` : ""}`);

/** Interpreta o texto digitado de uma lista de categorias (separadas por vírgula ou quebra de linha): minúsculas, sem vazios, sem repetição, ordenadas. */
export function parseCategoryList(raw: string): string[] {
  return [...new Set(raw.split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Espelha a regra do servidor. Retorna a mensagem de erro (pt-BR) ou `null` quando o valor pode ser enviado. */
export function validateLimitDraft(kind: "number" | "list", raw: string, globalValue: LimitValue): { error: string | null; value: LimitValue | null } {
  if (kind === "number") {
    const text = raw.trim().replace(",", ".");
    if (text === "") return { error: "Informe um número.", value: null };
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return { error: "Informe um número válido, maior ou igual a zero.", value: null };
    const g = globalValue as number;
    if (n > g) return { error: `Uma organização só pode tornar o limite mais restritivo: use no máximo ${g.toLocaleString("pt-BR")} (valor global).`, value: null };
    return { error: null, value: n };
  }
  const list = parseCategoryList(raw);
  if (list.some((c) => c.length > 60)) return { error: "Cada categoria pode ter até 60 caracteres.", value: null };
  if (list.length > 100) return { error: "No máximo 100 categorias.", value: null };
  const missing = (globalValue as string[]).filter((c) => !list.includes(c));
  if (missing.length) return { error: `Uma organização só pode ACRESCENTAR categorias: mantenha ${missing.join(", ")} (valor global).`, value: null };
  return { error: null, value: list };
}

export const sameLimit = (a: LimitValue, b: LimitValue) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- resumo geral
export function agentsHeadline(s: { total: number; registered: number; enabled: number; disabled: number; withOpenAlerts: number; withPendingExceptions: number }, automation: { paused: boolean; emergency: boolean }): { tone: Tone; text: string } {
  if (automation.emergency) return { tone: "attention", text: "Modo emergência: os agentes só podem criar alertas." };
  if (automation.paused) return { tone: "attention", text: "Automação pausada: nenhum agente muda dados." };
  if (s.withPendingExceptions > 0) return { tone: "attention", text: s.withPendingExceptions === 1 ? "1 agente com exceção aguardando decisão" : `${s.withPendingExceptions} agentes com exceções aguardando decisão` };
  if (s.withOpenAlerts > 0) return { tone: "attention", text: s.withOpenAlerts === 1 ? "1 agente com alerta em aberto" : `${s.withOpenAlerts} agentes com alertas em aberto` };
  if (s.registered === 0) return { tone: "info", text: "Nenhum agente foi registrado ainda; nada precisa da sua atenção." };
  return { tone: "ok", text: "Nenhuma pendência dos agentes." };
}

export function agentStateLabel(a: { registered: boolean; enabled: boolean | null }): { label: string; tone: Tone } {
  if (!a.registered) return { label: "Não registrado", tone: "neutral" };
  return a.enabled ? { label: "Ligado", tone: "ok" } : { label: "Desligado", tone: "attention" };
}

// ---------------------------------------------------------------- motor de eventos (M34) — SIMULAÇÃO
export const EVENT_TYPE_LABEL: Record<string, string> = {
  "stock_transaction.created": "Movimento de estoque registrado",
  "allocation.received": "Recebimento de atribuição registrado",
  "opportunity.created": "Oportunidade de doação criada",
};
export const eventTypeLabel = (t: string) => EVENT_TYPE_LABEL[t] ?? t;

/** Cada estado do motor, em texto. Nenhum deles significa execução real: o motor só simula. */
export const RUN_STATUS_LABEL: Record<string, { label: string; tone: Tone; help: string }> = {
  recebido: { label: "Recebido", tone: "info", help: "O motor registrou o evento para este agente." },
  validado: { label: "Validado", tone: "info", help: "Tipo, estrutura e organização conferem." },
  ignorado: { label: "Ignorado", tone: "neutral", help: "Fora do contrato do agente; não foi avaliado." },
  bloqueado_politica: { label: "Bloqueado", tone: "attention", help: "Não avançou (pausa, emergência ou agente desligado); retoma sozinho quando o motivo cessar." },
  aguardando_aprovacao: { label: "Aguardando aprovação", tone: "attention", help: "Uma regra de proteção interrompeu: uma pessoa precisa decidir na aba Exceções." },
  rejeitado: { label: "Rejeitado", tone: "neutral", help: "Uma pessoa rejeitou: a operação não avança." },
  autorizado_simulacao: { label: "Autorizado para simulação", tone: "info", help: "Liberado apenas para simulação; ainda não concluído." },
  simulacao_concluida: { label: "Simulação concluída", tone: "ok", help: "Simulação registrada. Nada foi executado fora do sistema." },
  falha: { label: "Falha", tone: "attention", help: "Erro inesperado repetido; o histórico foi mantido e há um alerta." },
  dados_insuficientes: { label: "Dados insuficientes", tone: "attention", help: "Falta um dado obrigatório: a análise é incompleta e NADA foi aprovado. Não avança sozinha." },
};
export const RUN_STATUS_ORDER = ["aguardando_aprovacao", "dados_insuficientes", "bloqueado_politica", "autorizado_simulacao", "simulacao_concluida", "rejeitado", "ignorado", "falha", "validado", "recebido"] as const;
export const runStatusLabel = (s: string) => RUN_STATUS_LABEL[s] ?? { label: s, tone: "neutral" as Tone, help: "" };

export const REASON_TEXT: Record<string, string> = {
  evento_recebido: "Evento recebido.",
  evento_valido: "Tipo, estrutura e organização conferem.",
  politica_permite: "Nenhuma regra de proteção interrompeu o evento.",
  simulacao_concluida: "Simulação concluída; nada foi executado fora do sistema.",
  excecao_aberta: "Uma regra de proteção abriu uma exceção.",
  excecao_aprovada: "As aprovações exigidas foram dadas (somente simulação).",
  excecao_rejeitada: "Uma pessoa rejeitou a exceção.",
  politica_alterada: "A política mudou depois da aprovação: nova exceção aberta.",
  reprocessado: "O motivo do bloqueio cessou: evento retomado.",
  automation_paused: "A automação está pausada.",
  automation_emergency: "Modo emergência ativo.",
  agent_disabled: "O agente está desligado.",
  organization_mismatch: "O agente não pode agir nesta organização.",
  tool_not_allowed: "Ferramenta fora da matriz do agente.",
  falha_repetida: "A avaliação falhou repetidas vezes.",
  entrada_invalida: "Entrada da avaliação inválida.",
  erro_inesperado: "Erro inesperado (nova tentativa).",
  estrutura_invalida: "A estrutura do evento não corresponde ao contrato.",
  tipo_nao_suportado: "Tipo de evento sem contrato.",
  sem_organizacao: "Evento sem organização.",
  dados_insuficientes: "Análise incompleta: falta um dado obrigatório; nada foi aprovado.",
};
export const reasonText = (code: string | null | undefined) => (code ? REASON_TEXT[code] ?? code : "—");

export const ACTOR_LABEL: Record<string, string> = { agent: "Agente", user: "Pessoa", system: "Sistema" };

/** Resumo do motor para a visão geral: só números reais; nenhum zero inventado quando o motor nunca recebeu nada. */
export function engineHeadline(s: { total: number; byStatus: Partial<Record<string, number>>; unprocessedEvents: number; enabledEngineAgents: number }): { tone: Tone; text: string } {
  const n = (k: string) => s.byStatus[k] ?? 0;
  if (s.enabledEngineAgents === 0 && s.total === 0) return { tone: "info", text: "Nenhum agente está ligado para avaliar eventos nesta organização; nada está sendo processado." };
  if (n("dados_insuficientes") > 0 && n("falha") === 0 && n("aguardando_aprovacao") === 0) return { tone: "attention", text: n("dados_insuficientes") === 1 ? "1 evento com dados insuficientes: a análise ficou incompleta e nada foi aprovado" : `${n("dados_insuficientes")} eventos com dados insuficientes: as análises ficaram incompletas e nada foi aprovado` };
  if (n("falha") > 0) return { tone: "attention", text: n("falha") === 1 ? "1 evento terminou em falha" : `${n("falha")} eventos terminaram em falha` };
  if (n("aguardando_aprovacao") > 0) return { tone: "attention", text: n("aguardando_aprovacao") === 1 ? "1 evento aguarda a decisão de uma pessoa" : `${n("aguardando_aprovacao")} eventos aguardam a decisão de uma pessoa` };
  if (n("bloqueado_politica") > 0) return { tone: "attention", text: n("bloqueado_politica") === 1 ? "1 evento está bloqueado e retoma quando o motivo cessar" : `${n("bloqueado_politica")} eventos estão bloqueados e retomam quando o motivo cessar` };
  if (s.unprocessedEvents > 0) return { tone: "info", text: s.unprocessedEvents === 1 ? "1 evento aguarda o próximo processamento" : `${s.unprocessedEvents} eventos aguardam o próximo processamento` };
  return { tone: "ok", text: "Nenhum evento pendente de processamento ou decisão." };
}

// ---------------------------------------------------------------- explicação da decisão (M35)
export const RULE_RESULT_LABEL: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "Atendida", tone: "ok" },
  violada: { label: "Violada", tone: "attention" },
  nao_avaliada: { label: "Não avaliada", tone: "neutral" },
  nao_se_aplica: { label: "Não se aplica", tone: "neutral" },
};
export const COMPLETENESS_LABEL: Record<string, { label: string; tone: Tone; help: string }> = {
  completa: { label: "Análise completa", tone: "ok", help: "Todos os dados obrigatórios estavam disponíveis." },
  parcial: { label: "Análise parcial", tone: "info", help: "Alguma regra não pôde ser comparada (dado não comparável), mas nenhum dado obrigatório faltou." },
  insuficiente: { label: "Análise insuficiente", tone: "attention", help: "Faltou um dado obrigatório: não é aprovação." },
};
export const DECISION_LABEL: Record<string, string> = {
  permitido: "Permitido pela política (simulação)",
  permitido_analise_parcial: "Permitido pela política, com análise parcial (simulação)",
  revisao: "Exige revisão de uma pessoa",
  dupla_autorizacao: "Exige dupla autorização",
  dados_insuficientes: "Dados insuficientes: nada foi aprovado",
  aprovado_por_pessoas_simulacao: "Liberado por pessoas para simulação",
};
export const decisionLabel = (d: string | null | undefined) => (d ? DECISION_LABEL[d] ?? d : "—");
export const FACT_LABEL: Record<string, string> = {
  estornaLancamento: "Lançamento original estornado", estornaAtribuicao: "Atribuição cujo recebimento foi estornado/corrigido", tipo: "Tipo do lançamento", variacao: "Variação de estoque", saldoApos: "Saldo depois do lançamento", origem: "Origem do lançamento", itemJaDistribuido: "Item já teve saída/distribuição",
  quantidadeRecebida: "Quantidade recebida", quantidadeAtribuida: "Quantidade atribuída", mesmaUnidade: "Mesma unidade (oferta × item)", categoria: "Categoria da oferta", quantidadeOferecida: "Quantidade oferecida",
  unidade: "Unidade", atorId: "Usuário (identificador)", versaoContrato: "Versão do contrato do evento", estimatedValue: "Valor estimado", distanceKm: "Distância (km)", logisticsCost: "Custo logístico",
};
export const ORIGEM_LABEL: Record<string, string> = { lancamento_manual: "Lançamento manual", ajuste_aprovado: "Ajuste aprovado por segunda pessoa", destinacao_saida: "Saída por destinação", estoque_inicial: "Estoque inicial (cadastro do item)", recebimento_oportunidade: "Recebimento de oportunidade local", estorno_destinacao: "Estorno de destinação (devolução física)", correcao_destinacao: "Correção de destinação", estorno_recebimento: "Estorno de recebimento", correcao_recebimento: "Correção de recebimento" };
export const MISSING_LABEL: Record<string, string> = {
  category: "categoria da oferta", itemHasPriorDistribution: "se o item já teve saída (contrato v1 não informa)", quantityAllocated: "quantidade atribuída (contrato v1 não informa)", estimatedValue: "valor estimado",
  reversesReference: "referência ao registro original do estorno/correção", distanceKm: "distância", logisticsCost: "custo logístico", quantityOffered: "quantidade oferecida", mesma_unidade: "unidade comparável",
};
export const missingLabel = (k: string) => MISSING_LABEL[k] ?? k;
/** Por que cada dado obrigatório importa e o que fazer — texto de impacto; a obrigatoriedade global do campo é decisão do proprietário. */
export const MISSING_IMPACT: Record<string, string> = {
  category: "A categoria é opcional no cadastro da oferta, mas as regras de risco dependem dela: sem categoria a oferta não pode ser avaliada e nada é aprovado. Hoje não existe tela para corrigir a categoria depois do cadastro; se ela passar a constar no registro da oferta, é possível pedir uma nova análise. Tornar o campo obrigatório é uma decisão do proprietário.",
  itemHasPriorDistribution: "Eventos anteriores à versão 2 do contrato não informam se o item já teve saída; a nova análise recalcula isso a partir do histórico do estoque.",
  quantityAllocated: "Eventos anteriores à versão 2 do contrato não informam a quantidade atribuída; a nova análise a lê da própria atribuição.",
  reversesReference: "Um estorno ou correção precisa apontar para o registro original; sem isso não pode ser avaliado como estorno.",
};
export const REEVALUATION_BLOCK_TEXT: Record<string, string> = {
  estado_invalido: "Só execuções em “dados insuficientes” podem ser reavaliadas.",
  agente_desligado: "O agente está desligado: ligue-o antes de pedir uma nova análise.",
  automacao_pausada: "A automação está pausada: a nova análise só pode ser pedida depois de retomada.",
  anterior_a_ativacao: "O evento é anterior à ativação do agente e não pode ser processado retroativamente.",
  dados_ainda_insuficientes: "Os dados obrigatórios continuam ausentes nos registros de origem.",
};
export const REEVALUATION_OUTCOME_LABEL: Record<string, string> = { iniciada: "Em andamento", concluida: "Concluída", ainda_insuficiente: "Dados ainda insuficientes (nada mudou)", bloqueada: "Bloqueada (nada mudou)" };
export const factValue = (key: string, v: string | number | boolean | null): string => (v === null ? "não informado" : typeof v === "boolean" ? (v ? "sim" : "não") : key === "origem" ? ORIGEM_LABEL[String(v)] ?? String(v) : String(v));
