import { z } from "zod";
import superjson from "superjson";

// Alinhado com FILE_MAX_SIZE_BYTES em files-upload_POST.ts — checagem no
// cliente é só uma conveniência de UX, a validação que importa é no servidor.
export const FILE_MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8MB
export const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  purpose: z.enum(["comprovante_entrega", "comprovante_destinacao"]),
  // Sem caracteres de controle (\r, \n, etc.) — este valor é gravado como
  // `originalFilename` e depois usado literalmente no header
  // `Content-Disposition` do download (files-download_GET.ts). Sem esta
  // restrição, um nome de arquivo como "a\r\nSet-Cookie: ..." injetaria
  // cabeçalhos HTTP arbitrários na resposta do download.
  fileName: z.string().min(1).max(255).regex(/^[^\x00-\x1F\x7F]+$/, "Nome de arquivo não pode conter caracteres de controle"),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  fileBase64: z.string().min(1),
});

export type OutputType = {
  file: {
    id: number;
    originalFilename: string;
    contentType: string;
    sizeBytes: number;
    downloadUrl: string;
  };
};

export const postFilesUpload = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/files-upload`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível enviar o arquivo");
  }

  return superjson.parse<OutputType>(await result.text());
};
