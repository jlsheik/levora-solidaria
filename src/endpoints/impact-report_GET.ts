import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./impact-report_GET.schema";
import { sql } from "kysely";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
    });

    // Prestação de contas é dado sensível: só proprietário/administrador
    // veem, não qualquer membro.
    await requireOrganizationMembership(user.id, input.organizationId, ["proprietario", "administrador"]);

    const org = await db
      .selectFrom("organizations")
      .select(["name"])
      .where("id", "=", input.organizationId)
      .executeTakeFirst();

    // Tudo aqui é calculado ao vivo a partir do ledger real — nunca um
    // número armazenado à parte que poderia ficar desatualizado ou ser
    // editado sem deixar rastro.
    const movementRows = await db
      .selectFrom("stockTransactions")
      .innerJoin("inventoryItems", "inventoryItems.id", "stockTransactions.itemId")
      .select([
        "inventoryItems.id as itemId",
        "inventoryItems.name as itemName",
        "inventoryItems.unit",
        (eb) => eb.fn.coalesce(eb.fn.sum(eb.case().when("stockTransactions.type", "=", "entrada").then(eb.ref("stockTransactions.delta")).else(sql<string>`0`).end()), sql<string>`0`).as("entradas"),
        (eb) => eb.fn.coalesce(eb.fn.sum(eb.case().when("stockTransactions.type", "=", "saida").then(sql<string>`abs(stock_transactions.delta)`).else(sql<string>`0`).end()), sql<string>`0`).as("saidas"),
        (eb) => eb.fn.coalesce(eb.fn.sum(eb.case().when("stockTransactions.type", "=", "ajuste").then(eb.ref("stockTransactions.delta")).else(sql<string>`0`).end()), sql<string>`0`).as("ajustes"),
      ])
      .where("stockTransactions.organizationId", "=", input.organizationId)
      .where("stockTransactions.createdAt", ">=", input.startDate)
      .where("stockTransactions.createdAt", "<=", input.endDate)
      .groupBy(["inventoryItems.id", "inventoryItems.name", "inventoryItems.unit"])
      .execute();

    const currentStockRows = await db
      .selectFrom("stockTransactions")
      .select(["itemId", (eb) => eb.fn.coalesce(eb.fn.sum("delta"), sql<string>`0`).as("total")])
      .where("organizationId", "=", input.organizationId)
      .groupBy("itemId")
      .execute();
    const currentStockByItem = new Map(currentStockRows.map((r) => [r.itemId, Number(r.total)]));

    const receivedTransactions = await db
      .selectFrom("stockTransactions")
      .innerJoin("inventoryItems", "inventoryItems.id", "stockTransactions.itemId")
      .select([
        "stockTransactions.id",
        "inventoryItems.name as itemName",
        "stockTransactions.delta",
        "inventoryItems.unit",
        "stockTransactions.reason",
        "stockTransactions.createdAt",
      ])
      .where("stockTransactions.organizationId", "=", input.organizationId)
      .where("stockTransactions.type", "=", "entrada")
      .where("stockTransactions.createdAt", ">=", input.startDate)
      .where("stockTransactions.createdAt", "<=", input.endDate)
      .orderBy("stockTransactions.createdAt", "desc")
      .execute();

    const needsAbertas = await db
      .selectFrom("needs")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", input.organizationId)
      .where("createdAt", ">=", input.startDate)
      .where("createdAt", "<=", input.endDate)
      .executeTakeFirst();

    const needsAtendidas = await db
      .selectFrom("needs")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", input.organizationId)
      .where("status", "=", "atendida")
      .where("updatedAt", ">=", input.startDate)
      .where("updatedAt", "<=", input.endDate)
      .executeTakeFirst();

    const needsCanceladas = await db
      .selectFrom("needs")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", input.organizationId)
      .where("status", "=", "cancelada")
      .where("updatedAt", ">=", input.startDate)
      .where("updatedAt", "<=", input.endDate)
      .executeTakeFirst();

    const auditCount = await db
      .selectFrom("auditLog")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("organizationId", "=", input.organizationId)
      .where("createdAt", ">=", input.startDate)
      .where("createdAt", "<=", input.endDate)
      .executeTakeFirst();

    return new Response(
      superjson.stringify({
        period: { startDate: input.startDate.toISOString(), endDate: input.endDate.toISOString() },
        organizationName: org?.name ?? "",
        itemMovements: movementRows.map((r) => ({
          itemId: r.itemId,
          itemName: r.itemName,
          unit: r.unit,
          entradas: Number(r.entradas),
          saidas: Number(r.saidas),
          ajustes: Number(r.ajustes),
          netChange: Number(r.entradas) - Number(r.saidas) + Number(r.ajustes),
          currentStock: currentStockByItem.get(r.itemId) ?? 0,
        })),
        receivedTransactions: receivedTransactions.map((t) => ({
          id: String(t.id),
          itemName: t.itemName,
          delta: Number(t.delta),
          unit: t.unit,
          reason: t.reason,
          createdAt: t.createdAt.toString(),
        })),
        needsSummary: {
          abertasNoPeriodo: Number(needsAbertas?.count ?? 0),
          atendidasNoPeriodo: Number(needsAtendidas?.count ?? 0),
          canceladasNoPeriodo: Number(needsCanceladas?.count ?? 0),
        },
        auditEventCount: Number(auditCount?.count ?? 0),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao gerar relatório de impacto:", error);
    const message = error instanceof Error ? error.message : "Falha ao gerar relatório";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
