import { randomBytes } from "node:crypto";
import { db } from "../src/helpers/db";
import { businessDateOf } from "../src/helpers/businessDate";
import { handle as destHandle } from "../src/endpoints/stock-destinations_POST";
import { buildRequest } from "./helpers";

/**
 * Atende a necessidade (parcial ou integralmente) pelo CAMINHO REAL da 99E/99F: dá entrada de estoque larga o bastante para não disparar a regra de risco, e registra uma
 * destinação de atendimento vinculada à necessidade. Devolve a resposta do endpoint. Pré-requisito: necessidade com item de mesma unidade.
 */
export async function attendNeedForTest(opts: { orgId: number; userId: number; cookie: string; needId: number; quantity?: number; extra?: Record<string, unknown> }) {
  const need = await db.selectFrom("needs").select(["itemId", "quantityNeeded"]).where("id", "=", opts.needId).executeTakeFirstOrThrow();
  if (need.itemId == null) throw new Error("attendNeedForTest exige necessidade com item");
  const quantity = opts.quantity ?? Number(need.quantityNeeded);
  await db.insertInto("stockTransactions").values({ organizationId: opts.orgId, itemId: need.itemId, type: "entrada", delta: String(quantity * 50), reason: "estoque para atendimento", createdByUserId: opts.userId }).execute();
  return destHandle(
    buildRequest("stock-destinations", {
      method: "POST",
      cookie: opts.cookie,
      body: {
        organizationId: opts.orgId,
        itemId: need.itemId,
        quantity,
        destinationType: "distribuicao_familias",
        needId: opts.needId,
        deliveredOn: businessDateOf(new Date()),
        idempotencyKey: `k-${randomBytes(8).toString("hex")}`,
        ...opts.extra,
      },
    })
  );
}
