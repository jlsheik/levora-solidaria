import { sql, type RawBuilder } from "kysely";
import { db } from "./db.js";
import { hydrateNeedItems, ORIGIN_SQL, allocationStatusLabel, type JourneyAccess, type JourneyListItem, type JourneyStep, type StepState } from "./journey.js";
import type { JourneyReceipt, TimelineEvent } from "./journeyDetail.js";

/**
 * M41 — a jornada deixa de ser só "por necessidade": além das necessidades, acompanha (SOMENTE LEITURA, sem contabilidade nova) as ofertas que NÃO têm necessidade vinculada:
 *   • `oferta_local`     — oferta registrada pela própria organização (donation_opportunities) sem `linked_need_id`;
 *   • `atribuicao_rede`  — atribuição de uma oferta do Registro Central a esta organização (opportunity_allocations) sem necessidade resolvida (nem `need_id` nem avaliação de matching com necessidade).
 * Oferta, oportunidade, atribuição, recebimento e destinação continuam conceitos distintos. Nada é preenchido para "completar" as sete etapas: o que não se aplica ou não existe é dito como tal.
 * O domínio NÃO tem operação de vincular uma oferta/atribuição a uma necessidade DEPOIS de criada (a necessidade só é informada na criação) — a jornada explica isso e aponta as ações que já existem;
 * a decisão de criar essa operação é de negócio e está registrada como pendente.
 */

export const JOURNEY_KINDS = ["necessidade", "oferta_local", "atribuicao_rede"] as const;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];
export const NEED_STATUS_VALUES = ["aberta", "atendida", "cancelada"] as const;
export const OFFER_STATUS_VALUES = ["registrada", "em_contato", "confirmada", "recebida", "cancelada"] as const;
export const ALLOCATION_STATUS_VALUES = ["proposta", "aceita", "recusada", "em_coleta", "em_transporte", "recebida", "cancelada"] as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const RANK: Record<JourneyKind, number> = { necessidade: 1, oferta_local: 2, atribuicao_rede: 3 };

export type OfferStepKey = "oferta" | "vinculo" | "correspondencia" | "atribuicao" | "recebimento" | "destinacao" | "prestacao";
export interface OfferStep { key: OfferStepKey; label: string; state: StepState; detail: string }

export interface OfferJourneyListItem {
  kind: "oferta_local" | "atribuicao_rede"; id: number; title: string; status: string; statusLabel: string; quantity: number | null; unit: string | null; createdAt: string;
  /** De onde a oferta surgiu, em palavras. */
  sourceLabel: string;
  /** Como a atribuição nasceu (matching × manual); null para oferta local. */
  originLabel: string | null;
  steps: OfferStep[]; next: string | null;
}
export type JourneyEntry = JourneyListItem | OfferJourneyListItem;

export const OFFER_STATUS_LABEL: Record<string, string> = { registrada: "Registrada", em_contato: "Em contato com o doador", confirmada: "Confirmada pelo doador", recebida: "Recebida", cancelada: "Cancelada" };
export const REGISTRY_STATUS_LABEL: Record<string, string> = {
  descoberta: "Descoberta", em_verificacao: "Em verificação", validada: "Validada", aguardando_destinacao: "Aguardando destinação", reservada: "Reservada", atribuida: "Atribuída", recebida: "Recebida", cancelada: "Cancelada", expirada: "Expirada",
};
const ORIGIN_LABEL: Record<string, string> = { matching: "Matching (avaliação do motor)", manual: "Atribuição manual", nao_verificavel: "Automática, sem avaliação no histórico" };

const GUIDE_LINK_REASON = "O sistema só permite informar a necessidade no momento em que a oferta (ou a atribuição) é criada. Ainda não existe uma operação para vincular depois — essa regra de negócio está pendente de decisão e nada foi criado no lugar dela.";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// etapas (funções puras, testadas)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function deriveLocalOfferSteps(a: { title: string; status: string; quantity: number | null; unit: string | null; access: Pick<JourneyAccess, "report">; received?: { quantity: number; unit: string | null } | null }): { steps: OfferStep[]; next: string | null } {
  const cancelled = a.status === "cancelada"; const received = a.status === "recebida";
  const qty = a.quantity !== null ? `${a.quantity.toLocaleString("pt-BR")}${a.unit ? ` ${a.unit}` : ""}` : "quantidade não informada";
  const steps: OfferStep[] = [
    { key: "oferta", label: "Oferta local registrada", state: "concluida", detail: `Situação: ${OFFER_STATUS_LABEL[a.status] ?? a.status} · ${qty}. Uma oferta registrada não é uma doação entregue.` },
    { key: "vinculo", label: "Vínculo com necessidade", state: cancelled ? "nao_se_aplica" : "pendente", detail: cancelled ? "Oferta cancelada." : "Nenhuma necessidade vinculada. O vínculo só pode ser informado ao registrar a oferta; o sistema ainda não permite vincular depois." },
    { key: "correspondencia", label: "Correspondência (matching)", state: "nao_se_aplica", detail: "O matching da rede avalia ofertas do Registro Central; ofertas locais não passam por ele." },
    { key: "recebimento", label: "Recebimento", state: received ? "concluida" : cancelled ? "nao_se_aplica" : "pendente",
      detail: received ? (a.received ? `Marcada como recebida; entrada de ${a.received.quantity.toLocaleString("pt-BR")}${a.received.unit ? ` ${a.received.unit}` : ""} no estoque.` : "Marcada como recebida.") : cancelled ? "Oferta cancelada." : "Ainda não foi marcada como recebida." },
    { key: "destinacao", label: "Destinação do estoque", state: "sem_dados", detail: "A destinação registra a saída do estoque por item e necessidade, não por oferta: não há como atribuir saídas a esta oferta." },
  ];
  steps.push(a.access.report ? { key: "prestacao", label: "Registros para prestação de contas", state: "sem_dados", detail: "Nenhum registro de prestação está ligado a esta oferta. Isto não é homologação." } : { key: "prestacao", label: "Registros para prestação de contas", state: "restrita", detail: "O seu papel não consulta a prestação de contas." });
  const next = cancelled ? null : received ? "Oferta recebida. Registre a destinação do estoque em Destinação, quando ocorrer." : "Acompanhe a oferta em Oportunidades até o recebimento ou o cancelamento.";
  return { steps, next };
}

export function deriveUnlinkedAllocationSteps(a: {
  title: string; sourceName: string | null; registryStatus: string; quantityAllocated: number; unit: string | null; status: string; origin: "matching" | "manual" | "nao_verificavel"; score: number | null; evaluationId: string | null;
  receivedQuantity: number | null; access: Pick<JourneyAccess, "report">;
}): { steps: OfferStep[]; next: string | null } {
  const qty = `${a.quantityAllocated.toLocaleString("pt-BR")}${a.unit ? ` ${a.unit}` : ""}`;
  const active = ["proposta", "aceita", "em_coleta", "em_transporte"].includes(a.status);
  const dead = a.status === "recusada" || a.status === "cancelada";
  const steps: OfferStep[] = [
    { key: "oferta", label: "Oferta da rede", state: "concluida", detail: `“${a.title}”${a.sourceName ? ` (fonte: ${a.sourceName})` : ""} · situação da oferta no registro: ${REGISTRY_STATUS_LABEL[a.registryStatus] ?? a.registryStatus}. Uma oferta atribuída não é uma doação entregue.` },
    { key: "vinculo", label: "Vínculo com necessidade", state: dead ? "nao_se_aplica" : "pendente", detail: dead ? "Atribuição encerrada." : "Atribuição sem necessidade: nenhuma necessidade foi informada quando ela foi criada, e o sistema ainda não permite vincular depois." },
  ];
  if (a.origin === "matching") steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "concluida", detail: `Avaliada pelo motor de matching${a.score !== null ? ` (pontuação ${a.score})` : ""}${a.evaluationId ? ` — avaliação #${a.evaluationId}` : ""}.` });
  else if (a.origin === "manual") steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "nao_se_aplica", detail: "Atribuição manual autorizada; nenhuma avaliação de matching foi executada." });
  else steps.push({ key: "correspondencia", label: "Correspondência (matching)", state: "sem_dados", detail: "Marcada como automática, mas sem avaliação no histórico — não é possível verificar o matching." });
  steps.push({ key: "atribuicao", label: "Atribuição à organização", state: a.status === "recebida" ? "concluida" : dead ? "nao_se_aplica" : "em_andamento", detail: `${qty} · ${allocationStatusLabel(a.status)}` });
  steps.push({ key: "recebimento", label: "Recebimento (suprimento)", state: a.receivedQuantity !== null ? "concluida" : dead ? "nao_se_aplica" : active ? "em_andamento" : "pendente", detail: a.receivedQuantity !== null ? `${a.receivedQuantity.toLocaleString("pt-BR")}${a.unit ? ` ${a.unit}` : ""} recebidos (ledger)` : dead ? "Atribuição encerrada." : "Ainda sem recebimento registrado." });
  steps.push({ key: "destinacao", label: "Destinação do estoque", state: "sem_dados", detail: "Sem necessidade vinculada, a destinação do estoque não é ligada a esta atribuição." });
  steps.push(a.access.report ? { key: "prestacao", label: "Registros para prestação de contas", state: "sem_dados", detail: "Nenhum registro de prestação está ligado a esta atribuição. Isto não é homologação." } : { key: "prestacao", label: "Registros para prestação de contas", state: "restrita", detail: "O seu papel não consulta a prestação de contas." });
  const next = dead ? null : a.status === "proposta" ? "Atribuição proposta aguardando decisão da organização (Atribuições)." : a.receivedQuantity === null ? "Acompanhe a logística e registre o recebimento quando ele ocorrer (Atribuições)." : "Recebido. Registre a destinação do estoque em Destinação, quando ocorrer.";
  return { steps, next };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// lista unificada (filtros, busca e paginação NO SERVIDOR; ordenação total e estável: criado em ↓, tipo ↑, id ↓)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface JourneyFilters { q?: string; tipo?: JourneyKind; vinculo?: "com_necessidade" | "sem_necessidade"; status?: string; limit: number; cursor?: string }

export const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[1-3]_\d{1,12}$/;
function decodeCursor(c: string): { at: string; rank: number; id: number } { const [at, rank, id] = c.split("_"); return { at, rank: Number(rank), id: Number(id) }; }
const escapeLike = (v: string) => `%${v.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/**
 * Busca SEM acento e sem diferença de caixa, sem extensão do banco (`unaccent` não existe no ambiente) e sem depender do locale: a MESMA tabela de troca é aplicada ao termo (aqui) e à coluna
 * (`translate` no SQL) e só depois se aplica `lower`. Os identificadores literais (#id, correlação) não passam por aqui. A expressão não usa índice; ela só roda sobre as linhas da organização
 * (o filtro por organização vem primeiro) e a página é limitada pelo servidor.
 */
const FOLD_FROM = "áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ";
const FOLD_TO = "aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN";
export const foldText = (t: string) => [...t].map((ch) => { const i = FOLD_FROM.indexOf(ch); return i >= 0 ? FOLD_TO[i] : ch; }).join("").toLowerCase();

export async function listJourneyPage(organizationId: number, access: JourneyAccess, f: JourneyFilters): Promise<{ items: JourneyEntry[]; nextCursor: string | null }> {
  const term = f.q?.trim() ? f.q.trim() : null;
  const like = term ? escapeLike(foldText(term)) : null;
  const idNum = term && /^#?\d{1,12}$/.test(term) ? Number(term.replace("#", "")) : null;
  const uuid = term && /^[0-9a-fA-F-]{36}$/.test(term) ? term.toLowerCase() : null;
  const kindsWanted = new Set<JourneyKind>(f.tipo ? [f.tipo] : JOURNEY_KINDS);
  if (f.vinculo === "com_necessidade") for (const k of ["oferta_local", "atribuicao_rede"] as const) kindsWanted.delete(k);
  if (f.vinculo === "sem_necessidade") kindsWanted.delete("necessidade");
  const statusOk = (set: readonly string[]) => !f.status || set.includes(f.status);

  const match = (frags: Array<RawBuilder<boolean>>) => (term ? sql` AND (${sql.join(frags, sql` OR `)})` : sql``);
  const branches: Array<RawBuilder<unknown>> = [];

  if (kindsWanted.has("necessidade") && statusOk(NEED_STATUS_VALUES)) {
    const frags: Array<RawBuilder<boolean>> = [sql<boolean>`lower(translate(n.title, ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`, sql<boolean>`lower(translate(COALESCE(n.description, ''), ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`];
    if (idNum !== null) frags.push(sql<boolean>`n.id = ${idNum}`);
    if (uuid) frags.push(sql<boolean>`n.correlation_id = ${uuid}`);
    // achar a necessidade pela oferta que ela recebe (só nas partes que o papel enxerga)
    if (access.opportunities) frags.push(sql<boolean>`EXISTS (SELECT 1 FROM donation_opportunities lo WHERE lo.organization_id = n.organization_id AND lo.linked_need_id = n.id AND (lower(translate(lo.title, ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like} OR lower(translate(lo.donor_name, ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}))`);
    if (access.network) frags.push(sql<boolean>`EXISTS (SELECT 1 FROM opportunity_allocations a JOIN opportunity_registry r ON r.id = a.opportunity_registry_id WHERE a.organization_id = n.organization_id AND lower(translate(r.title, ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}
      AND COALESCE(a.need_id, (SELECT m.need_id FROM match_evaluations m WHERE m.allocation_id = a.id ORDER BY m.id LIMIT 1)) = n.id)`);
    branches.push(sql`SELECT 'necessidade'::text AS kind, 1 AS rank, n.id::bigint AS id, n.created_at AS created_at FROM needs n WHERE n.organization_id = ${organizationId}${f.status ? sql` AND n.status::text = ${f.status}` : sql``}${match(frags)}`);
  }
  if (access.opportunities && kindsWanted.has("oferta_local") && statusOk(OFFER_STATUS_VALUES)) {
    const frags: Array<RawBuilder<boolean>> = [sql<boolean>`lower(translate(o.title, ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`, sql<boolean>`lower(translate(o.donor_name, ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`, sql<boolean>`lower(translate(COALESCE(o.description, ''), ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`, sql<boolean>`lower(translate(COALESCE(o.category, ''), ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`];
    if (idNum !== null) frags.push(sql<boolean>`o.id = ${idNum}`);
    if (uuid) frags.push(sql<boolean>`o.correlation_id = ${uuid}`);
    branches.push(sql`SELECT 'oferta_local'::text AS kind, 2 AS rank, o.id::bigint AS id, o.created_at AS created_at FROM donation_opportunities o WHERE o.organization_id = ${organizationId} AND o.linked_need_id IS NULL${f.status ? sql` AND o.status::text = ${f.status}` : sql``}${match(frags)}`);
  }
  if (access.network && kindsWanted.has("atribuicao_rede") && statusOk(ALLOCATION_STATUS_VALUES)) {
    const frags: Array<RawBuilder<boolean>> = [sql<boolean>`lower(translate(r.title, ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`, sql<boolean>`lower(translate(COALESCE(r.category, ''), ${FOLD_FROM}, ${FOLD_TO})) LIKE ${like}`];
    if (idNum !== null) frags.push(sql<boolean>`a.id = ${idNum}`);
    branches.push(sql`SELECT 'atribuicao_rede'::text AS kind, 3 AS rank, a.id::bigint AS id, a.created_at AS created_at FROM opportunity_allocations a JOIN opportunity_registry r ON r.id = a.opportunity_registry_id
      WHERE a.organization_id = ${organizationId} AND COALESCE(a.need_id, (SELECT m.need_id FROM match_evaluations m WHERE m.allocation_id = a.id ORDER BY m.id LIMIT 1)) IS NULL${f.status ? sql` AND a.status::text = ${f.status}` : sql``}${match(frags)}`);
  }
  if (branches.length === 0) return { items: [], nextCursor: null };

  const cur = f.cursor ? decodeCursor(f.cursor) : null;
  const cursorCond = cur ? sql`WHERE (created_at < ${cur.at}::timestamptz OR (created_at = ${cur.at}::timestamptz AND (rank > ${cur.rank} OR (rank = ${cur.rank} AND id < ${cur.id}))))` : sql``;
  const rows = await sql<{ kind: JourneyKind; id: string; createdText: string }>`
    SELECT kind, id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text
      FROM (${sql.join(branches, sql` UNION ALL `)}) u ${cursorCond}
     ORDER BY created_at DESC, rank ASC, id DESC LIMIT ${f.limit + 1}`.execute(db);
  const hasMore = rows.rows.length > f.limit;
  const page = rows.rows.slice(0, f.limit);
  const last = page[page.length - 1];

  const idsOf = (k: JourneyKind) => page.filter((r) => r.kind === k).map((r) => Number(r.id));
  const [needs, offers, allocs] = await Promise.all([hydrateNeeds(organizationId, idsOf("necessidade"), access), hydrateLocalOffers(organizationId, idsOf("oferta_local"), access), hydrateUnlinkedAllocations(organizationId, idsOf("atribuicao_rede"), access)]);
  const items: JourneyEntry[] = [];
  for (const r of page) { const it = r.kind === "necessidade" ? needs.get(Number(r.id)) : r.kind === "oferta_local" ? offers.get(Number(r.id)) : allocs.get(Number(r.id)); if (it) items.push(it); }
  return { items, nextCursor: hasMore && last ? `${last.createdText}_${RANK[last.kind]}_${last.id}` : null };
}

async function hydrateNeeds(organizationId: number, ids: number[], access: JourneyAccess): Promise<Map<number, JourneyListItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom("needs").select(["id", "title", "priority", "status", "unit", "quantityNeeded", "createdAt", "correlationId"]).where("organizationId", "=", organizationId).where("id", "in", ids).execute();
  const items = await hydrateNeedItems(organizationId, rows, access);
  return new Map(items.map((i) => [i.needId, i]));
}

async function receivedOfLocalOffers(organizationId: number, ids: number[]): Promise<Map<number, { quantity: number; unit: string | null }>> {
  const out = new Map<number, { quantity: number; unit: string | null }>();
  if (ids.length === 0) return out;
  // a doação local NÃO escreve no ledger da rede: a quantidade recebida está no registro de auditoria do recebimento (metadata gravada na mesma transação da entrada de estoque)
  const r = await sql<{ entityId: string; qty: string | null; unit: string | null }>`
    SELECT l.entity_id, l.metadata ->> 'quantityReceived' AS qty, (SELECT i.unit FROM inventory_items i WHERE i.id = (l.metadata ->> 'itemId')::int AND i.organization_id = ${organizationId}) AS unit
      FROM audit_log l WHERE l.organization_id = ${organizationId} AND l.action = 'oportunidade.recebida' AND l.entity_type = 'donation_opportunity' AND l.entity_id IN (${sql.join(ids.map(String))}) ORDER BY l.id ASC`.execute(db);
  for (const x of r.rows) if (x.qty !== null) out.set(Number(x.entityId), { quantity: Number(x.qty), unit: x.unit });
  return out;
}

async function hydrateLocalOffers(organizationId: number, ids: number[], access: JourneyAccess): Promise<Map<number, OfferJourneyListItem>> {
  const out = new Map<number, OfferJourneyListItem>();
  if (ids.length === 0 || !access.opportunities) return out;
  const rows = await db.selectFrom("donationOpportunities").select(["id", "title", "status", "quantityOffered", "unit", "createdAt"]).where("organizationId", "=", organizationId).where("linkedNeedId", "is", null).where("id", "in", ids).execute();
  const rec = access.stock ? await receivedOfLocalOffers(organizationId, rows.filter((r) => r.status === "recebida").map((r) => r.id)) : new Map();
  for (const r of rows) {
    const quantity = r.quantityOffered === null ? null : Number(r.quantityOffered);
    const { steps, next } = deriveLocalOfferSteps({ title: r.title, status: r.status, quantity, unit: r.unit, access, received: rec.get(r.id) ?? null });
    out.set(r.id, { kind: "oferta_local", id: r.id, title: r.title, status: r.status, statusLabel: OFFER_STATUS_LABEL[r.status] ?? r.status, quantity, unit: r.unit, createdAt: r.createdAt.toISOString(), sourceLabel: "Oferta registrada pela própria organização", originLabel: null, steps, next });
  }
  return out;
}

interface AllocRow { id: number; status: string; qty: string; createdAt: Date; title: string; unit: string | null; registryStatus: string; sourceName: string | null; origin: string; evaluationId: string | null; score: string | null }
async function loadUnlinkedAllocations(organizationId: number, ids: number[]): Promise<AllocRow[]> {
  if (ids.length === 0) return [];
  const r = await sql<AllocRow>`
    SELECT a.id, a.status::text AS status, a.quantity_allocated::text AS qty, a.created_at, r.title, r.unit, r.status::text AS registry_status, s.name AS source_name, ${ORIGIN_SQL} AS origin,
           (SELECT me.id::text FROM match_evaluations me WHERE me.allocation_id = a.id ORDER BY me.id LIMIT 1) AS evaluation_id, (SELECT me.final_score::text FROM match_evaluations me WHERE me.allocation_id = a.id ORDER BY me.id LIMIT 1) AS score
      FROM opportunity_allocations a JOIN opportunity_registry r ON r.id = a.opportunity_registry_id LEFT JOIN sources s ON s.id = r.source_id
     WHERE a.organization_id = ${organizationId} AND a.id IN (${sql.join(ids)})
       AND COALESCE(a.need_id, (SELECT m.need_id FROM match_evaluations m WHERE m.allocation_id = a.id ORDER BY m.id LIMIT 1)) IS NULL`.execute(db);
  return r.rows;
}
async function receivedOfAllocations(organizationId: number, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const r = await sql<{ allocationId: number; q: string }>`SELECT allocation_id, SUM(CASE WHEN entry_type = 'original' THEN quantity ELSE 0 END)::text AS q FROM need_fulfillments WHERE organization_id = ${organizationId} AND allocation_id IN (${sql.join(ids)}) GROUP BY allocation_id`.execute(db);
  for (const x of r.rows) if (Number(x.q) > 0) out.set(x.allocationId, Number(x.q));
  return out;
}

async function hydrateUnlinkedAllocations(organizationId: number, ids: number[], access: JourneyAccess): Promise<Map<number, OfferJourneyListItem>> {
  const out = new Map<number, OfferJourneyListItem>();
  if (ids.length === 0 || !access.network) return out;
  const rows = await loadUnlinkedAllocations(organizationId, ids);
  const rec = await receivedOfAllocations(organizationId, rows.map((r) => r.id));
  for (const r of rows) {
    const origin = (r.origin === "matching" || r.origin === "manual" ? r.origin : "nao_verificavel") as "matching" | "manual" | "nao_verificavel";
    const { steps, next } = deriveUnlinkedAllocationSteps({ title: r.title, sourceName: r.sourceName, registryStatus: r.registryStatus, quantityAllocated: Number(r.qty), unit: r.unit, status: r.status, origin, score: r.score === null ? null : Number(r.score), evaluationId: r.evaluationId, receivedQuantity: rec.get(r.id) ?? null, access });
    out.set(r.id, { kind: "atribuicao_rede", id: r.id, title: r.title, status: r.status, statusLabel: cap(allocationStatusLabel(r.status)), quantity: Number(r.qty), unit: r.unit, createdAt: r.createdAt.toISOString(), sourceLabel: `Oferta da rede (Registro Central)${r.sourceName ? ` · fonte ${r.sourceName}` : ""}`, originLabel: ORIGIN_LABEL[origin], steps, next });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// detalhe de uma oferta sem necessidade
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface OfferJourneyDetail extends OfferJourneyListItem {
  description: string | null; category: string | null; createdByName: string | null;
  /** Doador (só oferta local; o contato do doador não é exibido aqui). */
  donorName: string | null;
  /** Se a oferta local já está ligada a uma necessidade (não deveria estar nesta lista; ligação de leitura). */
  evaluation: { id: string; finalScore: number; decision: string; algorithmVersion: string; createdAt: string } | null;
  logistics: Array<{ id: string; eventType: string; scheduledFor: string | null; occurredAt: string; actorName: string | null }>;
  receipts: JourneyReceipt[];
  decidedByName: string | null;
  timeline: TimelineEvent[]; pendings: string[];
  linking: { available: false; reason: string; alternatives: Array<{ label: string; href: string }> };
  audit: { correlationId: string | null; entries: number | null; path: string | null; note: string } | null;
  access: JourneyAccess; notes: string[];
}

export async function getOfferJourneyDetail(organizationId: number, kind: "oferta_local" | "atribuicao_rede", id: number, access: JourneyAccess): Promise<OfferJourneyDetail | null> {
  const base = `/organizacoes/${organizationId}`;
  const notes = [
    "Tudo aqui vem de registros do sistema. Nenhuma tela comprova entrega física: a prestação de contas depende dos comprovantes anexados pela organização.",
    "Uma oferta sem necessidade vinculada ainda não tem matching, atribuição a uma necessidade, destinação ligada nem atendimento: essas etapas são ditas como pendentes ou não aplicáveis, não preenchidas.",
  ];
  const linking = { available: false as const, reason: GUIDE_LINK_REASON, alternatives: [] as Array<{ label: string; href: string }> };

  if (kind === "oferta_local") {
    if (!access.opportunities) return null;
    const o = await db.selectFrom("donationOpportunities as o").innerJoin("users as u", "u.id", "o.createdByUserId")
      .select(["o.id", "o.title", "o.description", "o.category", "o.quantityOffered", "o.unit", "o.donorName", "o.status", "o.createdAt", "o.correlationId", "u.displayName as createdBy", "o.version"])
      .where("o.id", "=", id).where("o.organizationId", "=", organizationId).where("o.linkedNeedId", "is", null).executeTakeFirst();
    if (!o) return null;
    const rec = access.stock && o.status === "recebida" ? (await receivedOfLocalOffers(organizationId, [o.id])).get(o.id) ?? null : null;
    const quantity = o.quantityOffered === null ? null : Number(o.quantityOffered);
    const { steps, next } = deriveLocalOfferSteps({ title: o.title, status: o.status, quantity, unit: o.unit, access, received: rec });
    const timeline: TimelineEvent[] = [{ at: o.createdAt.toISOString(), kind: "oferta_local", title: `Oferta local registrada: ${o.title}`, detail: quantity !== null ? `${quantity.toLocaleString("pt-BR")}${o.unit ? ` ${o.unit}` : ""} · doador ${o.donorName}` : `quantidade não informada · doador ${o.donorName}`, actor: o.createdBy, ref: { type: "donation_opportunity", id: String(o.id) } }];
    const ch = await sql<{ id: string; createdAt: Date; previous: string | null; next: string | null; actor: string | null; reason: string | null }>`
      SELECT c.id::text AS id, c.created_at, c.previous_value AS previous, c.new_value AS next, u.display_name AS actor, c.reason FROM opportunity_changes c JOIN users u ON u.id = c.changed_by_user_id
       WHERE c.opportunity_id = ${o.id} AND c.organization_id = ${organizationId} ORDER BY c.id ASC LIMIT 50`.execute(db);
    for (const c of ch.rows) timeline.push({ at: new Date(c.createdAt).toISOString(), kind: "oferta_local", title: `Categoria alterada: ${c.previous ?? "sem categoria"} → ${c.next ?? "sem categoria"}`, detail: c.reason, actor: c.actor, ref: { type: "opportunity_change", id: c.id } });
    if (o.status === "recebida") timeline.push({ at: o.createdAt.toISOString(), kind: "recebimento", title: "Oferta marcada como recebida", detail: rec ? `entrada de ${rec.quantity.toLocaleString("pt-BR")}${rec.unit ? ` ${rec.unit}` : ""} no estoque` : "a data exata consta na auditoria", actor: null, ref: null });
    timeline.sort((a, b) => a.at.localeCompare(b.at));
    const pendings: string[] = [];
    if (o.status !== "cancelada") pendings.push("Nenhuma necessidade está vinculada a esta oferta.");
    if (o.status === "registrada" || o.status === "em_contato" || o.status === "confirmada") pendings.push("O recebimento ainda não foi registrado.");
    let audit: OfferJourneyDetail["audit"] = null;
    if (access.audit) {
      const entries = o.correlationId ? Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_log WHERE organization_id = ${organizationId} AND correlation_id = ${o.correlationId}`.execute(db)).rows[0].n) : null;
      audit = { correlationId: o.correlationId, entries, path: o.correlationId ? `${base}/auditoria?correlacao=${o.correlationId}` : null, note: o.correlationId ? "Registros de auditoria desta oferta, ligados pela correlação gerada no cadastro dela." : "Esta oferta é anterior à correlação: consulte a Central de Auditoria pelo recurso." };
    }
    return {
      kind, id: o.id, title: o.title, status: o.status, statusLabel: OFFER_STATUS_LABEL[o.status] ?? o.status, quantity, unit: o.unit, createdAt: o.createdAt.toISOString(), sourceLabel: "Oferta registrada pela própria organização", originLabel: null, steps, next,
      description: o.description, category: o.category, createdByName: o.createdBy, donorName: o.donorName, evaluation: null, logistics: [], receipts: [], decidedByName: null, timeline, pendings,
      linking: { ...linking, alternatives: [{ label: "Abrir Oportunidades (status, categoria e recebimento da oferta)", href: `${base}/oportunidades` }, { label: "Ver as necessidades da organização", href: `${base}/necessidades` }] }, audit, access, notes,
    };
  }

  // atribuição da rede sem necessidade
  if (!access.network) return null;
  const rows = await loadUnlinkedAllocations(organizationId, [id]);
  const r = rows[0]; if (!r) return null;
  const extra = await db.selectFrom("opportunityAllocations as a").leftJoin("users as d", "d.id", "a.decidedByUserId").select(["d.displayName as decidedBy", "a.notes"]).where("a.id", "=", id).executeTakeFirst();
  const origin = (r.origin === "matching" || r.origin === "manual" ? r.origin : "nao_verificavel") as "matching" | "manual" | "nao_verificavel";
  const recMap = await receivedOfAllocations(organizationId, [id]);
  const { steps, next } = deriveUnlinkedAllocationSteps({ title: r.title, sourceName: r.sourceName, registryStatus: r.registryStatus, quantityAllocated: Number(r.qty), unit: r.unit, status: r.status, origin, score: r.score === null ? null : Number(r.score), evaluationId: r.evaluationId, receivedQuantity: recMap.get(id) ?? null, access });
  const ev = r.evaluationId ? await db.selectFrom("matchEvaluations").select(["id", "finalScore", "decision", "algorithmVersion", "createdAt"]).where("id", "=", r.evaluationId).where("organizationId", "=", organizationId).executeTakeFirst() : undefined;
  const lg = await db.selectFrom("logisticsEvents as l").leftJoin("users as u", "u.id", "l.actorUserId").select(["l.id", "l.eventType", "l.scheduledFor", "l.occurredAt", "u.displayName"]).where("l.organizationId", "=", organizationId).where("l.opportunityAllocationId", "=", id).orderBy("l.id", "asc").limit(50).execute();
  const rc = await db.selectFrom("needFulfillments as f").leftJoin("users as u", "u.id", "f.createdByUserId")
    .select(["f.id", "f.allocationId", "f.entryType", "f.quantity", "f.unit", "f.isCountable", "f.unitMismatchNote", "f.stockTransactionId", "f.createdAt", "u.displayName"])
    .where("f.organizationId", "=", organizationId).where("f.allocationId", "=", id).orderBy("f.id", "asc").limit(50).execute();
  const receipts: JourneyReceipt[] = rc.map((x) => ({ id: String(x.id), allocationId: x.allocationId, entryType: x.entryType, quantity: Number(x.quantity), unit: x.unit, isCountable: x.isCountable, unitMismatchNote: x.unitMismatchNote, stockTransactionId: x.stockTransactionId === null ? null : String(x.stockTransactionId), createdAt: x.createdAt.toISOString(), createdByName: x.displayName }));
  const q = (n: number, u: string | null) => `${n.toLocaleString("pt-BR")}${u ? ` ${u}` : ""}`;
  const timeline: TimelineEvent[] = [{ at: new Date(r.createdAt).toISOString(), kind: "atribuicao", title: `Atribuição #${id} (${ORIGIN_LABEL[origin].toLowerCase()}): ${q(Number(r.qty), r.unit)}`, detail: `oferta "${r.title}"${r.sourceName ? ` · fonte ${r.sourceName}` : ""}`, actor: null, ref: { type: "opportunity_allocation", id: String(id) } }];
  if (ev) timeline.push({ at: ev.createdAt.toISOString(), kind: "correspondencia", title: `Avaliação de matching #${ev.id}: pontuação ${Number(ev.finalScore)}`, detail: `algoritmo ${ev.algorithmVersion}`, actor: null, ref: { type: "match_evaluation", id: String(ev.id) } });
  for (const l of lg) timeline.push({ at: l.occurredAt.toISOString(), kind: "logistica", title: `Atribuição #${id}: ${l.eventType.replace(/_/g, " ")}`, detail: l.scheduledFor ? `agendado para ${l.scheduledFor.toISOString()}` : null, actor: l.displayName, ref: { type: "logistics_event", id: String(l.id) } });
  for (const x of receipts) timeline.push({ at: x.createdAt, kind: "recebimento", title: `${x.entryType === "original" ? "Recebimento" : x.entryType === "correction" ? "Correção de recebimento" : "Estorno de recebimento"}: ${q(x.quantity, x.unit)}`, detail: null, actor: x.createdByName, ref: { type: "need_fulfillment", id: x.id } });
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const pendings: string[] = [];
  if (r.status === "proposta") pendings.push("A atribuição está proposta e aguarda a decisão da organização.");
  if (r.status !== "recusada" && r.status !== "cancelada") pendings.push("Nenhuma necessidade está vinculada a esta atribuição.");
  if (["aceita", "em_coleta", "em_transporte"].includes(r.status) && receipts.length === 0) pendings.push("O recebimento ainda não foi registrado.");
  let audit: OfferJourneyDetail["audit"] = null;
  if (access.audit) {
    const entries = Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_log WHERE organization_id = ${organizationId} AND entity_type = 'opportunity_allocation' AND entity_id = ${String(id)}`.execute(db)).rows[0].n);
    audit = { correlationId: null, entries, path: `${base}/auditoria?recurso=opportunity_allocation&recursoId=${id}`, note: "Atribuições sem necessidade não têm uma correlação própria: os registros são consultados pelo recurso (a atribuição). Nenhuma correlação é inventada." };
  }
  return {
    kind, id, title: r.title, status: r.status, statusLabel: cap(allocationStatusLabel(r.status)), quantity: Number(r.qty), unit: r.unit, createdAt: new Date(r.createdAt).toISOString(), sourceLabel: `Oferta da rede (Registro Central)${r.sourceName ? ` · fonte ${r.sourceName}` : ""}`, originLabel: ORIGIN_LABEL[origin], steps, next,
    description: null, category: null, createdByName: null, donorName: null,
    evaluation: ev ? { id: String(ev.id), finalScore: Number(ev.finalScore), decision: ev.decision, algorithmVersion: ev.algorithmVersion, createdAt: ev.createdAt.toISOString() } : null,
    logistics: lg.map((l) => ({ id: String(l.id), eventType: l.eventType, scheduledFor: l.scheduledFor ? l.scheduledFor.toISOString() : null, occurredAt: l.occurredAt.toISOString(), actorName: l.displayName })), receipts, decidedByName: extra?.decidedBy ?? null, timeline, pendings,
    linking: { ...linking, alternatives: [{ label: "Abrir Atribuições (decidir, logística e recebimento)", href: `${base}/atribuicoes` }, { label: "Ver as necessidades da organização", href: `${base}/necessidades` }] }, audit, access, notes,
  };
}
