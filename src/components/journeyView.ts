/**
 * M40 — vocabulário e regras de APRESENTAÇÃO da jornada (puro e testável). A autoridade sobre o que cada papel vê é do servidor; aqui só se traduzem estados persistidos em texto.
 * Princípios: o estado é dito em PALAVRAS (nunca só cor); dado ausente nunca vira zero; "Restrita ao seu papel" ≠ "Sem dados"; nenhum estado é apresentado como entrega física comprovada.
 */
import type { StepState, StepKey } from "../endpoints/journeys_GET.schema";

export const STEP_STATE_LABEL: Record<StepState, string> = { concluida: "Concluída", em_andamento: "Em andamento", pendente: "Pendente", sem_dados: "Sem dados", nao_se_aplica: "Não se aplica", restrita: "Restrita ao seu papel", executado_sem_resultado: "Executado, sem correspondência" };
export const stepBadge = (s: StepState): "success" | "secondary" | "destructive" | "outline" => (s === "concluida" ? "success" : s === "em_andamento" || s === "executado_sem_resultado" ? "secondary" : s === "pendente" ? "destructive" : "outline");

export const PRIORITY_LABEL: Record<string, string> = { critica: "Crítica", alta: "Alta", media: "Média", baixa: "Baixa" };
export const NEED_STATUS_LABEL: Record<string, string> = { aberta: "Aberta", atendida: "Marcada como atendida", cancelada: "Encerrada" };
export const NEED_STATUS_HELP: Record<string, string> = {
  aberta: "A necessidade segue aberta.",
  atendida: "Decisão administrativa da organização; independe do progresso derivado abaixo.",
  cancelada: "A organização encerrou a necessidade (com motivo registrado).",
};

export const ALLOCATION_LABEL: Record<string, string> = { proposta: "Proposta (aguarda decisão)", aceita: "Aceita", recusada: "Recusada", em_coleta: "Em coleta", em_transporte: "Em transporte", recebida: "Recebida", cancelada: "Cancelada" };
export const LOGISTICS_LABEL: Record<string, string> = { coleta_agendada: "Coleta agendada", coleta_concluida: "Coleta concluída", transporte_iniciado: "Transporte iniciado", entrega_confirmada: "Entrega confirmada", cancelado: "Cancelado" };
export const DECISION_LABEL: Record<string, string> = { atribuido_automatico: "Atribuição automática (alta confiança)", proposto: "Proposta para decisão humana", descartado: "Descartada: pontuação abaixo do limiar de proposta", elegivel_sem_quantidade: "Elegível, mas a oferta já estava toda distribuída" };

/** Estado do matching para a necessidade (derivado só do que o motor registrou) e o texto de cada resultado de execução. */
export const MATCHING_STATE_LABEL: Record<string, string> = { restrita: "Restrita ao seu papel", executado_com_correspondencia: "Executado, com correspondência", executado_sem_correspondencia: "Executado, sem correspondência", historico_nao_verificavel: "Resultado histórico não verificável", atribuicao_manual: "Atribuição manual (matching não executado)", nao_executado: "Matching não executado" };
export const MATCHING_STATE_HELP: Record<string, string> = {
  executado_com_correspondencia: "O motor registrou ao menos uma correspondência válida para esta necessidade.",
  executado_sem_correspondencia: "O motor avaliou esta necessidade e não encontrou correspondência válida. Isto NÃO é uma falha técnica e não significa falta de oferta: a oferta pode existir e não ser compatível, e o motor só registra o motivo que calculou.",
  historico_nao_verificavel: "Há atribuição marcada como automática sem a avaliação no histórico: não é possível afirmar que o motor rodou.",
  atribuicao_manual: "Há atribuição feita manualmente por pessoa autorizada; nenhuma avaliação de matching foi executada para esta necessidade.",
  nao_executado: "Nenhuma execução do matching está registrada para esta necessidade.",
  restrita: "O seu papel não consulta a rede.",
};
export const MATCH_RUN_OUTCOME_LABEL: Record<string, string> = { com_correspondencia: "Houve correspondência válida", elegivel_sem_quantidade: "Elegível, mas sem quantidade livre na oferta", avaliada_descartada: "Avaliada, sem correspondência válida (abaixo do limiar)", sem_relacao: "Nenhuma oferta relacionada a esta necessidade", avaliada_sem_registro: "Avaliada, sem registro da avaliação" };
export const CLOSED_REASON_LABEL: Record<string, string> = {
  prazo_expirado: "prazo de resposta expirado", reserva_expirada: "reserva expirada", oferta_cancelada_admin: "oferta cancelada pela administração", oferta_expirada_admin: "oferta expirada (administração)",
  oferta_expirada_automatica: "oferta expirada automaticamente", oferta_encerrada: "oferta encerrada",
};
export const CRITERION_LABEL: Record<string, string> = {
  categoria: "Categoria", necessidade_urgencia: "Urgência da necessidade", quantidade: "Quantidade", proximidade: "Proximidade (aproximação por cidade/estado, não é distância em km)",
  capacidade_armazenamento: "Capacidade de armazenamento", capacidade_logistica: "Capacidade logística", raio_atendimento: "Raio de atendimento", horarios_restricoes: "Horários e restrições",
};
export const TIMELINE_KIND_LABEL: Record<string, string> = {
  necessidade: "Necessidade", oferta_local: "Oferta local", correspondencia: "Correspondência", atribuicao: "Atribuição", logistica: "Logística", recebimento: "Recebimento", destinacao: "Destinação", encerramento: "Encerramento",
};
export const DESTINATION_STATE_LABEL: Record<string, string> = { ativa: "Ativa", parcialmente_revertida: "Parcialmente revertida", revertida: "Revertida" };
export const RECEIPT_ENTRY_LABEL: Record<string, string> = { original: "Recebimento", correction: "Correção", reversal: "Estorno" };

export const STEP_ORDER: StepKey[] = ["necessidade", "correspondencia", "atribuicao", "recebimento", "destinacao", "atendimento", "prestacao"];

/** Onde a pessoa age em cada etapa (as ações continuam nas páginas de origem, onde o servidor valida permissão e estado). */
export function stepAction(key: StepKey, organizationId: number, needId?: number): { label: string; href: string } | null {
  const base = `/organizacoes/${organizationId}`;
  switch (key) {
    case "necessidade": return { label: "Abrir Necessidades", href: `${base}/necessidades` };
    case "correspondencia": return { label: "Abrir Atribuições", href: `${base}/atribuicoes` };
    case "atribuicao": return { label: "Decidir em Atribuições", href: `${base}/atribuicoes` };
    case "recebimento": return { label: "Registrar em Atribuições", href: `${base}/atribuicoes` };
    case "destinacao": return { label: "Abrir Destinação (filtrada por esta necessidade)", href: `${base}/destinacoes${needId ? `?need=${needId}` : ""}` };
    case "atendimento": return { label: "Abrir Destinação (filtrada por esta necessidade)", href: `${base}/destinacoes${needId ? `?need=${needId}` : ""}` };
    case "prestacao": return { label: "Abrir Prestação de contas", href: `${base}/prestacao-contas` };
  }
}

export const fmtQty = (n: number, unit?: string | null) => `${n.toLocaleString("pt-BR")}${unit ? ` ${unit}` : ""}`;
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("pt-BR");
export const pct = (n: number) => `${Math.max(0, Math.min(100, n))}%`;

/** Faixa de pontuação — só rotula o número gravado pelo motor (limiares congelados do Matching 1.4: 90/70); nunca cria pontuação. */
export function scoreBand(score: number): string { return score >= 90 ? "alta confiança" : score >= 70 ? "proposta" : "abaixo do limiar de proposta"; }

// ---- M41: ofertas sem necessidade, origem da atribuição, filtros
import type { OfferStepKey } from "../endpoints/journeys_GET.schema";

export const KIND_LABEL: Record<string, string> = { necessidade: "Necessidade", oferta_local: "Oferta local sem necessidade", atribuicao_rede: "Atribuição da rede sem necessidade" };
export const TIPO_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Todos" }, { value: "necessidade", label: "Necessidades" }, { value: "oferta_local", label: "Ofertas locais sem necessidade" }, { value: "atribuicao_rede", label: "Atribuições da rede sem necessidade" },
];
export const VINCULO_OPTIONS: Array<{ value: string; label: string }> = [{ value: "", label: "Todos" }, { value: "com_necessidade", label: "Com necessidade" }, { value: "sem_necessidade", label: "Sem necessidade vinculada" }];
export const STATUS_GROUPS: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [
  { label: "Necessidade", options: [{ value: "aberta", label: "Aberta" }, { value: "atendida", label: "Marcada como atendida" }, { value: "cancelada", label: "Encerrada / cancelada" }] },
  { label: "Oferta local", options: [{ value: "registrada", label: "Registrada" }, { value: "em_contato", label: "Em contato com o doador" }, { value: "confirmada", label: "Confirmada pelo doador" }, { value: "recebida", label: "Recebida" }] },
  { label: "Atribuição da rede", options: [{ value: "proposta", label: "Proposta" }, { value: "aceita", label: "Aceita" }, { value: "recusada", label: "Recusada" }, { value: "em_coleta", label: "Em coleta" }, { value: "em_transporte", label: "Em transporte" }] },
];
export const ORIGIN_BADGE: Record<string, string> = { matching: "Matching (avaliação do motor)", manual: "Atribuição manual", nao_verificavel: "Automática, sem avaliação no histórico" };

/** Chave da oferta na URL: `local-12` (oferta local) ou `rede-7` (atribuição da rede). */
export const offerParam = (kind: "oferta_local" | "atribuicao_rede", id: number) => `${kind === "oferta_local" ? "local" : "rede"}-${id}`;
export function parseOfferParam(v: string | null): { kind: "oferta_local" | "atribuicao_rede"; id: number } | null {
  const m = v ? /^(local|rede)-([0-9]{1,12})$/.exec(v) : null;
  return m ? { kind: m[1] === "local" ? "oferta_local" : "atribuicao_rede", id: Number(m[2]) } : null;
}

export function offerStepAction(key: OfferStepKey, kind: "oferta_local" | "atribuicao_rede", organizationId: number): { label: string; href: string } | null {
  const base = `/organizacoes/${organizationId}`;
  switch (key) {
    case "oferta": return kind === "oferta_local" ? { label: "Abrir Oportunidades", href: `${base}/oportunidades` } : { label: "Abrir Atribuições", href: `${base}/atribuicoes` };
    case "vinculo": return { label: "Ver as necessidades", href: `${base}/necessidades` };
    case "correspondencia": return kind === "atribuicao_rede" ? { label: "Abrir Atribuições", href: `${base}/atribuicoes` } : null;
    case "atribuicao": return { label: "Decidir em Atribuições", href: `${base}/atribuicoes` };
    case "recebimento": return kind === "oferta_local" ? { label: "Registrar em Oportunidades", href: `${base}/oportunidades` } : { label: "Registrar em Atribuições", href: `${base}/atribuicoes` };
    case "destinacao": return { label: "Abrir Destinação", href: `${base}/destinacoes` };
    case "prestacao": return { label: "Abrir Prestação de contas", href: `${base}/prestacao-contas` };
  }
}
