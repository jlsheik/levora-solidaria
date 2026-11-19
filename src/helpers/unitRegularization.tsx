/**
 * Fase 99C — casos de regularização de unidade.
 *
 * Um caso nasce quando o recebimento de uma oferta tem unidade sem equivalência comprovada com a unidade canônica do item (ver `checkOfferUnitAgainstItem`). Enquanto o caso está
 * ativo (aberto ou conferido) NADA é lançado no estoque, no ledger nem no atendimento; a atribuição/doação NÃO é marcada como recebida e NÃO expira por prazo. Saídas do caso:
 *  - conferência física (quantidade contada na unidade do item) + validação -> lança o recebimento UMA vez, na unidade canônica, com a quantidade conferida;
 *  - correção cadastral comprovada da unidade da oferta -> o caso fecha como "corrigido" e o recebimento é registrado pelo fluxo normal (nada é lançado pela correção);
 *  - encerramento sem resolução, com motivo (nada é lançado).
 * Não há conversão em lugar nenhum: a quantidade conferida é uma observação física, nunca um cálculo.
 *
 * ORDEM DE TRAVAS (única; compatível com receber, expirar e a logística): atribuição | doação local → item → caso → oferta da rede → auditoria (sempre por último).
 */
import { sql, type Transaction } from "kysely";
import { db } from "./db.js";
import type { DB, UnitRegularizationCategory } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { postAllocationReceipt, postLocalDonationReceipt } from "./receiptPosting.js";
import { canonicalizeUnitForWrite, checkOfferUnitAgainstItem } from "./unitVocabulary.js";
import { roundQuantity } from "./quantityRules.js";

type Trx = Transaction<DB>;

export const ACTIVE_CASE_STATUSES = ["aberto", "conferido"] as const;
const RECEIVABLE_ALLOCATION_STATUSES = ["aceita", "em_coleta", "em_transporte"];

export interface RegularizationCaseRow {
  id: number;
  organizationId: number;
  sourceType: "allocation" | "local_donation";
  allocationId: number | null;
  donationOpportunityId: number | null;
  itemId: number;
  divergenceKind: "unidade_ausente" | "unidade_diferente" | "unidade_nao_classificada";
  offeredQuantity: string | null;
  offeredUnit: string | null;
  informedQuantity: string;
  itemUnit: string;
  receiptNotes: string | null;
  category: UnitRegularizationCategory;
  status: "aberto" | "conferido" | "resolvido" | "corrigido" | "encerrado";
  openedByUserId: number;
  checkedQuantity: string | null;
  checkedUnit: string | null;
  divergenceReason: string | null;
  conferredByUserId: number | null;
  validatedByUserId: number | null;
  withoutSecondValidation: boolean;
}

const CASE_COLUMNS = [
  "id", "organizationId", "sourceType", "allocationId", "donationOpportunityId", "itemId", "divergenceKind", "offeredQuantity", "offeredUnit", "informedQuantity", "itemUnit",
  "receiptNotes", "category", "status", "openedByUserId", "checkedQuantity", "checkedUnit", "divergenceReason", "conferredByUserId", "validatedByUserId", "withoutSecondValidation",
] as const;

async function addEvent(
  trx: Trx,
  c: { id: number; organizationId: number },
  e: { eventType: "aberto" | "correcao_cadastral" | "conferencia_registrada" | "conferencia_devolvida" | "validada_resolvida" | "encerrado"; actorUserId: number | null; fieldRef?: string; previousValue?: string | null; newValue?: string | null; quantityBefore?: number | null; quantityAfter?: number | null; reason?: string | null }
) {
  await trx
    .insertInto("unitRegularizationEvents")
    .values({
      caseId: c.id,
      organizationId: c.organizationId,
      eventType: e.eventType,
      actorUserId: e.actorUserId,
      fieldRef: e.fieldRef ?? null,
      previousValue: e.previousValue ?? null,
      newValue: e.newValue ?? null,
      quantityBefore: e.quantityBefore ?? null,
      quantityAfter: e.quantityAfter ?? null,
      reason: e.reason ?? null,
    })
    .execute();
}

export async function findActiveCase(trx: Trx, ref: { allocationId?: number; donationOpportunityId?: number }): Promise<RegularizationCaseRow | undefined> {
  let q = trx.selectFrom("unitRegularizationCases").select(CASE_COLUMNS).where("status", "in", [...ACTIVE_CASE_STATUSES]);
  if (ref.allocationId !== undefined) q = q.where("allocationId", "=", ref.allocationId);
  if (ref.donationOpportunityId !== undefined) q = q.where("donationOpportunityId", "=", ref.donationOpportunityId);
  return (await q.forUpdate().executeTakeFirst()) as RegularizationCaseRow | undefined;
}

export interface OpenCaseInput {
  organizationId: number;
  allocationId?: number;
  donationOpportunityId?: number;
  itemId: number;
  offeredQuantity: number | null;
  offeredUnit: string | null;
  informedQuantity: number;
  itemUnit: string;
  receiptNotes: string | null;
  divergenceKind: "unidade_ausente" | "unidade_diferente" | "unidade_nao_classificada";
  userId: number;
}

/** Abre o caso (o chamador já travou atribuição/doação e item e já não achou caso ativo). A auditoria é a última escrita. */
export async function openCase(trx: Trx, input: OpenCaseInput): Promise<RegularizationCaseRow> {
  const row = await trx
    .insertInto("unitRegularizationCases")
    .values({
      organizationId: input.organizationId,
      sourceType: input.allocationId !== undefined ? "allocation" : "local_donation",
      allocationId: input.allocationId ?? null,
      donationOpportunityId: input.donationOpportunityId ?? null,
      itemId: input.itemId,
      divergenceKind: input.divergenceKind,
      offeredQuantity: input.offeredQuantity,
      offeredUnit: input.offeredUnit,
      informedQuantity: input.informedQuantity,
      itemUnit: input.itemUnit,
      receiptNotes: input.receiptNotes,
      openedByUserId: input.userId,
    })
    .returning(CASE_COLUMNS)
    .executeTakeFirstOrThrow();
  const c = row as unknown as RegularizationCaseRow;
  await addEvent(trx, c, { eventType: "aberto", actorUserId: input.userId, newValue: input.offeredUnit, quantityAfter: input.informedQuantity, reason: input.divergenceKind });
  await recordAuditLogEntry(
    {
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "regularizacao.caso_aberto",
      entityType: "unit_regularization_case",
      entityId: String(c.id),
      metadata: {
        origem: c.sourceType,
        atribuicaoId: input.allocationId ?? null,
        doacaoId: input.donationOpportunityId ?? null,
        itemId: input.itemId,
        divergencia: input.divergenceKind,
        quantidadeOfertada: input.offeredQuantity,
        unidadeOfertada: input.offeredUnit,
        quantidadeInformada: input.informedQuantity,
        unidadeDoItem: input.itemUnit,
      },
    },
    trx
  );
  return c;
}

/**
 * Num novo pedido de recebimento com caso ativo: se a unidade da oferta passou a ser compatível (correção cadastral feita por outro caminho), o caso fecha como "corrigido" e o
 * recebimento segue pelo fluxo normal. Devolve true se fechou. Nada é lançado aqui.
 */
export async function closeAsCorrectedIfNowCompatible(trx: Trx, c: RegularizationCaseRow, currentOfferUnit: string | null, userId: number): Promise<boolean> {
  if (!checkOfferUnitAgainstItem(currentOfferUnit, c.itemUnit).compatible) return false;
  const reason = "A unidade da oferta passou a ser compatível com a do item; o recebimento segue pelo fluxo normal.";
  await trx
    .updateTable("unitRegularizationCases")
    .set({ status: "corrigido", category: "erro_cadastral", closedReason: reason, closedByUserId: userId, closedAt: new Date() })
    .where("id", "=", c.id)
    .execute();
  await addEvent(trx, c, { eventType: "correcao_cadastral", actorUserId: userId, fieldRef: "oferta.unidade", previousValue: c.offeredUnit, newValue: currentOfferUnit, reason });
  await recordAuditLogEntry(
    { organizationId: c.organizationId, actorUserId: userId, action: "regularizacao.caso_corrigido", entityType: "unit_regularization_case", entityId: String(c.id), metadata: { unidadeAnterior: c.offeredUnit, unidadeAtual: currentOfferUnit, automatico: true } },
    trx
  );
  return true;
}

export type CaseOutcome<T = object> =
  | ({ type: "ok" } & T)
  | { type: "not_found" }
  | { type: "invalid_state"; status: string }
  | { type: "source_not_receivable"; status: string }
  | { type: "item_changed" }
  | { type: "forbidden_same_person" }
  | { type: "needs_second_validation" }
  | { type: "still_incompatible"; detail: string }
  | { type: "invalid_unit"; message: string }
  | { type: "has_dependents"; message: string }
  | { type: "claim_failed" };

/** Quantos proprietários/administradores ativos a organização tem (regra do "único elegível" da segunda validação). */
async function countActiveManagers(trx: Trx, organizationId: number): Promise<number> {
  const r = await trx
    .selectFrom("memberships")
    .select(sql<string>`count(*)`.as("n"))
    .where("organizationId", "=", organizationId)
    .where("status", "=", "ativo")
    .where("role", "in", ["proprietario", "administrador"])
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * Trava na ORDEM documentada (atribuição|doação → item → caso) e devolve o caso relido sob a trava. Um caso de outra organização é "não encontrado" (nunca vaza que existe).
 */
async function lockCaseChain(trx: Trx, organizationId: number, caseId: number) {
  const probe = await trx
    .selectFrom("unitRegularizationCases")
    .select(["id", "allocationId", "donationOpportunityId", "itemId"])
    .where("id", "=", caseId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
  if (!probe) return null;
  let allocation: { id: number; status: string; opportunityRegistryId: number; quantityAllocated: string } | undefined;
  let donation: { id: number; status: string; title: string; donorName: string; unit: string | null } | undefined;
  if (probe.allocationId !== null) {
    allocation = await trx
      .selectFrom("opportunityAllocations")
      .select(["id", "status", "opportunityRegistryId", "quantityAllocated"])
      .where("id", "=", probe.allocationId)
      .where("organizationId", "=", organizationId)
      .forUpdate()
      .executeTakeFirst();
  } else if (probe.donationOpportunityId !== null) {
    donation = await trx
      .selectFrom("donationOpportunities")
      .select(["id", "status", "title", "donorName", "unit"])
      .where("id", "=", probe.donationOpportunityId)
      .where("organizationId", "=", organizationId)
      .forUpdate()
      .executeTakeFirst();
  }
  const item = await trx.selectFrom("inventoryItems").select(["id", "name", "unit"]).where("id", "=", probe.itemId).where("organizationId", "=", organizationId).forUpdate().executeTakeFirst();
  const row = (await trx.selectFrom("unitRegularizationCases").select(CASE_COLUMNS).where("id", "=", caseId).where("organizationId", "=", organizationId).forUpdate().executeTakeFirst()) as RegularizationCaseRow | undefined;
  if (!row || !item || (!allocation && !donation)) return null;
  return { row, allocation, donation, item };
}

function sourceReceivable(chain: NonNullable<Awaited<ReturnType<typeof lockCaseChain>>>): { ok: true } | { ok: false; status: string } {
  if (chain.allocation) return RECEIVABLE_ALLOCATION_STATUSES.includes(chain.allocation.status) ? { ok: true } : { ok: false, status: chain.allocation.status };
  const s = chain.donation!.status;
  return s === "recebida" || s === "cancelada" ? { ok: false, status: s } : { ok: true };
}

/** Aplica a resolução (lança o recebimento UMA vez, na unidade do item, com a quantidade conferida) e fecha o caso. Chamada sob as travas de `lockCaseChain`. */
async function applyResolution(trx: Trx, chain: NonNullable<Awaited<ReturnType<typeof lockCaseChain>>>, validatorUserId: number, withoutSecondValidation: boolean) {
  const c = chain.row;
  const quantity = Number(c.checkedQuantity);
  let stockTransactionId: string;
  let newStock: number;
  if (chain.allocation) {
    const posted = await postAllocationReceipt(trx, {
      organizationId: c.organizationId,
      allocation: chain.allocation,
      item: chain.item,
      quantityReceived: quantity,
      userId: validatorUserId,
      notes: c.receiptNotes,
      proofUrl: null,
      regularizationCaseId: c.id,
    });
    stockTransactionId = posted.stockTransactionId;
    newStock = posted.newStock;
  } else {
    const posted = await postLocalDonationReceipt(trx, {
      organizationId: c.organizationId,
      opportunity: { id: chain.donation!.id, title: chain.donation!.title, donorName: chain.donation!.donorName },
      item: chain.item,
      quantityReceived: quantity,
      userId: validatorUserId,
      notes: c.receiptNotes,
      regularizationCaseId: c.id,
    });
    if (!posted.claimed) return null;
    stockTransactionId = posted.stockTransactionId;
    newStock = posted.newStock;
  }
  await trx
    .updateTable("unitRegularizationCases")
    .set({ status: "resolvido", category: "conferencia_fisica", validatedByUserId: validatorUserId, validatedAt: new Date(), withoutSecondValidation, resolvedStockTransactionId: stockTransactionId })
    .where("id", "=", c.id)
    .execute();
  await addEvent(trx, c, {
    eventType: "validada_resolvida",
    actorUserId: validatorUserId,
    quantityBefore: Number(c.informedQuantity),
    quantityAfter: quantity,
    newValue: c.itemUnit,
    reason: withoutSecondValidation ? "Conferência aceita sem segunda validação (único proprietário/administrador ativo)." : "Conferência validada por segunda pessoa.",
  });
  await recordAuditLogEntry(
    {
      organizationId: c.organizationId,
      actorUserId: validatorUserId,
      action: "regularizacao.resolvida",
      entityType: "unit_regularization_case",
      entityId: String(c.id),
      metadata: { quantidadeOfertada: c.offeredQuantity === null ? null : Number(c.offeredQuantity), unidadeOfertada: c.offeredUnit, quantidadeConferida: quantity, unidadeCanonica: c.itemUnit, stockTransactionId, semSegundaValidacao: withoutSecondValidation, conferidoPor: c.conferredByUserId },
    },
    trx
  );
  return { stockTransactionId, newStock };
}

export async function conferCase(input: { organizationId: number; caseId: number; userId: number; checkedQuantity: number; reason: string; validateNow: boolean; canValidate: boolean }): Promise<CaseOutcome<{ status: "conferido" | "resolvido"; stockTransactionId: string | null }>> {
  return db.transaction().execute(async (trx) => {
    const chain = await lockCaseChain(trx, input.organizationId, input.caseId);
    if (!chain) return { type: "not_found" as const };
    const c = chain.row;
    if (c.status !== "aberto") return { type: "invalid_state" as const, status: c.status };
    const recv = sourceReceivable(chain);
    if (!recv.ok) return { type: "source_not_receivable" as const, status: recv.status };
    if (chain.item.unit !== c.itemUnit) return { type: "item_changed" as const };

    const quantity = roundQuantity(input.checkedQuantity);
    await trx
      .updateTable("unitRegularizationCases")
      .set({ status: "conferido", category: "conferencia_fisica", checkedQuantity: quantity, checkedUnit: c.itemUnit, divergenceReason: input.reason, conferredByUserId: input.userId, conferredAt: new Date() })
      .where("id", "=", c.id)
      .execute();
    const conferred: RegularizationCaseRow = { ...c, status: "conferido", checkedQuantity: String(quantity), checkedUnit: c.itemUnit, divergenceReason: input.reason, conferredByUserId: input.userId };
    await addEvent(trx, c, { eventType: "conferencia_registrada", actorUserId: input.userId, quantityBefore: Number(c.informedQuantity), quantityAfter: quantity, newValue: c.itemUnit, reason: input.reason });

    // "Único elegível": quem tem a permissão de validar e é o único proprietário/administrador ativo pode conferir e validar no mesmo ato (marcado "sem segunda validação").
    if (input.validateNow && input.canValidate && (await countActiveManagers(trx, c.organizationId)) === 1) {
      const applied = await applyResolution(trx, { ...chain, row: conferred }, input.userId, true);
      if (!applied) return { type: "claim_failed" as const };
      return { type: "ok" as const, status: "resolvido" as const, stockTransactionId: applied.stockTransactionId };
    }
    if (input.validateNow) {
      // o pedido de validar no mesmo ato não pôde ser atendido: a conferência fica registrada e aguarda outra pessoa (a falha vira a resposta, a conferência permanece)
      await recordAuditLogEntry(
        { organizationId: c.organizationId, actorUserId: input.userId, action: "regularizacao.conferencia_registrada", entityType: "unit_regularization_case", entityId: String(c.id), metadata: { quantidadeConferida: quantity, unidade: c.itemUnit, aguardandoValidacao: true } },
        trx
      );
      return { type: "needs_second_validation" as const };
    }
    await recordAuditLogEntry(
      { organizationId: c.organizationId, actorUserId: input.userId, action: "regularizacao.conferencia_registrada", entityType: "unit_regularization_case", entityId: String(c.id), metadata: { quantidadeConferida: quantity, unidade: c.itemUnit, aguardandoValidacao: true } },
      trx
    );
    return { type: "ok" as const, status: "conferido" as const, stockTransactionId: null };
  });
}

export async function validateCase(input: { organizationId: number; caseId: number; userId: number; decision: "aprovar" | "devolver"; note: string }): Promise<CaseOutcome<{ status: "resolvido" | "aberto"; stockTransactionId: string | null }>> {
  return db.transaction().execute(async (trx) => {
    const chain = await lockCaseChain(trx, input.organizationId, input.caseId);
    if (!chain) return { type: "not_found" as const };
    const c = chain.row;
    if (c.status !== "conferido") return { type: "invalid_state" as const, status: c.status };

    if (input.decision === "devolver") {
      await trx
        .updateTable("unitRegularizationCases")
        .set({ status: "aberto", checkedQuantity: null, checkedUnit: null, divergenceReason: null, conferredByUserId: null, conferredAt: null })
        .where("id", "=", c.id)
        .execute();
      await addEvent(trx, c, { eventType: "conferencia_devolvida", actorUserId: input.userId, quantityBefore: c.checkedQuantity === null ? null : Number(c.checkedQuantity), reason: input.note });
      await recordAuditLogEntry(
        { organizationId: c.organizationId, actorUserId: input.userId, action: "regularizacao.conferencia_devolvida", entityType: "unit_regularization_case", entityId: String(c.id), metadata: { motivo: input.note } },
        trx
      );
      return { type: "ok" as const, status: "aberto" as const, stockTransactionId: null };
    }

    const recv = sourceReceivable(chain);
    if (!recv.ok) return { type: "source_not_receivable" as const, status: recv.status };
    if (chain.item.unit !== c.itemUnit) return { type: "item_changed" as const };
    let withoutSecond = false;
    if (c.conferredByUserId === input.userId) {
      if ((await countActiveManagers(trx, c.organizationId)) !== 1) return { type: "forbidden_same_person" as const };
      withoutSecond = true;
    }
    const applied = await applyResolution(trx, chain, input.userId, withoutSecond);
    if (!applied) return { type: "claim_failed" as const };
    return { type: "ok" as const, status: "resolvido" as const, stockTransactionId: applied.stockTransactionId };
  });
}

export async function closeCase(input: { organizationId: number; caseId: number; userId: number; category: "conversao_nao_suportada" | "informacao_insuficiente"; reason: string }): Promise<CaseOutcome<{ status: "encerrado" }>> {
  return db.transaction().execute(async (trx) => {
    const chain = await lockCaseChain(trx, input.organizationId, input.caseId);
    if (!chain) return { type: "not_found" as const };
    const c = chain.row;
    if (c.status !== "aberto" && c.status !== "conferido") return { type: "invalid_state" as const, status: c.status };
    await trx
      .updateTable("unitRegularizationCases")
      .set({ status: "encerrado", category: input.category, closedReason: input.reason, closedByUserId: input.userId, closedAt: new Date() })
      .where("id", "=", c.id)
      .execute();
    await addEvent(trx, c, { eventType: "encerrado", actorUserId: input.userId, reason: input.reason, newValue: input.category });
    await recordAuditLogEntry(
      { organizationId: c.organizationId, actorUserId: input.userId, action: "regularizacao.encerrada_sem_resolucao", entityType: "unit_regularization_case", entityId: String(c.id), metadata: { categoria: input.category, motivo: input.reason } },
      trx
    );
    return { type: "ok" as const, status: "encerrado" as const };
  });
}

/**
 * Correção cadastral COMPROVADA da unidade da oferta que causou a divergência. Só vale se a unidade nova é do vocabulário, fica compatível com a do item e a oferta não tem
 * dependentes (nenhum recebimento já lançado com a unidade antiga). O caso fecha como "corrigido"; o recebimento NÃO é lançado aqui: segue pelo fluxo normal.
 * `actor.platform` corrige a oferta da rede (registro global); sem ele, a doação local da própria organização.
 */
export async function correctOfferUnit(input: { organizationId: number | null; caseId: number; userId: number; newUnit: string; reason: string; platform: boolean }): Promise<CaseOutcome<{ status: "corrigido"; previousUnit: string | null; newUnit: string }>> {
  return db.transaction().execute(async (trx) => {
    let organizationId = input.organizationId;
    if (input.platform) {
      const probe = await trx.selectFrom("unitRegularizationCases").select(["organizationId", "sourceType"]).where("id", "=", input.caseId).executeTakeFirst();
      if (!probe || probe.sourceType !== "allocation") return { type: "not_found" as const };
      organizationId = probe.organizationId;
    }
    const chain = await lockCaseChain(trx, organizationId!, input.caseId);
    if (!chain) return { type: "not_found" as const };
    const c = chain.row;
    if (input.platform !== (c.sourceType === "allocation")) return { type: "not_found" as const };
    if (c.status !== "aberto" && c.status !== "conferido") return { type: "invalid_state" as const, status: c.status };
    const recv = sourceReceivable(chain);
    if (!recv.ok) return { type: "source_not_receivable" as const, status: recv.status };

    const checked = canonicalizeUnitForWrite(input.newUnit, "unidade da oferta");
    if (!checked.ok) return { type: "invalid_unit" as const, message: checked.message };
    const compat = checkOfferUnitAgainstItem(checked.label, c.itemUnit);
    if (!compat.compatible) return { type: "still_incompatible" as const, detail: compat.detail };

    let previousUnit: string | null;
    if (chain.allocation) {
      const registry = await trx.selectFrom("opportunityRegistry").select(["id", "unit"]).where("id", "=", chain.allocation.opportunityRegistryId).forUpdate().executeTakeFirstOrThrow();
      previousUnit = registry.unit;
      // dependentes: outra organização já recebeu esta oferta com a unidade antiga -> não se reinterpreta o que já foi lançado
      const received = await trx.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", registry.id).where("status", "=", "recebida").executeTakeFirst();
      if (received) return { type: "has_dependents" as const, message: "Esta oferta já tem recebimentos lançados com a unidade antiga. Ela não é alterada no lugar: use a conferência física neste caso." };
      await trx.updateTable("opportunityRegistry").set({ unit: checked.label, updatedAt: new Date() }).where("id", "=", registry.id).execute();
    } else {
      previousUnit = chain.donation!.unit;
      await trx.updateTable("donationOpportunities").set({ unit: checked.label, updatedAt: new Date(), version: sql`version + 1` }).where("id", "=", chain.donation!.id).where("organizationId", "=", c.organizationId).execute();
    }
    await trx
      .updateTable("unitRegularizationCases")
      .set({ status: "corrigido", category: "erro_cadastral", closedReason: input.reason, closedByUserId: input.userId, closedAt: new Date() })
      .where("id", "=", c.id)
      .execute();
    await addEvent(trx, c, { eventType: "correcao_cadastral", actorUserId: input.userId, fieldRef: chain.allocation ? "opportunity_registry.unit" : "donation_opportunities.unit", previousValue: previousUnit, newValue: checked.label, reason: input.reason });
    await recordAuditLogEntry(
      { organizationId: c.organizationId, actorUserId: input.userId, action: "regularizacao.caso_corrigido", entityType: "unit_regularization_case", entityId: String(c.id), metadata: { campo: chain.allocation ? "opportunity_registry.unit" : "donation_opportunities.unit", valorAnterior: previousUnit, valorNovo: checked.label, motivo: input.reason, porAdminDaPlataforma: input.platform } },
      trx
    );
    return { type: "ok" as const, status: "corrigido" as const, previousUnit, newUnit: checked.label };
  });
}
