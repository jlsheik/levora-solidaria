import { sql } from "kysely";
import { db } from "./db.js";
import { listDestinationHistory, REVERSAL_KIND_LABELS, type DestinationView } from "./destinationCorrections.js";
import { DESTINATION_APPROVAL_ACTION } from "./stockExit.js";
import { allocationStatusLabel, deriveSteps, type JourneyAccess, type JourneyListItem, hydrateNeedItems, ORIGIN_SQL, deriveMatchingState, MATCH_ORIGIN_LABEL, type MatchingState } from "./journey.js";

/**
 * M40 — detalhe da jornada de UMA necessidade: linha do tempo com fatos persistidos (cada evento vem de uma linha de tabela; nada é inferido nem preenchido). Somente leitura, sempre
 * filtrado pela organização da requisição. Ver o comentário de `journey.tsx` para o modelo (a necessidade é o eixo; suprimento ≠ atendimento; nada comprova entrega física).
 */

export type TimelineKind = "necessidade" | "oferta_local" | "correspondencia" | "atribuicao" | "logistica" | "recebimento" | "destinacao" | "encerramento";
export interface TimelineEvent { at: string; kind: TimelineKind; title: string; detail: string | null; actor: string | null; ref: { type: string; id: string } | null }

export interface JourneyEvaluation {
  id: string; createdAt: string; decision: string; finalScore: number; algorithmVersion: string; allocationId: number | null;
  /**
   * A oferta SÓ é identificada quando foi atribuída a esta organização (`allocationId`). Oferta avaliada e não atribuída pertence ao Registro Central (plataforma): a organização vê que houve
   * avaliação, a decisão e a pontuação, mas não o título, a categoria, a quantidade nem o texto dos critérios (que carrega atributos da oferta). M42: corrige a exposição introduzida na M40.
   */
  opportunity: { id: number; title: string; category: string | null; quantity: number | null; unit: string | null } | null;
  /** Critérios exatamente como gravados pelo motor. `score: null` = critério não aplicável/incompatível — nunca é trocado por um número. `detail: null` = texto reservado à plataforma (oferta não atribuída). */
  criteria: Array<{ key: string; score: number | null; weight: number; detail: string | null }>;
  notApplicable: string[];
}
export interface JourneyAllocation {
  id: number; status: string; quantityAllocated: number; autoMatched: boolean;
  /** M41 — origem persistida: `matching` (há avaliação do motor ligada), `manual` (pessoa autorizada, sem avaliação) ou `nao_verificavel` (automática sem avaliação no histórico). */
  origin: "matching" | "manual" | "nao_verificavel"; evaluationId: string | null; createdAt: string; responseDueAt: string | null; reservedUntil: string | null; closedAt: string | null; closedReason: string | null;
  decidedByName: string | null; opportunity: { id: number; title: string; unit: string | null };
  logistics: Array<{ id: string; eventType: string; scheduledFor: string | null; occurredAt: string; actorName: string | null }>;
}
export interface JourneyReceipt { id: string; allocationId: number; entryType: string; quantity: number; unit: string; isCountable: boolean; unitMismatchNote: string | null; stockTransactionId: string | null; createdAt: string; createdByName: string | null }

export interface JourneyDetail extends Omit<JourneyListItem, "hasCorrelation"> {
  description: string | null;
  itemName: string | null;
  closure: { reasonCode: string | null; closedAt: string } | null;
  evaluations: JourneyEvaluation[] | null;
  /** M42: estado e histórico das execuções do matching que consideraram a necessidade (null = papel sem acesso à rede). */
  matching: MatchingSection | null;
  allocations: JourneyAllocation[] | null;
  receipts: JourneyReceipt[];
  destinations: DestinationView[] | null;
  /** Saídas de destinação aguardando a segunda aprovação (null = papel sem acesso ao estoque). Nada saiu do estoque. */
  pendingApprovals: Array<{ id: number; quantity: number; unit: string | null; requestedAt: string }> | null;
  localOffers: Array<{ id: number; title: string; status: string; quantityOffered: number | null; unit: string | null; createdAt: string }> | null;
  timeline: TimelineEvent[];
  pendings: string[];
  audit: { correlationId: string | null; entries: number | null; path: string | null; note: string } | null;
  access: JourneyAccess;
  notes: string[];
}

const DECISION_LABEL: Record<string, string> = { atribuido_automatico: "atribuição automática (alta confiança)", proposto: "proposta enviada para decisão humana", descartado: "descartada (pontuação abaixo do limiar de proposta)", elegivel_sem_quantidade: "elegível, mas a oferta já estava toda distribuída" };

export interface MatchingRunView {
  id: string; origin: string; originLabel: string; finishedAt: string | null; repeatCount: number; lastRepeatedAt: string | null;
  /** O que o motor registrou PARA ESTA necessidade nesta execução (sem identificar a oferta). */
  outcome: "com_correspondencia" | "elegivel_sem_quantidade" | "avaliada_descartada" | "sem_relacao" | "avaliada_sem_registro";
}
export interface MatchingSection { state: MatchingState; runs: MatchingRunView[]; note: string }
const q = (n: number, unit: string | null) => `${n.toLocaleString("pt-BR")}${unit ? ` ${unit}` : ""}`;

export async function getJourneyDetail(organizationId: number, needId: number, access: JourneyAccess, viewer: { userId: number; canManage: boolean }): Promise<JourneyDetail | null> {
  const n = await db.selectFrom("needs as n").innerJoin("users as u", "u.id", "n.createdByUserId").leftJoin("inventoryItems as i", "i.id", "n.itemId")
    .select(["n.id", "n.title", "n.description", "n.priority", "n.status", "n.unit", "n.quantityNeeded", "n.createdAt", "n.correlationId", "u.displayName as createdBy", "i.name as itemName"])
    .where("n.id", "=", needId).where("n.organizationId", "=", organizationId).executeTakeFirst();
  if (!n) return null;

  const list = (await hydrateNeedItems(organizationId, [{ id: n.id, title: n.title, priority: n.priority, status: n.status, unit: n.unit, quantityNeeded: n.quantityNeeded, createdAt: n.createdAt, correlationId: n.correlationId }], access))[0];
  const timeline: TimelineEvent[] = [{ at: n.createdAt.toISOString(), kind: "necessidade", title: `Necessidade registrada: ${n.title}`, detail: `${q(Number(n.quantityNeeded), n.unit)} · prioridade ${n.priority}`, actor: n.createdBy, ref: { type: "need", id: String(n.id) } }];

  const allClosures = await db.selectFrom("needClosures as c").innerJoin("users as u", "u.id", "c.createdByUserId").select(["c.id", "c.entryType", "c.reasonCode", "c.createdAt", "u.displayName"])
    .where("c.needId", "=", needId).where("c.organizationId", "=", organizationId).orderBy("c.id", "asc").execute();
  for (const c of allClosures) timeline.push({ at: c.createdAt.toISOString(), kind: "encerramento", title: c.entryType === "encerramento" ? "Necessidade encerrada pela organização" : "Necessidade reaberta", detail: c.reasonCode, actor: c.displayName, ref: { type: "need_closure", id: String(c.id) } });
  const lastClose = [...allClosures].reverse().find((c) => c.entryType === "encerramento");
  const closure = n.status === "cancelada" && lastClose ? { reasonCode: lastClose.reasonCode, closedAt: lastClose.createdAt.toISOString() } : null;

  // ---- rede: correspondência, atribuição, logística
  let evaluations: JourneyEvaluation[] | null = null; let allocations: JourneyAllocation[] | null = null; let matching: MatchingSection | null = null;
  if (access.network) {
    const ev = await db.selectFrom("matchEvaluations as m").innerJoin("opportunityRegistry as r", "r.id", "m.opportunityRegistryId")
      .select(["m.id", "m.createdAt", "m.decision", "m.finalScore", "m.algorithmVersion", "m.allocationId", "m.criteria", "r.id as oppId", "r.title as oppTitle", "r.category", "r.quantity", "r.unit"])
      .where("m.organizationId", "=", organizationId).where("m.needId", "=", needId).orderBy("m.id", "asc").limit(50).execute();
    evaluations = ev.map((r) => {
      const raw = (r.criteria ?? {}) as Record<string, { score: number | null; weight: number; detail: string }>;
      // o Kysely devolve as chaves de JSON em camelCase; a jornada expõe os NOMES CANÔNICOS gravados pelo motor (snake_case), que a interface sabe rotular
      const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      const identified = r.allocationId !== null; // só a oferta atribuída a esta organização é dela para ver
      const criteria = Object.entries(raw).map(([key, c]) => ({ key: snake(key), score: c.score ?? null, weight: Number(c.weight), detail: identified ? String(c.detail ?? "") : null })).sort((a, b) => b.weight - a.weight);
      return {
        id: String(r.id), createdAt: r.createdAt.toISOString(), decision: r.decision, finalScore: Number(r.finalScore), algorithmVersion: r.algorithmVersion, allocationId: r.allocationId,
        opportunity: identified ? { id: r.oppId, title: r.oppTitle, category: r.category, quantity: r.quantity === null ? null : Number(r.quantity), unit: r.unit } : null, criteria, notApplicable: criteria.filter((c) => c.score === null).map((c) => c.key),
      };
    });
    for (const e of evaluations) timeline.push({ at: e.createdAt, kind: "correspondencia", title: `Correspondência com ${e.opportunity ? `a oferta "${e.opportunity.title}"` : "uma oferta da rede não atribuída a esta organização"}: ${DECISION_LABEL[e.decision] ?? e.decision}`, detail: `pontuação ${e.finalScore} · algoritmo ${e.algorithmVersion}`, actor: null, ref: { type: "match_evaluation", id: e.id } });

    // M42 — execuções do matching que CONSIDERARAM a necessidade (inclusive as sem resultado). Não identifica a oferta nem expõe contagens da plataforma: só o que o motor registrou para ESTA necessidade.
    const mr = await sql<{ id: string; origin: string; finishedAt: Date | null; repeatCount: number; lastRepeatedAt: Date | null; relation: string; decisions: string[] | null }>`
      SELECT r.id::text AS id, r.origin, r.finished_at, r.repeat_count, r.last_repeated_at, rn.relation,
             (SELECT array_agg(DISTINCT me.decision) FROM match_evaluations me WHERE me.matching_run_id = r.id AND me.need_id = rn.need_id) AS decisions
        FROM matching_run_needs rn JOIN matching_runs r ON r.id = rn.run_id
       WHERE rn.organization_id = ${organizationId} AND rn.need_id = ${needId} AND r.status <> 'falhou' ORDER BY r.id DESC LIMIT 30`.execute(db);
    const runs: MatchingRunView[] = mr.rows.map((r) => {
      const d = r.decisions ?? [];
      const outcome: MatchingRunView["outcome"] = d.includes("atribuido_automatico") || d.includes("proposto") ? "com_correspondencia" : d.includes("elegivel_sem_quantidade") ? "elegivel_sem_quantidade" : d.includes("descartado") ? "avaliada_descartada" : r.relation === "sem_relacao" ? "sem_relacao" : "avaliada_sem_registro";
      return { id: r.id, origin: r.origin, originLabel: MATCH_ORIGIN_LABEL[r.origin] ?? r.origin, finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null, repeatCount: r.repeatCount, lastRepeatedAt: r.lastRepeatedAt ? new Date(r.lastRepeatedAt).toISOString() : null, outcome };
    });
    for (const r of runs) if (r.finishedAt) timeline.push({ at: r.finishedAt, kind: "correspondencia", title: `Matching executado (${r.originLabel}): ${r.outcome === "com_correspondencia" ? "houve correspondência válida" : r.outcome === "sem_relacao" ? "nenhuma oferta relacionada a esta necessidade" : r.outcome === "avaliada_descartada" ? "avaliada, sem correspondência válida" : r.outcome === "elegivel_sem_quantidade" ? "elegível, sem quantidade livre na oferta" : "avaliada, sem registro da avaliação"}`, detail: r.repeatCount > 0 ? `reconfirmado ${r.repeatCount} vez(es) pela varredura${r.lastRepeatedAt ? `, a última em ${r.lastRepeatedAt}` : ""}` : null, actor: null, ref: { type: "matching_run", id: r.id } });
    const mstate = deriveMatchingState(list.counts, true);
    matching = { state: mstate, runs, note: "Execuções do matching anteriores ao histórico (M42) não deixaram registro por necessidade; a ausência de execução registrada não prova que o matching nunca rodou antes." };

    const al = await sql<{ id: number; status: string; qty: string; auto: boolean; origin: string; evaluationId: string | null; createdAt: Date; due: Date | null; reserved: Date | null; closedAt: Date | null; closedReason: string | null; decidedBy: string | null; oppId: number; oppTitle: string; unit: string | null }>`
      SELECT a.id, a.status::text AS status, a.quantity_allocated::text AS qty, a.auto_matched AS auto, ${ORIGIN_SQL} AS origin, (SELECT me.id::text FROM match_evaluations me WHERE me.allocation_id = a.id ORDER BY me.id LIMIT 1) AS evaluation_id, a.created_at, a.response_due_at AS due, a.reserved_until AS reserved, a.closed_at, a.closed_reason, u.display_name AS decided_by,
             r.id AS opp_id, r.title AS opp_title, r.unit
        FROM opportunity_allocations a JOIN opportunity_registry r ON r.id = a.opportunity_registry_id LEFT JOIN users u ON u.id = a.decided_by_user_id
       WHERE a.organization_id = ${organizationId}
         AND COALESCE(a.need_id, (SELECT m.need_id FROM match_evaluations m WHERE m.allocation_id = a.id ORDER BY m.id LIMIT 1)) = ${needId}
       ORDER BY a.id ASC LIMIT 50`.execute(db);
    const ids = al.rows.map((r) => r.id);
    const lg = ids.length ? await db.selectFrom("logisticsEvents as l").leftJoin("users as u", "u.id", "l.actorUserId").select(["l.id", "l.opportunityAllocationId", "l.eventType", "l.scheduledFor", "l.occurredAt", "u.displayName"]).where("l.organizationId", "=", organizationId).where("l.opportunityAllocationId", "in", ids).orderBy("l.id", "asc").execute() : [];
    allocations = al.rows.map((r) => ({
      id: r.id, status: r.status, quantityAllocated: Number(r.qty), autoMatched: r.auto, origin: (r.origin === "matching" || r.origin === "manual" ? r.origin : "nao_verificavel") as JourneyAllocation["origin"], evaluationId: r.evaluationId, createdAt: new Date(r.createdAt).toISOString(), responseDueAt: r.due ? new Date(r.due).toISOString() : null, reservedUntil: r.reserved ? new Date(r.reserved).toISOString() : null,
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null, closedReason: r.closedReason, decidedByName: r.decidedBy, opportunity: { id: r.oppId, title: r.oppTitle, unit: r.unit },
      logistics: lg.filter((l) => l.opportunityAllocationId === r.id).map((l) => ({ id: String(l.id), eventType: l.eventType, scheduledFor: l.scheduledFor ? l.scheduledFor.toISOString() : null, occurredAt: l.occurredAt.toISOString(), actorName: l.displayName })),
    }));
    for (const a of allocations) {
      timeline.push({ at: a.createdAt, kind: "atribuicao", title: `Atribuição #${a.id} (${a.origin === "matching" ? `por matching, avaliação #${a.evaluationId}` : a.origin === "manual" ? "manual, sem avaliação de matching" : "automática sem avaliação no histórico"}): ${q(a.quantityAllocated, a.opportunity.unit)} — situação atual: ${allocationStatusLabel(a.status)}`, detail: `oferta "${a.opportunity.title}"${a.closedReason ? ` · encerrada: ${a.closedReason}` : ""}`, actor: a.decidedByName, ref: { type: "opportunity_allocation", id: String(a.id) } });
      for (const l of a.logistics) timeline.push({ at: l.occurredAt, kind: "logistica", title: `Atribuição #${a.id}: ${l.eventType.replace(/_/g, " ")}`, detail: l.scheduledFor ? `agendado para ${l.scheduledFor}` : null, actor: l.actorName, ref: { type: "logistics_event", id: l.id } });
    }
  }

  // ---- recebimentos (ledger do suprimento)
  const rc = await db.selectFrom("needFulfillments as f").leftJoin("users as u", "u.id", "f.createdByUserId")
    .select(["f.id", "f.allocationId", "f.entryType", "f.quantity", "f.unit", "f.isCountable", "f.unitMismatchNote", "f.stockTransactionId", "f.createdAt", "u.displayName"])
    .where("f.organizationId", "=", organizationId).where("f.needId", "=", needId).orderBy("f.id", "asc").limit(100).execute();
  const receipts: JourneyReceipt[] = rc.map((r) => ({ id: String(r.id), allocationId: r.allocationId, entryType: r.entryType, quantity: Number(r.quantity), unit: r.unit, isCountable: r.isCountable, unitMismatchNote: r.unitMismatchNote, stockTransactionId: r.stockTransactionId === null ? null : String(r.stockTransactionId), createdAt: r.createdAt.toISOString(), createdByName: r.displayName }));
  for (const r of receipts) timeline.push({ at: r.createdAt, kind: "recebimento", title: `${r.entryType === "original" ? "Recebimento" : r.entryType === "correction" ? "Correção de recebimento" : "Estorno de recebimento"} da atribuição #${r.allocationId}: ${q(r.quantity, r.unit)}`, detail: r.isCountable ? null : "não contabilizável para a necessidade (unidade incompatível)", actor: r.createdByName, ref: { type: "need_fulfillment", id: r.id } });

  // ---- destinações (ledger do atendimento final) — mesma regra de leitura do histórico de destinações
  let destinations: DestinationView[] | null = null;
  if (access.stock) {
    destinations = (await listDestinationHistory(db, organizationId, { needId, limit: 50 }, viewer)).destinations;
    for (const d of destinations) {
      timeline.push({ at: d.createdAt, kind: "destinacao", title: `Destinação #${d.id}: ${q(d.quantity, d.unit)} de ${d.itemName} (${d.destinationType.replace(/_/g, " ")})`, detail: `situação: ${d.state.replace(/_/g, " ")}${d.proof ? " · comprovante anexado" : " · sem comprovante"}`, actor: d.createdByDisplayName, ref: { type: "stock_destination", id: d.id } });
      for (const e of d.events) timeline.push({ at: e.createdAt, kind: "destinacao", title: `Destinação #${d.id}: ${e.entryType === "reversal" && e.reversalKind ? REVERSAL_KIND_LABELS[e.reversalKind].label : e.proof ? `comprovante ${e.proof.action}` : "correção documental"}`, detail: e.quantity !== null ? q(e.quantity, d.unit) : null, actor: e.createdByDisplayName, ref: { type: "stock_destination", id: d.id } });
    }
  }

  // ---- ofertas locais vinculadas
  let localOffers: JourneyDetail["localOffers"] = null;
  if (access.opportunities) {
    const lo = await db.selectFrom("donationOpportunities").select(["id", "title", "status", "quantityOffered", "unit", "createdAt"]).where("organizationId", "=", organizationId).where("linkedNeedId", "=", needId).orderBy("id", "asc").limit(50).execute();
    localOffers = lo.map((o) => ({ id: o.id, title: o.title, status: o.status, quantityOffered: o.quantityOffered === null ? null : Number(o.quantityOffered), unit: o.unit, createdAt: o.createdAt.toISOString() }));
    for (const o of localOffers) timeline.push({ at: o.createdAt, kind: "oferta_local", title: `Oferta local vinculada: ${o.title} (${o.status})`, detail: o.quantityOffered !== null ? q(o.quantityOffered, o.unit) : "quantidade não informada", actor: null, ref: { type: "donation_opportunity", id: String(o.id) } });
  }

  let pendingApprovals: JourneyDetail["pendingApprovals"] = null;
  if (access.stock) {
    const ap = await sql<{ id: number; quantity: string | null; unit: string | null; createdAt: Date }>`
      SELECT a.id, a.payload -> 'input' ->> 'quantity' AS quantity, (SELECT i.unit FROM inventory_items i WHERE i.id = (a.payload -> 'input' ->> 'itemId')::int AND i.organization_id = ${organizationId}) AS unit, a.created_at
        FROM approval_requests a WHERE a.organization_id = ${organizationId} AND a.action_type = ${DESTINATION_APPROVAL_ACTION} AND a.status = 'pendente' AND a.payload -> 'input' ->> 'needId' = ${String(needId)}
       ORDER BY a.id ASC LIMIT 20`.execute(db);
    pendingApprovals = ap.rows.map((r) => ({ id: r.id, quantity: Number(r.quantity ?? 0), unit: r.unit, requestedAt: new Date(r.createdAt).toISOString() }));
    for (const p of pendingApprovals) timeline.push({ at: p.requestedAt, kind: "destinacao", title: `Saída de destinação de ${q(p.quantity, p.unit)} aguardando a segunda aprovação (pedido #${p.id})`, detail: "o estoque só baixa depois da aprovação de outra pessoa", actor: null, ref: { type: "approval_request", id: String(p.id) } });
  }

  const withoutProof = destinations ? destinations.filter((d) => d.state !== "revertida" && d.proof === null).length : null;
  const { steps, next } = deriveSteps({ status: n.status, quantityNeeded: Number(n.quantityNeeded), unit: n.unit, supply: list.supply, attendance: list.attendance, counts: list.counts, access, destinationsWithoutProof: withoutProof, pendingApprovals: pendingApprovals?.length ?? 0 });

  const pendings: string[] = [];
  for (const a of allocations ?? []) if (a.status === "proposta") pendings.push(`Atribuição #${a.id} está proposta e aguarda decisão da organização${a.responseDueAt ? ` até ${a.responseDueAt}` : ""}.`);
  for (const p of pendingApprovals ?? []) pendings.push(`Saída de ${q(p.quantity, p.unit)} para esta necessidade aguarda a segunda aprovação (pedido #${p.id}); o estoque ainda não baixou.`);
  if (list.counts.receipts > 0 && list.counts.destinations === 0 && (pendingApprovals?.length ?? 0) === 0) pendings.push("Há recebimento registrado, mas nenhuma destinação do estoque para esta necessidade.");
  if (withoutProof) pendings.push(`${withoutProof} destinação(ões) sem comprovante anexado.`);
  if (n.status !== "cancelada" && list.attendance.remaining > 0 && list.counts.destinations > 0) pendings.push(`Faltam ${q(list.attendance.remaining, n.unit)} para o atendimento final.`);
  if (list.attendance.unitIncompatibleDestined > 0) pendings.push(`${q(list.attendance.unitIncompatibleDestined, null)} destinado(s) com unidade incompatível não contam para o atendimento.`);
  if (list.attendance.state === "atendida_historica") pendings.push("A necessidade consta como atendida por uma versão anterior, sem destinação estruturada que a comprove.");

  let audit: JourneyDetail["audit"] = null;
  if (access.audit) {
    if (n.correlationId) {
      const c = await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).where("correlationId", "=", n.correlationId).executeTakeFirstOrThrow();
      audit = { correlationId: n.correlationId, entries: Number(c.n), path: `/organizacoes/${organizationId}/auditoria?correlacao=${n.correlationId}`, note: "Registros de auditoria desta jornada, ligados pela correlação persistida gerada no cadastro da necessidade." };
    } else audit = { correlationId: null, entries: null, path: null, note: "Esta necessidade é anterior à correlação da jornada: nenhuma correlação foi fabricada; consulte a Central de Auditoria pelos recursos." };
  }

  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return {
    kind: "necessidade", needId: n.id, title: n.title, priority: n.priority, status: n.status, unit: n.unit, quantityNeeded: Number(n.quantityNeeded), createdAt: n.createdAt.toISOString(), supply: list.supply, attendance: list.attendance, counts: list.counts, steps, next,
    description: n.description, itemName: n.itemName, closure, evaluations, matching, allocations, receipts, destinations, pendingApprovals, localOffers, timeline, pendings, audit, access,
    notes: [
      "Tudo aqui vem de registros do sistema. Nenhuma tela comprova entrega física: a prestação de contas depende dos comprovantes anexados pela organização.",
      "Recebido da rede (suprimento) e destinado (atendimento final) são contabilidades diferentes do domínio e não são somadas.",
      "A ordem do tempo mostra quando cada registro foi gravado; só os vínculos indicados (necessidade, atribuição, destinação) provam relação entre eles.",
    ],
  };
}
