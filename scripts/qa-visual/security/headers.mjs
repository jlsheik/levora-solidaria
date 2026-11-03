// Cabeçalhos de segurança de PRODUÇÃO medidos contra o nginx real (deploy/nginx.conf em contêiner, ver nginx.mjs) e a CSP comprovada em
// navegador real: a política tem de (a) bloquear injeção de verdade, comparada com uma página de controle SEM política onde as mesmas ações
// funcionam, e (b) deixar o app funcionar (login, páginas, envio de comprovante) sem nenhuma violação.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkHeaders, analyzeDocumentCsp } from "./csp.mjs";
import { httpsRequest } from "./nginx.mjs";

/** Valores de referência em src/helpers/securityHeaders.ts (o nginx não importa TypeScript: a cópia manual é conferida aqui). */
export function readReferenceCsp(root) {
  const src = readFileSync(path.join(root, "src", "helpers", "securityHeaders.ts"), "utf8");
  const m = /export const DOCUMENT_CSP =\s*"([^"]+)"/.exec(src);
  if (!m) throw new Error("DOCUMENT_CSP não encontrada em src/helpers/securityHeaders.ts");
  return { documentCsp: m[1], withFrameAncestors: `${m[1]}; frame-ancestors 'none'` };
}

/** Código executado NA PÁGINA para tentar seis ações de injeção; devolve o que de fato rodou e se a <base> foi trocada. */
export const INJECTION_JS = (collectorUrl) => `(async () => {
  window.__ran = []; const ran = (n) => window.__ran.push(n); window.__ran_fn = ran;
  const before = document.baseURI; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try { const s = document.createElement('script'); s.textContent = "window.__ran_fn('inline-script')"; document.head.append(s); } catch (e) { /* bloqueio por exceção */ }
  try { const d = document.createElement('div'); d.innerHTML = '<img src="data:," onerror="window.__ran_fn(\\'inline-handler\\')">'; document.body.append(d); } catch (e) {}
  try { const s = document.createElement('script'); s.src = ${JSON.stringify(collectorUrl)} + '/fx/ext.js'; document.head.append(s); } catch (e) {}
  try { const f = new Function("window.__ran_fn('new-function')"); f(); } catch (e) {}
  try { await fetch(${JSON.stringify(collectorUrl)} + '/h?id=CSP@connect', { mode: 'no-cors' }); ran('connect'); } catch (e) {}
  try { const base = document.createElement('base'); base.href = ${JSON.stringify(collectorUrl)} + '/'; document.head.append(base); } catch (e) {}
  await wait(1500);
  return JSON.stringify({ ran: window.__ran, baseChanged: document.baseURI !== before, violations: window.__csp ?? [] });
})()`;

export const VIOLATION_LISTENER = `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' | ' + String(e.blockedURI).slice(0, 80)), true);`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Avalia na página SEM a isenção de CSP que o CDP concede por padrão a `eval`/`new Function` (`allowUnsafeEvalBlockedByCSP: false`): senão a CSP não bloquearia o eval do próprio teste. */
async function evalStrict(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false });
  if (r.exceptionDetails) throw new Error(`erro na página: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const ASSET_KINDS = [["js", /\.js$/, /javascript/], ["css", /\.css$/, /css/]];

/** Cabeçalhos por localização do nginx, sem navegador. Linhas com navegador "nginx". */
export async function nginxHeaderChecks(kit, { nx, distDir, root }) {
  const { add, STATUS } = kit; const label = "nginx"; const version = "1.27-alpine (Docker)";
  const ref = readReferenceCsp(root);
  const row = (scenario, target, problems, detail) => add(label, version, scenario, target, "cabeçalhos", problems.length ? STATUS.FAIL : STATUS.PASS, problems.length ? problems.join("; ") : detail, { state: "produção" });
  const get = (p, o) => httpsRequest(nx.port, p, o);
  for (const p of ["/", "/login", "/index.html", "/organizacoes/1/necessidades"]) {
    const r = await get(p);
    const problems = r.status === 200 ? checkHeaders("document", r) : [`status ${r.status}`];
    const csp = r.headers["content-security-policy"];
    if (csp && csp !== ref.withFrameAncestors) problems.push("CSP do nginx difere de DOCUMENT_CSP_WITH_FRAME_ANCESTORS (src/helpers/securityHeaders.ts)");
    row(`headers:documento ${p}`, `GET ${p}`, problems, "CSP restritiva (bloqueia), frame-ancestors, nosniff, Referrer-Policy, HSTS, uma ocorrência de cada");
  }
  const files = readdirSync(path.join(distDir, "assets"));
  for (const [kind, re, mime] of ASSET_KINDS) {
    const f = files.find((x) => re.test(x));
    if (!f) { add(label, version, `headers:asset ${kind}`, "assets/", "cabeçalhos", STATUS.MISSING, `a build não gerou um .${kind}`, { state: "produção" }); continue; }
    const r = await get(`/assets/${f}`); const problems = r.status === 200 ? checkHeaders("asset", r) : [`status ${r.status}`];
    if (!mime.test(r.headers["content-type"] ?? "")) problems.push(`Content-Type '${r.headers["content-type"]}' não é ${kind} (o navegador recusa módulo com MIME errado)`);
    row(`headers:asset ${kind}`, `GET /assets/${f}`, problems, "tipo MIME correto, nosniff, HSTS, cache imutável");
  }
  { const r = await get("/assets/nao-existe-qa.js"); row("headers:asset inexistente", "GET /assets/nao-existe-qa.js", r.status === 404 ? checkHeaders("asset", r) : [`status ${r.status} (esperado 404)`], "404 sem cache imutável, com nosniff e HSTS"); }
  { // API atravessando o proxy: um único conjunto de cabeçalhos (nginx não duplica nem sobrescreve)
    const h = await get("/_api/__health"); const problems = h.status === 200 ? checkHeaders("api", h) : [`status ${h.status}`];
    row("headers:API pelo proxy", "GET /_api/__health", problems, "CSP da API intacta (default-src 'none'; frame-ancestors 'none'), sem duplicatas, HSTS do nginx");
    const e = await get("/_api/v1/nao-existe-qa"); const pe = e.status === 404 ? checkHeaders("api", e) : [`status ${e.status}`];
    if (!/json/.test(e.headers["content-type"] ?? "")) pe.push("erro 404 da API não é JSON");
    row("headers:API erro 404", "GET /_api/v1/nao-existe-qa", pe, "404 em JSON com os cabeçalhos da API");
    const w = await get("/_api/v1/needs", { method: "POST", headers: { "Content-Type": "text/plain", "Sec-Fetch-Site": "same-origin" }, body: "{}" });
    const pw = w.status === 415 ? checkHeaders("api", w) : [`status ${w.status} (esperado 415)`];
    row("headers:API recusa de escrita", "POST /_api/v1/needs text/plain", pw, "415 em JSON atravessando o proxy, com os cabeçalhos da API");
  }
  // o próprio index.html da build também carrega a CSP por <meta> (primeira camada; sem frame-ancestors, que <meta> ignora)
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(path.join(distDir, "index.html"), "utf8"));
  row("headers:<meta> CSP da build", "dist/index.html", !meta ? ["a build não trouxe a CSP em <meta>"] : meta[1] !== ref.documentCsp ? ["<meta> difere de DOCUMENT_CSP"] : [], "a build injeta DOCUMENT_CSP por <meta>");
  const a = analyzeDocumentCsp(ref.withFrameAncestors);
  add(label, version, "headers:notas da CSP", "CSP do documento", "cabeçalhos", STATUS.PASS, `INFORMATIVO: ${a.notes.join("; ") || "sem exceções"}`, { state: "produção" });
}

/** Por navegador: CSP bloqueia injeção (com controle sem CSP) e o app funciona sob ela. */
export async function cspInBrowser(kit, b, { nx, collector, user, pngFile, assertNoHit }) {
  const { add, STATUS, cdp, navigate, login, clickSelector } = kit; const base = `https://localhost:${nx.port}`;
  const rowB = (scenario, target, ok, detail, kind = "CSP") => add(b.name, b.version, scenario, target, kind, ok === null ? STATUS.UNMEASURABLE : ok ? STATUS.PASS : STATUS.FAIL, detail, { state: "produção" });

  // ---- controle: a MESMA injeção numa página sem CSP precisa funcionar (senão o teste não distingue bloqueio de falha da ação)
  const ctl = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: VIOLATION_LISTENER });
  try {
    await navigate(cdp, `${collector.url()}/fx/csp-control`); await sleep(500);
    const control = JSON.parse(await evalStrict(cdp, INJECTION_JS(collector.url())));
    const need = ["inline-script", "inline-handler", "external-script", "new-function", "connect"];
    const controlOk = need.every((n) => control.ran.includes(n)) && control.baseChanged;
    rowB("csp:controle sem política", "página de fixture sem CSP", controlOk ? true : null, controlOk ? `as seis ações funcionam sem política (executou: ${control.ran.join(", ")}; <base> trocada)` : `o controle NÃO conseguiu executar todas as ações (${control.ran.join(", ") || "nenhuma"}); o teste de bloqueio não é conclusivo`);

    // ---- o app em produção (nginx real): login e navegação legítimos, sem nenhuma violação
    if (!(await login(cdp, base, user))) { rowB("csp:login", base, null, "login pelo nginx não concluiu"); return; }
    const pages = ["/organizacoes/1", "/organizacoes/1/necessidades", "/organizacoes/1/inventario", "/organizacoes/1/atribuicoes", "/organizacoes/1/prestacao-contas"];
    for (const p of pages) {
      await navigate(cdp, `${base}${p}`); await sleep(1800);
      const s = JSON.parse(await cdp.eval(`JSON.stringify({ rendered: document.querySelector('#root')?.children.length > 0, title: document.title, text: document.body.innerText.length, violations: window.__csp ?? [] })`));
      rowB(`csp:funciona ${p}`, `${base}${p}`, s.rendered && s.text > 50 && s.violations.length === 0 ? true : s.violations.length ? false : null,
        s.violations.length ? `VIOLAÇÕES da própria CSP numa página legítima: ${s.violations.slice(0, 3).join(" ; ")}` : s.rendered ? `renderizou (${s.text} caracteres) sem nenhuma violação` : "a página não renderizou", "CSP×funcionamento");
    }
    // ---- envio de comprovante de verdade pela interface sob a CSP, e exibição da imagem enviada
    await navigate(cdp, `${base}/organizacoes/1/atribuicoes`); await sleep(1800);
    let uploaded = null; let stage = "botão 'Registrar recebimento direto' ausente na página";
    const pageBrief = () => cdp.eval(`JSON.stringify({ rota: location.pathname, botoes: [...document.querySelectorAll('button')].map((b) => b.textContent.trim().slice(0, 30)).slice(0, 8), dialogos: document.querySelectorAll('[role="dialog"]').length, campos: document.querySelectorAll('input[type="file"]').length })`).catch(() => "(página indisponível)"); // só observa: explica o UNMEASURABLE, não muda o resultado
    if (await clickSelector(cdp, "button", "^Registrar recebimento direto")) {
      stage = "campo de arquivo ausente no diálogo";
      await sleep(900);
      const doc = await cdp.send("DOM.getDocument", { depth: 0 });
      const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: '[role="dialog"] input[type="file"]' });
      if (node.nodeId) {
        await cdp.send("DOM.setFileInputFiles", { files: [pngFile], nodeId: node.nodeId }); await sleep(2500);
        uploaded = JSON.parse(await cdp.eval(`JSON.stringify({ name: [...document.querySelectorAll('[role="dialog"] span')].map((s) => s.textContent).find((t) => /\\.png$/i.test(t)) ?? null, violations: window.__csp ?? [] })`));
      }
    }
    rowB("csp:envio de comprovante", "FileDropzone → files-upload sob a CSP", uploaded === null ? null : !!uploaded.name && uploaded.violations.length === 0,
      uploaded === null ? `não consegui abrir o diálogo de recebimento / o campo de arquivo (etapa: ${stage}; página: ${await pageBrief()})` : uploaded.name ? `o arquivo ${uploaded.name} foi enviado pela interface, sem violações` : `o envio não apareceu na interface (violações: ${uploaded.violations.join(" ; ") || "nenhuma"})`, "CSP×funcionamento");
    await kit.sendKey(cdp, "Escape");

    // ---- bloqueio real: as mesmas seis ações, agora na página do app
    const hitsBefore = collector.hits.length;
    const r = JSON.parse(await evalStrict(cdp, INJECTION_JS(collector.url())));
    const blockedAll = r.ran.length === 0 && !r.baseChanged;
    const dirs = [...new Set(r.violations.map((v) => v.split(" | ")[0]))].sort();
    rowB("csp:bloqueia injeção", `${base}/organizacoes/1/atribuicoes`, blockedAll ? (r.violations.length >= 5 ? true : null) : false,
      blockedAll ? `nada executou e a <base> não mudou; ${r.violations.length} violações relatadas pelo navegador (${dirs.join(", ")})` : `INJEÇÃO PASSOU: executou [${r.ran.join(", ")}] base trocada=${r.baseChanged}`);
    const hits = assertNoHit(["CSP@connect"], hitsBefore); rowB("csp:conexão externa", "fetch para outra origem", hits.length === 0, hits.length ? "o coletor externo RECEBEU a conexão" : "o coletor externo não recebeu nada (connect-src 'self')");

    // ---- frame-ancestors: o app não pode ser incorporado por outra origem (e uma página sem a proteção pode, no controle)
    // um iframe bloqueado não gera quadro filho: a prova é "sem quadro" + a mensagem do navegador citando frame-ancestors/X-Frame-Options
    await cdp.send("Log.enable");
    const frameOf = async (target) => {
      cdp.events.length = 0; await navigate(cdp, `${collector.url()}/fx/frame?u=${encodeURIComponent(target)}`); await sleep(2500);
      const t = await cdp.send("Page.getFrameTree");
      const log = cdp.events.filter((e) => e.method === "Log.entryAdded").map((e) => e.params.entry.text).find((x) => /frame-ancestors|X-Frame-Options/.test(x)) ?? null;
      return { url: t.frameTree.childFrames?.[0]?.frame.url ?? null, log };
    };
    const ctlFrame = await frameOf(`${collector.url()}/fx/csp-control`); const appFrame = await frameOf(`${base}/login`);
    const frameControlOk = ctlFrame.url?.startsWith(collector.url()) && !ctlFrame.log;
    rowB("csp:incorporação em iframe", `${base}/login`, !frameControlOk ? null : !appFrame.url && !!appFrame.log,
      !frameControlOk ? "o controle (página sem proteção) não foi incorporado normalmente; teste inconclusivo" : !appFrame.url && appFrame.log ? `incorporação BLOQUEADA pelo navegador ("${appFrame.log.replace(/\s+/g, " ").slice(0, 110)}"); o controle sem proteção foi incorporado` : `o app FOI incorporado por outra origem (quadro: ${appFrame.url}, mensagem: ${appFrame.log})`);
  } finally { await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: ctl.identifier }).catch(() => {}); }
}

/** PNG 1x1 sintético para o teste de envio pela interface. */
export function writePng(file) {
  writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  return file;
}

/**
 * Envio pelo PROXY: o nginx tem um limite de corpo próprio (`client_max_body_size`, padrão 1 MB) que precisa acomodar o maior envio válido
 * (8 MB de arquivo = ~10,7 MB de JSON em base64) e deixar o Express (16 MB) responder em JSON o que passar disso. Sessão por login real.
 */
export async function nginxUploadThroughProxy(kit, { nx, orgId, email, password }) {
  const { add, STATUS } = kit; const label = "nginx"; const version = "1.27-alpine (Docker)";
  const row = (scenario, ok, detail) => add(label, version, scenario, "files-upload pelo nginx", "upload", ok === null ? STATUS.UNMEASURABLE : ok ? STATUS.PASS : STATUS.FAIL, detail, { state: "produção" });
  const login = await httpsRequest(nx.port, "/_api/v1/auth/login_with_password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: { email, password } }) });
  const cookie = (login.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
  if (login.status !== 200 || !cookie) { row("upload:pelo nginx (login)", null, `login pelo proxy falhou (${login.status}); envios grandes não avaliados`); return; }
  const png = (bytes) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8)]);
  const send = (buffer) => httpsRequest(nx.port, "/_api/v1/files-upload", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ json: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "grande.png", contentType: "image/png", fileBase64: buffer.toString("base64") } }) });
  const isJson = (r) => /json/.test(r.headers["content-type"] ?? "");
  const MB = 1024 * 1024;
  { const r = await send(png(3 * MB)); row("upload:3 MB pelo nginx", r.status === 200, r.status === 200 ? "ACEITO (200): o corpo de ~4 MB atravessa o proxy" : `o proxy/servidor recusou um envio VÁLIDO de 3 MB (status ${r.status}, ${isJson(r) ? "JSON" : "HTML do nginx"})`); }
  { const r = await send(png(8 * MB)); row("upload:8 MB (limite) pelo nginx", r.status === 200, r.status === 200 ? "ACEITO (200): o maior arquivo permitido (8 MB, ~10,7 MB em base64) atravessa o proxy" : `um envio VÁLIDO no limite de 8 MB foi recusado (status ${r.status}, ${isJson(r) ? "JSON" : "HTML do nginx"})`); }
  { const r = await send(png(9 * MB)); row("upload:9 MB pelo nginx", r.status === 400 && isJson(r), r.status === 400 && isJson(r) ? "REJEITADO CORRETAMENTE pelo app (400 em JSON): acima do limite de 8 MB" : `esperava 400 em JSON do app, veio ${r.status} (${isJson(r) ? "JSON" : "HTML"})`); }
  { const r = await send(png(Math.round(12.2 * MB))); const csp = r.headers["content-security-policy"] === "default-src 'none'; frame-ancestors 'none'"; row("upload:corpo acima de 16 MB pelo nginx", r.status === 413 && isJson(r) && csp, r.status === 413 && isJson(r) && csp ? "REJEITADO CORRETAMENTE (413 em JSON do Express, com a CSP da API), não uma página HTML do nginx" : `esperava 413 em JSON do Express; veio ${r.status} (${isJson(r) ? "JSON" : "HTML"}; CSP da API=${csp})`); }
}
