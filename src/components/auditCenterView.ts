/**
 * M38 — vocabulário e regras de APRESENTAÇÃO da Central de Auditoria (puro e testável; nenhuma regra de segurança mora aqui — o servidor decide quem vê o quê).
 * Princípios de texto: o estado é sempre dito em PALAVRAS; "íntegra" nunca é apresentado como garantia universal; ausência de verificação nunca vira "aprovado".
 */

export type VerificationStatus = "em_andamento" | "integra" | "inconsistencia" | "incompleta" | "falha_tecnica";

export const AREA_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "agentes", label: "Agentes" },
  { value: "automacao", label: "Automação (exceções, alertas, controles)" },
  { value: "oportunidades", label: "Oportunidades" },
  { value: "politicas", label: "Políticas e limites" },
  { value: "organizacao", label: "Organização e membros" },
  { value: "necessidades", label: "Necessidades" },
  { value: "inventario", label: "Inventário" },
  { value: "destinacao", label: "Destinação e atribuições" },
  { value: "aprovacoes", label: "Aprovações" },
  { value: "acesso", label: "Acesso e segurança" },
  { value: "arquivos", label: "Arquivos" },
];

/** Nomes legíveis das ações que a Central mais mostra. Ação desconhecida aparece pelo código (nunca é traduzida "no chute"). */
const ACTION_LABEL: Record<string, string> = {
  "oportunidade.categoria_alterada": "Categoria da oportunidade alterada",
  "agente.reavaliacao_solicitada": "Nova análise do Risk Engine solicitada",
  "agente.reavaliacao_recusada": "Nova análise do Risk Engine recusada",
  "agente.excecao_criada": "Exceção criada por um agente",
  "automacao.excecao_decidida": "Decisão humana sobre uma exceção",
  "automacao.controle_alterado": "Pausa/emergência da automação alterada",
  "automacao.alerta_criado": "Alerta de integridade criado",
  "automacao.alerta_atualizado": "Alerta de integridade atualizado",
  "politica.limite_alterado": "Limite de política alterado",
  "auditoria.verificacao_solicitada": "Verificação da trilha solicitada",
  "aprovacao.rejeitada": "Aprovação rejeitada",
};
export function actionLabel(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  if (action.startsWith("agente.evento_")) return `Evento do agente: ${action.slice("agente.evento_".length).replace(/_/g, " ")}`;
  return action;
}

/** Resultado EXPLÍCITO gravado no ponto do código que conhece o desfecho (M39). `null` = não registrado: histórico anterior à M39 e operações ainda não instrumentadas. */
export type AuditOutcome = "concluida" | "recusada" | "falhou" | "pendente";
export const OUTCOME_LABEL: Record<AuditOutcome, string> = { concluida: "Concluída", recusada: "Recusada", falhou: "Falhou", pendente: "Pendente" };
export const OUTCOME_UNKNOWN_LABEL = "Resultado não registrado";
export const outcomeLabel = (o: AuditOutcome | null): string => (o === null ? OUTCOME_UNKNOWN_LABEL : OUTCOME_LABEL[o]);
export const outcomeBadge = (o: AuditOutcome | null): "success" | "destructive" | "secondary" | "outline" => (o === "concluida" ? "success" : o === "falhou" || o === "recusada" ? "destructive" : o === "pendente" ? "secondary" : "outline");
export const OUTCOME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "concluida", label: "Concluída" }, { value: "recusada", label: "Recusada" }, { value: "falhou", label: "Falhou" }, { value: "pendente", label: "Pendente" }, { value: "nao_registrado", label: "Resultado não registrado" },
];
export const OUTCOME_HELP = "O resultado é gravado pela própria operação, no momento em que o desfecho é conhecido. “Concluída” terminou; “Recusada” foi barrada por regra; “Falhou” não terminou por erro; “Pendente” aguarda uma decisão ou dado, e o desfecho final é outro registro. “Resultado não registrado” aparece em todo o histórico anterior e em operações ainda não instrumentadas — não significa sucesso, nem falha, e nunca é deduzido do nome da ação.";
export const RECORD_VERSION_LABEL: Record<number, string> = { 1: "versão 1 (histórico: o hash não cobre resultado nem correlação)", 2: "versão 2 (o hash cobre resultado e correlação)" };

export const ACTOR_TYPE_LABEL = { user: "Pessoa", agent: "Agente", system: "Sistema" } as const;

/** Para onde levar o usuário a partir de uma entidade auditada. null = não há página própria (nenhum link inventado). */
export function entityLink(organizationId: number, entityType: string, entityId: string | null): { href: string; label: string } | null {
  if (!entityId) return null;
  const base = `/organizacoes/${organizationId}`;
  switch (entityType) {
    case "donation_opportunity": return { href: `${base}/oportunidades?destaque=${encodeURIComponent(entityId)}`, label: "Abrir a oportunidade" };
    case "agent_event_run": return { href: `${base}/automacao?run=${encodeURIComponent(entityId)}`, label: "Abrir a justificativa do Risk Engine" };
    case "exception": return { href: `${base}/automacao?aba=excecoes`, label: "Abrir a fila de exceções" };
    case "integrity_alert": return { href: `${base}/automacao?aba=alertas`, label: "Abrir os alertas" };
    default: return null;
  }
}

/** Ponto de partida da rastreabilidade para uma entidade auditada, quando existe. */
export function traceLink(organizationId: number, entityType: string, entityId: string | null): string | null {
  if (!entityId) return null;
  const base = `/organizacoes/${organizationId}/auditoria?aba=rastreabilidade`;
  if (entityType === "donation_opportunity") return `${base}&oportunidade=${encodeURIComponent(entityId)}`;
  if (entityType === "agent_event_run") return `${base}&execucao=${encodeURIComponent(entityId)}`;
  if (entityType === "exception") return `${base}&excecao=${encodeURIComponent(entityId)}`;
  return null;
}

export type Tone = "ok" | "attention" | "info" | "muted";

export interface VerificationInput {
  status: VerificationStatus;
  unhashedEvents: number | null;
  divergenceCount: number | null;
  verifiedEvents: number | null;
  totalEvents: number | null;
  coveredUpToEventId: string | null;
}

/** Estado da verificação em palavras. `null` (nunca verificada) é o estado "Ainda não verificado" — NÃO é aprovação. */
export function verificationState(v: VerificationInput | null): { label: string; tone: Tone; message: string; requiresInvestigation: boolean } {
  if (!v) return { label: "Ainda não verificado", tone: "muted", message: "Nenhuma verificação foi executada. Isto não significa que a trilha esteja íntegra nem comprometida: significa que ela ainda não foi conferida.", requiresInvestigation: false };
  switch (v.status) {
    case "em_andamento":
      return { label: "Verificação em andamento", tone: "info", message: "A conferência está sendo executada. O resultado aparece aqui quando terminar.", requiresInvestigation: false };
    case "integra": {
      const ressalva = v.unhashedEvents && v.unhashedEvents > 0 ? ` ${v.unhashedEvents} evento(s) anteriores ao encadeamento não têm hash e não puderam ser verificados.` : "";
      return { label: "Consistência interna confirmada no escopo", tone: "ok", message: `Dentro dos eventos cobertos, todos os hashes conferem e cada elo aponta para o anterior.${ressalva} Isto é só a garantia A (consistência interna): NÃO prova que nenhum evento do fim da trilha foi removido nem que quem tem acesso direto ao banco não recalculou a cadeia. Para isso é preciso comparar com um comprovante anterior preservado fora do alcance dessa pessoa.`, requiresInvestigation: false };
    }
    case "inconsistencia":
      return { label: "Inconsistência encontrada", tone: "attention", message: "A conferência encontrou divergências. Nada foi alterado nem reparado. Este resultado exige investigação pela equipe responsável antes de qualquer outra ação.", requiresInvestigation: true };
    case "incompleta":
      return { label: "Verificação incompleta", tone: "attention", message: "A verificação foi interrompida antes de concluir. Não há resultado de integridade para este pedido — execute outra verificação.", requiresInvestigation: false };
    case "falha_tecnica":
      return { label: "Falha técnica na verificação", tone: "attention", message: "A verificação não pôde ser concluída por um erro técnico. Isto NÃO é um resultado de integridade (nem positivo, nem negativo). Tente novamente; se persistir, acione a equipe técnica.", requiresInvestigation: false };
  }
}

export const DIVERGENCE_REASON_LABEL: Record<string, string> = {
  hash_nao_bate: "O conteúdo gravado não corresponde ao hash gravado",
  previous_hash_nao_bate_com_evento_anterior: "O elo não aponta para o hash do evento anterior",
  versao_inconsistente: "A versão do registro é incompatível com os campos de resultado/correlação",
  versao_nao_suportada: "Versão de registro desconhecida: não foi possível verificar",
  hash_ausente_apos_inicio_da_cadeia: "Registro sem hash depois do início da cadeia",
};

/** As TRÊS garantias, que não se confundem (M39). */
export const THREE_GUARANTEES: Array<{ key: "A" | "B" | "C"; title: string; status: string; text: string }> = [
  { key: "A", title: "Consistência interna", status: "Disponível", text: "Os registros existentes são coerentes entre si (hashes e elos). Não vê o truncamento do fim da trilha nem o recálculo completo da cadeia." },
  { key: "B", title: "Comparação com comprovante anterior", status: "Disponível (local)", text: "O estado atual é comparado com um comprovante exportado antes. Detecta remoção dos últimos registros, de registro intermediário, alteração e recálculo — mas só vale se o comprovante foi guardado por quem NÃO controla o banco." },
  { key: "C", title: "Referência independente", status: "Referência independente não configurada", text: "Uma referência mantida fora do alcance de quem altera o banco (serviço externo, assinatura, carimbo de tempo). Não está configurada nem ativada: depende de autorização específica." },
];

export const RECEIPT_REASON_LABEL: Record<string, string> = {
  comprovante_ilegivel: "O arquivo não é um comprovante legível (não é JSON ou está truncado)",
  campos_invalidos: "Os campos do comprovante estão incompletos ou inválidos",
  digest_invalido: "O digest do comprovante não confere: o arquivo foi alterado depois de gerado",
  formato_nao_suportado: "Versão de formato não suportada por esta instalação",
  algoritmo_nao_suportado: "Algoritmo não suportado por esta instalação",
  outro_escopo: "O comprovante é de outro escopo (não da cadeia global)",
  registro_final_ausente: "O registro final do comprovante não existe mais: registros finais foram removidos (ou o comprovante é de outro banco)",
  hash_do_registro_diferente: "O registro de referência existe, mas com outro hash: foi alterado ou a cadeia foi recalculada",
  quantidade_menor: "Há menos registros do que havia quando o comprovante foi gerado: algum registro foi removido",
  inconsistencia_interna: "A consistência interna até o registro de referência falhou",
};
export const RECEIPT_STATUS_LABEL: Record<string, string> = { conferido: "Comprovante comparado: confere", divergencia: "Divergência encontrada", malformado: "Comprovante malformado", nao_suportado: "Comprovante não suportado", escopo_diferente: "Comprovante de outro escopo" };
export const RECEIPT_TRUST_MODEL = "O comprovante é um texto público, sem assinatura e sem segredo: o digest detecta edição acidental do arquivo, não quem o produziu. Um arquivo guardado no mesmo computador, sob o mesmo controle de quem administra o banco, NÃO é uma âncora independente — quem controla os dois pode forjar um comprovante coerente. Guarde-o fora do alcance dessa pessoa para que a comparação tenha valor.";

export const COVERAGE_LIMITS: string[] = [
  "A cadeia é única e global (todas as organizações). A verificação confere a cadeia inteira, não só a sua organização.",
  "Só é possível verificar eventos que têm hash. Eventos anteriores ao encadeamento (migração 0003) não são verificáveis.",
  "Não há âncora independente do último hash: a remoção de eventos do FIM da trilha não é detectada por esta verificação.",
  "Quem tem acesso direto e privilegiado ao banco poderia, em tese, recalcular toda a cadeia; a verificação não detecta isso.",
  "O resultado fica em uma tabela operacional separada (não dentro da própria trilha). Ela também não é uma âncora independente.",
  "Um registro sem hash que apareça DEPOIS do início da cadeia é tratado como divergência, não como histórico.",
];

/** Intervalo local (data yyyy-mm-dd) → ISO. `to` é EXCLUSIVO: o fim do dia escolhido entra no período. */
export function dayStartIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
export function dayEndExclusiveIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export function formatCount(c: { count: number; capped: boolean }): string {
  return c.capped ? `${c.count.toLocaleString("pt-BR")} ou mais` : c.count.toLocaleString("pt-BR");
}

export const TRACE_STEP_LABEL: Record<string, string> = {
  oportunidade: "Oportunidade", evento: "Evento", transicao: "Execução do agente", decisao: "Decisão", excecao: "Exceção", revisao_humana: "Revisão humana", reavaliacao: "Reavaliação", alteracao_categoria: "Alteração de categoria",
};
