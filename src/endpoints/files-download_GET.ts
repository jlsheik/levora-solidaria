import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requireOrganizationMembership, requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { getProofState, PROOF_PURPOSE } from "../helpers/destinationProofs.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { adapterForProvider, keyBelongsToOrganization } from "../helpers/storageAdapter.js";
import { schema } from "./files-download_GET.schema.js";
import { ALLOWED_CONTENT_TYPES } from "./files-upload_POST.schema.js";
import { buildContentDisposition } from "../helpers/contentDisposition.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

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
      .select(["id", "organizationId", "storageProvider", "storageKey", "originalFilename", "contentType", "purpose", "uploadedByUserId"])
      .where("id", "=", input.fileId)
      .executeTakeFirst();

    if (!file) {
      return new Response(superjson.stringify({ message: "Arquivo não encontrado" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const membership = await requireOrganizationMembership(user.id, file.organizationId);

    // Fase 99J — comprovante de DESTINAÇÃO: pertencer à organização não basta. Exige a permissão de leitura de destinações (`inventario.lance`) E um vínculo vigente com uma destinação da
    // organização. Arquivo pendente (ainda sem vínculo) ou com a referência removida só é servido a quem o enviou e a proprietário/administrador (para conferir/auditar), nunca como comprovante.
    if (file.purpose === PROOF_PURPOSE) {
      await requirePermission(user.id, file.organizationId, "inventario.lance");
      const proof = await getProofState(db, file.organizationId, file.id);
      const privileged = file.uploadedByUserId === user.id || roleHasPermission(membership.role, "organizacao.gerencie");
      if (proof.state !== "vigente" && !privileged) {
        return new Response(superjson.stringify({ message: "Arquivo não encontrado" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
    }

    // Chave adulterada no banco (de outra organização, com `..` ou fora do formato) nunca vai ao armazenamento: o objeto servido tem de ser da organização do registro.
    if (!keyBelongsToOrganization(file.storageKey, file.organizationId)) {
      throw new Error(`Chave de armazenamento inconsistente com a organização do arquivo ${file.id}`);
    }

    // Provedor GRAVADO no registro (não o configurado agora), resolvido só DEPOIS da autorização acima; valor desconhecido/sem configuração = erro controlado.
    const buffer = await adapterForProvider(file.storageProvider).download(file.storageKey);

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
    // (buildContentDisposition cuida disso: só ASCII, sem aspas/barras/;, nome Unicode em filename*.)
    //
    // Só os tipos que o upload aceita (imagens e PDF) são exibidos no navegador ("ver comprovante"). Uma linha ANTIGA com qualquer outro
    // tipo (text/html, image/svg+xml...) nunca é servida como conteúdo renderizável na origem autenticada: vira download genérico.
    const renderable = (ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.contentType);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": renderable ? file.contentType : "application/octet-stream",
        "Content-Disposition": buildContentDisposition(renderable ? "inline" : "attachment", file.originalFilename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error: unknown) {
    console.error("Erro ao baixar arquivo:", error);
    return buildErrorResponse(error, "Não foi possível baixar o arquivo");
  }
}
