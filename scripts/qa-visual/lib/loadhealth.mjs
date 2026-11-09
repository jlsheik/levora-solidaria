// D6 — saúde de carregamento: separa "a página não pôde ser medida" (ambiente) de "o produto está errado" (regressão) e de "o elemento realmente não existe".
//
// Antes: qualquer elemento não achado virava MISSING, inclusive quando o app nem chegou a montar porque módulos do próprio app falharam ao carregar
// (evidência real do C24: #root vazio + 3× net::ERR_CACHE_READ_FAILURE em /@vite/client, /@react-refresh e /src/App.tsx). Agora a ausência é classificada pela EVIDÊNCIA:
//
//   FAIL         o produto/servidor está errado: redirecionamento indevido numa página montada, página de erro do produto no lugar do conteúdo,
//                recurso crítico próprio com resposta HTTP de erro (4xx/5xx, exceto 502/503/504), bloqueio imposto pelo próprio produto (CSP, redirecionamento inválido),
//                exceção não tratada ao montar sem falha de rede que a explique.
//   UNMEASURABLE o ambiente não permitiu medir: falha de REDE/CACHE do navegador em recurso crítico da própria origem (ERR_CACHE_*, ERR_CONNECTION_*, ERR_EMPTY_RESPONSE…),
//                gateway indisponível (502/503/504), ou app não montou sem NENHUMA evidência de causa (não afirma nada sobre o produto, e também nunca é aprovação).
//   MISSING      (decidido fora daqui) a página montou de verdade, está na rota esperada e o elemento não existe.
//
// Princípios: evidência de produto vence evidência de ambiente quando coexistem (nunca reduz severidade sem prova); falha da própria infraestrutura de QA
// (ERR_BLOCKED_BY_CLIENT de um cenário que bloqueia a URL de propósito) não conta como falha de carregamento.

export const LOAD = Object.freeze({ MEASURABLE: "MEASURABLE", FAIL: "FAIL", UNMEASURABLE: "UNMEASURABLE" });

const ENV_NET = /^net::ERR_(CACHE_|CONNECTION_|EMPTY_RESPONSE|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|HTTP2_|NETWORK_|INTERNET_DISCONNECTED|TIMED_OUT|INSUFFICIENT_RESOURCES|FAILED|ABORTED|SOCKET_|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|PROXY_|SSL_)/;
const PRODUCT_NET = /^net::ERR_(BLOCKED_BY_CSP|BLOCKED_BY_RESPONSE|UNSAFE_REDIRECT|TOO_MANY_REDIRECTS|INVALID_REDIRECT|CONTENT_DECODING_FAILED|INVALID_RESPONSE)/;
const GATEWAY = new Set([502, 503, 504]);
export const PRODUCT_ERROR_TEXT = /^\s*(acesso negado|página não encontrada|algo deu errado|erro inesperado)/i;

const pathOf = (u, base) => { try { return new URL(u, base).pathname.replace(/\/+$/, "") || "/"; } catch { return String(u); } };
const originOf = (u, base) => { try { return new URL(u, base).origin; } catch { return null; } };

/** Recurso que o app precisa para montar: documento, scripts/módulos e CSS da PRÓPRIA origem. Imagens, fontes e chamadas de dados não bloqueiam a montagem. */
export function isCritical(req, baseUrl) {
  if (originOf(req.url, baseUrl) !== originOf(baseUrl, baseUrl)) return false;
  if (["Script", "Stylesheet", "Document"].includes(req.type)) return true;
  const p = pathOf(req.url, baseUrl);
  return /^\/(@vite|@react-refresh|@id|@fs|src\/|node_modules\/)/.test(p) || /\.(m?js|tsx?|jsx|css)$/.test(p);
}

/** Converte os eventos CDP brutos da célula em evidência de carregamento (mantém o tipo do recurso, que o diagnóstico resumido descarta). */
export function extractLoadEvidence(events, baseUrl) {
  const reqs = new Map(); const exceptions = []; const consoleErrors = [];
  for (const e of events) {
    const p = e.params ?? {};
    if (e.method === "Network.requestWillBeSent") reqs.set(p.requestId, { url: p.request?.url ?? "", type: p.type, status: null, error: null, canceled: false, blocked: null });
    else if (e.method === "Network.responseReceived") { const r = reqs.get(p.requestId) ?? { url: p.response?.url ?? "", type: p.type, error: null, canceled: false, blocked: null }; r.status = p.response?.status ?? null; if (!r.url) r.url = p.response?.url ?? ""; reqs.set(p.requestId, r); }
    else if (e.method === "Network.loadingFailed") { const r = reqs.get(p.requestId) ?? { url: "", type: p.type, status: null }; r.error = p.errorText || p.blockedReason || "falhou"; r.canceled = !!p.canceled; r.blocked = p.blockedReason ?? null; r.type = r.type ?? p.type; reqs.set(p.requestId, r); }
    else if (e.method === "Runtime.exceptionThrown") exceptions.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "").slice(0, 300));
    else if (e.method === "Runtime.consoleAPICalled" && p.type === "error") consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  }
  const all = [...reqs.values()].filter((r) => r.url).map((r) => ({ ...r, url: String(r.url).replace(/[?#].*$/, "") }));
  // Se o servidor RESPONDEU (status conhecido) o erro é HTTP, não de rede: o Chromium emite loadingFailed também para módulos com 4xx/5xx, e a resposta é a melhor evidência.
  return { failed: all.filter((r) => r.error && !(r.status >= 400)).slice(0, 40), http: all.filter((r) => r.status >= 400).slice(0, 40), requests: all.length, exceptions: exceptions.slice(0, 10), consoleErrors: consoleErrors.slice(0, 10) };
}

/**
 * ev: { baseUrl, expectedPath, page:{url,rootChildren,visibleText}, net:{failed[],http[]}, exceptions[], scenarioBlocksUrls }
 * Retorna { verdict: MEASURABLE|FAIL|UNMEASURABLE, cause, detail, mounted, redirected }. MEASURABLE = a página montou, na rota certa: aí sim "elemento ausente" é MISSING.
 */
export function classifyLoad(ev) {
  const page = ev.page ?? {}; const base = ev.baseUrl ?? "http://x";
  const mounted = typeof page.rootChildren === "number" ? page.rootChildren > 0 : String(page.visibleText ?? "").trim().length > 0;
  const here = pathOf(page.url ?? "", base); const want = pathOf(ev.expectedPath ?? "/", base); const redirected = !!page.url && here !== want;
  const failed = (ev.net?.failed ?? []).filter((r) => !(ev.scenarioBlocksUrls && /BLOCKED_BY_CLIENT/.test(r.error))); // bloqueio do próprio cenário ≠ falha de carregamento
  const critFailed = failed.filter((r) => isCritical(r, base));
  const productNet = critFailed.filter((r) => PRODUCT_NET.test(r.error));
  const envNet = critFailed.filter((r) => ENV_NET.test(r.error) && !PRODUCT_NET.test(r.error));
  const unknownNet = critFailed.filter((r) => !ENV_NET.test(r.error) && !PRODUCT_NET.test(r.error));
  const critHttp = (ev.net?.http ?? []).filter((r) => isCritical(r, base));
  const productHttp = critHttp.filter((r) => !GATEWAY.has(r.status)); const gatewayHttp = critHttp.filter((r) => GATEWAY.has(r.status));
  const brief = (list) => list.slice(0, 4).map((r) => `${pathOf(r.url, base)} ${r.status ?? r.error}`).join("; ");
  const exceptions = ev.exceptions ?? [];

  if (mounted) {
    if (redirected) return { verdict: LOAD.FAIL, cause: "unexpected-redirect", mounted, redirected, detail: `a rota ${want} terminou em ${here} (redirecionamento indevido)` };
    if (PRODUCT_ERROR_TEXT.test(page.visibleText ?? "")) return { verdict: LOAD.FAIL, cause: "unexpected-error-page", mounted, redirected, detail: `o produto exibiu uma página de erro no lugar do conteúdo: "${String(page.visibleText).trim().slice(0, 60)}"` };
    return { verdict: LOAD.MEASURABLE, cause: "mounted", mounted, redirected, detail: "página montada na rota esperada" };
  }
  // não montou
  if (productHttp.length) return { verdict: LOAD.FAIL, cause: "critical-resource-http-error", mounted, redirected, detail: `o app não montou: recurso crítico da própria origem respondeu erro HTTP (${brief(productHttp)})` };
  if (productNet.length) return { verdict: LOAD.FAIL, cause: "critical-resource-blocked-by-product", mounted, redirected, detail: `o app não montou: recurso crítico bloqueado/rejeitado pelo produto (${brief(productNet)})` };
  if (redirected) return { verdict: LOAD.FAIL, cause: "unexpected-redirect", mounted, redirected, detail: `a rota ${want} terminou em ${here} sem montar o app (redirecionamento indevido)` };
  if (envNet.length) return { verdict: LOAD.UNMEASURABLE, cause: "environment-resource-load-failed", mounted, redirected, detail: `o app não montou: ${envNet.length} recurso(s) crítico(s) da própria origem falharam em nível de rede/cache do navegador (${brief(envNet)}); a página não pôde ser medida` };
  if (gatewayHttp.length) return { verdict: LOAD.UNMEASURABLE, cause: "environment-gateway-unavailable", mounted, redirected, detail: `o app não montou: servidor/gateway indisponível (${brief(gatewayHttp)})` };
  if (exceptions.length) return { verdict: LOAD.FAIL, cause: "app-crashed-on-mount", mounted, redirected, detail: `o app não montou por exceção não tratada: ${exceptions[0].split("\n")[0].slice(0, 160)}` };
  if (unknownNet.length) return { verdict: LOAD.UNMEASURABLE, cause: "unknown-network-error", mounted, redirected, detail: `o app não montou; falha de rede de tipo não classificado (${brief(unknownNet)}): sem prova de defeito do produto` };
  return { verdict: LOAD.UNMEASURABLE, cause: "not-mounted-no-evidence", mounted, redirected, detail: "o app não montou (#root vazio) e não há evidência de rede/console que explique: não afirmo defeito do produto, e não é aprovação" };
}

const PAGE_EVAL = `JSON.stringify({ url: location.href, rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : null, visibleText: (document.body ? document.body.innerText : '').slice(0, 200), readyState: document.readyState })`;

/** Coleta a evidência da célula corrente (estado da página + eventos de rede/console) e classifica. Nunca lança: se não conseguir ler a página, isso também é evidência. */
export async function assessLoad(cdp, { baseUrl, expectedPath, scenarioBlocksUrls = false }) {
  let page = null;
  try { page = JSON.parse(await cdp.eval(PAGE_EVAL)); } catch (e) { page = { url: "", rootChildren: null, visibleText: "", readError: String(e.message).slice(0, 120) }; }
  const ev = extractLoadEvidence(cdp.events, baseUrl);
  const verdict = classifyLoad({ baseUrl, expectedPath, page, net: { failed: ev.failed, http: ev.http }, exceptions: ev.exceptions, scenarioBlocksUrls });
  return { ...verdict, evidence: { url: page.url, rootChildren: page.rootChildren, requests: ev.requests, failed: ev.failed.slice(0, 5).map((r) => `${pathOf(r.url, baseUrl)} ${r.error}`), http: ev.http.slice(0, 5).map((r) => `${pathOf(r.url, baseUrl)} ${r.status}`), exceptions: ev.exceptions.slice(0, 2), console: ev.consoleErrors.slice(0, 2) } };
}
