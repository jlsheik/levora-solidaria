import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { DB } from "./schema.js";
import { normalize } from "./opportunityMatching.js";

/**
 * Ledger append-only de EVENTOS de atendimento de necessidades
 * (`need_fulfillments` — ver db/migrations/0006_need_fulfillments.sql,
 * 0007_need_fulfillments_fk_restrict.sql, 0008_need_fulfillments_ledger_of_events.sql,
 * 0009_need_fulfillments_inheritance_rules.sql e
 * 0010_need_fulfillments_stock_transaction_org_fk.sql para o comentário
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
 *
 * CONTRATO ARQUITETURAL de `stock_transaction_id` (Fase 33/34 — formalizado
 * após auditoria, não é uma regra nova de comportamento):
 * `stock_transaction_id` representa o LASTRO FÍSICO daquele evento — nunca
 * um identificador arbitrário que um chamador escolhe livremente. Hoje
 * `need_fulfillments` tem um único produtor real neste código-base: esta
 * função, chamada só por `allocations-receive_POST.ts`. Esse caminho NUNCA
 * aceita um `stock_transaction_id` vindo do cliente — o schema de entrada
 * do endpoint (`allocations-receive_POST.schema.ts`) não tem esse campo;
 * o `stock_transaction` é sempre criado dentro da MESMA transação
 * (`allocations-receive_POST.ts`, poucas linhas antes desta chamada) e seu
 * `id` recém-gerado é passado aqui imediatamente. O banco garante hoje,
 * estruturalmente (FK composta `need_fulfillments_stock_transaction_org_fkey`,
 * migration 0010): que o `stock_transaction` referenciado existe e
 * pertence à MESMA organização do fulfillment, e (`UNIQUE(stock_transaction_id)`)
 * que um mesmo movimento físico só é usado por uma linha do ledger. O
 * banco NÃO garante (e não tem hoje como garantir, por falta de uma fonte
 * canônica de item/unidade/quantidade/direção na cadeia
 * allocation→opportunity/need — ver comentário em db/schema.sql): que o
 * `stock_transaction` referenciado é fisicamente coerente com o evento
 * (mesmo item, mesma unidade, quantidade condizente, direção condizente).
 * Isso é responsabilidade do SERVIÇO DE DOMÍNIO que cria o
 * `stock_transaction` e o `need_fulfillment` juntos, na mesma operação —
 * nunca de um `stock_transaction_id` recebido de fora e usado por
 * confiança.
 *
 * Contrato obrigatório para um FUTURO endpoint de correction/reversal
 * (não implementado nesta fase): se a correction/reversal tiver lastro
 * físico próprio (`stock_transaction_id != NULL`), o fluxo deve
 * conceitualmente (1) validar autorização/contexto, (2) determinar os
 * dados físicos do novo movimento, (3) criar esse `stock_transaction`
 * DENTRO da mesma transação, (4) usar o `id` recém-criado, (5) criar o
 * `need_fulfillment` referenciando-o, (6) commit — nunca aceitar um
 * `stock_transaction_id` externo e confiar que ele representa o
 * movimento correto. Isso não elimina a necessidade de validar a lógica
 * de negócio do movimento em si; só impede que o vínculo físico nasça de
 * uma referência arbitrária.
 *
 * `correction.stock_transaction_id != NULL` representa uma correction com
 * lastro físico PRÓPRIO — não precisa (nem deve) ser idêntico ao evento
 * que ela referencia, porque `unit`/`quantity`/`is_countable` são
 * legitimamente livres numa correction (Fase 32); a consistência entre os
 * dois nasce do fluxo que os cria juntos, não de uma constraint de
 * igualdade.
 *
 * `reversal.stock_transaction_id != NULL` é uma capacidade que o schema
 * permite (nenhuma constraint proíbe) mas que NENHUM fluxo de aplicação
 * usa hoje e para a qual não existe contrato de domínio definido — só
 * `reversal.stock_transaction_id = NULL` (reversão puramente contábil,
 * sem novo movimento físico) é um caso exercitado e suportado.
 */
export interface CreateNeedFulfillmentInput {
  organizationId: number;
  allocationId: number;
  // stock_transactions.id é BIGSERIAL — o driver devolve como string (ver
  // tipo `Int8` em schema.tsx), nunca um `number` JS de verdade. Precisa
  // ser o id de um stock_transaction criado na MESMA transação que esta
  // chamada (ver contrato de stock_transaction_id no comentário acima) —
  // nunca um id recebido de fora sem essa garantia.
  stockTransactionId: string;
  quantity: number;
  unit: string;
  createdByUserId: number | null;
}

export async function createNeedFulfillment(trx: Transaction<DB>, input: CreateNeedFulfillmentInput): Promise<void> {
  // Resolve needId a partir de DUAS fontes legítimas e mutuamente
  // exclusivas (Fase 45):
  //   1. opportunity_allocations.id → match_evaluations.allocation_id →
  //      match_evaluations.need_id — allocations AUTOMÁTICAS (motor de
  //      matching). `allocationId` só é gravado em `match_evaluations` no
  //      momento em que o motor cria aquela allocation específica
  //      (opportunityMatching.tsx) — nunca reaproveitado por outra
  //      allocation depois — então no máximo uma linha pode aplicar-se
  //      aqui; `executeTakeFirst()` não é um LIMIT 1 arbitrário sobre dado
  //      ambíguo, é a cardinalidade real garantida pelo próprio motor
  //      (reforçada por `idx_match_evaluations_allocation_id`, índice
  //      único).
  //   2. opportunity_allocations.need_id — allocations MANUAIS
  //      (opportunity-allocations_POST.ts) com need explicitamente
  //      escolhida pelo platformAdmin no momento da criação (nunca
  //      inferida).
  // As duas fontes nunca deveriam coexistir para a MESMA allocation
  // (allocations manuais nunca geram match_evaluations, e vice-versa) —
  // se um dia coexistirem com valores DIFERENTES, isso é uma
  // inconsistência estrutural/de dados, nunca resolvida silenciosamente
  // escolhendo uma das duas: falha explicitamente dentro da transação.
  const [evaluation, allocation] = await Promise.all([
    trx.selectFrom("matchEvaluations").select(["needId"]).where("allocationId", "=", input.allocationId).executeTakeFirst(),
    trx.selectFrom("opportunityAllocations").select(["needId"]).where("id", "=", input.allocationId).executeTakeFirstOrThrow(),
  ]);

  if (evaluation?.needId != null && allocation.needId != null && evaluation.needId !== allocation.needId) {
    throw new Error(
      `need_fulfillments: inconsistência estrutural — match_evaluations.need_id (${evaluation.needId}) e opportunity_allocations.need_id (${allocation.needId}) divergem para a allocation ${input.allocationId}. As duas fontes nunca deveriam coexistir com valores diferentes; corrija o dado antes de registrar este recebimento.`
    );
  }

  const resolvedNeedId = evaluation?.needId ?? allocation.needId ?? null;

  let needId: number | null = null;
  let isCountable = true;
  let unitMismatchNote: string | null = null;

  if (resolvedNeedId != null) {
    const need = await trx
      .selectFrom("needs")
      .select(["unit"])
      .where("id", "=", resolvedNeedId)
      .executeTakeFirst();

    // Modelo B (decisão arquitetural desta sessão): a RELAÇÃO com a need
    // (need_id) é um fato já certo, gravado no momento do matching OU no
    // momento da criação da allocation manual (Fase 45) — nunca deve ser
    // descartada só porque a unidade do recebimento diverge. O que fica
    // incerto é só se esta quantidade pode ser CONTADA no progresso da
    // need (isCountable) — nunca soma unidades incompatíveis (kg +
    // unidade, litros + kg, etc.). Mesma normalização textual usada em
    // todo o motor de matching (normalize(): NFD + remoção de acento +
    // minúsculas) — não é conversão de unidade, só evita que
    // "Kg"/"kg "/"KG" sejam tratados como divergentes por diferença
    // puramente textual.
    if (need) {
      needId = resolvedNeedId;
      isCountable = normalize(need.unit) === normalize(input.unit);
      if (!isCountable) {
        unitMismatchNote = `Unidade do recebimento ("${input.unit}") diverge da unidade da necessidade ${resolvedNeedId} ("${need.unit}") — is_countable=false para nunca somar unidades incompatíveis, mas need_id é preservado (a relação com a need é um fato certo, não descartado por causa da unidade).`;
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

/**
 * Mesma fórmula de `getNeedFulfillmentBalance`, em lote — uma única query
 * `GROUP BY need_id` para uma listagem inteira de needs, em vez de um SUM
 * por linha (Fase 42, achado de auditoria: uma listagem chamando
 * `getNeedFulfillmentBalance` dentro de um loop por need seria N+1 —
 * evitado aqui pelo mesmo motivo que `opportunityMatching.tsx` já busca
 * capacidade/logística/área de atendimento em lote para todos os
 * candidatos de uma vez, nunca um SELECT por candidato). Needs sem
 * nenhuma linha no ledger simplesmente não aparecem no Map — o chamador
 * trata a ausência como saldo 0 (`?? 0`), nunca como erro.
 */
export async function getNeedFulfillmentBalanceBatch(trx: Transaction<DB> | Kysely<DB>, needIds: number[]): Promise<Map<number, number>> {
  if (needIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom("needFulfillments")
    .select(["needId", () => sql<string>`coalesce(sum(case when entry_type = 'reversal' then -quantity else quantity end), 0)`.as("total")])
    .where("needId", "in", needIds)
    .where("isCountable", "=", true)
    .groupBy("needId")
    .execute();

  const balances = new Map<number, number>();
  for (const row of rows) {
    if (row.needId !== null) balances.set(row.needId, Number(row.total));
  }
  return balances;
}

export interface NeedProgress {
  fulfilled: number;
  requiredRemaining: number;
  surplus: number;
}

/**
 * Camada de progresso da need (Fase 42) — puramente derivada, nunca
 * persistida. `fulfilled` é exclusivamente o saldo do Modelo B
 * (recebimentos CONTÁVEIS da rede Levora via `getNeedFulfillmentBalance`/
 * `getNeedFulfillmentBalanceBatch`) — nunca inclui `need_resolutions`
 * (resolução administrativa por estoque próprio, um conceito
 * estruturalmente separado desde a Fase 40) nem qualquer outra fonte.
 * `needs.status` permanece inteiramente independente deste cálculo —
 * uma need `atendida` com `fulfilled=0`, ou uma need `aberta` com
 * `requiredRemaining=0`, são ambas representações válidas e esperadas
 * (ver docs/plano-implementacao.md, Fase 37): este helper nunca tenta
 * sincronizar as duas dimensões.
 */
export function computeNeedProgress(quantityNeeded: number, fulfilled: number): NeedProgress {
  return {
    fulfilled,
    requiredRemaining: Math.max(0, quantityNeeded - fulfilled),
    surplus: Math.max(0, fulfilled - quantityNeeded),
  };
}
