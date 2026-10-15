/**
 * Fase 99E — regras de produto das oito finalidades de destinação (compartilhadas entre servidor e interface; o SERVIDOR é a autoridade).
 */
export const DESTINATION_TYPES = [
  "atendimento_coletivo",
  "distribuicao_familias",
  "entrega_instituicao_parceira",
  "uso_operacional_instituicao",
  "doacao_a_terceiro",
  "devolucao_ao_doador",
  "perda",
  "descarte",
] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const DESTINATION_LABELS: Record<DestinationType, { label: string; description: string }> = {
  atendimento_coletivo: { label: "Atendimento coletivo", description: "Uso ou distribuição para um grupo, sem identificar participantes." },
  distribuicao_familias: { label: "Distribuição a famílias", description: "Entrega direta de itens a famílias, sem nomes, contatos ou documentos." },
  entrega_instituicao_parceira: { label: "Entrega a instituição parceira", description: "Entrega física a uma instituição parceira para a atuação social dela." },
  uso_operacional_instituicao: { label: "Uso operacional da organização", description: "Consumo interno necessário à operação (não conta como atendimento direto)." },
  doacao_a_terceiro: { label: "Doação a terceiro", description: "Transferência a uma entidade externa fora do fluxo de instituição parceira." },
  devolucao_ao_doador: { label: "Devolução ao doador", description: "Saída física para devolver o recurso ao doador ou fornecedor." },
  perda: { label: "Perda", description: "Perda física involuntária (avaria, deterioração). Exige segunda aprovação." },
  descarte: { label: "Descarte", description: "Eliminação intencional de recurso inutilizável ou impróprio. Exige segunda aprovação." },
};

/** Únicas finalidades que podem se vincular a uma necessidade e informar pessoas atendidas. */
export const ATTENDANCE_TYPES: readonly DestinationType[] = ["atendimento_coletivo", "distribuicao_familias", "entrega_instituicao_parceira"];
export const isAttendanceType = (t: DestinationType) => ATTENDANCE_TYPES.includes(t);

/** Finalidades que exigem descrição/motivo (≥ 10 caracteres em `notes`; também uma CHECK do banco). */
export const REASON_REQUIRED_TYPES: readonly DestinationType[] = ["uso_operacional_instituicao", "doacao_a_terceiro", "devolucao_ao_doador", "perda", "descarte"];
export const NOTES_MIN_WHEN_REQUIRED = 10;

/** Finalidades que SEMPRE exigem segunda validação independente. */
export const ALWAYS_APPROVAL_TYPES: readonly DestinationType[] = ["perda", "descarte"];
/** Saída que alcança esta fração do SALDO FÍSICO imediatamente anterior exige segunda aprovação (relativo ao saldo na unidade do item; nunca um número absoluto entre unidades). */
export const HIGH_RISK_BALANCE_RATIO = 0.3;

export type RiskReason = "finalidade_perda_ou_descarte" | "saida_alcanca_30_por_cento_do_saldo";

export function evaluateDestinationRisk(input: { destinationType: DestinationType; quantity: number; balanceBefore: number }): RiskReason[] {
  const reasons: RiskReason[] = [];
  if (ALWAYS_APPROVAL_TYPES.includes(input.destinationType)) reasons.push("finalidade_perda_ou_descarte");
  // comparação em milésimos inteiros para não depender de erro binário (0,1 + 0,2)
  if (input.balanceBefore > 0 && Math.round(input.quantity * 1000) * 10 >= Math.round(input.balanceBefore * 1000) * 3) reasons.push("saida_alcanca_30_por_cento_do_saldo");
  return reasons;
}

export const RISK_LABELS: Record<RiskReason, string> = {
  finalidade_perda_ou_descarte: "perda e descarte sempre exigem uma segunda pessoa",
  saida_alcanca_30_por_cento_do_saldo: "a saída é de pelo menos 30% do saldo atual do item",
};
