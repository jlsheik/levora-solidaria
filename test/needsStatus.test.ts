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

  it("permite livremente qualquer transição entre aberta/atendida/cancelada (não é uma máquina de estados — decisão de produto ainda pendente, fora do escopo da Fase 35)", async () => {
    // Sem item vinculado: nenhuma baixa de estoque entra no caminho, então
    // este teste isola exatamente a permissividade de transição, que a trava
    // FOR UPDATE (Fase 35) não deve restringir de forma nenhuma.
    const need = await createNeed(orgId, owner.userId);
    const setStatus = (status: "aberta" | "atendida" | "cancelada") =>
      postNeedsStatus(buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status } }));

    for (const status of ["aberta", "cancelada", "atendida", "aberta", "cancelada", "atendida"] as const) {
      const response = await setStatus(status);
      expect(response.status).toBe(200);
      const data = await parseJson<{ need: { status: string } }>(response);
      expect(data.need.status).toBe(status);
    }
  });

  it("atualiza o status da necessidade e grava evento de auditoria", async () => {
    const need = await createNeed(orgId, owner.userId);

    const response = await postNeedsStatus(
      buildRequest("needs-status", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, needId: need.id, status: "atendida" },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ need: { status: string } }>(response);
    expect(data.need.status).toBe("atendida");

    const auditEntry = await db
      .selectFrom("auditLog")
      .select(["action", "entityId"])
      .where("entityType", "=", "need")
      .where("entityId", "=", String(need.id))
      .executeTakeFirst();
    expect(auditEntry?.action).toBe("necessidade.status_alterado");
  });

  it("retorna 404 ao tentar alterar, pela própria organização, uma necessidade que pertence a outra organização", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const need = await createNeed(otherOrg.id, otherOwner.userId);

    // owner é membro de orgId (passa na checagem de acesso), mas a
    // necessidade pertence a otherOrg — o filtro por organizationId no
    // SELECT é o que garante o isolamento aqui, não deve encontrar nada.
    const response = await postNeedsStatus(
      buildRequest("needs-status", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, needId: need.id, status: "atendida" },
      })
    );
    expect(response.status).toBe(404);
  });

  it("retorna 403 quando o usuário não é membro da organização informada", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const need = await createNeed(otherOrg.id, otherOwner.userId);

    const response = await postNeedsStatus(
      buildRequest("needs-status", {
        method: "POST",
        cookie: owner.cookie, // owner não é membro de otherOrg
        body: { organizationId: otherOrg.id, needId: need.id, status: "atendida" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("retorna 404 quando a necessidade não existe na organização informada", async () => {
    const response = await postNeedsStatus(
      buildRequest("needs-status", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, needId: 999999, status: "atendida" },
      })
    );
    expect(response.status).toBe(404);
  });

  describe("Fase 99E: marcar como atendida NÃO baixa estoque (a saída física só nasce no registro de destinação)", () => {
    it("NÃO dá baixa no item vinculado: o estoque não muda, não há saída nem auditoria de saída, e a resolução é declarativa", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      const response = await postNeedsStatus(
        buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
      );
      expect(response.status).toBe(200);
      expect(await stockBalance(item.id)).toBe(100);
      expect(await saidaCount(item.id)).toBe(0);
      const auditEntry = await db.selectFrom("auditLog").select(["action"]).where("entityType", "=", "inventory_item").where("entityId", "=", String(item.id)).executeTakeFirst();
      expect(auditEntry).toBeUndefined();

      // a resolução administrativa continua existindo, sem lastro físico (stockTransactionId nulo)
      const resolution = await db.selectFrom("needResolutions").selectAll().where("needId", "=", need.id).executeTakeFirstOrThrow();
      expect(resolution.stockTransactionId).toBeNull();
      expect(resolution.createdByUserId).toBe(owner.userId);
    });

    it("saldo insuficiente do item vinculado não bloqueia mais o status (não há baixa): 200, estoque intacto, resolução declarativa", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 10, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      const response = await postNeedsStatus(
        buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
      );
      expect(response.status).toBe(200);
      expect(await stockBalance(item.id)).toBe(10);
      expect(await saidaCount(item.id)).toBe(0);
      expect(await resolutionCount(need.id)).toBe(1);
    });

    it("não dá baixa quando a necessidade não está vinculada a um item de inventário, mas cria uma resolução puramente declarativa (Fase 40)", async () => {
      const need = await createNeed(orgId, owner.userId, { quantityNeeded: 40 });

      const response = await postNeedsStatus(
        buildRequest("needs-status", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, needId: need.id, status: "atendida" },
        })
      );
      expect(response.status).toBe(200);

      const auditEntry = await db.selectFrom("auditLog").select(["action"]).where("entityType", "=", "inventory_item").executeTakeFirst();
      expect(auditEntry).toBeUndefined();

      const resolution = await db.selectFrom("needResolutions").selectAll().where("needId", "=", need.id).executeTakeFirstOrThrow();
      expect(resolution.stockTransactionId).toBeNull();
    });

    it("não há baixa e a resolução não se repete ao reenviar 'atendida' para uma necessidade que já estava atendida (idempotência)", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      await postNeedsStatus(
        buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
      );
      expect(await stockBalance(item.id)).toBe(100);

      // Reenviar o mesmo status "atendida" não deve gerar uma segunda saída.
      await postNeedsStatus(
        buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
      );
      expect(await stockBalance(item.id)).toBe(100);
      expect(await resolutionCount(need.id)).toBe(1);
    });

    it("concorrência: duas requisições simultâneas marcando a mesma necessidade como 'atendida' resultam em UMA resolução e NENHUMA baixa de estoque (Fase 35 — FOR UPDATE na linha da need; Fase 99E — sem baixa)", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      const [responseA, responseB] = await Promise.all([
        postNeedsStatus(
          buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
        ),
        postNeedsStatus(
          buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
        ),
      ]);

      // Sem a trava (FOR UPDATE), a race deterministicamente reproduzida na
      // auditoria fazia as duas requisições lerem status="aberta" antes de
      // qualquer commit e ambas darem baixa — saldo cairia para 20 (dupla
      // baixa de 40) em vez de 60 (baixa única).
      expect(await stockBalance(item.id)).toBe(100);

      const stockOutCount = await db
        .selectFrom("stockTransactions")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("itemId", "=", item.id)
        .where("type", "=", "saida")
        .executeTakeFirstOrThrow();
      expect(Number(stockOutCount.count)).toBe(0);

      const finalNeed = await db.selectFrom("needs").select(["status"]).where("id", "=", need.id).executeTakeFirstOrThrow();
      expect(finalNeed.status).toBe("atendida");

      // As duas requisições respondem com sucesso (200) — a segunda observa a
      // need já atendida e simplesmente não dá baixa de novo (idempotente sob
      // concorrência, nunca um erro/409 nem uma segunda saída).
      expect(responseA.status).toBe(200);
      expect(responseB.status).toBe(200);
      expect(await resolutionCount(need.id)).toBe(1);
    });
  });

  describe("Fase 40 — need_resolutions: no máximo uma resolução em toda a vida da need (e, desde a 99E, nenhuma baixa)", () => {
    async function setup() {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 1000, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });
      return { item, need };
    }

    function setStatus(needId: number, status: "aberta" | "atendida" | "cancelada") {
      return postNeedsStatus(buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId, status } }));
    }

    it("aberta -> atendida -> aberta -> atendida: apenas 1 resolução e 1 baixa em todo o histórico", async () => {
      const { item, need } = await setup();
      await setStatus(need.id, "atendida");
      await setStatus(need.id, "aberta");
      const r = await setStatus(need.id, "atendida");

      expect(r.status).toBe(200);
      expect(await resolutionCount(need.id)).toBe(1);
      expect(await saidaCount(item.id)).toBe(0);
      expect(await stockBalance(item.id)).toBe(1000);
      const finalNeed = await db.selectFrom("needs").select(["status"]).where("id", "=", need.id).executeTakeFirstOrThrow();
      expect(finalNeed.status).toBe("atendida");
    });

    it("atendida -> aberta -> cancelada -> atendida: apenas 1 resolução e 1 baixa", async () => {
      const { item, need } = await setup();
      await setStatus(need.id, "atendida");
      await setStatus(need.id, "aberta");
      await setStatus(need.id, "cancelada");
      const r = await setStatus(need.id, "atendida");

      expect(r.status).toBe(200);
      expect(await resolutionCount(need.id)).toBe(1);
      expect(await saidaCount(item.id)).toBe(0);
    });

    it("múltiplos ciclos administrativos (aberta<->atendida repetido 3x): continua 1 resolução e 1 baixa", async () => {
      const { item, need } = await setup();
      for (let i = 0; i < 3; i++) {
        await setStatus(need.id, "atendida");
        await setStatus(need.id, "aberta");
      }
      const r = await setStatus(need.id, "atendida");

      expect(r.status).toBe(200);
      expect(await resolutionCount(need.id)).toBe(1);
      expect(await saidaCount(item.id)).toBe(0);
      expect(await stockBalance(item.id)).toBe(1000);
    });

    it("concorrência APÓS reabertura: duas tentativas simultâneas de reatender não duplicam resolução nem baixa", async () => {
      const { item, need } = await setup();
      await setStatus(need.id, "atendida");
      await setStatus(need.id, "aberta");

      const [a, b] = await Promise.all([setStatus(need.id, "atendida"), setStatus(need.id, "atendida")]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(await resolutionCount(need.id)).toBe(1);
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
