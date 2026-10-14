/**
 * Identificação do conteúdo REAL de um arquivo enviado (pelos primeiros bytes), em vez de confiar no `contentType` declarado pelo cliente.
 * Sem isto, um SVG/HTML com script declarado como `image/png` era aceito e guardado. Só os quatro tipos permitidos em
 * `ALLOWED_CONTENT_TYPES` são reconhecidos; qualquer outra coisa devolve `null`.
 */
export type DetectedFileType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) => buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function detectFileType(buffer: Buffer): DetectedFileType | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buffer, ascii("RIFF")) && startsWith(buffer, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(buffer, ascii("%PDF-"))) return "application/pdf";
  return null;
}

/** Base64 estrito: `Buffer.from(x, "base64")` ignora silenciosamente caracteres inválidos, então o formato é conferido antes de decodificar. */
export function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
