/**
 * Prova comportamental do achado CRÍTICO da auditoria do lifecycle: duas (ou
 * mais) transações terminando atribuições DIFERENTES da MESMA oportunidade,
 * ao mesmo tempo, deixavam de reabri-la — cada uma via a outra ainda "ativa"
 * (pré-commit), sob READ COMMITTED, porque a contagem de irmãs ativas não
 * travava nada. `reopenOpportunityIfNoActiveAllocations`
 * (src/helpers/reopenOpportunity.tsx) trava a linha da oportunidade ANTES de
 * contar, serializando a decisão entre todas as chamadas concorrentes
 * (allocations-decide_POST, allocations-logistics_POST, expireReservations
 * — os 3 caminhos reais que terminam uma atribuição e podem reabrir).
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { reopenOpportunityIfNoActiveAllocations } from "../src/helpers/reopenOpportunity";
import { handle as decideHandle } from "../src/endpoints/allocations-decide_POST";
import { handle as logisticsHandle } from "../src/endpoints/allocations-logistics_POST";
import { expireReservations } from "../src/helpers/expireReservations";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  buildRequest,
} from "./helpers";

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function makeOpportunityWithAllocations(
  status: "reservada" | "atribuida",
  allocations: Array<{ status: "proposta" | "aceita" | "em_coleta" | "em_transporte"; quantity?: number }>
) {
  const admin = await createAuthenticatedUser();
  const source = await createTestSource(admin.userId);
  const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status });

  const rows: Array<{ id: number; orgId: number; ownerCookie: string }> = [];
  for (const spec of allocations) {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const [alloc] = await db
      .insertInto("opportunityAllocations")
      .values({
        opportunityRegistryId: opportunity.id,
        organizationId: org.id,
        status: spec.status,
        quantityAllocated: String(spec.quantity ?? 5),
        autoMatched: true,
        reservedUntil: spec.status === "proposta" ? new Date(Date.now() + 30 * 60 * 1000) : null,
      })
      .returning(["id"])
      .execute();
    rows.push({ id: alloc.id, orgId: org.id, ownerCookie: owner.cookie });
  }

  return { admin, opportunityId: opportunity.id, allocations: rows };
}

describe("reopenOpportunityIfNoActiveAllocations — cenários obrigatórios da auditoria", () => {
  it("teste 1: A termina primeiro, B termina depois (sequencial) -> 0 ativas, oportunidade reaberta", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" },
      { status: "proposta" },
    ]);

    await db.transaction().execute(async (trx) => {
      await trx.updateTable("opportunityAllocations").set({ status: "cancelada" }).where("id", "=", allocations[0].id).execute();
      const reopened = await reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      expect(reopened).toBe(false); // B ainda ativa
    });

    await db.transaction().execute(async (trx) => {
      await trx.updateTable("opportunityAllocations").set({ status: "recusada" }).where("id", "=", allocations[1].id).execute();
      const reopened = await reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      expect(reopened).toBe(true);
    });

    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("aguardando_destinacao");
  });

  it("teste 2: B termina primeiro, A termina depois -> mesmo resultado (simetria)", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" },
      { status: "proposta" },
    ]);

    await db.transaction().execute(async (trx) => {
      await trx.updateTable("opportunityAllocations").set({ status: "recusada" }).where("id", "=", allocations[1].id).execute();
      const reopened = await reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      expect(reopened).toBe(false);
    });

    await db.transaction().execute(async (trx) => {
      await trx.updateTable("opportunityAllocations").set({ status: "cancelada" }).where("id", "=", allocations[0].id).execute();
      const reopened = await reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      expect(reopened).toBe(true);
    });

    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("aguardando_destinacao");
  });

  it("teste 3: A e B terminam CONCORRENTES -> 0 ativas, exatamente uma reabertura", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" },
      { status: "proposta" },
    ]);
    const [allocA, allocB] = allocations;
    const locked = { a: createDeferred<void>(), b: createDeferred<void>() };

    async function run(allocId: number, finalStatus: "recusada" | "cancelada", signalSelf: () => void, waitOther: Promise<void>) {
      return db.transaction().execute(async (trx) => {
        await trx.selectFrom("opportunityAllocations").select(["id"]).where("id", "=", allocId).forUpdate().executeTakeFirst();
        signalSelf();
        await waitOther; // força as duas allocations travadas antes de qualquer uma tentar travar a oportunidade
        await trx.updateTable("opportunityAllocations").set({ status: finalStatus }).where("id", "=", allocId).execute();
        return reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      });
    }

    const [reopenedA, reopenedB] = await Promise.all([
      run(allocA.id, "cancelada", locked.a.resolve, locked.b.promise),
      run(allocB.id, "recusada", locked.b.resolve, locked.a.promise),
    ]);

    expect([reopenedA, reopenedB].filter(Boolean)).toHaveLength(1);
    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("aguardando_destinacao");
  });

  it("teste 4: tres allocations terminando concorrentemente -> 0 ativas, uma unica reabertura", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" },
      { status: "proposta" },
      { status: "proposta" },
    ]);
    const locked = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];

    async function run(index: number, allocId: number, finalStatus: "recusada" | "cancelada") {
      return db.transaction().execute(async (trx) => {
        await trx.selectFrom("opportunityAllocations").select(["id"]).where("id", "=", allocId).forUpdate().executeTakeFirst();
        locked[index].resolve();
        await Promise.all(locked.filter((_, i) => i !== index).map((d) => d.promise));
        await trx.updateTable("opportunityAllocations").set({ status: finalStatus }).where("id", "=", allocId).execute();
        return reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      });
    }

    const results = await Promise.all([
      run(0, allocations[0].id, "cancelada"),
      run(1, allocations[1].id, "recusada"),
      run(2, allocations[2].id, "recusada"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("aguardando_destinacao");
  });

  it("teste 5: duas allocations terminam concorrentes, uma terceira permanece ativa -> oportunidade NAO reabre", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" }, // vai permanecer ativa
      { status: "proposta" },
      { status: "proposta" },
    ]);
    const locked = { a: createDeferred<void>(), b: createDeferred<void>() };

    async function run(allocId: number, finalStatus: "recusada" | "cancelada", signalSelf: () => void, waitOther: Promise<void>) {
      return db.transaction().execute(async (trx) => {
        await trx.selectFrom("opportunityAllocations").select(["id"]).where("id", "=", allocId).forUpdate().executeTakeFirst();
        signalSelf();
        await waitOther;
        await trx.updateTable("opportunityAllocations").set({ status: finalStatus }).where("id", "=", allocId).execute();
        return reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      });
    }

    const [reopenedByB, reopenedByC] = await Promise.all([
      run(allocations[1].id, "recusada", locked.a.resolve, locked.b.promise),
      run(allocations[2].id, "recusada", locked.b.resolve, locked.a.promise),
    ]);

    expect(reopenedByB).toBe(false);
    expect(reopenedByC).toBe(false);
    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("atribuida"); // não reabriu — allocations[0] ("aceita") ainda ativa
  });

  it("teste 6: depois da reabertura, novo matching pode ocorrer normalmente (oportunidade elegivel de novo)", async () => {
    const { admin, opportunityId, allocations } = await makeOpportunityWithAllocations("reservada", [{ status: "proposta" }]);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("opportunityAllocations").set({ status: "recusada" }).where("id", "=", allocations[0].id).execute();
      const reopened = await reopenOpportunityIfNoActiveAllocations(trx, opportunityId);
      expect(reopened).toBe(true);
    });

    const oppBefore = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(oppBefore.status).toBe("aguardando_destinacao");

    // Não estamos testando a matemática do motor de novo — só que a
    // oportunidade voltou a um status elegível (runMatchingForOpportunity
    // não retorna "skipped" por status).
    const result = await runMatchingForOpportunity(opportunityId, admin.userId);
    expect(result.skipped).toBe(false);
  });

  it("teste 7: reabrir duas vezes não cria duas transições/auditorias indevidas", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("reservada", [{ status: "proposta" }]);
    await db.updateTable("opportunityAllocations").set({ status: "recusada" }).where("id", "=", allocations[0].id).execute();

    const first = await db.transaction().execute((trx) => reopenOpportunityIfNoActiveAllocations(trx, opportunityId));
    expect(first).toBe(true);

    // Chamar de novo (ex.: uma segunda tarefa de expiração processando a
    // mesma oportunidade por engano) — já não está mais em "reservada"/
    // "atribuida", então é um no-op seguro, não uma segunda reabertura.
    const second = await db.transaction().execute((trx) => reopenOpportunityIfNoActiveAllocations(trx, opportunityId));
    expect(second).toBe(false);

    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("aguardando_destinacao"); // não regrediu, não duplicou nada
  });
});

describe("concorrência real entre endpoints/tarefas que compartilham a correção", () => {
  it("cenario A: cancelamento logistico concorrente com novo matching da mesma oportunidade -> sem allocation duplicada", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [{ status: "aceita" }]);
    const ownerRow = allocations[0];

    const logisticsReq = buildRequest("allocations-logistics", {
      method: "POST",
      cookie: ownerRow.ownerCookie,
      body: { organizationId: ownerRow.orgId, allocationId: ownerRow.id, eventType: "cancelado" },
    });

    const [logisticsRes] = await Promise.all([logisticsHandle(logisticsReq), runMatchingForOpportunity(opportunityId, null)]);
    expect(logisticsRes.status).toBe(200);

    const finalAllocations = await db.selectFrom("opportunityAllocations").select(["status"]).where("opportunityRegistryId", "=", opportunityId).execute();
    const activeCount = finalAllocations.filter((a) => a.status !== "recusada" && a.status !== "cancelada").length;
    expect(activeCount).toBeLessThanOrEqual(1); // nunca mais de 1 allocation ativa nova, mesmo com o rematch concorrente
  });

  it("cenario B: cancelamento logistico concorrente com expiração de OUTRA reserva da mesma oportunidade -> reabertura correta, sem estado impossível", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" },
      { status: "proposta" },
    ]);
    const [acceptedRow, proposedRow] = allocations;
    await db.updateTable("opportunityAllocations").set({ reservedUntil: new Date(Date.now() - 1000) }).where("id", "=", proposedRow.id).execute();

    const logisticsReq = buildRequest("allocations-logistics", {
      method: "POST",
      cookie: acceptedRow.ownerCookie,
      body: { organizationId: acceptedRow.orgId, allocationId: acceptedRow.id, eventType: "cancelado" },
    });

    await Promise.all([logisticsHandle(logisticsReq), expireReservations()]);

    const finalAllocations = await db.selectFrom("opportunityAllocations").select(["status"]).where("opportunityRegistryId", "=", opportunityId).execute();
    expect(finalAllocations.every((a) => a.status === "recusada" || a.status === "cancelada")).toBe(true);

    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    // As duas terminaram -> tem que ter reaberto (não fica presa em "atribuida").
    expect(opp.status).toBe("aguardando_destinacao");
  });

  it("cenario C: cancelamento logistico concorrente com decisão humana sobre OUTRA allocation da mesma oportunidade", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" },
      { status: "proposta" },
    ]);
    const [acceptedRow, proposedRow] = allocations;

    const logisticsReq = buildRequest("allocations-logistics", {
      method: "POST",
      cookie: acceptedRow.ownerCookie,
      body: { organizationId: acceptedRow.orgId, allocationId: acceptedRow.id, eventType: "cancelado" },
    });
    const decideReq = buildRequest("allocations-decide", {
      method: "POST",
      cookie: proposedRow.ownerCookie,
      body: { organizationId: proposedRow.orgId, allocationId: proposedRow.id, decision: "recusada" },
    });

    const [logisticsRes, decideRes] = await Promise.all([logisticsHandle(logisticsReq), decideHandle(decideReq)]);
    expect(logisticsRes.status).toBe(200);
    expect(decideRes.status).toBe(200);

    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("aguardando_destinacao"); // as duas terminaram -> reabriu, sem depender de sorte de timing
  });

  it("cenario D: duas operações logísticas simultâneas sobre allocations DIFERENTES da mesma oportunidade -> uma única reabertura", async () => {
    const { opportunityId, allocations } = await makeOpportunityWithAllocations("atribuida", [
      { status: "aceita" },
      { status: "aceita" },
    ]);
    const [rowA, rowB] = allocations;

    const reqA = buildRequest("allocations-logistics", { method: "POST", cookie: rowA.ownerCookie, body: { organizationId: rowA.orgId, allocationId: rowA.id, eventType: "cancelado" } });
    const reqB = buildRequest("allocations-logistics", { method: "POST", cookie: rowB.ownerCookie, body: { organizationId: rowB.orgId, allocationId: rowB.id, eventType: "cancelado" } });

    const [resA, resB] = await Promise.all([logisticsHandle(reqA), logisticsHandle(reqB)]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const opp = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("aguardando_destinacao");

    const matchingExecutadoAudits = await db
      .selectFrom("auditLog")
      .select(["id"])
      .where("action", "=", "matching.executado")
      .where("entityId", "=", String(opportunityId))
      .execute();
    // Cada endpoint chama runMatchingForOpportunity só quando ELE PRÓPRIO reabriu
    // — como só um dos dois efetivamente reabre (o outro vê remainingActive>0
    // no momento em que passa pelo lock, ou já reaberto), no máximo 1 rematch.
    expect(matchingExecutadoAudits.length).toBeLessThanOrEqual(1);
  });
});
