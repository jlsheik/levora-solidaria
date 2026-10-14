import { db } from "./db.js";
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { DB, Json } from "./schema.js";

/**
 * Grava uma entrada na trilha de auditoria (audit_log), com hash
 * encadeado (master prompt, seção 12; ver docs/AUDIT.md).
 *
 * A tabela audit_log é append-only: o banco de dados possui triggers que
 * bloqueiam UPDATE e DELETE. Isso protege contra alteração pela aplicação
 * normal, mas não prova matematicamente que a sequência de eventos nunca
 * foi adulterada por alguém com acesso direto ao Postgres (ex.: restaurar
 * uma tabela substituída por cima). O hash encadeado resolve isso: cada
 * evento inclui o hash do evento anterior (cadeia única, global — não por
 * organização, ver comentário na migração 0003), então qualquer alteração
 * retroativa quebra a cadeia a partir daquele ponto de forma verificável
 * (ver verifyAuditLogChain em verifyAuditChain.tsx).
 *
 * Esta função é o único caminho recomendado para escrever em audit_log —
 * sempre dentro da mesma transação da ação de negócio que está sendo
 * registrada, para que a auditoria nunca fique fora de sincronia com o que
 * realmente aconteceu.
 */
export interface AuditLogEntryInput {
  organizationId: number | null;
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Json;
}

// Lock fixo (não depende de organização) — serializa TODA escrita na
// cadeia de hash, mesmo entre organizações diferentes, porque a cadeia é
// global. Sem isto, duas transações concorrentes poderiam ler o mesmo
// "hash anterior" e produzir uma bifurcação inválida na cadeia.
const AUDIT_CHAIN_LOCK_KEY = "levora_solidaria_audit_log_chain";

// JSONB do Postgres não garante preservar a ordem de inserção das chaves de
// um objeto (diferente do tipo `json`) — ler `metadata` de volta do banco
// pode produzir uma ordem de chaves diferente da que existia no momento da
// escrita, mesmo com o conteúdo idêntico. `JSON.stringify` sozinho é
// sensível a essa ordem, então geraria hashes diferentes para o mesmo dado
// (foi exatamente o que aconteceu ao testar isto ao vivo: a verificação
// acusou divergência num evento que nunca foi alterado). Serializa com
// chaves ordenadas, recursivamente, para que o hash dependa só do
// conteúdo, nunca da ordem em que o driver do Postgres devolve as chaves.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeAuditEventHash(input: {
  organizationId: number | null;
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Json;
  createdAt: Date;
  previousEventHash: string | null;
}): string {
  const canonical = [
    input.organizationId ?? "",
    input.actorUserId ?? "",
    input.action,
    input.entityType,
    input.entityId ?? "",
    stableStringify(input.metadata),
    input.createdAt.toISOString(),
    input.previousEventHash ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export async function recordAuditLogEntry(
  entry: AuditLogEntryInput,
  trx?: Transaction<DB>
): Promise<void> {
  if (trx) {
    await writeAuditLogEntry(entry, trx);
    return;
  }
  // Sem transação do chamador (ex.: tarefas agendadas que registram um
  // evento avulso) — cria a própria, porque ler o hash anterior e inserir
  // precisam ser atômicos e compartilhar o mesmo advisory lock.
  await db.transaction().execute((newTrx) => writeAuditLogEntry(entry, newTrx));
}

async function writeAuditLogEntry(entry: AuditLogEntryInput, trx: Transaction<DB>): Promise<void> {
  // De propósito um advisory lock de TRANSAÇÃO (libera só no commit/rollback
  // de `trx`), não de sessão com unlock explícito logo após o insert. Um
  // unlock antecipado pareceria "reduzir o tempo que o lock fica preso",
  // mas quebraria a cadeia: outra transação concorrente, liberada mais
  // cedo, não enxergaria esta linha ainda não commitada (MVCC comum do
  // Postgres) e leria o MESMO "hash anterior" que esta — as duas poderiam
  // commitar cada uma apontando para o mesmo predecessor, uma bifurcação
  // silenciosa na cadeia que só apareceria depois, na verificação. Manter
  // o lock até o commit real de `trx` é o que garante que a ordem de
  // inserção == ordem de commit == ordem da cadeia.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${AUDIT_CHAIN_LOCK_KEY}))`.execute(trx);

  const previous = await trx
    .selectFrom("auditLog")
    .select(["eventHash"])
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();

  const createdAt = new Date();
  const metadata = entry.metadata ?? {};
  const entityId = entry.entityId ?? null;
  const previousEventHash = previous?.eventHash ?? null;

  const eventHash = computeAuditEventHash({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId,
    metadata,
    createdAt,
    previousEventHash,
  });

  await trx
    .insertInto("auditLog")
    .values({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId,
      metadata,
      createdAt,
      previousEventHash,
      eventHash,
    })
    .execute();
}
