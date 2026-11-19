import { createHash } from "node:crypto";
import { db } from "./db.js";
import { stableStringify } from "./auditLog.js";
import { verifyAuditLogChain } from "./verifyAuditChain.js";
import { ConflictError } from "./errorResponse.js";
import type { AuditReceiptComparisonStatus } from "./schema.js";

/**
 * M39 — comprovante LOCAL do estado da cadeia de auditoria e comparação posterior.
 *
 * TRÊS GARANTIAS, que não se confundem:
 *   A) Integridade INTERNA (`verifyAuditLogChain`): os registros existentes são coerentes entre si. Não vê remoção do fim da cadeia nem recálculo completo.
 *   B) Comparação com COMPROVANTE ANTERIOR (este módulo): o estado atual é confrontado com uma referência exportada antes. Detecta remoção dos últimos registros, de registro
 *      intermediário, alteração do registro de referência e recálculo da cadeia — MAS só se o comprovante foi preservado por quem NÃO controla o banco.
 *   C) Âncora INDEPENDENTE: referência mantida fora do alcance de quem altera o banco (serviço externo, assinatura, carimbo de tempo). NÃO está configurada nem ativada.
 *
 * Modelo de confiança: o comprovante é um texto público, sem segredo e sem assinatura. `receiptDigest` detecta edição ACIDENTAL do arquivo, não autoria: quem controla o arquivo e o banco
 * pode forjar um comprovante novo coerente. Por isso um comprovante guardado no mesmo computador, sob o mesmo controle operacional, NÃO é uma âncora independente.
 *
 * Formato (versão 1, algoritmo sha256): corpo = {algorithm, capturedAt, eventCount, format, formatVersion, headHash, lastEventId, scope, unhashedEvents, verificationId, verificationResult},
 * serializado com chaves ordenadas (`stableStringify`); `receiptDigest` = SHA-256 do texto canônico do corpo SEM este campo. O comprovante exportado = corpo + receiptDigest.
 * Só metadados: nenhum conteúdo de auditoria, dado pessoal ou segredo.
 */

export const RECEIPT_FORMAT = "levora-audit-chain-receipt";
export const RECEIPT_FORMAT_VERSION = 1;
export const RECEIPT_ALGORITHM = "sha256";
export const RECEIPT_SCOPE = "global_chain";
const MAX_RECEIPT_BYTES = 4096;

export interface ReceiptBody {
  algorithm: "sha256";
  capturedAt: string;
  eventCount: string;
  format: typeof RECEIPT_FORMAT;
  formatVersion: number;
  headHash: string;
  lastEventId: string;
  scope: "global_chain";
  unhashedEvents: number;
  verificationId: string;
  verificationResult: "integra";
}
export type Receipt = ReceiptBody & { receiptDigest: string };

export const digestOf = (body: ReceiptBody): string => createHash("sha256").update(stableStringify(body)).digest("hex");
export const canonicalOf = (receipt: Receipt): string => stableStringify(receipt);

export interface StoredReceipt { id: string; receipt: Receipt; canonical: string }

/**
 * Gera um comprovante a partir da ÚLTIMA verificação concluída. Só é possível se ela foi `integra`: um comprovante nunca nasce de resultado inconsistente, incompleto ou falho.
 * O estado é relido AGORA e precisa bater com o que a verificação cobriu (mesmo registro final e mesma contagem); se mudou, recusa — o pedido seria um comprovante de um estado não verificado.
 */
export async function createReceipt(userId: number): Promise<StoredReceipt> {
  const v = await db.selectFrom("auditChainVerifications").selectAll().where("scope", "=", "global_chain").where("status", "<>", "em_andamento").orderBy("id", "desc").limit(1).executeTakeFirst();
  if (!v) throw new ConflictError("Não há verificação concluída. Execute a verificação interna primeiro.", "sem_verificacao");
  if (v.status !== "integra") throw new ConflictError("A última verificação não confirmou a consistência interna. Um comprovante só é gerado a partir de uma verificação íntegra.", "verificacao_nao_integra");
  if (v.maxAuditIdAtStart === null || v.totalEvents === null || v.unhashedEvents === null) throw new ConflictError("A verificação não registrou a abrangência necessária.", "verificacao_sem_abrangencia");

  const head = await db.selectFrom("auditLog").select(["id", "eventHash"]).where("id", "=", v.maxAuditIdAtStart).executeTakeFirst();
  const count = await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).where("id", "<=", v.maxAuditIdAtStart).executeTakeFirstOrThrow();
  if (!head || !head.eventHash || Number(count.n) !== v.totalEvents) {
    throw new ConflictError("A cadeia mudou desde a última verificação (registro final ausente, sem hash ou contagem diferente). Verifique de novo antes de gerar o comprovante.", "estado_mudou_desde_a_verificacao");
  }
  const body: ReceiptBody = {
    algorithm: RECEIPT_ALGORITHM, capturedAt: new Date().toISOString(), eventCount: String(count.n), format: RECEIPT_FORMAT, formatVersion: RECEIPT_FORMAT_VERSION,
    headHash: head.eventHash, lastEventId: String(head.id), scope: RECEIPT_SCOPE, unhashedEvents: v.unhashedEvents, verificationId: String(v.id), verificationResult: "integra",
  };
  const receipt: Receipt = { ...body, receiptDigest: digestOf(body) };
  const canonical = canonicalOf(receipt);
  try {
    const row = await db.insertInto("auditChainReceipts").values({
      scope: RECEIPT_SCOPE, formatVersion: RECEIPT_FORMAT_VERSION, algorithm: RECEIPT_ALGORITHM, verificationId: String(v.id), lastEventId: body.lastEventId, eventCount: body.eventCount,
      headHash: body.headHash, receiptDigest: receipt.receiptDigest, canonical, createdByUserId: userId,
    }).returning("id").executeTakeFirstOrThrow();
    return { id: String(row.id), receipt, canonical };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConflictError("Já existe um comprovante idêntico (mesmo estado da cadeia no mesmo instante).", "comprovante_duplicado");
    throw error;
  }
}

export type CompareReason =
  | "comprovante_ilegivel" | "campos_invalidos" | "digest_invalido"
  | "formato_nao_suportado" | "algoritmo_nao_suportado"
  | "outro_escopo"
  | "registro_final_ausente" | "hash_do_registro_diferente" | "quantidade_menor" | "inconsistencia_interna";

export interface CompareResult {
  id: string;
  status: AuditReceiptComparisonStatus;
  reason: CompareReason | null;
  receiptId: string | null;
  comparedUpToEventId: string | null;
  eventsSinceReceipt: number | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^[0-9]{1,18}$/;

/** Valida a FORMA (sem confiar em nada do arquivo) e devolve o comprovante tipado, ou o motivo. */
export function parseReceipt(text: string): { ok: true; receipt: Receipt } | { ok: false; status: AuditReceiptComparisonStatus; reason: CompareReason; digest: string | null } {
  if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) return { ok: false, status: "malformado", reason: "comprovante_ilegivel", digest: null };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, status: "malformado", reason: "comprovante_ilegivel", digest: null }; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, status: "malformado", reason: "comprovante_ilegivel", digest: null };
  const r = raw as Record<string, unknown>;
  const digest = typeof r.receiptDigest === "string" && HEX64.test(r.receiptDigest) ? r.receiptDigest : null;
  const KEYS = ["algorithm", "capturedAt", "eventCount", "format", "formatVersion", "headHash", "lastEventId", "receiptDigest", "scope", "unhashedEvents", "verificationId", "verificationResult"];
  const keys = Object.keys(r).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return { ok: false, status: "malformado", reason: "campos_invalidos", digest };
  if (r.format !== RECEIPT_FORMAT) return { ok: false, status: "malformado", reason: "campos_invalidos", digest };
  // versão e algoritmo desconhecidos NÃO são "malformado": o arquivo pode ser legítimo de outra versão e precisa ser dito assim
  if (r.formatVersion !== RECEIPT_FORMAT_VERSION) return { ok: false, status: "nao_suportado", reason: "formato_nao_suportado", digest };
  if (r.algorithm !== RECEIPT_ALGORITHM) return { ok: false, status: "nao_suportado", reason: "algoritmo_nao_suportado", digest };
  if (typeof r.headHash !== "string" || !HEX64.test(r.headHash) || digest === null || typeof r.lastEventId !== "string" || !DIGITS.test(r.lastEventId) || typeof r.eventCount !== "string" || !DIGITS.test(r.eventCount)
    || typeof r.verificationId !== "string" || !DIGITS.test(r.verificationId) || typeof r.capturedAt !== "string" || Number.isNaN(Date.parse(r.capturedAt)) || !Number.isInteger(r.unhashedEvents) || (r.unhashedEvents as number) < 0
    || r.verificationResult !== "integra" || typeof r.scope !== "string") return { ok: false, status: "malformado", reason: "campos_invalidos", digest };
  const { receiptDigest, ...body } = r as unknown as Receipt;
  if (digestOf(body as ReceiptBody) !== receiptDigest) return { ok: false, status: "malformado", reason: "digest_invalido", digest };
  if (r.scope !== RECEIPT_SCOPE) return { ok: false, status: "escopo_diferente", reason: "outro_escopo", digest };
  return { ok: true, receipt: r as unknown as Receipt };
}

/**
 * Compara o estado ATUAL da cadeia com um comprovante anterior. Ordem e significado:
 *   1) forma/versão/algoritmo/digest/escopo do arquivo;
 *   2) o registro final do comprovante ainda existe? (ausente ⇒ registros finais removidos — ou o arquivo é de outro banco);
 *   3) o hash dele é o mesmo? (diferente ⇒ alterado ou cadeia recalculada);
 *   4) a contagem de registros até ele é a mesma? (menor ⇒ registro intermediário removido — o hash final não muda nesse caso);
 *   5) a verificação interna até esse registro continua íntegra? (pega alteração de registro antigo sem recálculo).
 * Registros posteriores ao comprovante são esperados (`eventsSinceReceipt`). A comparação é SOMENTE LEITURA sobre `audit_log`; só grava o próprio resultado.
 */
export async function compareReceipt(text: string, userId: number): Promise<CompareResult> {
  const parsed = parseReceipt(text);
  const finish = async (status: AuditReceiptComparisonStatus, reason: CompareReason | null, extra: { receiptId?: string | null; digest?: string | null; upTo?: string | null; since?: number | null } = {}): Promise<CompareResult> => {
    const row = await db.insertInto("auditChainReceiptComparisons").values({
      receiptId: extra.receiptId ?? null, receiptDigest: extra.digest ?? null, status, reasonCode: reason, comparedUpToEventId: extra.upTo ?? null, eventsSinceReceipt: extra.since ?? null, comparedByUserId: userId,
    }).returning("id").executeTakeFirstOrThrow();
    return { id: String(row.id), status, reason, receiptId: extra.receiptId ?? null, comparedUpToEventId: extra.upTo ?? null, eventsSinceReceipt: extra.since ?? null };
  };
  if (!parsed.ok) return finish(parsed.status, parsed.reason, { digest: parsed.digest });

  const r = parsed.receipt;
  const stored = await db.selectFrom("auditChainReceipts").select("id").where("receiptDigest", "=", r.receiptDigest).executeTakeFirst();
  const receiptId = stored ? String(stored.id) : null;
  const last = await db.selectFrom("auditLog").select(["id", "eventHash"]).where("id", "=", r.lastEventId).executeTakeFirst();
  const base = { receiptId, digest: r.receiptDigest, upTo: r.lastEventId };
  // Um comprovante que o servidor não conhece (exportado antes e guardado fora) ainda pode ser comparado; o resultado fica sem `receipt_id`.
  if (!last) return finish("divergencia", "registro_final_ausente", base);
  if (last.eventHash !== r.headHash) return finish("divergencia", "hash_do_registro_diferente", base);
  const count = await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).where("id", "<=", r.lastEventId).executeTakeFirstOrThrow();
  if (BigInt(count.n) < BigInt(r.eventCount)) return finish("divergencia", "quantidade_menor", base);
  const internal = await verifyAuditLogChain({ maxId: r.lastEventId });
  if (!internal.integra) return finish("divergencia", "inconsistencia_interna", base);
  const since = await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).where("id", ">", r.lastEventId).executeTakeFirstOrThrow();
  // Um comprovante preservado FORA do banco (o uso que importa) pode não existir em `audit_chain_receipts`: a comparação vale do mesmo jeito e o resultado fica sem `receipt_id`.
  return finish("conferido", null, { ...base, since: Number(since.n) });
}

export interface ReceiptListItem {
  id: string; capturedAt: string; lastEventId: string; eventCount: string; verificationId: string; createdByName: string | null;
  /** Só a equipe da plataforma recebe os valores; organizações veem apenas existência, data e estado. */
  headHash: string | null; receiptDigest: string | null;
  /** Texto canônico exportável — só para a equipe da plataforma. */
  canonical: string | null;
  lastComparison: null | { status: AuditReceiptComparisonStatus; reason: string | null; comparedAt: string; eventsSinceReceipt: number | null };
}

export async function listReceipts(options: { limit: number; isPlatformAdmin: boolean }): Promise<ReceiptListItem[]> {
  const rows = await db.selectFrom("auditChainReceipts as r").leftJoin("users as u", "u.id", "r.createdByUserId")
    .select(["r.id", "r.capturedAt", "r.lastEventId", "r.eventCount", "r.verificationId", "u.displayName", "r.headHash", "r.receiptDigest", "r.canonical"]).where("r.scope", "=", "global_chain").orderBy("r.id", "desc").limit(options.limit).execute();
  const out: ReceiptListItem[] = [];
  for (const r of rows) {
    const c = await db.selectFrom("auditChainReceiptComparisons").select(["status", "reasonCode", "comparedAt", "eventsSinceReceipt"]).where("receiptId", "=", r.id).orderBy("id", "desc").limit(1).executeTakeFirst();
    out.push({
      id: String(r.id), capturedAt: r.capturedAt.toISOString(), lastEventId: String(r.lastEventId), eventCount: String(r.eventCount), verificationId: String(r.verificationId),
      createdByName: options.isPlatformAdmin ? r.displayName : null, headHash: options.isPlatformAdmin ? r.headHash : null, receiptDigest: options.isPlatformAdmin ? r.receiptDigest : null, canonical: options.isPlatformAdmin ? r.canonical : null,
      lastComparison: c ? { status: c.status, reason: c.reasonCode, comparedAt: c.comparedAt.toISOString(), eventsSinceReceipt: c.eventsSinceReceipt === null ? null : Number(c.eventsSinceReceipt) } : null,
    });
  }
  return out;
}

export async function getReceiptCanonical(id: string): Promise<string | null> {
  const row = await db.selectFrom("auditChainReceipts").select("canonical").where("id", "=", id).executeTakeFirst();
  return row?.canonical ?? null;
}
