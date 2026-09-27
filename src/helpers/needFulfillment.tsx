import type { Transaction } from "kysely";
import type { DB } from "./schema";
import { normalize } from "./opportunityMatching";

/**
 * Ledger append-only de atendimento de necessidades (`need_fulfillments`
 * — ver db/migrations/0006_need_fulfillments.sql para o comentário
 * arquitetural completo). Registra o FATO FÍSICO de que um recebimento de
 * doação contribuiu para uma necessidade — sem transformar
 * `needs.quantity_needed` num contador mutável, sem alterar
 * `needs.status`, e sem tocar no motor de matching (`opportunityMatching.tsx`
 * é só consultado aqui pela função pura `normalize`, exportada — nada no
 * motor é chamado nem alterado).
 *
 * `quantity`/`unit` registrados aqui são sempre os do RECEBIMENTO real
 * (`quantityReceived`), nunca `quantityAllocated` nem `quantityNeeded` —
 * este ledger é sobre o que aconteceu de verdade, não sobre a expectativa.
 *
 * Chamado por `allocations-receive_POST.ts`, dentro da mesma transação do
 * recebimento, depois de a `stock_transaction` já existir (precisa do seu
 * `id`) e depois de a allocation já estar marcada `"recebida"`.
 */
export interface CreateNeedFulfillmentInput {
  organizationId: number;
  allocationId: number;
  // stock_transactions.id é BIGSERIAL — o driver devolve como string (ver
  // tipo `Int8` em schema.tsx), nunca um `number` JS de verdade.
  stockTransactionId: string;
  quantity: number;
  unit: string;
  createdByUserId: number | null;
}

export async function createNeedFulfillment(trx: Transaction<DB>, input: CreateNeedFulfillmentInput): Promise<void> {
  // Resolve needId pela relação estrutural real que já existe hoje:
  // opportunity_allocations.id → match_evaluations.allocation_id →
  // match_evaluations.need_id. `allocationId` só é gravado em
  // `match_evaluations` no momento em que o motor cria aquela allocation
  // específica (opportunityMatching.tsx) — nunca reaproveitado por outra
  // allocation depois — então no máximo uma linha pode aplicar-se aqui;
  // `executeTakeFirst()` não é um LIMIT 1 arbitrário sobre dado ambíguo,
  // é a cardinalidade real garantida pelo próprio motor. Allocations
  // criadas manualmente (opportunity-allocations_POST.ts) nunca geram uma
  // linha em match_evaluations — para essas, esta consulta legitimamente
  // não encontra nada, e needId permanece null (não é um erro nem uma
  // lacuna a preencher, é o que realmente aconteceu).
  const evaluation = await trx
    .selectFrom("matchEvaluations")
    .select(["needId"])
    .where("allocationId", "=", input.allocationId)
    .executeTakeFirst();

  let needId: number | null = null;
  let unitMismatchNote: string | null = null;

  if (evaluation?.needId) {
    const need = await trx
      .selectFrom("needs")
      .select(["unit"])
      .where("id", "=", evaluation.needId)
      .executeTakeFirst();

    // Nunca soma unidades incompatíveis (kg + unidade, litros + kg, etc.).
    // Mesma normalização textual usada em todo o motor de matching
    // (normalize(): NFD + remoção de acento + minúsculas) — não é uma
    // conversão de unidade, só evita que "Kg"/"kg "/"KG" sejam tratados
    // como divergentes por diferença puramente textual.
    if (need && normalize(need.unit) === normalize(input.unit)) {
      needId = evaluation.needId;
    } else if (need) {
      unitMismatchNote = `needId ${evaluation.needId} encontrado via match_evaluations, mas unidade do recebimento ("${input.unit}") diverge da unidade da necessidade ("${need.unit}") — need_id não atribuído para evitar somar unidades incompatíveis.`;
    }
  }

  await trx
    .insertInto("needFulfillments")
    .values({
      organizationId: input.organizationId,
      needId,
      allocationId: input.allocationId,
      stockTransactionId: input.stockTransactionId,
      quantity: input.quantity,
      unit: input.unit,
      unitMismatchNote,
      createdByUserId: input.createdByUserId,
    })
    .execute();
}
