#!/usr/bin/env node
// Verificação de SEGURANÇA em navegador real (CSRF e XSS), contra a pilha local descartável (banco `_qa`, dados sintéticos). Veja docs/QA_VISUAL.md.
//
//   npm run qa:security                        → calibração do detector + CSRF + XSS no Edge e/ou Chrome encontrados
//   npm run qa:security -- --browser edge --verbose
//   npm run qa:security -- --only csrf|xss|calibration
//   npm run qa:security -- --cleanup           → recupera órfãos de uma execução morta à força
//
// SÓ ambiente local/descartável: o banco precisa terminar em `_qa` (lib/guard.mjs), os servidores escutam em 127.0.0.1, as cargas só pedem uma
// imagem de 1 pixel ao coletor local. Nada é enviado para fora desta máquina. Compartilha o registro de órfãos com `qa:visual` (ambas recriam o `_qa`).
// Códigos de saída: 0 tudo conforme · 1 falha de segurança (FAIL) · 2 não consegui medir · 3 ambiente indisponível · 4 calibração do detector falhou.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertDisposableDatabase } from "./lib/guard.mjs";
import { findBrowser, launchBrowser } from "./lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase, resolveDatabaseUrl } from "./lib/stack.mjs";
import { Report, EXIT } from "./lib/report.mjs";
import { STATUS } from "./lib/contrast.mjs";
import { Cleanups } from "./lib/cleanup.mjs";
import { RunState, installSignalHandlers, recoverOrphans } from "./lib/orphans.mjs";
import { QA_PASSWORD, USERS } from "./scenarios.mjs";
import { ATTACKER_ORIGINS, ATTACK_KINDS, attackPage, classifyAttempt, summarizeNetwork, describeNetwork } from "./security/attacks.mjs";
import { allIds, payloadSet, FIELDS } from "./security/payloads.mjs";
import { startCollector, startFixtureVictim } from "./security/server.mjs";
import { dockerStatus, startNginx, removeContainer } from "./security/nginx.mjs";
import { nginxHeaderChecks, nginxUploadThroughProxy, cspInBrowser, writePng } from "./security/headers.mjs";
import { uploadChecks } from "./security/uploads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: opt } = parseArgs({
  options: { browser: { type: "string", default: "auto" }, "db-url": { type: "string" }, only: { type: "string" }, out: { type: "string" }, verbose: { type: "boolean", default: false }, "keep-db": { type: "boolean", default: false }, cleanup: { type: "boolean", default: false } },
});
const ALL_PARTS = ["calibration", "csrf", "xss", "uploads", "headers"];
const parts = new Set((opt.only ?? ALL_PARTS.join(",")).split(",").map((s) => s.trim()));
if (![...parts].every((p) => ALL_PARTS.includes(p))) { console.error(`--only aceita ${ALL_PARTS.join(", ")}`); process.exit(EXIT.ENV); }

const report = new Report(); const cleanups = new Cleanups(); const state = new RunState();
installSignalHandlers({ cleanups, state, exitCode: EXIT.ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const actionsFor = (dbUrl) => ({
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }),
  removeContainer: (name) => removeContainer(name),
  dropDb: async (name, deadRunId) => { if (!dbUrl) throw new Error("URL do banco indisponível para derrubar o banco órfão"); if (assertDisposableDatabase(dbUrl).database !== name) throw new Error(`o banco órfão (${name}) não é o banco de QA atual; não derrubado`); await dropDatabase(dbUrl, { runId: deadRunId }); },
});

let rowSeq = 0;
function add(browser, version, scenario, target, kind, status, detail, extra = {}) {
  report.add({ browser, version, scenario, target, variant: kind, viewport: extra.origin ?? "-", theme: "-", state: extra.state ?? "-", kind, status, detail, ...extra, seq: ++rowSeq });
}

// ---------------------------------------------------------------------------------------------------------------- navegação / login
async function navigate(cdp, url, ready = "document.readyState === 'complete'") {
  await cdp.send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) { try { if (await cdp.eval(ready)) return true; } catch { /* navegando */ } await sleep(150); }
  return false;
}
async function waitUntil(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* tenta de novo */ } await sleep(150); } return false; }
async function clearCookies(cdp) { await cdp.send("Network.clearBrowserCookies"); }
// usuários que existem só na semente de segurança: administrador da plataforma, administrador da organização e usuário de outra organização
const EMAILS = { owner: USERS.owner.email, admin: "admin@qa.example", adm: "adm@qa.example", outsider: "fora@qa.example" };
async function login(cdp, baseUrl, user) {
  await clearCookies(cdp);
  if (!(await navigate(cdp, `${baseUrl}/login`, "!!document.querySelector('input[type=\"email\"]')"))) return false;
  const q = JSON.stringify;
  await cdp.eval(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[type="email"]'), ${q(EMAILS[user])}); set(document.querySelector('input[type="password"]'), ${q(QA_PASSWORD)}); document.querySelector('button[type="submit"]').click(); })()`);
  return !!(await waitUntil(() => cdp.eval("location.pathname !== '/login'")));
}

// ---------------------------------------------------------------------------------------------------------------- calibração do detector
/** Prova que os detectores acusam o que devem (fixtures vulneráveis) e NÃO acusam o que não devem (fixtures seguras). Sem isso, nada vale. */
async function calibrate(b, ctx) {
  const { cdp, collector, victim } = ctx;
  const ok = (name, cond, detail) => { add(b.name, b.version, `calibração:${name}`, name, "calibração", cond ? STATUS.PASS : STATUS.FAIL, detail, { state: "detector" }); return cond; };
  let good = true;
  // --- XSS: fixture vulnerável (innerHTML) deve ser acusada; a segura (textContent) não, e mostra a carga como texto
  const p = payloadSet(collector.url(), "fixture").find((x) => x.key === "P1");
  for (const [route, vulnerable] of [["xss-vuln", true], ["xss-safe", false]]) {
    const before = collector.hits.length;
    await navigate(cdp, `${collector.url()}/fx/${route}?p=${encodeURIComponent(p.text)}`);
    await sleep(900);
    const scan = await scanPage(cdp); const fired = collector.hits.slice(before).some((h) => h.id === p.id);
    const flagged = fired || scan.markers > 0;
    good = ok(`xss:${route}`, vulnerable ? flagged && fired : !flagged && scan.literal, vulnerable ? `fixture vulnerável (innerHTML): acusada (aviso recebido=${fired}, elementos injetados=${scan.markers})` : `fixture segura (textContent): NÃO acusada e a carga aparece como texto (elementos=${scan.markers}, texto literal=${scan.literal})`) && good;
  }
  // --- href javascript: fixture vulnerável deve disparar ao clicar; a segura não cria href javascript:
  for (const [route, vulnerable] of [["href-vuln", true], ["href-safe", false]]) {
    const id = `P9@fixture-${route}`; const before = collector.hits.length;
    await navigate(cdp, `${collector.url()}/fx/${route}?p=${encodeURIComponent(`javascript:void((new Image).src='${collector.url()}/h?id=${id}')`)}`);
    const s = await scanPage(cdp); await clickSelector(cdp, "a"); await sleep(900);
    const fired = collector.hits.slice(before).some((h) => h.id === id);
    good = ok(`href:${route}`, vulnerable ? s.jsLinks > 0 && fired : s.jsLinks === 0 && !fired, vulnerable ? `href javascript: presente e executado ao clicar (acusado: links=${s.jsLinks}, aviso=${fired})` : `href javascript: ausente e nada executa (links=${s.jsLinks}, aviso=${fired})`) && good;
  }
  // --- informativo: o mesmo href javascript: com target=_blank rel=noopener (como a âncora do app) executa ao clicar neste navegador?
  {
    const id = "P9@fixture-href-blank"; const before = collector.hits.length;
    await navigate(cdp, `${collector.url()}/fx/href-blank-vuln?p=${encodeURIComponent(`javascript:void((new Image).src='${collector.url()}/h?id=${id}')`)}`);
    await clickSelector(cdp, "a"); await sleep(1500);
    const fired = collector.hits.slice(before).some((h) => h.id === id);
    add(b.name, b.version, "calibração:href-blank", "href-blank", "calibração", STATUS.PASS, `INFORMATIVO (sem critério): javascript: em âncora com target=_blank rel=noopener ${fired ? "EXECUTOU" : "NÃO executou"} ao clicar neste navegador`, { state: "informativo" });
  }
  // --- arquivos servidos: o MESMO conteúdo ativo executa quando servido como HTML/SVG inline (vulnerável) e NÃO executa como imagem+nosniff ou attachment (seguro)
  await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  for (const [route, vulnerable] of [["file-html-inline", true], ["file-svg-inline", true], ["file-html-as-png-nosniff", false], ["file-html-attachment", false]]) {
    const before = collector.hits.length;
    await navigate(cdp, `${collector.url()}/fx/${route}`).catch(() => {}); await sleep(1300);
    const fired = collector.hits.slice(before).some((h) => h.id === `FX@${route}`);
    good = ok(`arquivo:${route}`, vulnerable ? fired : !fired, vulnerable ? `arquivo ativo servido inline: EXECUTOU e o detector acusa (aviso=${fired})` : `mesmo conteúdo servido de forma segura (${route.includes("png") ? "image/png + nosniff" : "attachment + octet-stream + nosniff"}): NÃO executou (aviso=${fired})`) && good;
  }
  // --- CSRF: contra a vítima de fixture, a origem do MESMO SITE deve criar registro no endpoint vulnerável e ser barrada no guardado
  await navigate(cdp, `${victim.url}/login`);
  for (const origin of ["same-site", "cross-site"]) {
    for (const [endpoint, vulnerableExpected] of [["vuln", origin === "same-site"], ["guarded", false]]) {
      const marker = `cal-${origin}-${endpoint}-${Date.now()}`; const id = `cal-${endpoint}-${origin}`;
      collector.pages.set(id, attackPage({ kind: "fetch-text-plain", target: `${victim.url}/${endpoint}/create`, organizationId: 1, marker, doneUrl: `http://${ATTACKER_ORIGINS[origin]}:${collector.port}/done`, attackId: id }));
      await navigate(cdp, `http://${ATTACKER_ORIGINS[origin]}:${collector.port}/attack/${id}`);
      const fired = await collector.waitDone(id); await sleep(300);
      const created = (await victim.count(marker)) > 0;
      const verdict = classifyAttempt({ expected: "blocked", created, fired });
      good = ok(`csrf:${endpoint}:${origin}`, fired && (verdict.status === "FAIL") === vulnerableExpected, `${endpoint === "vuln" ? "endpoint vulnerável" : "endpoint guardado por Sec-Fetch-Site"} atacado de ${origin}: registro criado=${created} → detector diz ${verdict.status} (esperado ${vulnerableExpected ? "FAIL" : "PASS"})`) && good;
    }
  }
  return good;
}

// ---------------------------------------------------------------------------------------------------------------- varredura de página
async function scanPage(cdp) {
  return JSON.parse(await cdp.eval(`JSON.stringify({
    markers: document.querySelectorAll('[data-xss]').length,
    jsLinks: [...document.querySelectorAll('a[href]')].filter((a) => /^\\s*javascript:/i.test(a.getAttribute('href'))).length,
    literal: document.body.innerText.includes('data-xss') || document.body.innerText.includes('onerror') || document.body.innerText.includes('<'),
    text: (document.body.innerText + " " + [...document.querySelectorAll("input,textarea")].map((e) => e.value).join(" ")).slice(0, 200000),
    path: location.pathname })`));
}
async function clickSelector(cdp, css, text) {
  const r = await cdp.eval(`(() => { const re = ${text ? `new RegExp(${JSON.stringify(text)}, 'i')` : "null"}; const el = [...document.querySelectorAll(${JSON.stringify(css)})].find((e) => !re || re.test((e.getAttribute('aria-label') || e.textContent || '').trim())); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`);
  if (!r) return false;
  const { x, y } = JSON.parse(r); await cdp.click(x, y); return true;
}

// ---------------------------------------------------------------------------------------------------------------- CSRF contra o app real
async function csrf(b, ctx) {
  const { cdp, collector, baseUrl, sql } = ctx;
  const target = `${baseUrl}/_api/v1/needs`;
  const orgId = (await sql`SELECT id FROM organizations ORDER BY id LIMIT 1`)[0].id;
  const countMarker = async (m) => (await sql`SELECT count(*)::int AS n FROM needs WHERE title = ${m}`)[0].n;
  const row = (scenario, origin, kind, v, net, marker) => add(b.name, b.version, scenario, `POST /_api/v1/needs · ${kind.id}`, "CSRF", v.status, `${v.detail} · rede: ${describeNetwork(net)}`, { origin, state: "autenticado", marker });

  // sessão da vítima: login real pela interface (cookie HttpOnly guardado pelo navegador)
  if (!(await login(cdp, baseUrl, "owner"))) { add(b.name, b.version, "csrf:login", "login do dono", "CSRF", STATUS.UNMEASURABLE, "login da vítima não concluiu; ataques não avaliados"); return; }

  // controle positivo: o MESMO endpoint, requisição legítima da própria origem do app, TEM de criar o registro (senão a sonda não prova nada)
  {
    const marker = `csrf-controle-mesma-origem-${Date.now()}`;
    cdp.events.length = 0;
    await cdp.eval(`fetch('/_api/v1/needs', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ json: { organizationId: orgId, title: marker, quantityNeeded: 1, unit: "kg", priority: "media" } }))} }).then((r) => r.status)`);
    await sleep(500);
    const v = classifyAttempt({ expected: "created", created: (await countMarker(marker)) > 0, fired: true });
    row("csrf:controle-mesma-origem", "same-origin", { id: "fetch-json" }, v, summarizeNetwork(cdp.events, "/_api/v1/needs"), marker);
  }

  for (const [originName, host] of Object.entries(ATTACKER_ORIGINS)) {
    for (const kind of ATTACK_KINDS) {
      const attackId = `${originName}-${kind.id}-${Date.now()}`; const marker = `csrf-${attackId}`;
      collector.pages.set(attackId, attackPage({ kind: kind.id, target, organizationId: orgId, marker, doneUrl: `http://${host}:${collector.port}/done`, attackId }));
      await navigate(cdp, "about:blank"); cdp.events.length = 0;
      await navigate(cdp, `http://${host}:${collector.port}/attack/${attackId}`);
      const fired = await collector.waitDone(attackId, 15000); await sleep(1500);
      const v = classifyAttempt({ expected: "blocked", created: (await countMarker(marker)) > 0, fired });
      row(`csrf:${originName}`, originName, kind, v, summarizeNetwork(cdp.events, "/_api/v1/needs"), marker);
    }
  }

  // sem sessão (cookies apagados): o mesmo ataque do mesmo site NÃO pode criar nada (controle negativo: a autenticação é o que o ataque precisa)
  {
    await clearCookies(cdp);
    const attackId = `sem-sessao-${Date.now()}`; const marker = `csrf-${attackId}`;
    collector.pages.set(attackId, attackPage({ kind: "fetch-text-plain", target, organizationId: orgId, marker, doneUrl: `http://127.0.0.1:${collector.port}/done`, attackId }));
    await navigate(cdp, "about:blank"); cdp.events.length = 0;
    await navigate(cdp, `http://127.0.0.1:${collector.port}/attack/${attackId}`);
    const fired = await collector.waitDone(attackId, 15000); await sleep(1200);
    row("csrf:sem-sessao", "same-site", { id: "fetch-text-plain" }, classifyAttempt({ expected: "blocked", created: (await countMarker(marker)) > 0, fired }), summarizeNetwork(cdp.events, "/_api/v1/needs"), marker);
  }
}

// ---------------------------------------------------------------------------------------------------------------- XSS contra o app real
const PAGES = ["", "/necessidades", "/inventario", "/matching", "/oportunidades", "/atribuicoes", "/prestacao-contas"];
async function xss(b, ctx) {
  const { cdp, collector, baseUrl } = ctx;
  if (!(await login(cdp, baseUrl, "owner"))) { add(b.name, b.version, "xss:login", "login do dono", "XSS", STATUS.UNMEASURABLE, "login não concluiu; páginas não avaliadas"); return; }
  const orgPath = "/organizacoes/1";
  const universe = new Set(allIds(collector.url()));
  const hitsNow = () => collector.hits.filter((h) => universe.has(h.id) || /^P9@/.test(h.id)).map((h) => h.id);
  const seen = (before) => [...new Set(hitsNow().slice(before))];

  const rendered = new Map(); // campo → onde a carga apareceu como TEXTO
  const noteRendered = (text, where) => { for (const fl of FIELDS) if (text.includes(`P1@${fl}`) && !rendered.has(fl)) rendered.set(fl, where); };
  for (const sub of PAGES) {
    const url = `${baseUrl}${orgPath}${sub}`; const before = hitsNow().length;
    if (!(await navigate(cdp, url))) { add(b.name, b.version, `xss:página${sub || "/"}`, url, "XSS", STATUS.UNMEASURABLE, "a página não carregou"); continue; }
    await sleep(2000);
    // abre o que normalmente fica fechado (edição, históricos, linhas do tempo): clica só em controles de LEITURA, nunca em confirmar/excluir
    for (const [css, text] of [['button[aria-label^="Editar"]', null], ["button", "^(Ver|Ocultar)? ?(histórico|linha do tempo)|^Linha do tempo|^Ver histórico"], ['button[class*="_outline_"]', "^(Ver )?(linha do tempo|histórico)"]]) {
      if (await clickSelector(cdp, css, text)) { await sleep(1200); const s = await scanPage(cdp); noteRendered(s.text, `${sub || "/"} (diálogo/painel)`); await sendKey(cdp, "Escape"); await sleep(200); }
    }
    const scan = await scanPage(cdp); noteRendered(scan.text, sub || "/"); const hit = seen(before);
    const bad = hit.length > 0 || scan.markers > 0;
    add(b.name, b.version, `xss:página${sub || "/"}`, url, "XSS", bad ? STATUS.FAIL : STATUS.PASS, bad ? `EXECUÇÃO/INJEÇÃO: avisos recebidos=[${hit.join(", ")}] elementos injetados=${scan.markers}` : `nenhuma carga executou (0 avisos) e nenhum elemento foi injetado; carga visível como texto=${scan.literal}`, { state: "armazenado" });
  }

  // páginas da conta (Conta e identidade): o nome do dono carrega a carga de XSS e aparece no campo "Nome", no cabeçalho e na sessão; /seguranca não exibe dado livre, mas é página autenticada nova
  for (const sub of ["/conta", "/seguranca"]) {
    const url = `${baseUrl}${sub}`; const before = hitsNow().length;
    if (!(await navigate(cdp, url))) { add(b.name, b.version, `xss:página${sub}`, url, "XSS", STATUS.UNMEASURABLE, "a página não carregou"); continue; }
    await sleep(2000);
    const scan = await scanPage(cdp); noteRendered(scan.text, sub); const hit = seen(before); const bad = hit.length > 0 || scan.markers > 0;
    add(b.name, b.version, `xss:página${sub}`, url, "XSS", bad ? STATUS.FAIL : STATUS.PASS, bad ? `EXECUÇÃO/INJEÇÃO: avisos recebidos=[${hit.join(", ")}] elementos injetados=${scan.markers}` : "nenhum aviso do coletor e nenhum elemento injetado", { state: "armazenado" });
  }

  // administrador da plataforma: a lista de organizações mostra nome/cidade guardados (só /plataforma)
  if (await login(cdp, baseUrl, "admin")) {
    const before = hitsNow().length;
    if (await navigate(cdp, `${baseUrl}/plataforma`)) {
      await sleep(2500); const scan = await scanPage(cdp); noteRendered(scan.text, "/plataforma"); const hit = seen(before); const bad = hit.length > 0 || scan.markers > 0;
      add(b.name, b.version, "xss:página/plataforma", `${baseUrl}/plataforma`, "XSS", bad ? STATUS.FAIL : STATUS.PASS, bad ? `EXECUÇÃO/INJEÇÃO: avisos=[${hit.join(", ")}] elementos=${scan.markers}` : `nenhuma carga executou e nenhum elemento foi injetado; carga visível como texto=${scan.literal}`, { state: "armazenado" });
    } else add(b.name, b.version, "xss:página/plataforma", `${baseUrl}/plataforma`, "XSS", STATUS.UNMEASURABLE, "a página não carregou", { state: "armazenado" });
  } else add(b.name, b.version, "xss:página/plataforma", "login do administrador", "XSS", STATUS.UNMEASURABLE, "login do administrador não concluiu", { state: "armazenado" });
  if (!(await login(cdp, baseUrl, "owner"))) { add(b.name, b.version, "xss:login", "login do dono", "XSS", STATUS.UNMEASURABLE, "login do dono (segunda vez) não concluiu"); return; }

  // quais campos guardados chegaram a ser exibidos como texto (campo que nunca aparece numa tela visitada NÃO foi avaliado: não vira aprovação)
  for (const fl of FIELDS) add(b.name, b.version, `xss:cobertura:${fl}`, `campo ${fl}`, "XSS", rendered.has(fl) ? STATUS.PASS : STATUS.SKIP, rendered.has(fl) ? `a carga apareceu como TEXTO literal em ${rendered.get(fl)} (sem executar)` : "o campo não aparece em nenhuma tela/diálogo visitado: não avaliado neste contexto", { state: "cobertura" });

  // contexto de URL: comprovante legado com javascript: na linha do tempo (a âncora não pode apontar para javascript:, nem executar ao clicar)
  {
    const before = hitsNow().length;
    await navigate(cdp, `${baseUrl}${orgPath}/atribuicoes`); await sleep(2000);
    let opened = false;
    for (let i = 0; i < 6 && (await clickSelector(cdp, "button", "^Ver linha do tempo")); i++) { opened = true; await sleep(900); } // abre a de cada atribuição (o botão vira "Ocultar")
    await sleep(1500);
    const tl = JSON.parse(await cdp.eval(`JSON.stringify({
      rows: [...document.querySelectorAll("[class*=timelineRow]")].length,
      links: [...document.querySelectorAll("[class*=timelineRow] a")].map((a) => a.getAttribute("href")),
      blockedNote: [...document.querySelectorAll("[class*=timelineRow]")].some((r) => /não exibido/.test(r.textContent)) })`));
    const dangerous = tl.links.filter((h) => /^\s*javascript:/i.test(h ?? ""));
    if (!opened || tl.rows === 0) add(b.name, b.version, "xss:href-comprovante", "linha do tempo da atribuição", "XSS", STATUS.MISSING, `não consegui abrir a linha do tempo da atribuição com o evento legado (aberta=${opened}, linhas=${tl.rows}); a âncora do comprovante não pôde ser avaliada`, { state: "armazenado" });
    else {
      if (dangerous.length) { await clickSelector(cdp, "[class*=timelineRow] a"); await sleep(1500); }
      const fired = seen(before).filter((i) => i === "P9@legacy-proof-url");
      const bad = dangerous.length > 0 || fired.length > 0;
      add(b.name, b.version, "xss:href-comprovante", "âncora do comprovante (linha legada com javascript:)", "XSS", bad ? STATUS.FAIL : STATUS.PASS,
        bad ? `href javascript: presente em ${dangerous.length} âncora(s) e ${fired.length ? "EXECUTOU ao clicar" : "não executou"} (aviso ${fired.join(",") || "-"})` : `linha do tempo aberta (${tl.rows} evento(s)); nenhuma âncora aponta para javascript: (âncoras=${tl.links.length}, aviso de endereço bloqueado=${tl.blockedNote}); nada executou`, { state: "armazenado" });
    }
  }

  // o servidor recusa gravar um comprovante javascript:? (tentativa pelo endpoint real, como o dono, na atribuição aceita)
  {
    const r = await cdp.eval(`fetch('/_api/v1/allocations-receive', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { organizationId: 1, allocationId: ${ctx.openAllocationId}, itemId: ${ctx.itemId}, quantityReceived: 1, proofUrl: ${JSON.stringify(`javascript:void((new Image).src='${collector.url()}/h?id=P9@api-proof-url')`)} } }) }).then((r) => r.status)`);
    add(b.name, b.version, "xss:api-aceita-javascript", "POST allocations-receive com proofUrl javascript:", "XSS", r === 400 ? STATUS.PASS : STATUS.FAIL, r === 400 ? "o servidor recusou (400)" : `o servidor aceitou/respondeu ${r}: a URL javascript: foi gravada`, { state: "entrada" });
  }

  // refletido: caminho, hash e consulta da URL com as cargas (nada pode executar)
  {
    const payloads = payloadSet(collector.url(), "url").slice(0, 6); const before = hitsNow().length;
    for (const [label, mk] of [["caminho /convites/<carga>", (t) => `/convites/${encodeURIComponent(t)}`], ["consulta ?next=<carga>", (t) => `/login?next=${encodeURIComponent(t)}`], ["hash #<carga>", (t) => `/#${encodeURIComponent(t)}`], ["caminho 404 /<carga>", (t) => `/${encodeURIComponent(t)}`]]) {
      const b0 = collector.hits.length;
      for (const p of payloads) { await navigate(cdp, `${baseUrl}${mk(p.text)}`); await sleep(500); }
      await sleep(600);
      const hits = collector.hits.slice(b0).map((h) => h.id).filter((i) => i.endsWith("@url"));
      const scan = await scanPage(cdp);
      add(b.name, b.version, `xss:refletido:${label}`, label, "XSS", hits.length || scan.markers ? STATUS.FAIL : STATUS.PASS, hits.length || scan.markers ? `EXECUÇÃO/INJEÇÃO: avisos=[${hits.join(", ")}] elementos=${scan.markers}` : "nenhuma carga executou nem criou elementos", { state: "refletido" });
    }
    void before;
  }
}
async function sendKey(cdp, name) { try { await cdp.key(name); } catch { /* ok */ } }

// ---------------------------------------------------------------------------------------------------------------- principal
async function main() {
  const dbUrl = resolveDatabaseUrl({ cli: opt["db-url"], root });
  const rec = await recoverOrphans({ ownRunId: state.runId, actions: actionsFor(dbUrl) });
  if (rec.busy) { report.addEnv(`já existe uma execução da verificação visual/segurança em andamento (pid ${rec.pid})`); return; }
  if (rec.killed?.length || rec.profiles?.length || rec.database || rec.preserved?.length) console.log(`órfãos recuperados: processos=${rec.killed.length} perfis=${rec.profiles.length} banco=${rec.database ?? "-"} preservados=${(rec.preserved?.length ?? 0) + (rec.profilesPreserved?.length ?? 0)}${rec.errors.length ? ` · erros: ${rec.errors.join("; ")}` : ""}`);
  if (opt.cleanup) { console.log("limpeza concluída"); return; }
  state.begin(); cleanups.add("registro de execução", async () => state.end());

  const wanted = opt.browser === "auto" || opt.browser === "both" ? ["edge", "chrome"] : [opt.browser];
  if (!wanted.every((x) => ["edge", "chrome"].includes(x))) { report.addEnv(`--browser inválido: ${opt.browser}`); return; }
  const browsers = [];
  for (const name of wanted) { const exe = findBrowser(name); if (exe) browsers.push({ name, exe }); else if (opt.browser === "auto") console.log(`aviso: ${name} não encontrado — não será avaliado`); else report.addEnv(`${name} não encontrado (defina QA_${name.toUpperCase()}_PATH)`); }
  if (report.env.length) return;
  if (!browsers.length) { report.addEnv("nenhum navegador (Edge/Chrome) encontrado"); return; }

  const collector = await startCollector(); cleanups.add("coletor", () => collector.stop());
  const victim = await startFixtureVictim(); cleanups.add("vítima de fixture", () => victim.stop());
  console.log(`coletor/atacante em 127.0.0.1:${collector.port} · vítima de fixture em 127.0.0.1:${victim.port}`);

  let stack; let sql; let ids = {}; let storageDir; let nx; let distDir; let pngFile;
  const needsApp = ["csrf", "xss", "uploads", "headers"].some((p) => parts.has(p));
  if (needsApp) {
    let target; try { target = assertDisposableDatabase(dbUrl); } catch (e) { report.addEnv(`banco: ${e.message}`); return; }
    console.log(`banco de QA: ${target.database} em ${target.host}:${target.port} (schema recriado a partir de db/schema.sql)`);
    try {
      if (!opt["keep-db"]) cleanups.add("banco de QA", async () => { await dropDatabase(dbUrl, { runId: state.runId }); state.clearDatabase(); });
      state.setDatabase(target.database);
      await prepareDatabase(dbUrl, root, { runId: state.runId });
      process.env.QA_PASSWORD = QA_PASSWORD;
      // armazenamento de arquivos DESCARTÁVEL (a API e a semente gravam aqui; nunca em storage/uploads do projeto)
      storageDir = mkdtempSync(path.join(tmpdir(), "levora-qa-profile-storage-")); state.addProfile(storageDir);
      cleanups.add("armazenamento de arquivos", async () => { rmSync(storageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); state.dropProfile(storageDir); });
      stack = await startStack({ root, databaseUrl: dbUrl, onSpawn: (pid, kind, extra) => state.addChild(pid, kind, extra), seedScript: path.join("scripts", "qa-visual", "security", "seed.ts"), extraEnv: { QA_SEC_COLLECTOR: collector.url(), QA_PASSWORD, STORAGE_LOCAL_DIR: storageDir, ...(process.platform === "linux" && parts.has("headers") ? { QA_API_HOST: "0.0.0.0" } : {}) } });
    } catch (e) { report.addEnv(`pilha de verificação não subiu: ${e.message}`); return; }
    cleanups.add("API e Vite", () => stack.stop());
    const { default: postgres } = await import("postgres");
    sql = postgres(dbUrl, { max: 2, prepare: false, onnotice: () => {} }); cleanups.add("conexão com o banco", () => sql.end());
    ids = { openAllocationId: (await sql`SELECT id FROM opportunity_allocations WHERE status = 'aceita' ORDER BY id LIMIT 1`)[0].id, itemId: (await sql`SELECT id FROM inventory_items ORDER BY id LIMIT 1`)[0].id };
    ids.orgId = (await sql`SELECT id FROM organizations WHERE slug = 'associacao-sec'`)[0].id;
    console.log(`aplicação em ${stack.baseUrl}`);
  }

  // nginx REAL (Docker) com a configuração de produção do repositório + build temporária do cliente
  if (parts.has("headers")) {
    const docker = dockerStatus();
    if (!docker.ok) report.addEnv(`parte "headers" não executada: ${docker.reason} (código 3: sem o nginx real não há como medir os cabeçalhos de produção)`);
    else {
      try {
        distDir = mkdtempSync(path.join(tmpdir(), "levora-qa-profile-dist-")); state.addProfile(distDir);
        cleanups.add("build temporária do cliente", async () => { rmSync(distDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); state.dropProfile(distDir); });
        const build = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", distDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 240000 });
        if (build.status !== 0 || !existsSync(path.join(distDir, "index.html"))) throw new Error(`a build do cliente falhou: ${(build.stderr || build.stdout || "").slice(0, 300)}`);
        nx = await startNginx({ confPath: path.join(root, "deploy", "nginx.conf"), distDir, apiPort: stack.apiPort, onContainer: (name) => state.addContainer(name), onWorkDir: (d) => state.addProfile(d) });
        cleanups.add("nginx (Docker)", async () => { await nx.stop(); state.dropContainer(nx.name); state.dropProfile(nx.workDir); });
        console.log(`nginx real (deploy/nginx.conf, TLS autoassinado descartável) em https://localhost:${nx.port}`);
        pngFile = writePng(path.join(storageDir, "..", `levora-qa-profile-png-${process.pid}.png`));
        state.addProfile(pngFile); cleanups.add("PNG sintético", async () => { rmSync(pngFile, { force: true }); state.dropProfile(pngFile); });
        await nginxHeaderChecks({ add, STATUS }, { nx, distDir, root });
        await nginxUploadThroughProxy({ add, STATUS }, { nx, orgId: ids.orgId, email: EMAILS.adm, password: QA_PASSWORD });
      } catch (e) { report.addEnv(`parte "headers" não executada: ${e.message}`); nx = undefined; }
    }
  }

  const ran = [];
  for (const br of browsers) {
    let session;
    try { session = await launchBrowser(br.exe, { extraArgs: nx ? ["--ignore-certificate-errors"] : [], onSpawn: (pid, kind, extra) => state.addChild(pid, kind, extra), onProfile: (d) => state.addProfile(d), onProfileGone: (d) => state.dropProfile(d) }); } catch (e) { report.addEnv(`${br.name}: não abriu (${e.message})`); continue; }
    cleanups.add(`navegador ${br.name}`, async () => session.close());
    try {
      const b = { name: br.name, version: session.version };
      console.log(`${b.name}: ${session.version}`);
      const ctx = { cdp: session.cdp, collector, victim, baseUrl: stack?.baseUrl, sql, ...ids };
      if (parts.has("calibration")) { const good = await calibrate(b, ctx); if (!good) { report.addEnv("calibração do detector falhou: os resultados de CSRF/XSS deste navegador NÃO são confiáveis"); calibrationFailed = true; } }
      if (!calibrationFailed && parts.has("csrf")) await csrf(b, ctx);
      if (!calibrationFailed && parts.has("xss")) await xss(b, ctx);
      const kit = { add, STATUS, cdp: session.cdp, navigate, login, clickSelector, sleep, sendKey };
      const user = browsers.indexOf(br) === 0 ? "owner" : "adm"; // o limite de envio de arquivos é por usuário
      if (!calibrationFailed && parts.has("uploads")) await uploadChecks(kit, b, { cdp: session.cdp, collector, sql, storageDir, user, outsiderLogin: () => login(session.cdp, stack.baseUrl, "outsider"), baseUrl: stack.baseUrl, orgId: ids.orgId });
      if (!calibrationFailed && parts.has("headers") && nx) await cspInBrowser(kit, b, { nx, collector, user, pngFile, assertNoHit: (hitIds, from = 0) => collector.hits.slice(from).filter((h) => hitIds.includes(h.id)) });
      ran.push(b);
    } finally { await session.close(); }
  }
  return { ran, headersExecuted: Boolean(nx) };
}
let calibrationFailed = false;

let code; let outcome;
try { outcome = await main(); code = report.exitCode(); if (calibrationFailed) code = EXIT.SELFTEST; }
catch (e) { report.addEnv(`erro inesperado: ${e.stack ?? e.message}`); code = EXIT.ENV; }
finally { const errs = await cleanups.runAll(); for (const er of errs) console.log(`aviso de limpeza (${er.name}): ${er.message}`); }
const file = opt.out ? path.resolve(opt.out) : path.join(tmpdir(), "levora-qa-visual", `seguranca-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ geradoEm: new Date().toISOString(), node: process.version, so: process.platform, partes: [...parts], partesOmitidas: ALL_PARTS.filter((p) => !parts.has(p)), headersExecutados: outcome?.headersExecuted ?? false, navegadores: outcome?.ran ?? [], contagem: report.counts(), env: report.env, linhas: report.rows }, null, 1));
for (const line of report.format({ verbose: opt.verbose })) console.log(line);
const skipped = ALL_PARTS.filter((p) => !parts.has(p));
console.log(`Partes executadas: ${[...parts].join(", ")}${skipped.length ? ` · NÃO selecionadas (não contam como aprovadas): ${skipped.join(", ")}` : ""} · cabeçalhos nginx: ${outcome?.headersExecuted ? "EXECUTADOS" : parts.has("headers") ? "NÃO executados (ver ENV)" : "não selecionados"}`);
console.log(`Relatório JSON: ${file}`);
process.exit(code);
