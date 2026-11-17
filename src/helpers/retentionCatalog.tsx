/**
 * Catálogo de RETENÇÃO dos registros da plataforma de agentes (M34). É só CLASSIFICAÇÃO e simulação: nenhum prazo legal ou operacional foi definido pelo proprietário, então NENHUMA exclusão
 * automática existe nem é feita aqui. `retentionDefined: false` significa "decisão do proprietário pendente"; o comportamento seguro na ausência de política é CONSERVAR tudo.
 *
 * Categorias (cada uma pode, no futuro, ter exigência de guarda diferente):
 *   - operacional  : eventos internos e execuções do motor (podem ser reprocessados/auditados);
 *   - decisao      : exceções e as decisões humanas (prova de quem aprovou/rejeitou o quê);
 *   - alerta       : alertas de integridade e sua resolução;
 *   - auditoria    : trilha de auditoria encadeada por hash — NÃO é cache: imutável por gatilho e verificada periodicamente; excluir quebraria a cadeia.
 */
export const RETENTION_CATEGORIES = [
  { key: "eventos", label: "Eventos internos", group: "operacional", table: "domain_events", dateColumn: "created_at", orgColumn: "organization_id", deletable: false, note: "Barramento de eventos (append-only por gatilho). Hoje só crescem." },
  { key: "execucoes", label: "Execuções do motor de eventos", group: "operacional", table: "agent_event_runs", dateColumn: "created_at", orgColumn: "organization_id", deletable: false, note: "Estado atual de cada avaliação simulada; o histórico de transições é append-only." },
  { key: "excecoes", label: "Exceções", group: "decisao", table: "exception_queue", dateColumn: "created_at", orgColumn: "organization_id", deletable: false, note: "Prova do que foi interrompido e decidido; as decisões individuais são append-only." },
  { key: "alertas", label: "Alertas de integridade", group: "alerta", table: "integrity_alerts", dateColumn: "created_at", orgColumn: "organization_id", deletable: false, note: "Avisos e sua resolução." },
  { key: "auditoria", label: "Trilha de auditoria", group: "auditoria", table: "audit_log", dateColumn: "created_at", orgColumn: "organization_id", deletable: false, note: "Cadeia de hash imutável: nunca é candidata a expiração; qualquer política futura precisa preservar a verificação da cadeia." },
] as const;

export type RetentionCategoryKey = (typeof RETENTION_CATEGORIES)[number]["key"];

export const RETENTION_DECISIONS_PENDING = [
  "Prazo mínimo de guarda de eventos e execuções do motor (e se haverá arquivamento em vez de exclusão).",
  "Prazo de guarda de exceções e decisões humanas (pode ter exigência legal ou contratual ainda não levantada).",
  "Prazo de guarda de alertas resolvidos e descartados.",
  "Como preservar a verificação da cadeia de auditoria se um dia houver arquivamento (ex.: âncora externa).",
  "Quem autoriza e como se audita uma eventual rotina de expiração.",
] as const;
