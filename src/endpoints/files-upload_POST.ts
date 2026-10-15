import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { storageAdapter } from "../helpers/storageAdapter.js";
import { schema, FILE_MAX_SIZE_BYTES } from "./files-upload_POST.schema.js";
import { detectFileType, isStrictBase64 } from "../helpers/fileSignature.js";
import { getScanMode } from "../helpers/fileScanner.js";
import { scanFile, scanMessage } from "../helpers/fileScan.js";
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

    // Base64 estrito: Buffer.from ignora caracteres inválidos em silêncio (o arquivo gravado seria outro).
    if (!isStrictBase64(input.fileBase64)) {
      return new Response(superjson.stringify({ message: "Arquivo em base64 inválido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const buffer = Buffer.from(input.fileBase64, "base64");

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

    // O `contentType` vem do cliente: um SVG/HTML com script declarado como image/png seria aceito e guardado. Os primeiros bytes têm de
    // corresponder ao tipo declarado ANTES de qualquer gravação (rejeitado = nada no storage nem no banco).
    if (detectFileType(buffer) !== input.contentType) {
      return new Response(superjson.stringify({ message: "O conteúdo do arquivo não corresponde ao tipo informado" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
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
            // análise obrigatória (produção) = nasce PENDENTE e só é liberado pelo scanner; fora dela, "dispensado" explícito (nunca "aprovado")
            scanStatus: getScanMode() === "required" ? "pendente" : "dispensado",
          } as never)
          .returning(["id", "originalFilename", "contentType", "sizeBytes", "scanStatus"])
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
      // Compensação: remove SÓ o objeto criado por ESTA tentativa (chave nova, uuid gerado agora), para não deixar blob órfão se o banco falhar.
      // Se a remoção também falhar (armazenamento indisponível) o blob fica órfão: isso NÃO é escondido — vira uma linha de log com marcador fixo,
      // provedor e chave (sem credenciais) para a limpeza manual (docs/UPLOAD_DE_ARQUIVOS.md) — e o erro original do banco continua sendo o devolvido.
      try {
        await storageAdapter.delete(stored.storageKey);
      } catch (cleanupError) {
        console.error(`ARQUIVO_ORFAO provider=${stored.storageProvider} key=${stored.storageKey} organizationId=${input.organizationId}: o registro no banco falhou e a remoção do objeto também (${cleanupError instanceof Error ? cleanupError.name : "erro"})`);
      }
      throw dbError;
    }

    // análise antimalware (fora da transação do banco: é uma chamada de rede). Falha/indisponibilidade NÃO libera: o arquivo fica retido e pode ser reanalisado.
    let scanStatus: string = (file as unknown as { scanStatus: string }).scanStatus;
    if (scanStatus === "pendente") {
      try {
        scanStatus = (await scanFile(file.id, input.organizationId, user.id)).status;
      } catch (scanError) {
        console.error(`ANALISE_FALHOU fileId=${file.id} organizationId=${input.organizationId} (${scanError instanceof Error ? scanError.name : "erro"})`);
      }
    }

    return new Response(
      superjson.stringify({
        file: {
          id: file.id,
          originalFilename: file.originalFilename,
          contentType: file.contentType,
          sizeBytes: Number(file.sizeBytes),
          downloadUrl: `/_api/v1/files-download?fileId=${file.id}`,
          scanStatus,
          scanMessage: scanMessage(scanStatus),
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao enviar arquivo:", error);
    return buildErrorResponse(error, "Não foi possível enviar o arquivo");
  }
}
