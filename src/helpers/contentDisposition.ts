/**
 * `Content-Disposition` seguro para o nome original do arquivo (texto livre do usuário): o valor do cabeçalho é só ASCII (um caractere
 * fora de Latin-1 fazia o `Response` lançar e o download virar 500), sem aspas, barras, ponto e vírgula nem caracteres de controle
 * (nada de injetar parâmetros ou caminhos); o nome Unicode completo vai em `filename*` (RFC 5987/6266), percent-encoded.
 */
export function buildContentDisposition(kind: "inline" | "attachment", originalName: string): string {
  const fallback = originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;/%]/g, "_").trim() || "arquivo";
  const encoded = encodeURIComponent(originalName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
