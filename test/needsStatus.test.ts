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

  describe("baixa automática de estoque ao marcar necessidade vinculada como atendida", () => {
    it("dá baixa automaticamente no item vinculado quando há estoque suficiente", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      const response = await postNeedsStatus(
        buildRequest("needs-status", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, needId: need.id, status: "atendida" },
        })
      );
      expect(response.status).toBe(200);
      expect(await stockBalance(item.id)).toBe(60);

      const auditEntry = await db
        .selectFrom("auditLog")
        .select(["action", "metadata"])
        .where("entityType", "=", "inventory_item")
        .where("entityId", "=", String(item.id))
        .executeTakeFirst();
      expect(auditEntry?.action).toBe("inventario.saida_registrada");
    });

    it("bloqueia (409) e não altera o status quando o estoque do item vinculado é insuficiente", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 10, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      const response = await postNeedsStatus(
        buildRequest("needs-status", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, needId: need.id, status: "atendida" },
        })
      );
      expect(response.status).toBe(409);
      expect(await stockBalance(item.id)).toBe(10); // nenhuma transação de saída foi criada

      const stillOpen = await db.selectFrom("needs").select(["status"]).where("id", "=", need.id).executeTakeFirstOrThrow();
      expect(stillOpen.status).toBe("aberta");
    });

    it("não dá baixa quando a necessidade não está vinculada a um item de inventário", async () => {
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
    });

    it("não dá baixa de novo ao reenviar 'atendida' para uma necessidade que já estava atendida (idempotência)", async () => {
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: 100, createdByUserId: owner.userId }).execute();
      const need = await createNeed(orgId, owner.userId, { itemId: item.id, quantityNeeded: 40 });

      await postNeedsStatus(
        buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
      );
      expect(await stockBalance(item.id)).toBe(60);

      // Reenviar o mesmo status "atendida" não deve gerar uma segunda saída.
      await postNeedsStatus(
        buildRequest("needs-status", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, needId: need.id, status: "atendida" } })
      );
      expect(await stockBalance(item.id)).toBe(60);
    });

    it("concorrência: duas requisições simultâneas marcando a mesma necessidade como 'atendida' resultam em exatamente UMA baixa de estoque (Fase 35 — FOR UPDATE na linha da need)", async () => {
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
      expect(await stockBalance(item.id)).toBe(60);

      const stockOutCount = await db
        .selectFrom("stockTransactions")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("itemId", "=", item.id)
        .where("type", "=", "saida")
        .executeTakeFirstOrThrow();
      expect(Number(stockOutCount.count)).toBe(1);

      const finalNeed = await db.selectFrom("needs").select(["status"]).where("id", "=", need.id).executeTakeFirstOrThrow();
      expect(finalNeed.status).toBe("atendida");

      // As duas requisições respondem com sucesso (200) — a segunda observa a
      // need já atendida e simplesmente não dá baixa de novo (idempotente sob
      // concorrência, nunca um erro/409 nem uma segunda saída).
      expect(responseA.status).toBe(200);
      expect(responseB.status).toBe(200);
    });
  });
});
