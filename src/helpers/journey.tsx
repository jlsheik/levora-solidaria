import { sql } from "kysely";
import { db } from "./db.js";
import { getNeedFulfillmentBalanceBatch, computeNeedProgress, type NeedProgress } from "./needFulfillment.js";
import { computeAttendanceProgress, getNeedAttendanceBatch, type NeedAttendanceProgress } from "./needAttendance.js";
import type { NeedStatus } from "./schema.js";

/**
 * M40 — JORNADA integrada da necessidade. É SOMENTE LEITURA e só combina fatos que JÁ estão persistidos pelos módulos existentes — nenhuma contabilidade nova:
 *   necessidade → correspondência (match_evaluations) → atribuição (opportunity_allocations + logistics_events) → recebimento (need_fulfillments, o ledger do suprimento)
 *   → destinação (stock_destinations, o ledger do atendimento final) → registros para prestação de contas.
 * A necessidade é o eixo porque é o único elo persistido entre as quatro tabelas (`need_id` em avaliações, atribuições, ledger e destinações). Conceitos que o domínio distingue continuam
 * distintos: SUPRIMENTO (recebido da rede) ≠ ATENDIMENTO final (destinado); estado administrativo da necessidade (`needs.status`) ≠ progresso derivado; correspondência ≠ atribuição ≠ recebimento ≠ destinação.
 * Etapas sem dado são ditas "sem dado"/"restrita ao seu papel" — nunca viram zero nem "concluída". Nada aqui representa movimentação física comprovada.
 */

export type StepState = "concluida" | "em_andamento" | "pendente" | "sem_dados" | "nao_se_aplica" | "restrita" | "executado_sem_resultado";
export type StepKey = "necessidade" | "correspondencia" | "atribuicao" | "recebimento" | "destinacao" | "atendimento" | "prestacao";
export interface JourneyStep { key: StepKey; label: string; state: StepState; detail: string }

export interface JourneyAccess {
  /** `atribuicoes.leia`: correspondências, atribuições e logística. */
  network: boolean;
  /** `inventario.lance` (mesma regra do histórico de destinações): destinações em detalhe. */
  stock: boolean;
  /** `oportunidades.leia`: ofertas locais vinculadas. */
  opportunities: boolean;
  /** `relatorios.leia`: ligação com a prestação de contas. */
  report: boolean;
  /** `auditoria.leia`: correlação e atalhos da Central. */
  audit: boolean;
}

export interface JourneyCounts {
  evaluations: number | null;
  allocations: Record<string, number> | null;
  receipts: number;
  destinations: number;
  localOffers: number | null;
  /**
   * M41 — ORIGEM das atribuições da necessidade, a partir do que está persistido: `matching` (existe avaliação do motor ligada à atribuição), `manual` (atribuição escolhida por uma pessoa autorizada,
   * sem avaliação) e `naoVerificavel` (marcada como automática, mas sem avaliação no histórico — nunca se afirma que o algoritmo rodou). null = papel sem acesso à rede.
   */
  allocationOrigins?: { matching: number; manual: number; naoVerificavel: number } | null;
  /**
   * M42 — o que o motor de matching REGISTROU sobre esta necessidade: execuções que a consideraram (`matching_run_needs`) e as decisões das avaliações gravadas. Nada é calculado aqui.
   * null = papel sem acesso à rede; ausente = chamador que não carrega este resumo.
   */
  matching?: MatchingSummary | null;
}

export interface MatchingSummary {
  /** Execuções que consideraram a necessidade (exclui as que falharam: uma falha não é atribuível a uma necessidade). */
  runs: number;
  /** Execuções em que NENHUMA oferta tinha relação de categoria com a necessidade. */
  runsNoRelation: number;
  /** Avaliações gravadas por decisão: com correspondência (`atribuido_automatico`/`proposto`), `elegivel_sem_quantidade`, `descartado` (abaixo do limiar). */
  evalValid: number; evalNoQuantity: number; evalDiscarded: number;
  lastAt: string | null; lastOrigin: string | null;
}

/** Estado do matching PARA UMA NECESSIDADE, só a partir do que está registrado. `restrita` = papel sem acesso à rede. */
export type MatchingState = "restrita" | "executado_com_correspondencia" | "executado_sem_correspondencia" | "historico_nao_verificavel" | "atribuicao_manual" | "nao_executado";
export function deriveMatchingState(counts: Pick<JourneyCounts, "evaluations" | "allocations" | "allocationOrigins" | "matching">, network: boolean): MatchingState {
  if (!network) return "restrita";
  const m = counts.matching ?? { runs: 0, runsNoRelation: 0, evalValid: 0, evalNoQuantity: 0, evalDiscarded: 0, lastAt: null, lastOrigin: null };
  const o = counts.allocationOrigins ?? { matching: 0, manual: 0, naoVerificavel: 0 };
  if (m.evalValid > 0 || m.evalNoQuantity > 0 || o.matching > 0) return "executado_com_correspondencia";
  if (m.runs > 0 || m.evalDiscarded > 0) return "executado_sem_correspondencia";
  if (o.naoVerificavel > 0) return "historico_nao_verificavel";
  if (o.manual > 0) return "atribuicao_manual";
  return "nao_executado";
}
export const MATCH_ORIGIN_LABEL: Record<string, string> = { varredura: "varredura automática", manual: "execução manual da administração", mudanca_de_estado: "mudança de estado da oferta", reabertura: "reabertura da oferta", expiracao: "expiração de reserva ou prazo", indeterminada: "origem não informada" };

export interface JourneyListItem {
  kind: "necessidade";
  needId: number;
  title: string;
  priority: string;
  status: NeedStatus;
  unit: string;
  quantityNeeded: number;
  createdAt: string;
  /** SUPRIMENTO: recebido da rede (ledger de atendimento). */
  supply: NeedProgress;
  /** ATENDIMENTO final: derivado das destinações. */
  attendance: NeedAttendanceProgress;
  counts: JourneyCounts;
  steps: JourneyStep[];
  /** Próxima ação sugerida, só quando decorre de um estado persistido (nunca uma prioridade inventada). */
  next: string | null;
  hasCorrelation: boolean;
}

const ACTIVE = ["proposta", "aceita", "em_coleta", "em_transporte"];
const ALLOCATION_LABEL: Record<string, string> = { proposta: "proposta (aguarda decisão)", aceita: "aceita", em_coleta: "em coleta", em_transporte: "em transporte", recebida: "recebida", recusada: "recusada", cancelada: "cancelada" };
export const allocationStatusLabel = (s: string) => ALLOCATION_LABEL[s] ?? s;

/** Etapas e próxima ação a partir dos FATOS (contagens e ledgers) — função pura, testada. */
export function deriveSteps(args: {
  status: NeedStatus; quantityNeeded: number; unit: string; supply: NeedProgress; attendance: NeedAttendanceProgress; counts: JourneyCounts;
  access: Pick<JourneyAccess, "network" | "report">; destinationsWithoutProof?: number | null;
  /** Saídas de destinação de alto risco aguardando a SEGUNDA aprovação (nada saiu do estoque ainda). */
  pendingApprovals?: number;
}): { steps: JourneyStep[]; next: string | null } {
  const { status, supply, attendance, counts, access } = args;
  const closed = status === "cancelada";
  const fmt = (n: number) => `${n.toLocaleString("pt-BR")} ${args.unit}`;
  const steps: JourneyStep[] = [{ key: "necessidade", label: "Necessidade registrada", state: "concluida", detail: `${fmt(args.quantityNeeded)} solicitados${closed ? " — encerrada pela organização" : ""}` }];

  // correspondência (matching): "concluída" só com correspondência VÁLIDA registrada. Executado sem resultado é dito como tal (não é falha nem sucesso); atribuição manual não é matching.
  const hasAllocations = Object.keys(counts.allocations ?? {}).length > 0;
  const orig = counts.allocationOrigins ?? { matching: 0, manual: 0, naoVerificavel: 0 };
  const mstate = deriveMatchingState(counts, access.network);
  const mm = counts.matching ?? { runs: 0, runsNoRelation: 0, evalValid: 0, evalNoQuantity: 0, evalDiscarded: 0, lastAt: null, lastOrigin: null };
  const manualNote = orig.manual > 0 ? ` · além de ${orig.manual} atribuição(ões) manual(is)` : "";
  const lastNote = mm.lastAt ? ` Última execução: ${new Date(mm.lastAt).toLocaleString("pt-BR")}${mm.lastOrigin ? ` (${MATCH_ORIGIN_LABEL[mm.lastOrigin] ?? mm.lastOrigin})` : ""}.` : "";
  if (mstate === "restrita") steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "restrita", detail: "O seu papel não consulta a rede." });
  else if (mstate === "executado_com_correspondencia") steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "concluida", detail: `${mm.evalValid + orig.matching > 0 ? `${Math.max(mm.evalValid, orig.matching)} avaliação(ões) com correspondência válida` : `${mm.evalNoQuantity} avaliação(ões) elegível(is) sem quantidade livre`} registrada(s) pelo motor${manualNote}${hasAllocations ? "" : " · nenhuma resultou em atribuição"}.${lastNote}` });
  else if (mstate === "executado_sem_correspondencia") steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "executado_sem_resultado",
    detail: `Matching executado${mm.runs > 0 ? ` em ${mm.runs} execução(ões)` : ""}: nenhuma correspondência válida${mm.evalDiscarded > 0 ? ` (${mm.evalDiscarded} avaliação(ões) abaixo do limiar de proposta)` : ""}${mm.runsNoRelation > 0 ? ` · ${mm.runsNoRelation} execução(ões) sem nenhuma oferta relacionada à necessidade` : ""}.${manualNote ? manualNote.replace(" · além de", " Há também") + "." : ""}${lastNote} Isto não é uma falha.` });
  else if (mstate === "historico_nao_verificavel") steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "sem_dados", detail: `${orig.naoVerificavel} atribuição(ões) marcada(s) como automática(s), mas sem avaliação no histórico — não é possível verificar o matching.${orig.manual > 0 ? ` Há também ${orig.manual} atribuição(ões) manual(is).` : ""}` });
  else if (mstate === "atribuicao_manual") steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "nao_se_aplica", detail: `Atribuição manual autorizada (${orig.manual}); nenhuma avaliação de matching foi executada para esta necessidade.` });
  else steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: closed ? "nao_se_aplica" : "pendente", detail: closed ? "Necessidade encerrada." : "O matching ainda não foi executado para esta necessidade (nenhuma execução registrada)." });

  // atribuição
  const al = counts.allocations ?? {};
  const active = ACTIVE.filter((s) => (al[s] ?? 0) > 0);
  if (!access.network) steps.push({ key: "atribuicao", label: "Atribuição da rede", state: "restrita", detail: "O seu papel não consulta a rede." });
  else if ((al.recebida ?? 0) > 0 && active.length === 0) steps.push({ key: "atribuicao", label: "Atribuição da rede", state: "concluida", detail: `${al.recebida} atribuição(ões) recebida(s)` });
  else if (active.length > 0) steps.push({ key: "atribuicao", label: "Atribuição da rede", state: "em_andamento", detail: active.map((s) => `${al[s]} ${allocationStatusLabel(s)}`).join(" · ") });
  else if (Object.keys(al).length > 0) steps.push({ key: "atribuicao", label: "Atribuição da rede", state: "pendente", detail: Object.entries(al).map(([s, n]) => `${n} ${allocationStatusLabel(s)}`).join(" · ") + " — sem atribuição ativa" });
  else steps.push({ key: "atribuicao", label: "Atribuição da rede", state: closed ? "nao_se_aplica" : "pendente", detail: closed ? "Necessidade encerrada." : "Nenhuma atribuição para esta necessidade." });

  // recebimento (suprimento)
  if (counts.receipts > 0) steps.push({ key: "recebimento", label: "Recebimento (suprimento)", state: "concluida", detail: `${fmt(supply.fulfilled)} recebidos da rede (ledger)${supply.surplus > 0 ? ` · excedente ${fmt(supply.surplus)}` : ""}` });
  else steps.push({ key: "recebimento", label: "Recebimento (suprimento)", state: active.length > 0 ? "em_andamento" : closed ? "nao_se_aplica" : "pendente", detail: active.length > 0 ? "Atribuição em andamento, ainda sem recebimento registrado." : closed ? "Necessidade encerrada." : "Nenhum recebimento da rede registrado." });

  // destinação
  const awaiting = args.pendingApprovals ?? 0;
  if (counts.destinations > 0) steps.push({ key: "destinacao", label: "Destinação do estoque", state: attendance.remaining === 0 ? "concluida" : "em_andamento", detail: `${counts.destinations} destinação(ões); ${fmt(attendance.physicalDestined)} saíram do estoque${awaiting > 0 ? ` · ${awaiting} aguardando segunda aprovação` : ""}` });
  else if (awaiting > 0) steps.push({ key: "destinacao", label: "Destinação do estoque", state: "em_andamento", detail: `${awaiting} saída(s) aguardando a segunda aprovação; nada saiu do estoque ainda` });
  else steps.push({ key: "destinacao", label: "Destinação do estoque", state: closed ? "nao_se_aplica" : "pendente", detail: closed ? "Necessidade encerrada." : counts.receipts > 0 ? "Há recebimento, mas nenhuma destinação registrada para esta necessidade." : "Nenhuma destinação registrada." });

  // atendimento final
  const stateMap: Record<string, StepState> = { atendida: "concluida", atendida_historica: "concluida", parcial: "em_andamento", sem_atendimento: closed ? "nao_se_aplica" : "pendente", cancelada: "nao_se_aplica" };
  steps.push({
    key: "atendimento", label: "Atendimento final", state: stateMap[attendance.state] ?? "pendente",
    detail: attendance.state === "atendida_historica" ? "Marcada como atendida por uma versão anterior, sem destinação estruturada que a comprove."
      : attendance.state === "cancelada" ? "Necessidade encerrada pela organização." : `${fmt(attendance.attended)} atendidos de ${fmt(attendance.requested)} (${attendance.percent}%)`,
  });

  // registros para prestação de contas (documental) — NÃO é homologação
  if (!access.report) steps.push({ key: "prestacao", label: "Registros para prestação de contas", state: "restrita", detail: "O seu papel não consulta a prestação de contas." });
  else if (counts.receipts === 0 && counts.destinations === 0) steps.push({ key: "prestacao", label: "Registros para prestação de contas", state: "sem_dados", detail: "Ainda não há recebimento nem destinação para prestar contas." });
  else {
    const missing = args.destinationsWithoutProof;
    steps.push({
      key: "prestacao", label: "Registros para prestação de contas",
      state: missing === null || missing === undefined ? "em_andamento" : missing > 0 ? "em_andamento" : "concluida",
      detail: missing === null || missing === undefined ? `${counts.receipts} recebimento(s) e ${counts.destinations} destinação(ões) registrados; veja a prestação de contas.`
        : missing > 0 ? `${missing} destinação(ões) sem comprovante anexado. Isto não é homologação.` : "Todas as destinações têm comprovante anexado. Isto não é homologação.",
    });
  }

  // próxima ação: só decorre de estado persistido
  let next: string | null = null;
  if (closed) next = null;
  else if (awaiting > 0) next = "Há destinação aguardando a segunda aprovação de outra pessoa (Aprovações); o estoque só baixa depois dela.";
  else if (al.proposta) next = "Há atribuição proposta aguardando decisão da organização (Atribuições).";
  else if (active.length > 0 && counts.receipts === 0) next = "Acompanhe a logística e registre o recebimento quando ele ocorrer (Atribuições).";
  else if (counts.receipts > 0 && counts.destinations === 0) next = "Há recebimento sem destinação: registre a destinação do estoque (Destinação).";
  else if (counts.destinations > 0 && attendance.remaining > 0) next = `Faltam ${fmt(attendance.remaining)} para o atendimento final.`;
  else if (counts.receipts === 0 && counts.destinations === 0 && !active.length) next = mstate === "executado_sem_correspondencia" ? "O matching da rede foi executado e não encontrou correspondência válida; aguarde novas ofertas, uma oferta local vinculada ou uma atribuição manual feita pela administração da plataforma." : "Aguardando correspondência da rede ou uma oferta local vinculada.";
  return { steps, next };
}

export interface NeedRow { id: number; title: string; priority: string; status: NeedStatus; unit: string; quantityNeeded: string | number; createdAt: Date; correlationId: string | null }

/**
 * Origem da atribuição, SÓ a partir do persistido: com avaliação do motor ligada à atribuição = matching; automática sem avaliação no histórico = não verificável (nunca se afirma que o algoritmo rodou);
 * criada por uma pessoa autorizada (auto_matched = false e sem avaliação) = manual. Registros antigos não são reescritos.
 */
export const ORIGIN_SQL = sql`(CASE WHEN EXISTS (SELECT 1 FROM match_evaluations me WHERE me.allocation_id = a.id) THEN 'matching' WHEN a.auto_matched THEN 'nao_verificavel' ELSE 'manual' END)`;

/** Etapas, medidores e próxima ação das necessidades de UMA página (consultas em lote; só leitura). */
export async function hydrateNeedItems(organizationId: number, page: NeedRow[], access: JourneyAccess): Promise<JourneyListItem[]> {
  const ids = page.map((r) => r.id);
  if (ids.length === 0) return [];
  const [balances, attendance] = await Promise.all([getNeedFulfillmentBalanceBatch(db, ids), getNeedAttendanceBatch(db, ids)]);
  const receipts = await sql<{ needId: number; n: string }>`SELECT need_id, count(*)::text AS n FROM need_fulfillments WHERE organization_id = ${organizationId} AND need_id IN (${sql.join(ids)}) AND entry_type = 'original' GROUP BY need_id`.execute(db);
  const receiptCount = new Map(receipts.rows.map((r) => [r.needId, Number(r.n)]));

  const matchingByNeed = new Map<number, MatchingSummary>();
  const emptyMatching = (): MatchingSummary => ({ runs: 0, runsNoRelation: 0, evalValid: 0, evalNoQuantity: 0, evalDiscarded: 0, lastAt: null, lastOrigin: null });
  let evalCount = new Map<number, number>(); const allocByNeed = new Map<number, Record<string, number>>(); const originsByNeed = new Map<number, { matching: number; manual: number; naoVerificavel: number }>(); let offers = new Map<number, number>();
  if (access.network) {
    const ev = await sql<{ needId: number; decision: string; n: string }>`SELECT need_id, decision, count(*)::text AS n FROM match_evaluations WHERE organization_id = ${organizationId} AND need_id IN (${sql.join(ids)}) GROUP BY need_id, decision`.execute(db);
    for (const r of ev.rows) {
      evalCount.set(r.needId, (evalCount.get(r.needId) ?? 0) + Number(r.n));
      const m = matchingByNeed.get(r.needId) ?? emptyMatching();
      if (r.decision === "atribuido_automatico" || r.decision === "proposto") m.evalValid += Number(r.n); else if (r.decision === "elegivel_sem_quantidade") m.evalNoQuantity += Number(r.n); else if (r.decision === "descartado") m.evalDiscarded += Number(r.n);
      matchingByNeed.set(r.needId, m);
    }
    const runs = await sql<{ needId: number; runs: string; noRelation: string; lastAt: Date | null; lastOrigin: string | null }>`
      SELECT rn.need_id, count(*)::text AS runs, count(*) FILTER (WHERE rn.relation = 'sem_relacao')::text AS no_relation, max(r.finished_at) AS last_at, (array_agg(r.origin ORDER BY r.id DESC))[1] AS last_origin
        FROM matching_run_needs rn JOIN matching_runs r ON r.id = rn.run_id
       WHERE rn.organization_id = ${organizationId} AND rn.need_id IN (${sql.join(ids)}) AND r.status <> 'falhou' GROUP BY rn.need_id`.execute(db);
    for (const r of runs.rows) { const m = matchingByNeed.get(r.needId) ?? emptyMatching(); m.runs = Number(r.runs); m.runsNoRelation = Number(r.noRelation); m.lastAt = r.lastAt ? new Date(r.lastAt).toISOString() : null; m.lastOrigin = r.lastOrigin; matchingByNeed.set(r.needId, m); }
    const al = await sql<{ needId: number; status: string; origin: string; n: string }>`
      SELECT COALESCE(a.need_id, (SELECT m.need_id FROM match_evaluations m WHERE m.allocation_id = a.id ORDER BY m.id LIMIT 1)) AS need_id, a.status::text AS status,
             ${ORIGIN_SQL} AS origin, count(*)::text AS n
        FROM opportunity_allocations a WHERE a.organization_id = ${organizationId} GROUP BY 1, 2, 3`.execute(db);
    for (const r of al.rows) {
      if (r.needId === null || !ids.includes(r.needId)) continue;
      const m = allocByNeed.get(r.needId) ?? {}; m[r.status] = (m[r.status] ?? 0) + Number(r.n); allocByNeed.set(r.needId, m);
      const o = originsByNeed.get(r.needId) ?? { matching: 0, manual: 0, naoVerificavel: 0 };
      if (r.origin === "matching") o.matching += Number(r.n); else if (r.origin === "manual") o.manual += Number(r.n); else o.naoVerificavel += Number(r.n);
      originsByNeed.set(r.needId, o);
    }
  }
  if (access.opportunities) {
    const lo = await sql<{ needId: number; n: string }>`SELECT linked_need_id AS need_id, count(*)::text AS n FROM donation_opportunities WHERE organization_id = ${organizationId} AND linked_need_id IN (${sql.join(ids)}) GROUP BY linked_need_id`.execute(db);
    offers = new Map(lo.rows.map((r) => [r.needId, Number(r.n)]));
  }

  return page.map((r) => {
    const quantityNeeded = Number(r.quantityNeeded);
    const supply = computeNeedProgress(quantityNeeded, balances.get(r.id) ?? 0);
    const att = computeAttendanceProgress(quantityNeeded, attendance.get(r.id) ?? { physicalNet: 0, appliedNet: 0, surplusNet: 0, unitIncompatiblePhysical: 0, destinationCount: 0 }, r.status);
    const counts: JourneyCounts = {
      evaluations: access.network ? evalCount.get(r.id) ?? 0 : null,
      allocations: access.network ? allocByNeed.get(r.id) ?? {} : null,
      receipts: receiptCount.get(r.id) ?? 0,
      destinations: attendance.get(r.id)?.destinationCount ?? 0,
      localOffers: access.opportunities ? offers.get(r.id) ?? 0 : null,
      allocationOrigins: access.network ? originsByNeed.get(r.id) ?? { matching: 0, manual: 0, naoVerificavel: 0 } : null,
      matching: access.network ? matchingByNeed.get(r.id) ?? emptyMatching() : null,
    };
    const { steps, next } = deriveSteps({ status: r.status, quantityNeeded, unit: r.unit, supply, attendance: att, counts, access, destinationsWithoutProof: null });
    return { kind: "necessidade" as const, needId: r.id, title: r.title, priority: r.priority, status: r.status, unit: r.unit, quantityNeeded, createdAt: r.createdAt.toISOString(), supply, attendance: att, counts, steps, next, hasCorrelation: r.correlationId !== null };
  });
}
