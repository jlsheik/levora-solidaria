import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { DB } from "./schema";
import { normalize } from "./opportunityMatching";

/**
 * Ledger append-only de EVENTOS de atendimento de necessidades
 * (`need_fulfillments` — ver db/migrations/0006_need_fulfillments.sql,
 * 0007_need_fulfillments_fk_restrict.sql e
 * 0008_need_fulfillments_ledger_of_events.sql para o comentário
 * arquitetural completo). Não transforma `needs.quantity_needed` num
 * contador mutável, não altera `needs.status`, e não toca no motor de
 * matching (`opportunityMatching.tsx` é só consultado aqui pela função
 * pura `normalize`, exportada — nada no motor é chamado nem alterado).
 *
 * `quantity`/`unit` registrados aqui são sempre os do RECEBIMENTO real
 * (`quantityReceived`), nunca `quantityAllocated` nem `quantityNeeded` —
 * este ledger é sobre o que aconteceu de verdade, não sobre a expectativa.
 *
 * Esta função cria sempre um evento `entry_type="original"` — a única
 * função de criação implementada nesta fase (infraestrutura do Modelo B).
 * Correções/reversões (`entry_type="correction"`/`"reversal"`,
 * `reverses_fulfillment_id`) são suportadas pelo schema (validadas por
 * `need_fulfillments_validate_entry`, trigger BEFORE INSERT), mas nenhuma
 * função/endpoint para criá-las foi implementado ainda — isso é
 * deliberadamente uma etapa futura separada.
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
  // é a cardinalidade real garantida pelo próprio motor (reforçada por
  // `idx_match_evaluations_allocation_id`, índice único). Allocations
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
  let isCountable = true;
  let unitMismatchNote: string | null = null;

  if (evaluation?.needId) {
    const need = await trx
      .selectFrom("needs")
      .select(["unit"])
      .where("id", "=", evaluation.needId)
      .executeTakeFirst();

    // Modelo B (decisão arquitetural desta sessão): a RELAÇÃO com a need
    // (need_id) é um fato já certo, gravado no momento do matching — nunca
    // deve ser descartada só porque a unidade do recebimento diverge.
    // O que fica incerto é só se esta quantidade pode ser CONTADA no
    // progresso da need (isCountable) — nunca soma unidades incompatíveis
    // (kg + unidade, litros + kg, etc.). Mesma normalização textual usada
    // em todo o motor de matching (normalize(): NFD + remoção de acento +
    // minúsculas) — não é conversão de unidade, só evita que
    // "Kg"/"kg "/"KG" sejam tratados como divergentes por diferença
    // puramente textual.
    if (need) {
      needId = evaluation.needId;
      isCountable = normalize(need.unit) === normalize(input.unit);
      if (!isCountable) {
        unitMismatchNote = `Unidade do recebimento ("${input.unit}") diverge da unidade da necessidade ${evaluation.needId} ("${need.unit}") — is_countable=false para nunca somar unidades incompatíveis, mas need_id é preservado (a relação com o matching é um fato certo, não descartado por causa da unidade).`;
      }
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
      entryType: "original",
      isCountable,
    })
    .execute();
}

/**
 * Fórmula canônica do ledger — única implementação reutilizável do
 * cálculo de efeito contábil (achado de auditoria: antes só existia em
 * documentação/teste manual, risco de futuros consumidores implementarem
 * fórmulas divergentes). Não expõe endpoint público; é só uma função
 * auxiliar, mesmo padrão de `getItemStockBalance` em `stockBalance.tsx`.
 *
 * Regra:
 *   is_countable = false                 → 0 (nunca participa da soma,
 *                                            seja original/correction/reversal)
 *   entry_type = 'original'/'correction' → +quantity
 *   entry_type = 'reversal'              → -quantity
 *
 * `quantity` nunca é armazenada negativa (CHECK(quantity > 0) inalterado)
 * — o sinal é sempre derivado de `entry_type` na leitura, nunca no dado
 * persistido.
 */
export async function getNeedFulfillmentBalance(trx: Transaction<DB> | Kysely<DB>, needId: number): Promise<number> {
  const row = await trx
    .selectFrom("needFulfillments")
    .select(() => sql<string>`coalesce(sum(case when entry_type = 'reversal' then -quantity else quantity end), 0)`.as("total"))
    .where("needId", "=", needId)
    .where("isCountable", "=", true)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}
