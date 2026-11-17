import { sql, type Transaction } from "kysely";
import type { DB } from "./schema.js";

/**
 * CERCA DE POLÍTICA (M36) — a coordenação que faltava entre quem DECIDE (o motor, ao concluir uma simulação) e quem MUDA o que a decisão depende (pausa/emergência, limites de política, agente
 * ligado/desligado).
 *
 * Problema original (M35): a conclusão relia pausa/agente/limites dentro da própria transação, mas em READ COMMITTED e SEM travas: uma alteração concorrente podia ser confirmada entre a leitura e o
 * commit da conclusão, e a decisão avançava com política já desatualizada. Reduzir a janela não a elimina; e uma trava só do consumidor não protege nada se quem altera a política a ignora.
 *
 * Estratégia (a menor que dá garantia): travas consultivas de TRANSAÇÃO do PostgreSQL, em dois níveis, usadas pelos DOIS lados:
 *   - quem LÊ para decidir (conclusão) toma a trava COMPARTILHADA do nível global e da organização e SÓ ENTÃO lê pausa, agente e limites;
 *   - quem ALTERA toma a trava EXCLUSIVA do seu nível (global: pausa/limite global; organização: pausa/limite/agente da organização) e só então grava.
 * Como a trava só é liberada no commit/rollback, cada par (conclusão, alteração) fica estritamente ORDENADO pelo banco: ou a alteração confirmou antes (a conclusão a enxerga ao ler, pois a leitura
 * vem depois da trava) ou a conclusão confirmou antes (a decisão valia no seu instante e a alteração só entra depois). Não existe terceiro caso.
 *
 * Ordem de aquisição FIXA, para não haver deadlock entre pares: global → organização. Quem altera a organização toma a global compartilhada (lê limite global ao validar "só restringe") e depois a da
 * organização exclusiva; quem altera o global toma só a global exclusiva; quem decide toma global compartilhada e organização compartilhada. Ninguém pede uma trava de nível mais alto depois de uma de nível
 * mais baixo. Compartilhadas não se bloqueiam entre si (vários motores decidem em paralelo); a exclusividade da execução e do evento continua vindo da UNIQUE e do compare-and-set de `agentEventRuns`.
 *
 * `lock_timeout` curto no lado que decide: se uma alteração demorar, a conclusão falha de forma recuperável (o motor tenta de novo depois) em vez de ficar presa.
 */

const FENCE_CLASS_ID = 842036; // classid fixo desta camada (nunca reutilizar para outra coisa)
const LOCK_TIMEOUT_MS = 5000;

export type FenceMode = "shared" | "exclusive";

async function acquire(trx: Transaction<DB>, objId: number, mode: FenceMode): Promise<void> {
  if (mode === "shared") await sql`SELECT pg_advisory_xact_lock_shared(${FENCE_CLASS_ID}::int, ${objId}::int)`.execute(trx);
  else await sql`SELECT pg_advisory_xact_lock(${FENCE_CLASS_ID}::int, ${objId}::int)`.execute(trx);
}

/** Lado que DECIDE: global compartilhada → organização compartilhada, com limite de espera. */
export async function fenceForDecision(trx: Transaction<DB>, organizationId: number | null): Promise<void> {
  await sql`SELECT set_config('lock_timeout', ${`${LOCK_TIMEOUT_MS}ms`}, true)`.execute(trx);
  await acquire(trx, 0, "shared");
  if (organizationId !== null) await acquire(trx, organizationId, "shared");
}

/** Lado que ALTERA a política de uma ORGANIZAÇÃO (pausa, limite, agente): global compartilhada → organização exclusiva. */
export async function fenceForOrganizationChange(trx: Transaction<DB>, organizationId: number): Promise<void> {
  await acquire(trx, 0, "shared");
  await acquire(trx, organizationId, "exclusive");
}

/** Lado que ALTERA a política GLOBAL (pausa/emergência/limite da plataforma): global exclusiva. */
export async function fenceForGlobalChange(trx: Transaction<DB>): Promise<void> {
  await acquire(trx, 0, "exclusive");
}

/** Conveniência para quem altera: escolhe o nível pelo escopo (`null` = global). */
export async function fenceForChange(trx: Transaction<DB>, organizationId: number | null): Promise<void> {
  if (organizationId === null) await fenceForGlobalChange(trx);
  else await fenceForOrganizationChange(trx, organizationId);
}
