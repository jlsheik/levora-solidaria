import { sql, type Kysely, type Transaction } from "kysely";
import { db } from "./db.js";
import type { DB, Json } from "./schema.js";
import { newCorrelationId } from "./correlation.js";

/**
 * Barramento de eventos (outbox no Postgres) — master prompt, seção 59.
 *
 * Quem muda um dado de negócio publica o evento NA MESMA TRANSAÇÃO, então o
 * evento só existe se a mudança foi confirmada. Consumidores (agentes) leem
 * por polling; sem broker externo. Cada (evento, consumidor) é processado
 * uma vez: o registro de consumo é gravado na mesma transação dos efeitos do
 * handler, então um efeito nunca é aplicado duas vezes pelo mesmo
 * consumidor. `payload` leva só fatos mínimos e ids, nunca dado pessoal.
 */

export interface PublishDomainEventInput {
  eventType: string;
  organizationId: number | null;
  entityType: string;
  entityId?: string | null;
  payload?: Json;
  /** M39: correlação da operação de origem (gerada no servidor). Omitida = este evento é a ORIGEM de uma jornada e recebe uma correlação nova. */
  correlationId?: string | null;
}

/** Devolve a correlação gravada no evento, para o chamador propagá-la à auditoria da mesma operação. */
export async function publishDomainEvent(trx: Transaction<DB>, input: PublishDomainEventInput): Promise<string> {
  const correlationId = input.correlationId ?? newCorrelationId();
  await trx
    .insertInto("domainEvents")
    .values({
      eventType: input.eventType,
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      payload: input.payload ?? {},
      correlationId,
    })
    .execute();
  return correlationId;
}

export interface DomainEvent {
  id: string;
  eventType: string;
  organizationId: number | null;
  entityType: string;
  entityId: string | null;
  payload: Json;
  createdAt: Date;
}

export interface ConsumeOptions {
  consumer: string;
  /** Vazio/omitido = todos os tipos. */
  eventTypes?: string[];
  batchSize?: number;
  /** Tentativas por evento antes de desistir (fica registrado como erro). */
  maxAttempts?: number;
  handler: (trx: Transaction<DB>, event: DomainEvent) => Promise<void>;
}

export interface ConsumeResult {
  processed: number;
  failed: number;
  skipped: number;
}

export async function consumeDomainEvents(options: ConsumeOptions, executor: Kysely<DB> = db): Promise<ConsumeResult> {
  const batchSize = options.batchSize ?? 50;
  const maxAttempts = options.maxAttempts ?? 3;

  let query = executor
    .selectFrom("domainEvents")
    .selectAll("domainEvents")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("domainEventConsumptions as c")
            .select("c.eventId")
            .whereRef("c.eventId", "=", "domainEvents.id")
            .where("c.consumer", "=", options.consumer)
            .where((inner) => inner.or([inner("c.outcome", "=", "ok"), inner("c.attempts", ">=", maxAttempts)]))
        )
      )
    )
    .orderBy("domainEvents.id", "asc")
    .limit(batchSize);

  if (options.eventTypes && options.eventTypes.length > 0) {
    query = query.where("domainEvents.eventType", "in", options.eventTypes);
  }

  const events = await query.execute();
  const result: ConsumeResult = { processed: 0, failed: 0, skipped: 0 };

  for (const row of events) {
    const event: DomainEvent = {
      id: String(row.id),
      eventType: row.eventType,
      organizationId: row.organizationId,
      entityType: row.entityType,
      entityId: row.entityId,
      payload: row.payload,
      createdAt: row.createdAt,
    };

    try {
      const outcome = await executor.transaction().execute(async (trx) => {
        // Dois executores do mesmo consumidor nunca processam o mesmo evento ao mesmo tempo.
        const lock = await sql<{ locked: boolean }>`
          SELECT pg_try_advisory_xact_lock(hashtext(${`${options.consumer}:${event.id}`})) AS locked
        `.execute(trx);
        if (!lock.rows[0]?.locked) return "skipped" as const;

        const done = await trx
          .selectFrom("domainEventConsumptions")
          .select("outcome")
          .where("eventId", "=", row.id)
          .where("consumer", "=", options.consumer)
          .executeTakeFirst();
        if (done?.outcome === "ok") return "skipped" as const;

        await options.handler(trx, event);

        await trx
          .insertInto("domainEventConsumptions")
          .values({ eventId: row.id, consumer: options.consumer, outcome: "ok" })
          .onConflict((oc) =>
            oc.columns(["eventId", "consumer"]).doUpdateSet({ outcome: "ok", error: null, processedAt: new Date() })
          )
          .execute();
        return "processed" as const;
      });
      if (outcome === "processed") result.processed += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await executor
        .insertInto("domainEventConsumptions")
        .values({ eventId: row.id, consumer: options.consumer, outcome: "erro", attempts: 1, error: message })
        .onConflict((oc) =>
          oc.columns(["eventId", "consumer"]).doUpdateSet((eb) => ({
            outcome: "erro",
            attempts: eb("domainEventConsumptions.attempts", "+", 1),
            error: message,
            processedAt: new Date(),
          }))
        )
        .execute();
    }
  }

  return result;
}
