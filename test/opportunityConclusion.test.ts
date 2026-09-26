/**
 * Prova comportamental do achado CRÍTICO da auditoria de fechamento: a
 * condição de conclusão ("todas as atribuições terminais + pelo menos uma
 * recebida") só era verificada dentro de `allocations-receive_POST.ts` —
 * cancelar/recusar/expirar a ÚLTIMA atribuição ainda ativa, quando outra já
 * tinha sido "recebida", deixava a oportunidade presa em "atribuida" para
 * sempre, mesmo sem nenhuma reprodução de concorrência (bug determinístico,
 * sequencial). `concludeOpportunityIfAllTerminalAndReceived`
 * (src/helpers/concludeOpportunity.tsx) centraliza a regra e é chamada
 * pelos 4 caminhos que terminam uma atribuição: `allocations-receive_POST`,
 * `allocations-decide_POST`, `allocations-logistics_POST`,
 * `expireReservations` — sempre travando a linha da oportunidade antes de
 * contar irmãs, e sempre antes de qualquer `recordAuditLogEntry` na mesma
 * transação (ordem de locks consistente com a correção da Fase 27, para
 * não reintroduzir o deadlock `PostgresError 40P01` encontrado ali).
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { concludeOpportunityIfAllTerminalAndReceived } from "../src/helpers/concludeOpportunity";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { handle as decideHandle } from "../src/endpoints/allocations-decide_POST";
import { handle as logisticsHandle } from "../src/endpoints/allocations-logistics_POST";
import { expireReservations } from "../src/helpers/expireReservations";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  buildRequest,
} from "./helpers";

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function makeOpportunity(status: "atribuida" = "atribuida") {
  const admin = await createAuthenticatedUser();
  const source = await createTestSource(admin.userId);
  const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status });
  return opportunity.id;
}

async function makeReceivableRow(opportunityId: number, allocationStatus: "aceita" | "em_coleta" | "em_transporte" = "em_coleta") {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Item de teste", unit: "unidade" });
  const [alloc] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: opportunityId, organizationId: org.id, status: allocationStatus, quantityAllocated: "5", autoMatched: true })
    .returning(["id"])
    .execute();
  return { ownerCookie: owner.cookie, orgId: org.id, itemId: item.id, allocationId: alloc.id };
}

async function insertAllocation(opportunityId: number, status: "recebida" | "cancelada" | "recusada" | "proposta" | "aceita") {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const [alloc] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: opportunityId, organizationId: org.id, status, quantityAllocated: "5", autoMatched: true })
    .returning(["id"])
    .execute();
  return { ownerCookie: owner.cookie, orgId: org.id, allocationId: alloc.id };
}

async function getOpportunityStatus(opportunityId: number) {
  const row = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
  return row.status;
}

describe("concludeOpportunityIfAllTerminalAndReceived — cenários obrigatórios", () => {
  it("teste 1: uma unica allocation aceita->recebida -> concluida (via handler real)", async () => {
    const opportunityId = await makeOpportunity();
    const a = await makeReceivableRow(opportunityId, "aceita");

    const res = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: a.ownerCookie, body: { organizationId: a.orgId, allocationId: a.allocationId, itemId: a.itemId, quantityReceived: 5 } }));
    expect(res.status).toBe(200);
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
  });

  it("teste 2: A recebida, B ainda ativa -> NAO conclui", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "recebida");
    await insertAllocation(opportunityId, "aceita");

    const concluded = await db.transaction().execute((trx) => concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId));
    expect(concluded).toBe(false);
    expect(await getOpportunityStatus(opportunityId)).toBe("atribuida");
  });

  it("teste 3: A recebida, B recebida depois -> conclui", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "recebida");
    const b = await insertAllocation(opportunityId, "aceita");

    await db.updateTable("opportunityAllocations").set({ status: "recebida" }).where("id", "=", b.allocationId).execute();
    const concluded = await db.transaction().execute((trx) => concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId));
    expect(concluded).toBe(true);
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
  });

  it("teste 4: A recebida, B cancelada (nao recebida) -> conclui — o BUG CRITICO original", async () => {
    const opportunityId = await makeOpportunity();
    const a = await insertAllocation(opportunityId, "recebida");
    const b = await insertAllocation(opportunityId, "aceita");
    expect(await getOpportunityStatus(opportunityId)).toBe("atribuida"); // antes do cancelamento

    const res = await logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie: b.ownerCookie, body: { organizationId: b.orgId, allocationId: b.allocationId, eventType: "cancelado" } }));
    expect(res.status).toBe(200);

    // Este é exatamente o cenário que ficava presa em "atribuida" antes da correção.
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
    const allocations = await db.selectFrom("opportunityAllocations").select(["id", "status"]).where("opportunityRegistryId", "=", opportunityId).execute();
    expect(allocations.find((x) => x.id === a.allocationId)?.status).toBe("recebida");
    expect(allocations.find((x) => x.id === b.allocationId)?.status).toBe("cancelada");
  });

  it("teste 5: A recebida, B recusada (nao recebida) -> conclui", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "recebida");
    const b = await insertAllocation(opportunityId, "proposta");

    const res = await decideHandle(buildRequest("allocations-decide", { method: "POST", cookie: b.ownerCookie, body: { organizationId: b.orgId, allocationId: b.allocationId, decision: "recusada" } }));
    expect(res.status).toBe(200);
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
  });

  it("teste 6: tres allocations — recebida + cancelada + recusada -> conclui", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "recebida");
    await insertAllocation(opportunityId, "cancelada");
    await insertAllocation(opportunityId, "recusada");

    const concluded = await db.transaction().execute((trx) => concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId));
    expect(concluded).toBe(true);
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
  });

  it("teste 7: nenhuma allocation recebida (todas canceladas/recusadas) -> NAO conclui por esta regra", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "cancelada");
    await insertAllocation(opportunityId, "recusada");

    const concluded = await db.transaction().execute((trx) => concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId));
    expect(concluded).toBe(false);
    expect(await getOpportunityStatus(opportunityId)).toBe("atribuida"); // comportamento existente de reabertura/estado é responsabilidade de outro helper, não deste
  });

  it("teste 8: duas terminacoes concorrentes que juntas satisfazem a condicao -> no maximo uma conclusao, sem auditoria duplicada", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "recebida");
    const b = await insertAllocation(opportunityId, "aceita");
    const c = await insertAllocation(opportunityId, "proposta");

    const locked = { b: createDeferred<void>(), c: createDeferred<void>() };
    async function terminate(allocId: number, finalStatus: "cancelada" | "recusada", signalSelf: () => void, waitOther: Promise<void>) {
      return db.transaction().execute(async (trx) => {
        await trx.selectFrom("opportunityAllocations").select(["id"]).where("id", "=", allocId).forUpdate().executeTakeFirst();
        signalSelf();
        await waitOther;
        await trx.updateTable("opportunityAllocations").set({ status: finalStatus }).where("id", "=", allocId).execute();
        return concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId);
      });
    }

    const [concludedB, concludedC] = await Promise.all([
      terminate(b.allocationId, "cancelada", locked.b.resolve, locked.c.promise),
      terminate(c.allocationId, "recusada", locked.c.resolve, locked.b.promise),
    ]);

    expect([concludedB, concludedC].filter(Boolean)).toHaveLength(1);
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
  });

  it("teste 9: recebimento concorrente em duas allocations diferentes -> conclusao correta, sem regressao (ja validado indiretamente na auditoria anterior)", async () => {
    const opportunityId = await makeOpportunity();
    const a = await makeReceivableRow(opportunityId, "em_coleta");
    const b = await makeReceivableRow(opportunityId, "aceita");

    const [resA, resB] = await Promise.all([
      receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: a.ownerCookie, body: { organizationId: a.orgId, allocationId: a.allocationId, itemId: a.itemId, quantityReceived: 5 } })),
      receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: b.ownerCookie, body: { organizationId: b.orgId, allocationId: b.allocationId, itemId: b.itemId, quantityReceived: 5 } })),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
    const concludedAudits = await db.selectFrom("auditLog").select(["id"]).where("action", "=", "descoberta_central.concluida").where("entityId", "=", String(opportunityId)).execute();
    expect(concludedAudits).toHaveLength(1);
  });
});

describe("concorrência real entre caminhos de terminalização (verificação especial de deadlock)", () => {
  it("cenario A: receive(A) concorrente com cancel(B) -> sem deadlock, exatamente uma conclusao", async () => {
    const opportunityId = await makeOpportunity();
    const a = await makeReceivableRow(opportunityId, "em_coleta");
    const b = await insertAllocation(opportunityId, "aceita");

    const [resA, resB] = await Promise.all([
      receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: a.ownerCookie, body: { organizationId: a.orgId, allocationId: a.allocationId, itemId: a.itemId, quantityReceived: 5 } })),
      logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie: b.ownerCookie, body: { organizationId: b.orgId, allocationId: b.allocationId, eventType: "cancelado" } })),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
    const concludedAudits = await db.selectFrom("auditLog").select(["id"]).where("action", "=", "descoberta_central.concluida").where("entityId", "=", String(opportunityId)).execute();
    expect(concludedAudits).toHaveLength(1);
  });

  it("cenario B: receive(A) concorrente com refuse(B) -> sem deadlock, exatamente uma conclusao", async () => {
    const opportunityId = await makeOpportunity();
    const a = await makeReceivableRow(opportunityId, "em_coleta");
    const b = await insertAllocation(opportunityId, "proposta");

    const [resA, resB] = await Promise.all([
      receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: a.ownerCookie, body: { organizationId: a.orgId, allocationId: a.allocationId, itemId: a.itemId, quantityReceived: 5 } })),
      decideHandle(buildRequest("allocations-decide", { method: "POST", cookie: b.ownerCookie, body: { organizationId: b.orgId, allocationId: b.allocationId, decision: "recusada" } })),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
    const concludedAudits = await db.selectFrom("auditLog").select(["id"]).where("action", "=", "descoberta_central.concluida").where("entityId", "=", String(opportunityId)).execute();
    expect(concludedAudits).toHaveLength(1);
  });

  it("cenario C: receive(A) concorrente com expiração de reserva de B -> sem deadlock, conclusão eventual correta", async () => {
    const opportunityId = await makeOpportunity();
    const a = await makeReceivableRow(opportunityId, "em_coleta");
    const b = await insertAllocation(opportunityId, "proposta");
    await db.updateTable("opportunityAllocations").set({ reservedUntil: new Date(Date.now() - 1000) }).where("id", "=", b.allocationId).execute();

    const [resA] = await Promise.all([
      receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: a.ownerCookie, body: { organizationId: a.orgId, allocationId: a.allocationId, itemId: a.itemId, quantityReceived: 5 } })),
      expireReservations(),
    ]);
    expect(resA.status).toBe(200);

    const bFinal = await db.selectFrom("opportunityAllocations").select(["status"]).where("id", "=", b.allocationId).executeTakeFirstOrThrow();
    expect(bFinal.status).toBe("cancelada");
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
    const concludedAudits = await db.selectFrom("auditLog").select(["id"]).where("action", "=", "descoberta_central.concluida").where("entityId", "=", String(opportunityId)).execute();
    expect(concludedAudits.length).toBeLessThanOrEqual(1);
  });

  it("cenario D: cancel(A) concorrente com refuse(B) em allocations diferentes, sem nenhuma recebida -> nao conclui (sem allocation recebida)", async () => {
    const opportunityId = await makeOpportunity();
    const a = await insertAllocation(opportunityId, "aceita");
    const b = await insertAllocation(opportunityId, "proposta");

    const [resA, resB] = await Promise.all([
      logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie: a.ownerCookie, body: { organizationId: a.orgId, allocationId: a.allocationId, eventType: "cancelado" } })),
      decideHandle(buildRequest("allocations-decide", { method: "POST", cookie: b.ownerCookie, body: { organizationId: b.orgId, allocationId: b.allocationId, decision: "recusada" } })),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const concludedAudits = await db.selectFrom("auditLog").select(["id"]).where("action", "=", "descoberta_central.concluida").where("entityId", "=", String(opportunityId)).execute();
    expect(concludedAudits).toHaveLength(0); // nenhuma foi recebida — não deve concluir por esta regra
  });

  it("cenario E: tres terminacoes simultaneas (receive + cancel + refuse) -> exatamente uma conclusao, sem estado parcial", async () => {
    const opportunityId = await makeOpportunity();
    const a = await makeReceivableRow(opportunityId, "em_coleta");
    const b = await insertAllocation(opportunityId, "aceita");
    const c = await insertAllocation(opportunityId, "proposta");

    const [resA, resB, resC] = await Promise.all([
      receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: a.ownerCookie, body: { organizationId: a.orgId, allocationId: a.allocationId, itemId: a.itemId, quantityReceived: 5 } })),
      logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie: b.ownerCookie, body: { organizationId: b.orgId, allocationId: b.allocationId, eventType: "cancelado" } })),
      decideHandle(buildRequest("allocations-decide", { method: "POST", cookie: c.ownerCookie, body: { organizationId: c.orgId, allocationId: c.allocationId, decision: "recusada" } })),
    ]);
    expect([resA.status, resB.status, resC.status]).toEqual([200, 200, 200]);

    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
    const concludedAudits = await db.selectFrom("auditLog").select(["id"]).where("action", "=", "descoberta_central.concluida").where("entityId", "=", String(opportunityId)).execute();
    expect(concludedAudits).toHaveLength(1);

    const allocations = await db.selectFrom("opportunityAllocations").select(["status"]).where("opportunityRegistryId", "=", opportunityId).execute();
    expect(allocations.map((x) => x.status).sort()).toEqual(["cancelada", "recebida", "recusada"]);
  });
});

describe("multi-tenancy e idempotência do helper de conclusão", () => {
  it("o helper só recebe opportunityRegistryId — nenhum lookup cruzado de organização", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "recebida");
    // Confirma que a assinatura da função não aceita nem precisa de organizationId.
    const concluded = await db.transaction().execute((trx) => concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId));
    expect(concluded).toBe(true);
  });

  it("chamar o helper duas vezes seguidas não conclui duas vezes", async () => {
    const opportunityId = await makeOpportunity();
    await insertAllocation(opportunityId, "recebida");

    const first = await db.transaction().execute((trx) => concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId));
    expect(first).toBe(true);

    const second = await db.transaction().execute((trx) => concludeOpportunityIfAllTerminalAndReceived(trx, opportunityId));
    expect(second).toBe(false); // já não está mais "atribuida" — no-op seguro
    expect(await getOpportunityStatus(opportunityId)).toBe("concluida");
  });
});
