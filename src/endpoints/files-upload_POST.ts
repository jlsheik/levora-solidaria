import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { storageAdapter } from "../helpers/storageAdapter.js";
import { schema, FILE_MAX_SIZE_BYTES } from "./files-upload_POST.schema.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Por usuário: protege o storage de abuso (upload em massa) por uma conta
// autenticada — o risco aqui é volume/custo de armazenamento, não bot
// anônimo (upload já exige sessão + membership).
const USER_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);

    const userLimit = checkRateLimit({ bucket: "files-upload", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.retryAfterSeconds, "Muitos arquivos enviados em pouco tempo. Aguarde antes de enviar mais.");
    }

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "arquivos.envie");

    let buffer: Buffer;
    try {
      buffer = Buffer.from(input.fileBase64, "base64");
    } catch {
      return new Response(superjson.stringify({ message: "Arquivo em base64 inválido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (buffer.length === 0) {
      return new Response(superjson.stringify({ message: "Arquivo vazio" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (buffer.length > FILE_MAX_SIZE_BYTES) {
      return new Response(
        superjson.stringify({ message: `Arquivo maior que o limite permitido de ${Math.round(FILE_MAX_SIZE_BYTES / 1024 / 1024)}MB` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const stored = await storageAdapter.upload({ organizationId: input.organizationId, buffer, contentType: input.contentType });

    let file;
    try {
      file = await db.transaction().execute(async (trx) => {
        const [row] = await trx
          .insertInto("files")
          .values({
            organizationId: input.organizationId,
            uploadedByUserId: user.id,
            storageProvider: stored.storageProvider,
            storageKey: stored.storageKey,
            originalFilename: input.fileName,
            contentType: input.contentType,
            sizeBytes: buffer.length,
            purpose: input.purpose,
          })
          .returning(["id", "originalFilename", "contentType", "sizeBytes"])
          .execute();

        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "arquivo.enviado",
            entityType: "file",
            entityId: String(row.id),
            metadata: { originalFilename: input.fileName, contentType: input.contentType, sizeBytes: buffer.length, purpose: input.purpose },
          },
          trx
        );

        return row;
      });
    } catch (dbError) {
      // Não deixa um blob órfão no storage se o registro no banco falhar.
      await storageAdapter.delete(stored.storageKey);
      throw dbError;
    }

    return new Response(
      superjson.stringify({
        file: {
          id: file.id,
          originalFilename: file.originalFilename,
          contentType: file.contentType,
          sizeBytes: Number(file.sizeBytes),
          downloadUrl: `/_api/v1/files-download?fileId=${file.id}`,
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao enviar arquivo:", error);
    return buildErrorResponse(error, "Não foi possível enviar o arquivo");
  }
}
