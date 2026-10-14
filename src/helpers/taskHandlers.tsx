import { runMatchingSweep } from "./runMatchingSweep.js";
import { expireReservations } from "./expireReservations.js";
import { expireOpportunities } from "./expireOpportunities.js";
import { expireApprovalRequests } from "./expireApprovalRequests.js";
import { expireAssignmentDeadlines } from "./expireAssignmentDeadlines.js";
import { verifyAuditChainScheduled } from "./verifyAuditChainTask.js";

/**
 * Único ponto de verdade para o mapeamento nome-da-tarefa → função que a
 * executa, usado tanto pelo agendador real (scheduler.tsx) quanto pelo
 * reprocessamento manual (background-tasks-retry_POST.ts). Antes existiam
 * duas cópias independentes deste mapa, que já haviam divergido na ordem
 * das chaves — risco real de um dia divergirem também no conteúdo (uma
 * tarefa nova adicionada em um lugar e esquecida no outro).
 *
 * Não fica em backgroundTasks.tsx porque as próprias funções de tarefa
 * importam claimTaskRun/finishTaskRun/failTaskRun de lá — colocar o mapa
 * junto criaria um ciclo de import.
 */
export const TASK_HANDLERS: Record<string, () => Promise<void>> = {
  runMatchingSweep,
  expireReservations,
  expireOpportunities,
  expireApprovalRequests,
  expireAssignmentDeadlines,
  verifyAuditChain: verifyAuditChainScheduled,
};
