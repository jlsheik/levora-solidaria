// Páginas "do atacante" (CSRF) e classificação dos resultados. Módulo puro (testado): nada aqui toca o banco, o navegador ou a rede.
// O alvo é sempre o endpoint real `POST /_api/v1/needs` (cria uma necessidade com um título-marcador único) do banco de QA descartável.

/** Origens do atacante: o mesmo servidor de fixtures atendido por dois nomes de host diferentes. */
export const ATTACKER_ORIGINS = Object.freeze({
  // localhost × 127.0.0.1: sites diferentes (o host inteiro é o "site" de um IP) → requisição entre sites (Sec-Fetch-Site: cross-site)
  "cross-site": "localhost",
  // outra PORTA no mesmo host: mesma origem NÃO, mesmo site SIM → Sec-Fetch-Site: same-site (o SameSite=Lax do cookie não protege)
  "same-site": "127.0.0.1",
});

/** Tipos de requisição forjada. `simple` = não dispara pré-verificação (preflight) CORS no navegador. */
export const ATTACK_KINDS = Object.freeze([
  { id: "fetch-text-plain", describe: "fetch no-cors com Content-Type text/plain e credenciais (requisição simples)", simple: true },
  { id: "xhr-text-plain", describe: "XMLHttpRequest withCredentials com text/plain (requisição simples)", simple: true },
  { id: "beacon-text-plain", describe: "navigator.sendBeacon com text/plain (requisição simples, sempre com cookies)", simple: true },
  { id: "form-text-plain", describe: "formulário auto-enviado (enctype=text/plain) que monta um corpo JSON válido: navegação de topo POST", simple: true },
  { id: "fetch-json", describe: "fetch com Content-Type application/json e credenciais (exige preflight CORS; a API não responde CORS)", simple: false },
  { id: "form-urlencoded", describe: "formulário auto-enviado urlencoded (controle: o corpo não é JSON)", simple: true },
]);

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

/** Corpo que o app espera (superjson de um objeto sem tipos especiais = `{"json": {...}}`). */
export const needBody = (organizationId, title) => ({ json: { organizationId, title, quantityNeeded: 1, unit: "kg", priority: "media" } });

/**
 * HTML da página do atacante. Ao terminar (ou ao enviar o formulário), avisa o coletor (`doneUrl`) com `?a=<ataque>`; a requisição forjada
 * em si é feita com os cookies que o navegador decidir enviar — é exatamente o que se quer observar.
 */
export function attackPage({ kind, target, organizationId, marker, doneUrl, attackId }) {
  const body = JSON.stringify(needBody(organizationId, marker));
  const done = `new Image().src=${js(`${doneUrl}?a=${attackId}`)}`;
  const head = `<!doctype html><meta charset="utf-8"><title>página do atacante (fixture de teste)</title><body>`;
  switch (kind) {
    case "fetch-text-plain":
      return `${head}<script>fetch(${js(target)},{method:"POST",mode:"no-cors",credentials:"include",headers:{"Content-Type":"text/plain"},body:${js(body)}}).catch(()=>{}).finally(()=>setTimeout(()=>{${done}},700))</script>`;
    case "fetch-json":
      return `${head}<script>fetch(${js(target)},{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:${js(body)}}).catch(()=>{}).finally(()=>setTimeout(()=>{${done}},700))</script>`;
    case "xhr-text-plain":
      return `${head}<script>const x=new XMLHttpRequest();x.open("POST",${js(target)});x.withCredentials=true;x.setRequestHeader("Content-Type","text/plain");x.onloadend=()=>setTimeout(()=>{${done}},700);x.send(${js(body)})</script>`;
    case "beacon-text-plain":
      return `${head}<script>navigator.sendBeacon(${js(target)},new Blob([${js(body)}],{type:"text/plain"}));setTimeout(()=>{${done}},1200)</script>`;
    case "form-text-plain": {
      // Truque do corpo "nome=valor" do enctype=text/plain: o nome carrega todo o JSON menos o fecho, o valor fecha as chaves → JSON válido.
      const full = JSON.parse(body); full.json.pad = "";
      const text = JSON.stringify(full); const cut = text.lastIndexOf('"pad":"') + '"pad":"'.length;
      const name = text.slice(0, cut); const value = text.slice(cut);
      return `${head}<form id="f" method="post" action="${esc(target)}" enctype="text/plain"><input name="${esc(name)}" value="${esc(value)}"></form><script>${done};setTimeout(()=>document.getElementById("f").submit(),400)</script>`;
    }
    case "form-urlencoded":
      return `${head}<form id="f" method="post" action="${esc(target)}"><input name="title" value="${esc(marker)}"><input name="organizationId" value="${esc(organizationId)}"></form><script>${done};setTimeout(()=>document.getElementById("f").submit(),400)</script>`;
    default:
      throw new Error(`tipo de ataque desconhecido: ${kind}`);
  }
}

/**
 * Classifica o resultado de UMA tentativa.
 *  expected "blocked": o app deve impedir o efeito (criou = FAIL, não criou = PASS)
 *  expected "created": controle positivo (o registro TEM de ser criado; senão a sonda não prova nada → UNMEASURABLE)
 *  fired false: a página do atacante não chegou a avisar o fim (não executou) → UNMEASURABLE
 */
export function classifyAttempt({ expected, created, fired }) {
  if (!fired) return { status: "UNMEASURABLE", detail: "a página do atacante não terminou (ataque não executado); sem conclusão" };
  if (expected === "created") return created ? { status: "PASS", detail: "controle positivo: o registro foi criado (a sonda detecta efeito)" } : { status: "UNMEASURABLE", detail: "controle positivo NÃO criou o registro: a sonda não consegue provar nada" };
  return created ? { status: "FAIL", detail: "CSRF: o registro FOI criado por uma origem de atacante" } : { status: "PASS", detail: "bloqueado: nenhum registro criado" };
}

/** Resume o que o navegador/rede mostraram sobre a requisição forjada (sem valores de cookie). */
export function summarizeNetwork(events, urlPart) {
  const sent = new Map(); const out = { requests: [] };
  for (const e of events) {
    if (e.method === "Network.requestWillBeSent" && e.params.request.url.includes(urlPart)) sent.set(e.params.requestId, { method: e.params.request.method, contentType: e.params.request.headers["Content-Type"] ?? e.params.request.headers["content-type"] ?? null, initiator: e.params.type });
  }
  for (const e of events) {
    if (!["Network.requestWillBeSentExtraInfo", "Network.responseReceived", "Network.loadingFailed"].includes(e.method)) continue;
    const r = sent.get(e.params.requestId); if (!r) continue;
    if (e.method === "Network.requestWillBeSentExtraInfo") {
      const h = Object.fromEntries(Object.entries(e.params.headers).map(([k, v]) => [k.toLowerCase(), v]));
      r.secFetchSite = h["sec-fetch-site"] ?? null; r.origin = h["origin"] ?? null; r.cookieSent = "cookie" in h;
      r.blockedCookies = (e.params.associatedCookies ?? []).filter((c) => c.blockedReasons?.length).map((c) => c.blockedReasons.join("+"));
    } else if (e.method === "Network.responseReceived") r.status = e.params.response.status;
    else r.failed = e.params.errorText ?? "falhou";
  }
  out.requests = [...sent.values()].filter((r) => r.method === "POST" || r.method === "OPTIONS");
  return out;
}

export const describeNetwork = (n) => n.requests.length === 0 ? "nenhuma requisição ao alvo chegou a sair" : n.requests.map((r) => `${r.method} ${r.initiator ?? ""} Sec-Fetch-Site=${r.secFetchSite ?? "?"} Origin=${r.origin ?? "-"} cookie=${r.cookieSent === undefined ? "?" : r.cookieSent ? "enviado" : "NÃO enviado"}${r.blockedCookies?.length ? ` (bloqueado: ${r.blockedCookies.join(",")})` : ""} → ${r.status ?? r.failed ?? "sem resposta"}`).join(" ; ");
