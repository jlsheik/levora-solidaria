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
    /** Situação da análise antimalware; só `aprovado`/`dispensado` liberam o arquivo. */
    scanStatus: string;
    scanMessage: string;
  };
};

export const UPLOAD_NETWORK_ERROR_MESSAGE = "Não foi possível enviar o arquivo. Verifique sua conexão e tente novamente.";
export const UPLOAD_SERVER_ERROR_MESSAGE = "Não foi possível concluir o envio. Tente novamente mais tarde.";

export const postFilesUpload = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  let result: Response;
  try {
    result = await fetch(`/_api/v1/files-upload`, {
      method: "POST",
      body: superjson.stringify(validatedInput),
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      credentials: "include",
    });
  } catch (err) {
    // Cancelamento deliberado (AbortController) segue como está; o resto é falha de conexão: o texto bruto do navegador ("Failed to fetch") não vai ao usuário.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error(UPLOAD_NETWORK_ERROR_MESSAGE);
  }

  if (!result.ok) {
    // 5xx e corpos que não são JSON do servidor não têm mensagem segura para o usuário; 4xx traz a mensagem pública (pt-BR) escolhida pelo endpoint.
    let message: string | undefined;
    try {
      message = superjson.parse<{ message?: string }>(await result.text())?.message;
    } catch {
      message = undefined;
    }
    throw new Error(result.status >= 500 || !message ? UPLOAD_SERVER_ERROR_MESSAGE : message);
  }

  return superjson.parse<OutputType>(await result.text());
};
