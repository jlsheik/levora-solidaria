import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { storageAdapter } from "../helpers/storageAdapter";
import { schema } from "./files-download_GET.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

// Arquivo privado por padrão (master prompt, seção sobre armazenamento):
// nunca uma URL pública direta. Este endpoint É o "signed URL" — a
// autorização é a própria sessão autenticada + checagem de membership,
// verificada a cada download, não um token de acesso que pode vazar e
// continuar válido por conta própria.
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ fileId: url.searchParams.get("fileId") });

    const file = await db
      .selectFrom("files")
      .select(["id", "organizationId", "storageProvider", "storageKey", "originalFilename", "contentType"])
      .where("id", "=", input.fileId)
      .executeTakeFirst();

    if (!file) {
      return new Response(superjson.stringify({ message: "Arquivo não encontrado" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    await requireOrganizationMembership(user.id, file.organizationId);

    const buffer = await storageAdapter.download(file.storageKey);

    await recordAuditLogEntry({
      organizationId: file.organizationId,
      actorUserId: user.id,
      action: "arquivo.baixado",
      entityType: "file",
      entityId: String(file.id),
      metadata: { originalFilename: file.originalFilename },
    });

    // Defesa em profundidade: o schema de upload já rejeita caractere de
    // controle no nome do arquivo (ver files-upload_POST.schema.ts), mas um
    // arquivo gravado antes dessa validação existir (ou por qualquer outro
    // caminho futuro que escreva `files.original_filename`) não pode virar
    // injeção de cabeçalho HTTP aqui.
    const safeFilename = file.originalFilename.replace(/["\r\n]/g, "");

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `inline; filename="${safeFilename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error: unknown) {
    console.error("Erro ao baixar arquivo:", error);
    return buildErrorResponse(error, "Não foi possível baixar o arquivo");
  }
}
