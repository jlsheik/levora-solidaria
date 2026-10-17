/**
 * Fase 99J — comprovantes de destinação. O arquivo é um `files` PRIVADO (propósito `comprovante_destinacao`, mesma infraestrutura de upload/armazenamento já existente); o vínculo com a
 * destinação é um EVENTO imutável (`correction` só com o arquivo; remoção = `correction` com `proof_removed`). A destinação original nunca muda, o estoque e o atendimento não são tocados,
 * e o objeto armazenado NUNCA é apagado por uma remoção (a referência deixa de valer; a evidência fica auditável). Comprovante é OPCIONAL: nenhuma regra o exige.
 * Ordem de travas: chave de idempotência (consultiva) → linha da destinação original (FOR UPDATE; o gatilho do banco repete a trava) → evento → auditoria (por último).
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";

export const PROOF_PURPOSE = "comprovante_destinacao";

export type ProofErrorCode = "destinacao_nao_encontrada" | "arquivo_nao_encontrado" | "arquivo_invalido" | "arquivo_ja_vinculado" | "sem_permissao" | "sem_comprovante_vigente" | "comprovante_diferente_do_vigente";
export type ProofFailure = { type: "error"; code: ProofErrorCode; status: number; message: string };
const fail = (code: ProofErrorCode, status: number, message: string): ProofFailure => ({ type: "error", code, status, message });

export interface ProofActor {
  userId: number;
  /** proprietário/administrador (`organizacao.gerencie`). */
  canManage: boolean;
}

export type ProofState = "vigente" | "removido" | "pendente";

/** Estado de um arquivo `comprovante_destinacao` em relação às destinações da organização (fonte única da autorização de download e da listagem). */
export async function getProofState(db: Kysely<DB> | Transaction<DB>, organizationId: number, fileId: number): Promise<{ state: ProofState; destinationId: string | null }> {
  const link = await sql<{ destinationId: string }>`
    SELECT CASE WHEN e.entry_type = 'original' THEN e.id ELSE e.reverses_destination_id END AS destination_id
      FROM stock_destinations e
     WHERE e.organization_id = ${organizationId} AND e.proof_file_id = ${fileId} AND e.proof_removed IS NOT TRUE
     ORDER BY e.id DESC LIMIT 1`.execute(db);
  const row = link.rows[0];
  if (!row) return { state: "pendente", destinationId: null };
  const destinationId = String(row.destinationId);
  // vigente = o evento de comprovante mais recente da destinação é justamente este anexo (não foi removido depois)
  const latest = await sql<{ fileId: number | null; removed: boolean | null }>`
    SELECT e.proof_file_id AS file_id, e.proof_removed AS removed FROM stock_destinations e
     WHERE (e.id = ${destinationId} OR e.reverses_destination_id = ${destinationId}) AND e.proof_file_id IS NOT NULL
     ORDER BY e.id DESC LIMIT 1`.execute(db);
  const l = latest.rows[0];
  return { state: l && l.fileId === fileId && l.removed !== true ? "vigente" : "removido", destinationId };
}

async function lockDestination(trx: Transaction<DB>, organizationId: number, destinationId: string) {
  const d = await trx
    .selectFrom("stockDestinations")
    .select(["id", "entryType", "itemId", "createdByUserId"])
    .where("id", "=", destinationId)
    .where("organizationId", "=", organizationId)
    .forUpdate()
    .executeTakeFirst();
  return d && d.entryType === "original" ? d : null;
}

export interface ProofApplied {
  type: "ok";
  eventId: string;
  action: "anexado" | "removido";
  destinationId: string;
  itemId: number;
  file: { id: number; name: string; contentType: string; sizeBytes: number };
}

export async function attachProof(trx: Transaction<DB>, input: { organizationId: number; destinationId: string; fileId: number; reason: string }, actor: ProofActor): Promise<ProofApplied | ProofFailure> {
  const dest = await lockDestination(trx, input.organizationId, input.destinationId);
  if (!dest) return fail("destinacao_nao_encontrada", 404, "Destinação não encontrada nesta organização");
  if (!actor.canManage && dest.createdByUserId !== actor.userId) return fail("sem_permissao", 403, "Somente quem registrou a destinação, ou proprietário/administrador, pode anexar o comprovante");
  const file = await trx.selectFrom("files").select(["id", "organizationId", "purpose", "originalFilename", "contentType", "sizeBytes", "uploadedByUserId"]).where("id", "=", input.fileId).where("organizationId", "=", input.organizationId).forUpdate().executeTakeFirst(); // trava o arquivo: dois anexos simultâneos do mesmo arquivo se serializam
  if (!file) return fail("arquivo_nao_encontrado", 404, "Arquivo não encontrado nesta organização");
  if (file.purpose !== PROOF_PURPOSE) return fail("arquivo_invalido", 422, "Este arquivo não foi enviado como comprovante de destinação");
  if (!actor.canManage && file.uploadedByUserId !== actor.userId) return fail("sem_permissao", 403, "Você só pode anexar arquivos que você mesmo enviou");
  const linked = await trx.selectFrom("stockDestinations").select("id").where("proofFileId", "=", input.fileId).where("proofRemoved", "is not", true).executeTakeFirst();
  if (linked) return fail("arquivo_ja_vinculado", 409, "Este arquivo já está vinculado a uma destinação. Envie o comprovante novamente se precisar usá-lo de novo");
  const [event] = await trx
    .insertInto("stockDestinations")
    .values({ organizationId: input.organizationId, entryType: "correction", itemId: dest.itemId, reversesDestinationId: dest.id, proofFileId: input.fileId, reason: input.reason.trim(), createdByUserId: actor.userId } as never)
    .returning(["id"])
    .execute();
  return { type: "ok", eventId: String(event.id), action: "anexado", destinationId: String(dest.id), itemId: dest.itemId, file: { id: file.id, name: file.originalFilename, contentType: file.contentType, sizeBytes: Number(file.sizeBytes) } };
}

export async function removeProof(trx: Transaction<DB>, input: { organizationId: number; destinationId: string; fileId: number; reason: string }, actor: ProofActor): Promise<ProofApplied | ProofFailure> {
  // remover evidência é mais sensível que anexar: só proprietário/administrador
  if (!actor.canManage) return fail("sem_permissao", 403, "Somente proprietário ou administrador pode remover a referência a um comprovante");
  const dest = await lockDestination(trx, input.organizationId, input.destinationId);
  if (!dest) return fail("destinacao_nao_encontrada", 404, "Destinação não encontrada nesta organização");
  const file = await trx.selectFrom("files").select(["id", "originalFilename", "contentType", "sizeBytes"]).where("id", "=", input.fileId).where("organizationId", "=", input.organizationId).executeTakeFirst();
  if (!file) return fail("arquivo_nao_encontrado", 404, "Arquivo não encontrado nesta organização");
  const state = await getProofState(trx, input.organizationId, input.fileId);
  if (state.state !== "vigente" || state.destinationId !== String(dest.id)) return fail("comprovante_diferente_do_vigente", 409, "Este arquivo não é o comprovante vigente desta destinação");
  const [event] = await trx
    .insertInto("stockDestinations")
    .values({ organizationId: input.organizationId, entryType: "correction", itemId: dest.itemId, reversesDestinationId: dest.id, proofFileId: input.fileId, proofRemoved: true, reason: input.reason.trim(), createdByUserId: actor.userId } as never)
    .returning(["id"])
    .execute();
  return { type: "ok", eventId: String(event.id), action: "removido", destinationId: String(dest.id), itemId: dest.itemId, file: { id: file.id, name: file.originalFilename, contentType: file.contentType, sizeBytes: Number(file.sizeBytes) } };
}

/** Auditoria (por último). Nunca grava chave/provedor de armazenamento. */
export async function auditProof(trx: Transaction<DB>, organizationId: number, actorUserId: number, applied: ProofApplied, reason: string, idempotencyKey: string) {
  await recordAuditLogEntry(
    {
      organizationId,
      actorUserId,
      action: applied.action === "anexado" ? "destinacao.comprovante_anexado" : "destinacao.comprovante_removido",
      entityType: "stock_destination",
      entityId: applied.destinationId,
      metadata: { eventoId: applied.eventId, arquivoId: applied.file.id, nomeArquivo: applied.file.name, tipo: applied.file.contentType, tamanhoBytes: applied.file.sizeBytes, motivo: reason.trim(), nenhumMovimentoDeEstoque: true, objetoArmazenadoPreservado: true, chaveIdempotencia: idempotencyKey },
    },
    trx
  );
}
