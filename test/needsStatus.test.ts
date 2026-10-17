import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postNeedsStatus } from "../src/endpoints/needs-status_POST";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestInventoryItem,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";
import { attendNeedForTest } from "./attendHelper";

async function createNeed(organizationId: number, userId: number, overrides: { itemId?: number; quantityNeeded?: number } = {}) {
  const [need] = await db
    .insertInto("needs")
    .values({
      organizationId,
      title: "40 cobertores para o inverno",
      itemId: overrides.itemId ?? null,
      quantityNeeded: overrides.quantityNeeded ?? 40,
      unit: "unidade",
      priority: "alta",
      createdByUserId: userId,
    })
    .returning(["id", "status", "itemId", "quantityNeeded"])
    .execute();
  return need;
}

async function stockBalance(itemId: number): Promise<number> {
  const row = await db
    .selectFrom("stockTransactions")
    .select((eb) => eb.fn.sum("delta").as("total"))
    .where("itemId", "=", itemId)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

async function saidaCount(itemId: number): Promise<number> {
  const row = await db
    .selectFrom("stockTransactions")
    .select((eb) => eb.fn.countAll().as("c"))
    .where("itemId", "=", itemId)
    .where("type", "=", "saida")
    .executeTakeFirst();
  return Number(row?.c ?? 0);
}

async function resolutionCount(needId: number): Promise<number> {
  const row = await db.selectFrom("needResolutions").select((eb) => eb.fn.countAll().as("c")).where("needId", "=", needId).executeTakeFirst();
  return Number(row?.c ?? 0);
}

describe("POST /needs-status", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
  });

  const setStatusOf = (needId: number, status: "aberta" | "atendida" | "cancelada", cookie = owner.cookie) =>
    postNeedsStatus(buildRequest("needs-status", { method: "POST", cookie, body: { organizationId: orgId, needId, status } }));
  const attend = (needId: number, quantity?: number) => attendNeedForTest({ orgId, userId: owner.userId, cookie: owner.cookie, needId, quantity });

  it("Fase 99F: 'atendida' manual só é aceita quando as destinações cobrem a quantidade; 'cancelada' só pelo encerramento com motivo", async () => {
    const item = await createTestInventoryItem(orgId, owner.userId);
    const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

    const refused = await setStatusOf(need.id, "atendida");
    expect(refused.status).toBe(409);
    expect(await parseJson<{ code: string; progress: { attended: number; remaining: number } }>(refused)).toMatchObject({ code: "atendimento_insuficiente", progress: { attended: 0, remaining: 40 } });

    const cancel = await setStatusOf(need.id, "cancelada");
    expect(cancel.status).toBe(409);
    expect((await parseJson<{ code: string }>(cancel)).code).toBe("encerramento_exige_motivo");
    expect((await db.selectFrom("needs").select("status").where("id", "=", need.id).executeTakeFirstOrThrow()).status).toBe("aberta");

    // atendimento parcial continua recusando; a destinação que completa torna a necessidade 'atendida' automaticamente
    expect((await attend(need.id, 15)).status).toBe(200);
    expect((await setStatusOf(need.id, "atendida")).status).toBe(409);
    expect((await attend(need.id, 25)).status).toBe(200);
    expect((await db.selectFrom("needs").select("status").where("id", "=", need.id).executeTakeFirstOrThrow()).status).toBe("atendida");
    expect((await setStatusOf(need.id, "atendida")).status).toBe(200); // idempotente
  });

  it("atendida por destinações NÃO é reaberta por um clique (a correção é a reversão da destinação); a necessidade histórica sem destinação pode ser reaberta", async () => {
    const item = await createTestInventoryItem(orgId, owner.userId);
    const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 10 });
    expect((await attend(need.id)).status).toBe(200);
    const refused = await setStatusOf(need.id, "aberta");
    expect(refused.status).toBe(409);
    expect((await parseJson<{ code: string }>(refused)).code).toBe("atendida_por_destinacao");

    const historical = await createNeed(orgId, owner.userId, { quantityNeeded: 10 });
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", historical.id).execute(); // registro anterior à 99F: sem destinação estruturada
    expect((await setStatusOf(historical.id, "aberta")).status).toBe(200);
  });

  it("grava evento de auditoria ao confirmar uma situação permitida (reabrir um registro histórico)", async () => {
    const need = await createNeed(orgId, owner.userId);
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", need.id).execute();

    const response = await setStatusOf(need.id, "aberta");
    expect(response.status).toBe(200);
    expect((await parseJson<{ need: { status: string } }>(response)).need.status).toBe("aberta");

    const auditEntry = await db.selectFrom("auditLog").select(["action", "entityId"]).where("entityType", "=", "need").where("entityId", "=", String(need.id)).executeTakeFirst();
    expect(auditEntry?.action).toBe("necessidade.status_alterado");
  });

  it("retorna 404 ao tentar alterar, pela própria organização, uma necessidade que pertence a outra organização", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const need = await createNeed(otherOrg.id, otherOwner.userId);

    // owner é membro de orgId (passa na checagem de acesso), mas a necessidade pertence a otherOrg — o filtro por organizationId no SELECT garante o isolamento.
    expect((await setStatusOf(need.id, "atendida")).status).toBe(404);
  });

  it("retorna 403 quando o usuário não é membro da organização informada", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const need = await createNeed(otherOrg.id, otherOwner.userId);

    const response = await postNeedsStatus(
      buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: otherOrg.id, needId: need.id, status: "atendida" } })
    );
    expect(response.status).toBe(403);
  });

  it("retorna 404 quando a necessidade não existe na organização informada", async () => {
    expect((await setStatusOf(999999, "atendida")).status).toBe(404);
  });

  describe("Fases 99E/99F: o status nunca baixa estoque (a saída física só nasce no registro de destinação)", () => {
    it("tentativa de 'atendida' sem destinações NÃO muda o estoque, não cria saída nem auditoria de saída nem resolução", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      expect((await setStatusOf(need.id, "atendida")).status).toBe(409);
      expect(await stockBalance(item.id)).toBe(100);
      expect(await saidaCount(item.id)).toBe(0);
      const auditEntry = await db.selectFrom("auditLog").select(["action"]).where("entityType", "=", "inventory_item").where("entityId", "=", String(item.id)).executeTakeFirst();
      expect(auditEntry).toBeUndefined();
      expect(await resolutionCount(need.id)).toBe(0);
    });

    it("o atendimento por destinação baixa exatamente a quantidade destinada (uma saída) e reenviar 'atendida' é idempotente: sem nova saída nem resolução", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });
      expect((await attend(need.id)).status).toBe(200); // entrada de 2000, saída de 40
      expect(await stockBalance(item.id)).toBe(1960);
      expect(await saidaCount(item.id)).toBe(1);

      expect((await setStatusOf(need.id, "atendida")).status).toBe(200);
      expect((await setStatusOf(need.id, "atendida")).status).toBe(200);
      expect(await stockBalance(item.id)).toBe(1960);
      expect(await saidaCount(item.id)).toBe(1);
      expect(await resolutionCount(need.id)).toBe(0);
    });

    it("concorrência: duas requisições simultâneas de 'atendida' em necessidade JÁ atendida resultam em 200/200, sem nova saída", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });
      expect((await attend(need.id)).status).toBe(200);
      const [a, b] = await Promise.all([setStatusOf(need.id, "atendida"), setStatusOf(need.id, "atendida")]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await saidaCount(item.id)).toBe(1);
      expect((await db.selectFrom("needs").select("status").where("id", "=", need.id).executeTakeFirstOrThrow()).status).toBe("atendida");
    });

    it("concorrência: duas requisições simultâneas de 'atendida' em necessidade SEM atendimento: ambas 409, nada muda", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });
      const [a, b] = await Promise.all([setStatusOf(need.id, "atendida"), setStatusOf(need.id, "atendida")]);
      expect([a.status, b.status]).toEqual([409, 409]);
      expect(await stockBalance(item.id)).toBe(100);
      expect((await db.selectFrom("needs").select("status").where("id", "=", need.id).executeTakeFirstOrThrow()).status).toBe("aberta");
    });
  });

  describe("Fase 40 — need_resolutions: tabela append-only (desde a 99F nenhum fluxo novo a escreve)", () => {
    async function setup() {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 1000, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });
      return { item, need };
    }

    it("ciclos de status (histórico atendida ↔ aberta) nunca geram resolução nem baixa", async () => {
      const { item, need } = await setup();
      for (let i = 0; i < 3; i++) {
        await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", need.id).execute();
        expect((await setStatusOf(need.id, "aberta")).status).toBe(200);
      }
      expect(await resolutionCount(need.id)).toBe(0);
      expect(await saidaCount(item.id)).toBe(0);
      expect(await stockBalance(item.id)).toBe(1000);
    });

    it("integridade: uma segunda linha em need_resolutions para a MESMA need é rejeitada pela constraint UNIQUE(need_id)", async () => {
      const { need } = await setup();
      await db.insertInto("needResolutions").values({ needId: need.id, stockTransactionId: null, createdByUserId: owner.userId }).execute();

      await expect(
        db.insertInto("needResolutions").values({ needId: need.id, stockTransactionId: null, createdByUserId: owner.userId }).execute()
      ).rejects.toThrow(/need_resolutions_need_id_key/);
    });

    it("integridade: o mesmo stock_transaction_id em duas resoluções (de needs diferentes) é rejeitado pelo índice único parcial", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const [tx] = await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "saida", delta: -10, createdByUserId: owner.userId }).returning(["id"]).execute();
      const needA = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 10 });
      const needB = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 10 });

      await db.insertInto("needResolutions").values({ needId: needA.id, stockTransactionId: tx.id, createdByUserId: owner.userId }).execute();

      await expect(
        db.insertInto("needResolutions").values({ needId: needB.id, stockTransactionId: tx.id, createdByUserId: owner.userId }).execute()
      ).rejects.toThrow(/idx_need_resolutions_stock_transaction/);
    });

    it("integridade: need_resolutions é append-only — UPDATE e DELETE são bloqueados pelo trigger", async () => {
      const { need } = await setup();
      const [resolution] = await db
        .insertInto("needResolutions")
        .values({ needId: need.id, stockTransactionId: null, createdByUserId: owner.userId })
        .returning(["id"])
        .execute();

      await expect(db.updateTable("needResolutions").set({ stockTransactionId: null }).where("id", "=", resolution.id).execute()).rejects.toThrow();
      await expect(db.deleteFrom("needResolutions").where("id", "=", resolution.id).execute()).rejects.toThrow();
    });
  });
});
