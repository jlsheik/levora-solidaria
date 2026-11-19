/**
 * M37 — apresentação e validação (PURAS, sem React nem servidor) da correção de categoria de oportunidades. A validação aqui só ESPELHA a do servidor (`src/helpers/opportunityCategory.tsx`, que é a
 * autoridade; um teste de paridade garante que as duas concordam). Não há catálogo de categorias: o campo é texto livre validado na forma; nada é inventado nem preenchido por padrão.
 */
export const CATEGORY_MIN = 2;
export const CATEGORY_MAX = 60;

export function validateCategoryDraft(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < CATEGORY_MIN) return { ok: false, message: `A categoria precisa ter ao menos ${CATEGORY_MIN} caracteres.` };
  if (value.length > CATEGORY_MAX) return { ok: false, message: `A categoria pode ter no máximo ${CATEGORY_MAX} caracteres.` };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _\-/]*$/u.test(value)) return { ok: false, message: "Use apenas letras, números, espaço, hífen, barra ou sublinhado (e comece por letra ou número)." };
  return { ok: true, value };
}

export const SUGGESTION_SOURCE_LABEL: Record<string, string> = { oportunidades: "já usada em ofertas desta organização", estoque: "já usada no estoque desta organização", politica: "tem regra na política de risco" };

export const MISSING_CATEGORY_HELP = "Sem categoria, o Risk Engine não consegue avaliar esta oferta por completo e nada é aprovado automaticamente. A categoria continua opcional no cadastro; informe-a aqui quando souber.";

/** Texto do estado da avaliação do agente para a lista de oportunidades (sempre simulação). */
export function assessmentSummary(a: { status: string; completeness: string | null; decision: string | null }): { title: string; tone: "ok" | "attention" | "info" | "neutral"; text: string } {
  switch (a.status) {
    case "dados_insuficientes": return { title: "Avaliação incompleta", tone: "attention", text: "O Risk Engine não conseguiu avaliar por falta de dados. Nada foi aprovado." };
    case "simulacao_concluida": return { title: "Avaliação concluída (simulação)", tone: "ok", text: "A política permitiu esta oferta na simulação. Nada foi executado fora do sistema." };
    case "aguardando_aprovacao": return { title: "Aguardando revisão humana", tone: "attention", text: "Uma regra de proteção encaminhou esta oferta para uma pessoa decidir na fila de exceções." };
    case "autorizado_simulacao": return { title: "Autorizada para simulação", tone: "info", text: "As aprovações foram dadas; o motor ainda vai concluir a simulação." };
    case "rejeitado": return { title: "Rejeitada na revisão", tone: "neutral", text: "Uma pessoa rejeitou: a operação não avança." };
    case "bloqueado_politica": return { title: "Avaliação bloqueada", tone: "attention", text: "Pausa, emergência ou agente desligado: retoma quando o motivo cessar." };
    case "ignorado": return { title: "Fora do contrato do agente", tone: "neutral", text: "O evento não foi avaliado." };
    case "falha": return { title: "Falha na avaliação", tone: "attention", text: "A avaliação falhou; há um alerta interno." };
    default: return { title: "Avaliação em andamento", tone: "info", text: "O motor ainda está processando este evento." };
  }
}

export const REEVALUATION_STATE_TEXT: Record<string, string> = {
  elegivel: "A categoria já consta no registro: é possível solicitar uma nova análise.",
  ainda_insuficiente: "Ainda falta a categoria no registro: defina-a antes de pedir uma nova análise.",
  indisponivel: "Nova análise indisponível agora.",
  nao_aplicavel: "Esta avaliação já foi reavaliada ou não está em dados insuficientes.",
};
