// Diagnóstico de "usuário autenticado terminou em /login". Só /login NÃO basta para chamar o resultado de inconclusivo: o que a consulta de sessão
// (GET /_api/v1/auth/session, feita pela aplicação ao montar uma rota protegida) respondeu decide de quem é o problema.
//   produto  → o servidor RESPONDEU e a resposta contradiz o contrato do QA (usuário recém-logado recusado com 401/403, ou aceito com 2xx mas mandado ao login): FAIL.
//   ambiente → a consulta não obteve resposta (falha de rede, abortada, pendente), o servidor devolveu 5xx ou o navegador perdeu o cookie: UNMEASURABLE, com a causa.
//   sem-evidência → não há requisição de sessão registrada, ou não deu para saber se o cookie existia: UNMEASURABLE, contado como "sem dados suficientes".
// Nunca vira MISSING (o elemento não foi avaliado) nem PASS. A função é pura: recebe os eventos CDP da célula e a presença do cookie.
export const SESSION_PATH = "/_api/v1/auth/session";

const pathOf = (url) => { try { return new URL(url).pathname; } catch { return String(url ?? ""); } };

/** Requisições de sessão da célula, em ordem, com o desfecho de cada uma (status, falha ou pendente). */
export function sessionRequests(events) {
  const byId = new Map(); const order = [];
  for (const e of events) {
    const p = e.params ?? {};
    if (e.method === "Network.requestWillBeSent" && pathOf(p.request?.url) === SESSION_PATH) { const r = { id: p.requestId, status: null, failed: null, finished: false }; byId.set(p.requestId, r); order.push(r); }
    else if (e.method === "Network.responseReceived") { const r = byId.get(p.requestId); if (r) r.status = p.response?.status ?? null; }
    else if (e.method === "Network.loadingFinished") { const r = byId.get(p.requestId); if (r) r.finished = true; }
    else if (e.method === "Network.loadingFailed") { const r = byId.get(p.requestId); if (r) r.failed = p.errorText || p.blockedReason || "falhou"; }
  }
  return order;
}

/** @returns {{ verdict: "produto"|"ambiente"|"sem-evidencia", cause: string, why: string, requests: number }} */
export function classifyLoginRedirect({ events, cookiePresent = null }) {
  const reqs = sessionRequests(events); const n = reqs.length;
  const last = reqs[n - 1];
  const out = (verdict, cause, why) => ({ verdict, cause, why, requests: n });
  if (!last) return out("sem-evidencia", "sem-requisicao-de-sessao", "a página terminou em /login sem nenhuma consulta de sessão registrada nesta célula: não há como atribuir a causa");
  if (last.failed) return out("ambiente", "consulta-de-sessao-sem-resposta", `a consulta de sessão não obteve resposta (${last.failed}); a rota protegida não pôde ser avaliada`);
  if (last.status === null) return out("ambiente", "consulta-de-sessao-pendente", "a consulta de sessão não terminou antes de a página ir para /login (sem resposta do servidor)");
  if (last.status >= 500) return out("ambiente", "servidor-5xx-na-sessao", `a consulta de sessão devolveu HTTP ${last.status}: erro do servidor, não decisão de autenticação`);
  if (last.status === 401 || last.status === 403) {
    if (cookiePresent === false) return out("ambiente", "cookie-de-sessao-ausente", `HTTP ${last.status} na consulta de sessão porque o navegador não enviou cookie de sessão (perdido no ambiente de QA)`);
    if (cookiePresent === null) return out("sem-evidencia", "cookie-desconhecido", `HTTP ${last.status} na consulta de sessão e não foi possível verificar o cookie do navegador`);
    return out("produto", "sessao-recusada-com-cookie", `o usuário de QA acabou de logar e o navegador tem o cookie de sessão, mas GET ${SESSION_PATH} devolveu HTTP ${last.status}: a aplicação tratou um usuário autenticado como não autenticado`);
  }
  return out("produto", "login-apesar-de-sessao-valida", `GET ${SESSION_PATH} devolveu HTTP ${last.status}, mas a página terminou em /login: comportamento diferente do contrato esperado para um usuário autenticado`);
}
