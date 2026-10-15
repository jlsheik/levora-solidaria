/**
 * Orquestra a análise antimalware de UM arquivo já armazenado: baixa o objeto (do provedor gravado), chama o scanner e registra o resultado com atualização CONDICIONAL (só sai de
 * pendente/indisponível/legado) + auditoria na mesma transação. Idempotente e seguro sob concorrência: dois pedidos simultâneos podem analisar, mas só um grava o estado final; o outro
 * devolve o estado já gravado. Falha de auditoria desfaz a gravação (o arquivo continua não liberado). Nunca apaga o objeto (infectado/pendente ficam isolados até decisão de retenção).
 */
import { db } from "./db.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { adapterForProvider } from "./storageAdapter.js";
import { buildFileScanner, getScanMode, isReleasable, type ScanUnavailableReason } from "./fileScanner.js";

export type ScanStatus = "pendente" | "aprovado" | "infectado" | "indisponivel" | "dispensado" | "legado_nao_analisado";
const RESCANNABLE: ScanStatus[] = ["pendente", "indisponivel", "legado_nao_analisado"];

export interface ScanResult {
  status: ScanStatus;
  reason?: ScanUnavailableReason;
  released: boolean;
}

/** Mensagem segura para o usuário (sem detalhes do scanner). */
export function scanMessage(status: string): string {
  switch (status) {
    case "aprovado":
    case "dispensado":
      return "Arquivo liberado.";
    case "infectado":
      return "O arquivo foi bloqueado por segurança e não pode ser usado. Envie outro arquivo.";
    case "indisponivel":
      return "A análise de segurança está temporariamente indisponível. O arquivo ficou retido; tente analisar novamente em instantes ou procure um administrador.";
    default:
      return "O arquivo aguarda a análise de segurança e ainda não foi liberado.";
  }
}

export async function scanFile(fileId: number, organizationId: number, actorUserId: number): Promise<ScanResult> {
  const file = await db.selectFrom("files").select(["id", "organizationId", "storageProvider", "storageKey", "scanStatus"]).where("id", "=", fileId).where("organizationId", "=", organizationId).executeTakeFirst();
  if (!file) throw new Error("arquivo inexistente");
  const current = file.scanStatus as ScanStatus;
  if (!RESCANNABLE.includes(current)) return { status: current, released: isReleasable(current) };

  const scanner = buildFileScanner();
  let outcome: Awaited<ReturnType<typeof scanner.scan>>;
  try {
    const buffer = await adapterForProvider(file.storageProvider).download(file.storageKey);
    outcome = await scanner.scan(buffer);
  } catch {
    outcome = { status: "indisponivel", reason: "erro_inesperado" };
  }

  const next: ScanStatus = outcome.status === "limpo" ? "aprovado" : outcome.status === "infectado" ? "infectado" : "indisponivel";
  const engine = outcome.status === "indisponivel" ? scanner.name : `${scanner.name}${outcome.engine ? ` ${outcome.engine}` : ""}`.slice(0, 200);
  const updated = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("files")
      .set({ scanStatus: next, scanCheckedAt: new Date(), scanEngine: engine, scanSignature: outcome.status === "infectado" ? outcome.signature : null } as never)
      .where("id", "=", fileId)
      .where("organizationId", "=", organizationId)
      .where("scanStatus", "in", RESCANNABLE)
      .returning(["id"])
      .executeTakeFirst();
    if (!row) return false; // outra requisição já gravou o estado final
    await recordAuditLogEntry(
      {
        organizationId,
        actorUserId,
        action: next === "aprovado" ? "arquivo.analise_aprovada" : next === "infectado" ? "arquivo.bloqueado_por_analise" : "arquivo.analise_indisponivel",
        entityType: "file",
        entityId: String(fileId),
        metadata: { resultado: next, motor: engine, ...(outcome.status === "infectado" ? { assinatura: outcome.signature } : {}), ...(outcome.status === "indisponivel" ? { motivo: outcome.reason } : {}), modo: getScanMode() },
      },
      trx
    );
    return true;
  });
  if (!updated) {
    const now = await db.selectFrom("files").select("scanStatus").where("id", "=", fileId).executeTakeFirstOrThrow();
    return { status: now.scanStatus as ScanStatus, released: isReleasable(now.scanStatus) };
  }
  return { status: next, ...(outcome.status === "indisponivel" ? { reason: outcome.reason } : {}), released: isReleasable(next) };
}
