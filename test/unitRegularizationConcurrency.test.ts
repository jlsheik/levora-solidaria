/**
 * Fase 99C — concorrência da regularização de unidades (PostgreSQL real). Ordem de travas documentada: atribuição|doação → item → caso → oferta da rede → auditoria.
 * Onde precisa de determinismo, a trava é segurada numa conexão própria e só é solta quando as chamadas já estão bloqueadas.
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { expireAssignmentDeadlines } from "../src/helpers/expireAssignmentDeadlines";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { handle as logisticsHandle } from "../src/endpoints/allocations-logistics_POST";
import { handle as conferHandle } from "../src/endpoints/unit-regularization-confer_POST";
import { handle as validateHandle } from "../src/endpoints/unit-regularization-validate_POST";
import { handle as closeHandle } from "../src/endpoints/unit-regularization-close_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource } from "./helpers";

const side = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => { await side.end({ timeout: 5 }); });
const post = (path: string, cookie: string, body: unknown) => buildRequest(path, { method: "POST", cookie, body });

async function waitBlocked(n: number) {
  let c = 0;
  for (let i = 0; i < 400 && c < n; i++) {
    c = (await side`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0].n;
    if (c < n) await new Promise((r) => setTimeout(r, 25));
  }
  return c;
}

async function net(o: { offerUnit: string | null; itemUnit: string; deadlinePast?: boolean }) {
  const owner = await createAuthenticatedUser();
  const second = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  await addMembership(org.id, second.userId, "administrador");
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: o.itemUnit });
  const platform = await createPlatformAdmin();
  const source = await createTestSource(platform.userId);
  const registry = await createTestOpportunityRegistry(source.id, platform.userId, { status: "reservada", unit: o.offerUnit });
  const [allocation] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: registry.id, organizationId: org.id, status: "aceita", quantityAllocated: "10", autoMatched: o.deadlinePast === true, responseDueAt: o.deadlinePast ? sql<Date>`now() - interval '1 hour'` : null })
    .returning("id")
    .execute();
  return { owner, second, org, item, allocId: allocation.id };
}
type Net = Awaited<ReturnType<typeof net>>;
const receive = (n: Net, itemId = n.item.id) => receiveHandle(post("allocations-receive", n.owner.cookie, { organizationId: n.org.id, allocationId: n.allocId, itemId, quantityReceived: 10 }));
const confer = (n: Net, caseId: number, cookie = n.owner.cookie) => conferHandle(post("unit-regularization-confer", cookie, { organizationId: n.org.id, caseId, checkedQuantity: 9, reason: "Contagem direta na entrada: 9 kg" }));
const validate = (n: Net, caseId: number, cookie = n.second.cookie) => validateHandle(post("unit-regularization-validate", cookie, { organizationId: n.org.id, caseId, decision: "aprovar", note: "" }));
const logistics = (n: Net, eventType: string) => logisticsHandle(post("allocations-logistics", n.owner.cookie, { organizationId: n.org.id, allocationId: n.allocId, eventType }));
const stockRows = (itemId: number) => db.selectFrom("stockTransactions").selectAll().where("itemId", "=", itemId).execute();
const ledgerRows = (allocId: number) => db.selectFrom("needFulfillments").selectAll().where("allocationId", "=", allocId).execute();
const caseRows = (allocId: number) => db.selectFrom("unitRegularizationCases").selectAll().where("allocationId", "=", allocId).execute();
const allocStatus = async (id: number) => (await db.selectFrom("opportunityAllocations").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const statuses = (rs: Response[]) => rs.map((r) => r.status).sort();

async function conferred(n: Net) {
  expect((await receive(n)).status).toBe(202);
  const [c] = await caseRows(n.allocId);
  expect((await confer(n, c.id)).status).toBe(200);
  return c;
}

describe("recebimento concorrente", () => {
  it("41: dois recebimentos simultâneos com divergência criam UM caso (ambos 202) e nenhum estoque", async () => {
    const n = await net({ offerUnit: "caixa", itemUnit: "kg" });
    const rs = await Promise.all([receive(n), receive(n), receive(n)]);
    expect(statuses(rs)).toEqual([202, 202, 202]);
    expect(await caseRows(n.allocId)).toHaveLength(1);
    expect(await stockRows(n.item.id)).toHaveLength(0);
    expect(await ledgerRows(n.allocId)).toHaveLength(0);
  });

  it("40: dois recebimentos simultâneos compatíveis criam UMA entrada (um 200 e um 409)", async () => {
    const n = await net({ offerUnit: "kg", itemUnit: "kg" });
    const rs = await Promise.all([receive(n), receive(n)]);
    expect(statuses(rs)).toEqual([200, 409]);
    expect(await stockRows(n.item.id)).toHaveLength(1);
    expect(await ledgerRows(n.allocId)).toHaveLength(1);
  });
});

describe("resolução concorrente", () => {
  it("43: duas validações simultâneas deixam UMA decisão válida e UMA entrada de estoque", async () => {
    const n = await net({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await conferred(n);
    const rs = await Promise.all([validate(n, c.id), validate(n, c.id, n.second.cookie)]);
    expect(statuses(rs)).toEqual([200, 409]);
    expect(await stockRows(n.item.id)).toHaveLength(1);
    expect(await ledgerRows(n.allocId)).toHaveLength(1);
    expect((await caseRows(n.allocId))[0].status).toBe("resolvido");
  });

  it("duas conferências simultâneas: uma vale, a outra é recusada; validar e encerrar ao mesmo tempo: um vence e o estado final é coerente", async () => {
    const n = await net({ offerUnit: "caixa", itemUnit: "kg" });
    expect((await receive(n)).status).toBe(202);
    const [c] = await caseRows(n.allocId);
    expect(statuses(await Promise.all([confer(n, c.id), confer(n, c.id, n.second.cookie)]))).toEqual([200, 409]);

    // quem validou não pode ser quem conferiu (regra da segunda validação): escolhe o outro administrador
    const [afterConfer] = await caseRows(n.allocId);
    const validatorCookie = afterConfer.conferredByUserId === n.owner.userId ? n.second.cookie : n.owner.cookie;
    const rs = await Promise.all([
      validate(n, c.id, validatorCookie),
      closeHandle(post("unit-regularization-close", n.owner.cookie, { organizationId: n.org.id, caseId: c.id, category: "informacao_insuficiente", reason: "Encerrado por falta de dados do doador" })),
    ]);
    expect(statuses(rs)).toEqual([200, 409]);
    const [row] = await caseRows(n.allocId);
    if (row.status === "resolvido") {
      expect(await stockRows(n.item.id)).toHaveLength(1);
      expect(await allocStatus(n.allocId)).toBe("recebida");
    } else {
      expect(row.status).toBe("encerrado");
      expect(await stockRows(n.item.id)).toHaveLength(0);
      expect(await allocStatus(n.allocId)).toBe("aceita");
    }
  });

  it("44: validar concorrente com cancelar a atribuição: o cancelamento é recusado, a resolução vale e o estado final é coerente", async () => {
    const n = await net({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await conferred(n);
    const [v, x] = await Promise.all([validate(n, c.id), logistics(n, "cancelado")]);
    expect(v.status).toBe(200);
    expect(x.status).toBe(409);
    expect(await allocStatus(n.allocId)).toBe("recebida");
    expect(await stockRows(n.item.id)).toHaveLength(1);
  });

  it("45: validar concorrente com a expiração por prazo: a atribuição não expira e o recebimento é lançado uma vez", async () => {
    const n = await net({ offerUnit: "caixa", itemUnit: "kg", deadlinePast: true });
    const c = await conferred(n);
    const [v] = await Promise.all([validate(n, c.id), expireAssignmentDeadlines()]);
    expect(v.status).toBe(200);
    expect(await allocStatus(n.allocId)).toBe("recebida");
    expect(await stockRows(n.item.id)).toHaveLength(1);
  });

  it("42: com a trava da atribuição segurada, recebimento e validação esperam e, soltos, produzem UM resultado coerente (sem estoque duplicado)", async () => {
    const n = await net({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await conferred(n);
    const holder = await side.reserve();
    await holder`BEGIN`;
    await holder`SELECT id FROM opportunity_allocations WHERE id = ${n.allocId} FOR UPDATE`;
    const pending = Promise.all([validate(n, c.id), receive(n)]);
    expect(await waitBlocked(2)).toBeGreaterThanOrEqual(2);
    await holder`COMMIT`;
    holder.release();
    const [v, r] = await pending;
    expect(v.status).toBe(200);
    // as duas ordens são coerentes: o recebimento entrou primeiro e viu o caso ativo (202, nada lançado) ou entrou depois da resolução e viu a atribuição recebida (409)
    expect([202, 409]).toContain(r.status);
    expect(await stockRows(n.item.id)).toHaveLength(1);
    expect(await ledgerRows(n.allocId)).toHaveLength(1);
  });
});

describe("47: ordem de travas e ausência de deadlock", () => {
  it("operações misturadas sobre o mesmo item e atribuições vizinhas terminam todas, sem 'deadlock detected'", async () => {
    const a = await net({ offerUnit: "caixa", itemUnit: "kg" });
    // segunda atribuição da MESMA organização e do MESMO item (disputa a trava do item)
    const platform = await createPlatformAdmin();
    const source = await createTestSource(platform.userId);
    const registry2 = await createTestOpportunityRegistry(source.id, platform.userId, { status: "reservada", unit: "caixa" });
    const [alloc2] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: registry2.id, organizationId: a.org.id, status: "aceita", quantityAllocated: "4" }).returning("id").execute();
    const b = { ...a, allocId: alloc2.id };
    const c1 = await conferred(a);
    expect((await receive(b)).status).toBe(202);
    const [c2] = await caseRows(b.allocId);
    const results = await Promise.allSettled([validate(a, c1.id), confer(b, c2.id), receive(a), receive(b), logistics(b, "coleta_agendada"), logistics(a, "cancelado"), expireAssignmentDeadlines()]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled" && r.value instanceof Response) {
        expect(r.value.status, await r.value.clone().text()).toBeLessThan(500);
      }
    }
    expect(await stockRows(a.item.id)).toHaveLength(1); // só a atribuição A foi resolvida
  });
});
