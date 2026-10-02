import type { Transaction } from "kysely";
import type { DB } from "./schema.js";

/**
 * Decide, de forma segura sob concorrência, se uma oportunidade deve virar
 * "concluida" depois que UMA de suas atribuições chegou a um estado
 * terminal. Regra de negócio (inalterada, só centralizada — antes só
 * existia dentro de `allocations-receive_POST.ts`, então cancelar/recusar/
 * expirar a ÚLTIMA atribuição ainda ativa, quando outra já tinha sido
 * recebida, nunca disparava a conclusão — achado de auditoria corrigido
 * aqui): a oportunidade conclui quando TODAS as suas atribuições estão em
 * `recebida`/`cancelada`/`recusada` E pelo menos uma está `recebida`.
 *
 * Chamada pelos 4 caminhos que terminam uma atribuição:
 * `allocations-receive_POST.ts` (recebida), `allocations-decide_POST.ts`
 * (recusada), `allocations-logistics_POST.ts` (cancelado),
 * `expireReservations.tsx` (expiração).
 *
 * DELIBERADAMENTE SEPARADA de `reopenOpportunityIfNoActiveAllocations`
 * (reopenOpportunity.tsx) — são regras de negócio diferentes, não duas
 * variantes da mesma coisa: para reabertura, uma atribuição "recebida"
 * conta como ATIVA (nunca reabrir uma doação já entregue); para conclusão,
 * "recebida" é exatamente o estado TERMINAL que precisa existir para
 * concluir. Um chamador nunca deve decidir sozinho qual das duas chamar —
 * a convenção usada nos 4 pontos de integração é: tentar concluir
 * primeiro; só se não concluir, tentar reabrir (as duas condições são
 * mutuamente exclusivas pelos mesmos dados, então a ordem entre elas nunca
 * produz um resultado incorreto, só evita uma segunda leitura desnecessária
 * quando a primeira já resolveu).
 *
 * Mesma técnica de sincronização de `reopenOpportunityIfNoActiveAllocations`:
 * trava a linha da OPORTUNIDADE (`FOR UPDATE`) antes de contar as
 * atribuições-irmãs, serializando a decisão entre todas as transações
 * concorrentes que tentam terminar atribuições da mesma oportunidade.
 *
 * ORDEM DE LOCKS — não grava nenhuma entrada de auditoria aqui de
 * propósito. `recordAuditLogEntry` trava um advisory lock GLOBAL
 * (transação-scoped, só libera no commit — ver `auditLog.tsx`); a Fase 27
 * encontrou um deadlock real (`PostgresError 40P01`) quando um caminho
 * travava esse lock global ANTES de travar a linha da oportunidade,
 * enquanto outro caminho concorrente fazia o inverso. Este helper só trava
 * a oportunidade e escreve `opportunity_registry` — cabe ao CHAMADOR
 * registrar `descoberta_central.concluida` (e seus próprios eventos)
 * DEPOIS de chamar esta função, nunca antes — assim a ordem em toda
 * transação que usa este helper fica sempre "recursos próprios → linha da
 * oportunidade → advisory lock de auditoria", a mesma ordem já usada por
 * `reopenOpportunityIfNoActiveAllocations` e pelos 4 pontos de integração.
 */
export async function concludeOpportunityIfAllTerminalAndReceived(
  trx: Transaction<DB>,
  opportunityRegistryId: number
): Promise<boolean> {
  await trx
    .selectFrom("opportunityRegistry")
    .select(["id"])
    .where("id", "=", opportunityRegistryId)
    .forUpdate()
    .executeTakeFirst();

  const allocations = await trx
    .selectFrom("opportunityAllocations")
    .select(["status"])
    .where("opportunityRegistryId", "=", opportunityRegistryId)
    .execute();

  const TERMINAL_STATUSES = ["recebida", "cancelada", "recusada"];
  const allTerminal = allocations.every((a) => TERMINAL_STATUSES.includes(a.status));
  const hasReceived = allocations.some((a) => a.status === "recebida");

  if (!allTerminal || !hasReceived) return false;

  // "atribuida" é o único status legítimo neste ponto: uma atribuição só
  // chega a "recebida" depois de ter sido "aceita" (via
  // allocations-decide_POST ou automaticamente pelo motor de alta
  // confiança), e ambos os caminhos de aceite sempre levam a oportunidade a
  // "atribuida". Enquanto existir uma atribuição "recebida", ela sempre
  // conta como ATIVA para reopenOpportunityIfNoActiveAllocations — nada
  // nunca move a oportunidade de "atribuida" para outro status enquanto
  // isso for verdade. A atualização é sempre condicional e atômica; se
  // afetar zero linhas (ex.: já concluída por outra transação, ou chamada
  // de novo depois de já ter concluído), não há conclusão duplicada.
  const updated = await trx
    .updateTable("opportunityRegistry")
    .set({ status: "concluida", updatedAt: new Date() })
    .where("id", "=", opportunityRegistryId)
    .where("status", "=", "atribuida")
    .returning(["id"])
    .execute();

  return updated.length > 0;
}
