import type { Transaction } from "kysely";
import type { DB } from "./schema.js";

/**
 * Decide, de forma segura sob concorrência, se uma oportunidade deve voltar
 * a "aguardando_destinacao" depois que UMA de suas atribuições chegou a um
 * estado terminal (recusada/cancelada). Chamada por
 * `allocations-decide_POST.ts` (recusa), `allocations-logistics_POST.ts`
 * (cancelamento) e `expireReservations.tsx` (expiração) — os 3 caminhos que
 * terminam uma atribuição e podem provocar reabertura.
 *
 * Achado de auditoria corrigido aqui: antes, cada um desses 3 caminhos lia
 * "quantas atribuições-irmãs ainda estão ativas" com um SELECT simples, sem
 * travar as linhas-irmãs. Sob READ COMMITTED, duas transações terminando
 * atribuições DIFERENTES da MESMA oportunidade ao mesmo tempo podiam cada
 * uma ver a outra ainda "ativa" (pré-commit) — nenhuma das duas concluía
 * "zero ativas restantes", e a oportunidade nunca era reaberta, mesmo que
 * as duas tivessem de fato terminado. Reproduzido deterministicamente na
 * auditoria (interleaving controlado, sem depender de sorte de timing).
 *
 * Correção: trava a LINHA da oportunidade (`FOR UPDATE`) ANTES de contar as
 * irmãs. Isso serializa a decisão "zero ativas" entre todas as transações
 * concorrentes que tentam terminar atribuições desta mesma oportunidade —
 * cada chamador já trava a PRÓPRIA atribuição primeiro (allocation lock),
 * então a ordem final de locks é sempre "allocation própria → oportunidade",
 * nunca o inverso. Como nenhum desses 3 chamadores nunca tenta travar a
 * atribuição de outro (só a própria, sempre antes de chamar esta função), e
 * o motor de matching (`runMatchingForOpportunity`) só trava a oportunidade
 * e nunca uma atribuição já existente via `FOR UPDATE`, não existe ciclo de
 * espera possível — sem risco de deadlock.
 *
 * "reservada" e "atribuida" são os dois status legítimos de onde uma
 * reabertura pode partir (confirmado por análise dos fluxos que levam a
 * `remainingActive = 0`: uma oportunidade sem nenhuma atribuição ativa só
 * chega a esse ponto vindo de "reservada" — nenhuma atribuição jamais foi
 * aceita — ou de "atribuida" — uma atribuição aceita foi depois cancelada
 * via logística, ou coexistia com uma proposta de confiança média que
 * também acabou recusada). Qualquer outro status (terminal, ou já
 * "aguardando_destinacao") faz este UPDATE ser um no-op seguro — a
 * atualização é sempre condicional e atômica, nunca um "ler status, depois
 * decidir se escreve" separado.
 */
export async function reopenOpportunityIfNoActiveAllocations(
  trx: Transaction<DB>,
  opportunityRegistryId: number
): Promise<boolean> {
  await trx
    .selectFrom("opportunityRegistry")
    .select(["id"])
    .where("id", "=", opportunityRegistryId)
    .forUpdate()
    .executeTakeFirst();

  const remainingActive = await trx
    .selectFrom("opportunityAllocations")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("opportunityRegistryId", "=", opportunityRegistryId)
    .where("status", "!=", "recusada")
    .where("status", "!=", "cancelada")
    .executeTakeFirst();

  if (Number(remainingActive?.count ?? 0) > 0) return false;

  const updated = await trx
    .updateTable("opportunityRegistry")
    .set({ status: "aguardando_destinacao", updatedAt: new Date() })
    .where("id", "=", opportunityRegistryId)
    .where("status", "in", ["reservada", "atribuida"])
    .returning(["id"])
    .execute();

  return updated.length > 0;
}
