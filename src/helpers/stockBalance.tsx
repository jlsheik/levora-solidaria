import type { Transaction } from "kysely";
import { sql } from "kysely";
import type { DB } from "./schema.js";

/**
 * Saldo atual de um item de estoque: soma de stock_transactions.delta.
 * Única fonte de verdade para este cálculo de saldo de um item — antes
 * duplicado, com a mesma query literal, em 5 endpoints diferentes (risco
 * real de um dia divergir, ex. um lugar esquecer o coalesce e quebrar em
 * saldo zerado).
 *
 * Recebe `trx` (não `db`) de propósito: todo chamador precisa deste saldo
 * dentro de uma transação que em seguida grava um novo lançamento com base
 * nele — sem isso, duas requisições concorrentes poderiam ler o mesmo
 * saldo "antigo" e ambas aprovarem uma baixa que juntas deixam o estoque
 * negativo.
 */
export async function getItemStockBalance(trx: Transaction<DB>, itemId: number): Promise<number> {
  const stockRow = await trx
    .selectFrom("stockTransactions")
    .select((eb) => eb.fn.coalesce(eb.fn.sum("delta"), sql<string>`0`).as("total"))
    .where("itemId", "=", itemId)
    .executeTakeFirst();
  return Number(stockRow?.total ?? 0);
}
