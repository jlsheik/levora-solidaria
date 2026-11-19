import { db } from "./db.js";
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { AuditActorType, AuditOutcome, DB, Json } from "./schema.js";

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
  // Quem agiu. Omitido = "user" (todo o histórico anterior à Fase 74).
  // "agent" exige actorAgentPrincipalId; "system" é ação automática sem
  // agente nem pessoa (ex.: alerta de segurança gerado pela plataforma).
  actorType?: AuditActorType;
  actorAgentPrincipalId?: number | null;
  /**
   * M39 — desfecho REAL da operação, informado por quem o conhece (nunca derivado do nome da ação). Omitido = "resultado não registrado" (registro no formato histórico, v1).
   * Semântica: `concluida` = a operação registrada terminou; `recusada` = recusada por regra de domínio; `falhou` = falhou (auditoria feita FORA da transação revertida);
   * `pendente` = aceita, mas o desfecho final acontece depois e é registrado à parte. Nunca grave `concluida` antes do ponto que ainda pode falhar: o registro vive na mesma
   * transação do negócio, então um rollback leva o registro junto.
   */
  outcome?: AuditOutcome | null;
  /** M39 — correlação gerada NO SERVIDOR na origem da operação e propagada (UUID). Nunca vem de entrada de cliente externo. */
  correlationId?: string | null;
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
export function stableStringify(value: unknown): string {
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
  // Opcionais de propósito: eventos de usuário (o histórico inteiro até a
  // Fase 74) NÃO incluem estes campos no hash canônico, então todo hash
  // já gravado continua verificável sem reescrever nada. Só eventos de
  // agente/sistema acrescentam o ator ao conteúdo protegido pela cadeia.
  actorType?: AuditActorType;
  actorAgentPrincipalId?: number | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Json;
  createdAt: Date;
  previousEventHash: string | null;
  /**
   * Versão do formato do registro. 1 (ou omitida) = formato histórico: o hash NÃO cobre outcome/correlação — todo hash já gravado continua verificável sem reescrever nada.
   * 2 = o hash cobre `outcome` e `correlationId` (ambos sempre presentes no texto canônico, vazios quando nulos).
   */
  recordVersion?: number;
  outcome?: AuditOutcome | null;
  correlationId?: string | null;
}): string {
  const parts: Array<string | number> = [
    input.organizationId ?? "",
    input.actorUserId ?? "",
    input.action,
    input.entityType,
    input.entityId ?? "",
    stableStringify(input.metadata),
    input.createdAt.toISOString(),
    input.previousEventHash ?? "",
  ];
  if (input.actorType && input.actorType !== "user") {
    parts.push(`actor:${input.actorType}:${input.actorAgentPrincipalId ?? ""}`);
  }
  if (input.recordVersion === 2) {
    parts.push(`outcome:${input.outcome ?? ""}`);
    parts.push(`corr:${input.correlationId ?? ""}`);
  }
  const canonical = parts.join("|");
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

  const actorType = entry.actorType ?? "user";
  const actorAgentPrincipalId = entry.actorAgentPrincipalId ?? null;
  if (actorType === "agent" && actorAgentPrincipalId === null) {
    throw new Error("Evento de auditoria de agente exige actorAgentPrincipalId");
  }

  // Versão do registro: v2 só quando há algo novo a cobrir (resultado ou correlação). Sem isso, o formato histórico é mantido (compatibilidade explícita).
  const outcome = entry.outcome ?? null;
  const correlationId = entry.correlationId ?? null;
  const recordVersion = outcome !== null || correlationId !== null ? 2 : 1;

  const eventHash = computeAuditEventHash({
    recordVersion,
    outcome,
    correlationId,
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    actorType,
    actorAgentPrincipalId,
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
      actorType,
      actorAgentPrincipalId,
      action: entry.action,
      entityType: entry.entityType,
      entityId,
      metadata,
      createdAt,
      previousEventHash,
      eventHash,
      recordVersion,
      outcome,
      correlationId,
    })
    .execute();
}

/**
 * M39 — auditoria de uma FALHA, feita FORA da transação que falhou. Uma transação abortada não aceita novas escritas e, se aceitasse, um rollback apagaria a evidência da falha;
 * por isso a falha é registrada numa transação própria, depois que a do negócio foi revertida. Grava `outcome = falhou` e nunca declara conclusão.
 */
export async function recordAuditFailure(entry: Omit<AuditLogEntryInput, "outcome">): Promise<void> {
  await recordAuditLogEntry({ ...entry, outcome: "falhou" });
}
