import { reserveDedicatedConnection } from "./db.js";

/**
 * Exclusão mútua real entre execuções da MESMA tarefa agendada (achado de
 * auditoria: `claimTaskRun` não protege contra isso — ver
 * docs/OPERATIONS.md, "Idempotência de background_task_runs"). Camada
 * adicional, por cima de `claimTaskRun`, que continua responsável só pelo
 * registro/idempotência por `idempotencyKey` como antes.
 *
 * Usa `pg_try_advisory_lock` de SESSÃO (não de transação) na forma de duas
 * chaves inteiras (`classid`, `objid`) — essa forma nunca conflita com a
 * forma de uma chave só (usada por `recordAuditLogEntry` via
 * `pg_advisory_xact_lock(hashtext(...))`), então os dois mecanismos nunca
 * podem colidir entre si, mesmo por acaso. `objid` vem de um mapa explícito
 * e estável por nome de tarefa — nunca um hash probabilístico.
 *
 * Precisa ser de SESSÃO, não de transação: as tarefas protegidas
 * (expireReservations etc.) fazem várias transações/queries soltas, não
 * uma `db.transaction()` única do início ao fim (decisão explícita: não
 * mudar a granularidade transacional existente). Por isso o lock é pego e
 * solto na MESMA conexão reservada (`sql.reserve()`), mantida aberta durante
 * toda a execução de `fn` — devolver a conexão ao pool antes de soltar o
 * lock manteria o lock preso naquela conexão física para sempre (até ela
 * ser fisicamente encerrada), quebrando qualquer tentativa futura de
 * adquiri-lo. Se o processo morrer no meio, o Postgres libera o lock de
 * sessão automaticamente quando a conexão TCP cai — nenhum lock órfão
 * persistente.
 */

// classid fixo desta camada — nunca reutilizar para outra coisa, nem
// mudar sem atualizar todo lock já em uso em produção.
const SCHEDULED_TASK_LOCK_CLASS_ID = 842013;

// objid estável por tarefa. Nunca duas tarefas compartilham o mesmo id.
const SCHEDULED_TASK_LOCK_IDS: Record<string, number> = {
  expireReservations: 1,
  expireOpportunities: 2,
  expireApprovalRequests: 3,
  runMatchingSweep: 4,
  // Fase 53 — verificação periódica da audit hash-chain (SEC-06).
  verifyAuditChain: 5,
};

export interface ScheduledTaskLockResult<T> {
  /** false quando outra execução da mesma tarefa já detém o lock — `fn` não foi chamada. */
  ran: boolean;
  result?: T;
}

export async function withScheduledTaskLock<T>(
  taskName: string,
  fn: () => Promise<T>
): Promise<ScheduledTaskLockResult<T>> {
  const objId = SCHEDULED_TASK_LOCK_IDS[taskName];
  if (objId === undefined) {
    throw new Error(`withScheduledTaskLock: "${taskName}" não tem lock id mapeado em SCHEDULED_TASK_LOCK_IDS.`);
  }

  const reserved = await reserveDedicatedConnection();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${SCHEDULED_TASK_LOCK_CLASS_ID}, ${objId}) AS locked
    `;
    if (!locked) {
      return { ran: false };
    }

    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      await reserved`SELECT pg_advisory_unlock(${SCHEDULED_TASK_LOCK_CLASS_ID}, ${objId})`;
    }
  } finally {
    reserved.release();
  }
}
