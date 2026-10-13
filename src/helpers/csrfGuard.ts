/**
 * Defesa em profundidade contra CSRF nas rotas que ESCREVEM (qualquer método diferente de GET/HEAD/OPTIONS).
 *
 * Por que existe: o cookie de sessão é `SameSite=Lax`, que só impede o envio entre SITES diferentes. Uma página de OUTRA ORIGEM do MESMO SITE
 * (outra porta ou outro subdomínio do mesmo domínio registrável) continua enviando o cookie, e a API aceitava qualquer Content-Type no corpo
 * (o corpo era lido de qualquer tipo): um `fetch` "simples" com `text/plain` não dispara preflight CORS e criava registros com a sessão da vítima
 * (reproduzido em navegador real por `npm run qa:security`).
 *
 * Duas camadas independentes, ambas baratas e sem estado:
 *  1. Fetch Metadata: `Sec-Fetch-Site` é enviado pelo navegador (a página não consegue forjá-lo). Escrita só é aceita com `same-origin` ou `none`
 *     (ação direta do usuário/ferramenta). Ausente (cliente que não é navegador, ou navegador antigo) → passa para a camada 2.
 *  2. Content-Type: o app só envia `application/json`. Qualquer outro tipo é recusado (415). Uma página de outra origem só consegue enviar
 *     `application/json` por um fetch que exige preflight CORS, e a API não responde CORS → o navegador não envia a requisição de fato.
 */
export type CsrfVerdict = { ok: true } | { ok: false; status: 403 | 415; message: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function checkWriteRequest(method: string, headers: { get(name: string): string | null | undefined }): CsrfVerdict {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return { ok: false, status: 403, message: "Requisição de escrita entre origens não é permitida" };
  }

  const type = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, status: 415, message: "Content-Type deve ser application/json" };
  }
  return { ok: true };
}
