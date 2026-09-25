import { z } from "zod";

export const schema = z.object({
  fileId: z.coerce.number().int().positive(),
});

// Este endpoint não retorna JSON — devolve os bytes do arquivo direto
// (Content-Type do próprio arquivo), então não há um postX/getX helper
// superjson aqui. O cliente usa a URL diretamente (ver downloadUrl em
// files-upload_POST.schema.ts), sempre com credentials: "include" para
// levar o cookie de sessão, já que o arquivo é privado por organização.
export const buildFilesDownloadUrl = (fileId: number): string => `/_api/v1/files-download?fileId=${fileId}`;
