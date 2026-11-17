import { sql } from "kysely";
import { db } from "./db.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { verifyAuditLogChain } from "./verifyAuditChain.js";
import { ConflictError } from "./errorResponse.js";
import { newCorrelationId } from "./correlation.js";
import type { AuditChainVerificationStatus, Json } from "./schema.js";

/**
 * M38 — verificação da cadeia de auditoria pela interface. REUTILIZA `verifyAuditLogChain` (o algoritmo canônico, sem segunda implementação) e acrescenta só o que faltava:
 * um REGISTRO OPERACIONAL do pedido e do resultado (`audit_chain_verifications`, tabela separada da cadeia — nunca grava o resultado em `audit_log`, ver Fase 53), um estado
 * "em andamento" visível e a abrangência definida (eventos com id <= max_audit_id_at_start).
 *
 * O que um resultado "íntegra" prova: dentro dos eventos cobertos, cada hash gravado confere com o conteúdo gravado e cada elo aponta para o hash do evento anterior. NÃO prova:
 * (a) que nenhum evento do FIM da cadeia foi removido (não há âncora independente do último hash); (b) nada sobre eventos sem hash (anteriores à migração 0003);
 * (c) que quem tem escrita direta no banco não recalculou a cadeia inteira. Esses limites são mostrados na interface e documentados.
 */

/** Verificação "em andamento" há mais que isso é considerada interrompida (processo reiniciado, etc.) e vira `incompleta` — nunca é tratada como íntegra. */
export const STALE_VERIFICATION_MS = 15 * 60 * 1000;
const MAX_STORED_DIVERGENCES = 100;

/** Pontos de injeção SÓ para testes (falha técnica simulada / sincronização de concorrência). Em produção ficam vazios. */
export const AUDIT_CHAIN_TEST_HOOKS: { beforeVerify?: (verificationId: string) => Promise<void> } = {};

const pending = new Map<string, Promise<void>>();
/** Para testes: espera a conclusão de uma verificação iniciada neste processo. */
export async function awaitVerification(id: string): Promise<void> {
  await pending.get(id);
}

export interface StartedVerification { id: string; startedAt: string }

export async function startAuditChainVerification(userId: number): Promise<StartedVerification> {
  // Verificação antiga que nunca terminou → `incompleta` (libera o limite de uma por vez; o resultado antigo não vira "íntegro").
  await sql`UPDATE audit_chain_verifications SET status = 'incompleta', finished_at = now(), error_kind = 'interrompida'
             WHERE scope = 'global_chain' AND status = 'em_andamento' AND started_at < now() - ${sql.lit(STALE_VERIFICATION_MS / 1000)} * interval '1 second'`.execute(db);

  let id: string;
  let startedAt: Date;
  try {
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto("auditChainVerifications").values({ scope: "global_chain", requestedByUserId: userId }).returning(["id", "startedAt"]).executeTakeFirstOrThrow();
      // O PEDIDO é auditado (sensível: operação de plataforma). O RESULTADO nunca é gravado na cadeia que ele avalia.
      await recordAuditLogEntry({ organizationId: null, actorUserId: userId, action: "auditoria.verificacao_solicitada", outcome: "pendente", correlationId: newCorrelationId(), entityType: "audit_chain_verification", entityId: String(created.id), metadata: { escopo: "global_chain" } }, trx);
      return created;
    });
    id = String(row.id);
    startedAt = row.startedAt;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("Já existe uma verificação da trilha em andamento. Aguarde a conclusão.", "verificacao_em_andamento");
    throw error;
  }

  const run = runVerification(id).catch((error) => { console.error("Erro inesperado ao registrar a verificação da trilha:", error); });
  pending.set(id, run);
  void run.finally(() => pending.delete(id));
  return { id, startedAt: startedAt.toISOString() };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

async function runVerification(id: string): Promise<void> {
  const t0 = Date.now();
  try {
    await AUDIT_CHAIN_TEST_HOOKS.beforeVerify?.(id);
    const max = await db.selectFrom("auditLog").select((eb) => eb.fn.max("id").as("maxId")).executeTakeFirst();
    const maxId = max?.maxId ?? null;
    await db.updateTable("auditChainVerifications").set({ maxAuditIdAtStart: maxId }).where("id", "=", id).where("status", "=", "em_andamento").execute();
    // Eventos gravados depois desta leitura NÃO fazem parte do resultado (abrangência definida).
    const result = maxId === null ? { totalEventos: 0, eventosVerificados: 0, eventosPreExistentesSemHash: 0, integra: true, divergencias: [] } : await verifyAuditLogChain({ maxId });
    const status: AuditChainVerificationStatus = result.integra ? "integra" : "inconsistencia";
    // Só o MOTIVO técnico e o id do evento: nunca os hashes esperado/gravado.
    const stored = result.divergencias.slice(0, MAX_STORED_DIVERGENCES).map((d) => ({ id: d.id, reason: d.reason }));
    await db.updateTable("auditChainVerifications").set({
      status,
      finishedAt: new Date(),
      totalEvents: result.totalEventos,
      verifiedEvents: result.eventosVerificados,
      unhashedEvents: result.eventosPreExistentesSemHash,
      divergenceCount: result.divergencias.length,
      divergences: stored as unknown as Json,
      durationMs: Date.now() - t0,
    }).where("id", "=", id).where("status", "=", "em_andamento").execute();
  } catch (error) {
    // A verificação em si não terminou: NUNCA vira "íntegra". Só um código técnico seguro é guardado (sem mensagem do banco).
    console.error("Falha técnica na verificação da trilha de auditoria:", error);
    await db.updateTable("auditChainVerifications").set({ status: "falha_tecnica", finishedAt: new Date(), errorKind: "verificacao_nao_concluida", durationMs: Date.now() - t0 }).where("id", "=", id).where("status", "=", "em_andamento").execute().catch(() => undefined);
  }
}

export interface VerificationRow {
  id: string;
  status: AuditChainVerificationStatus;
  startedAt: string;
  finishedAt: string | null;
  requestedByName: string | null;
  coveredUpToEventId: string | null;
  totalEvents: number | null;
  verifiedEvents: number | null;
  unhashedEvents: number | null;
  divergenceCount: number | null;
  /** Só para a equipe da plataforma: (id do evento, motivo técnico). Demais perfis recebem apenas `divergencesInYourOrganization`. */
  divergences: Array<{ id: string; reason: string }> | null;
  divergencesInYourOrganization: number | null;
  durationMs: number | null;
  errorKind: string | null;
}

/** Últimas verificações. `viewerOrganizationId`: organização de quem consulta (para contar divergências que tocam os eventos DELA sem expor ids de outras organizações). */
export async function listVerifications(options: { limit: number; isPlatformAdmin: boolean; viewerOrganizationId: number | null }): Promise<VerificationRow[]> {
  const rows = await db
    .selectFrom("auditChainVerifications as v")
    .leftJoin("users as u", "u.id", "v.requestedByUserId")
    .select(["v.id", "v.status", "v.startedAt", "v.finishedAt", "u.displayName", "v.maxAuditIdAtStart", "v.totalEvents", "v.verifiedEvents", "v.unhashedEvents", "v.divergenceCount", "v.divergences", "v.durationMs", "v.errorKind"])
    .where("v.scope", "=", "global_chain")
    .orderBy("v.id", "desc")
    .limit(options.limit)
    .execute();
  const out: VerificationRow[] = [];
  for (const r of rows) {
    const list = (Array.isArray(r.divergences) ? r.divergences : []) as Array<{ id: string; reason: string }>;
    let inOrg: number | null = null;
    if (!options.isPlatformAdmin && options.viewerOrganizationId !== null && list.length > 0) {
      const ids = list.map((d) => d.id);
      const mine = await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).where("id", "in", ids).where("organizationId", "=", options.viewerOrganizationId).executeTakeFirstOrThrow();
      inOrg = Number(mine.n);
    } else if (!options.isPlatformAdmin && r.divergenceCount === 0) inOrg = 0;
    out.push({
      id: String(r.id),
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      requestedByName: options.isPlatformAdmin ? r.displayName : null,
      coveredUpToEventId: r.maxAuditIdAtStart === null ? null : String(r.maxAuditIdAtStart),
      totalEvents: r.totalEvents,
      verifiedEvents: r.verifiedEvents,
      unhashedEvents: r.unhashedEvents,
      divergenceCount: r.divergenceCount,
      divergences: options.isPlatformAdmin ? list : null,
      divergencesInYourOrganization: inOrg,
      durationMs: r.durationMs,
      errorKind: r.errorKind,
    });
  }
  return out;
}
