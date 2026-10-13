/**
 * Endereço de comprovante (`proofUrl`) só pode ser um caminho relativo do próprio app (ex.: `/_api/v1/files-download?fileId=1`) ou uma URL
 * `http:`/`https:`. Esquemas como `javascript:`, `data:` e `vbscript:` executariam código (ou abririam conteúdo ativo) no clique de
 * "ver comprovante", e o React 18 NÃO bloqueia `javascript:` em `href`. Os navegadores ignoram tabulações e quebras de linha dentro do esquema
 * (`java\tscript:`), por isso a verificação passa pelo parser de URL da plataforma e recusa caracteres de controle.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isAllowedProofUrl(value: string): boolean {
  const v = value.trim();
  if (!v || CONTROL_CHARS.test(v)) return false;
  // caminho relativo do mesmo site: começa com uma única "/" (// e /\ seriam URL relativa ao protocolo → outro site)
  if (v.startsWith("/")) return !v.startsWith("//") && !v.startsWith("/\\");
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
