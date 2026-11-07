#!/usr/bin/env node
// Autoteste do QA visual com NAVEGADOR REAL (Chrome e/ou Edge) contra o app-fixture descartável (nunca o produto): prova, com capturas e comparações de verdade, que
//   (1) as capturas são reais e completas; (2) candidata ≠ aprovada; (3) a comparação detecta regressões controladas de cada tipo e NÃO acusa ruído imperceptível;
//   (4) STALE/MISSING_BASELINE/CORRUPT são distinguidos; (5) o D6 classifica falhas de carregamento (e o executor FUNCIONAL real usa essa classificação).
// Uso: node scripts/qa-visual/visual-selftest.mjs [--browser chrome|edge|both] [--out DIR] [--quick] [--sections core,variants,baseline,d6]
// Saída: DIR/selftest-report.json + capturas/diferenças reais em DIR/<navegador>/…  Código: 0 tudo como esperado · 4 alguma expectativa falhou · 3 navegador indisponível.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { findBrowser, launchBrowser } from "./lib/browser.mjs";
import { installProbe, runScenarios } from "./lib/runner.mjs";
import { Report } from "./lib/report.mjs";
import { STATUS } from "./lib/contrast.mjs";
import { VIEWPORTS } from "./lib/viewport.mjs";
import { CAPTURE, captureCell } from "./lib/capture.mjs";
import { approveBaseline, auditBaselines, loadManifest, saveManifest, assertNoSecrets } from "./lib/baseline.mjs";
import { VS, VISUAL_EXIT, runVisualForBrowser, summarizeVisual, verifyEvidence, visualExitCode, writeVisualReport } from "./lib/visualrun.mjs";
import { decodePng } from "./lib/png.mjs";
import { FIXTURE_PAGES, startFixtureApp } from "./fixtures/visual-fixture-app.mjs";

const { values: opt } = parseArgs({ options: { browser: { type: "string", default: "both" }, out: { type: "string" }, quick: { type: "boolean", default: false }, sections: { type: "string", default: "all" } } });
const SECTIONS = new Set(opt.sections.split(",").map((x) => x.trim())); const has = (n) => SECTIONS.has("all") || SECTIONS.has(n); // core | variants | baseline | d6 | dynamic | long | clock
const wanted = opt.browser === "both" ? ["chrome", "edge"] : [opt.browser];
const OUT = path.resolve(opt.out ?? path.join(tmpdir(), "levora-qa-visual-selftest", new Date().toISOString().replace(/[:.]/g, "-"))); mkdirSync(OUT, { recursive: true });
const SHA = "0".repeat(40); const VPS = [VIEWPORTS.find((v) => v.w === 375), VIEWPORTS.find((v) => v.w === 1280)]; const THEMES = ["light", "dark"];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const results = []; let failures = 0;
const check = (browser, name, ok, detail = "") => { results.push({ browser, name, ok: !!ok, detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  [${browser}] ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`); };
const lum = (img) => { let s = 0; for (let i = 0; i < img.data.length; i += 4) s += img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114; return s / (img.data.length / 4); };
const distinct = (img) => { const set = new Set(); for (let i = 0; i < img.data.length; i += 4) { set.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]); if (set.size > 50) break; } return set.size; };

const VARIANT_EXPECT = { // variante → o que a comparação precisa dizer (nas células do painel)
  cor: { shape: "color-only", finding: "color" }, deslocamento: { finding: "moved" }, espacamento: { finding: "moved" }, oculto: { finding: "hidden" },
  cortado: { finding: "clipped" }, sobreposicao: { finding: "moved" }, tipografia: { finding: "typography" }, altura: { dimension: true },
};

async function perBrowser(name) {
  const exe = findBrowser(name); if (!exe) { check(name, "navegador disponível", false, `${name} não encontrado (QA_${name.toUpperCase()}_PATH)`); return; }
  const app = await startFixtureApp(); const dir = path.join(OUT, name); const bl = path.join(dir, "baselines"); mkdirSync(dir, { recursive: true });
  const filesDir = mkdtempSync(path.join(tmpdir(), "levora-qa-visual-files-"));
  let session = await launchBrowser(exe); await installProbe(session.cdp);
  const painel = FIXTURE_PAGES.filter((p) => p.id === "painel"); const baseOpts = () => ({ session, browserName: name, baseUrl: app.url, pages: FIXTURE_PAGES, viewports: VPS, themes: THEMES, baselineDir: bl, sourceSha: SHA, filesDir });
  const run = (mode, label, over = {}) => runVisualForBrowser({ ...baseOpts(), mode, outDir: path.join(dir, label), ...over });
  console.log(`\n== ${name}: ${session.version}`);
  try {
    const doCore = has("core") || has("variants") || has("baseline");
    if (doCore) {
    // 1) captura real → candidatas
    app.setVariant("base"); const cap = await run("capture", "01-capture");
    check(name, "captura gera 8 candidatas (2 páginas × 2 viewports × 2 temas)", cap.length === 8 && cap.every((c) => c.status === VS.CANDIDATE_CREATED), JSON.stringify(summarizeVisual(cap)));
    check(name, "modo capture NÃO homologa (exit 6) e nada vira APPROVED", visualExitCode(cap) === VISUAL_EXIT.NOT_HOMOLOGATED && loadManifest(bl).entries.every((e) => e.state === "CANDIDATE"));
    const imgs = new Map(); let real = true, metaOk = true, shaOk = true;
    for (const c of cap) {
      if (!c.captured) { real = false; metaOk = false; shaOk = false; continue; } // célula não capturada: as verificações abaixo reprovam, o autoteste não cai
      const buf = readFileSync(path.join(dir, "01-capture", c.captured.file)); const img = decodePng(buf); imgs.set(c.id, img);
      real &&= img.width === Number(c.viewport.split("x")[0]) && img.height >= 600 && distinct(img) >= 3 && img.height <= 3200;
      shaOk &&= sha(buf) === c.captured.sha256;
      metaOk &&= !!(c.route && c.browser === name && c.browserVersion && c.viewport && c.theme && c.sourceSha === SHA && c.capturedAt && c.captureConfigVersion && c.auth?.user === "guest" && c.captured.sha256 && c.fingerprintFile && c.preconditions?.pixelStable === true);
    }
    check(name, "as imagens são páginas realmente renderizadas (largura = viewport, várias cores, altura plausível)", real);
    check(name, "SHA-256 gravado confere com o arquivo; metadados completos (URL, navegador+versão, viewport, tema, SHA, data, config, auth sem segredo)", shaOk && metaOk);
    const dk = [...imgs].filter(([id]) => id.includes("painel__") && id.endsWith("1280x900__dark"))[0]?.[1], lt = [...imgs].filter(([id]) => id.includes("painel__") && id.endsWith("1280x900__light"))[0]?.[1];
    check(name, "tema escuro é de fato mais escuro que o claro (o tema foi aplicado antes da captura)", dk && lt && lum(dk) < lum(lt) - 60, `luminância escuro=${dk && Math.round(lum(dk))} claro=${lt && Math.round(lum(lt))}`);
    const cap2 = await run("capture", "01b-capture-de-novo"); // mesma imagem: não cria duplicata nem toca em nada
    check(name, "capturar de novo a mesma imagem não duplica candidata", cap2.every((c) => c.candidate && c.candidate.created === false) && loadManifest(bl).entries.length === 8);

    // 2) comparar sem aprovação
    const before = sha(readFileSync(path.join(bl, "manifest.json")));
    const c0 = await run("compare", "02-compare-sem-aprovacao");
    check(name, "sem aprovação, comparar dá CANDIDATE_ONLY em tudo (candidata não é referência) e exit 6", c0.every((c) => c.status === VS.CANDIDATE_ONLY) && visualExitCode(c0) === VISUAL_EXIT.NOT_HOMOLOGATED);
    check(name, "comparar nunca escreve no diretório de baselines", sha(readFileSync(path.join(bl, "manifest.json"))) === before);

    // 3) aprovação explícita → comparação pixel a pixel
    for (const e of loadManifest(bl).entries) approveBaseline(bl, { id: e.id, imageSha256: e.imageSha256, reviewer: "autoteste" });
    const c1 = await run("compare", "03-compare-aprovado");
    check(name, "com baseline aprovada, a captura idêntica é VISUAL_PASS (pixels idênticos) em todas as células, exit 0", c1.length === 8 && c1.every((c) => c.status === VS.PASS && c.verdict === "IDENTICAL") && visualExitCode(c1) === VISUAL_EXIT.OK, JSON.stringify(summarizeVisual(c1)));
    await session.close(); session = await launchBrowser(exe); await installProbe(session.cdp); // navegador novo, perfil novo
    const c1b = await run("compare", "03b-compare-sessao-nova");
    check(name, "determinismo entre sessões: outro processo do navegador reproduz os mesmos pixels (PASS idêntico)", c1b.every((c) => c.status === VS.PASS && c.verdict === "IDENTICAL"), JSON.stringify(summarizeVisual(c1b)));


      if (has("variants")) {
    // 4) regressões visuais controladas
    for (const [variant, exp] of Object.entries(VARIANT_EXPECT)) {
      if (opt.quick && !["cor", "oculto", "altura"].includes(variant)) continue;
      app.setVariant(variant); const r = await run("compare", `04-regressao-${variant}`, { pages: painel });
      const hit = r.every((c) => c.status === VS.REGRESSION);
      const diffs = r.every((c) => c.diff && c.metrics?.diffPixels !== undefined && existsSync(path.join(dir, `04-regressao-${variant}`, c.diff.file)));
      let extra = true;
      if (exp.shape) extra &&= r.every((c) => c.metrics.shape === exp.shape);
      if (exp.finding) extra &&= r.some((c) => (c.layoutFindings?.findings ?? []).some((f) => f.type === exp.finding));
      if (exp.dimension) extra &&= r.every((c) => c.verdict === "DIMENSION_MISMATCH");
      check(name, `regressão controlada "${variant}" é detectada como VISUAL_REGRESSION em todas as células e explicada${exp.finding ? ` (${exp.finding})` : ""}${exp.shape ? ` (${exp.shape})` : ""}`, hit && diffs && extra, r.map((c) => `${c.viewport}/${c.theme}:${c.status}${c.metrics ? `:${c.metrics.diffPixels}px` : ""}`).join(" "));
      check(name, `  "${variant}": exit 1 (regressão) e imagem de diferença + painel gravados com SHA-256`, visualExitCode(r) === VISUAL_EXIT.FAIL && r.every((c) => c.diff?.sha256 && (c.triptych?.sha256 || c.verdict === "DIMENSION_MISMATCH")));
    }
    app.setVariant("irrelevante"); const ir = await run("compare", "05-irrelevante", { pages: painel });
    check(name, "M11: diferença de 1 nível por canal NÃO passa no padrão estrito (sem região declarada): VISUAL_REGRESSION/DIFFERENT em todas as células (o padrão antigo a escondia)", ir.every((c) => c.status === VS.REGRESSION && c.verdict === "DIFFERENT"), ir.map((c) => c.verdict).join(","));
    app.setVariant("base"); const back = await run("compare", "05b-volta-ao-base", { pages: painel });
    check(name, "voltar ao CSS original volta a PASS idêntico", back.every((c) => c.status === VS.PASS && c.verdict === "IDENTICAL"));


      }
      if (has("baseline")) {
    // 5) baseline STALE / MISSING / CORRUPT / viewport e tema não se misturam
    const stale = path.join(dir, "bl-stale"); cpSync(bl, stale, { recursive: true }); const m = loadManifest(stale); for (const e of m.entries) e.captureConfigVersion = "cc-antiga"; saveManifest(stale, m);
    const st = await run("compare", "06-stale", { baselineDir: stale });
    check(name, "baseline de outra configuração de captura é STALE_BASELINE (não é regressão nem PASS)", st.every((c) => c.status === VS.STALE) && visualExitCode(st) === VISUAL_EXIT.NOT_HOMOLOGATED);
    const stale2 = path.join(dir, "bl-stale-nav"); cpSync(bl, stale2, { recursive: true }); const m2 = loadManifest(stale2); for (const e of m2.entries) e.browserMajor = (e.browserMajor ?? 0) - 1; saveManifest(stale2, m2);
    const st2 = await run("compare", "06b-stale-navegador", { baselineDir: stale2 });
    check(name, "mudança de versão principal do navegador também é STALE_BASELINE", st2.every((c) => c.status === VS.STALE));
    const only = path.join(dir, "bl-parcial"); cpSync(bl, only, { recursive: true }); const m3 = loadManifest(only); m3.entries = m3.entries.filter((e) => e.theme === "light" && e.viewport === "1280x900"); saveManifest(only, m3);
    const parc = await run("compare", "07-parcial", { baselineDir: only });
    check(name, "viewport/tema nunca herdam a baseline de outro: só 1280x900 claro tem referência; as demais são MISSING_BASELINE", parc.filter((c) => c.status === VS.PASS).length === 2 && parc.filter((c) => c.status === VS.MISSING).length === 6, JSON.stringify(summarizeVisual(parc)));
    const corrupt = path.join(dir, "bl-corrompida"); cpSync(bl, corrupt, { recursive: true }); const m4 = loadManifest(corrupt); const f1 = path.join(corrupt, m4.entries[0].file); writeFileSync(f1, Buffer.concat([readFileSync(f1), Buffer.from("x")])); rmSync(path.join(corrupt, m4.entries[1].file));
    const cor = await run("compare", "08-corrompida", { baselineDir: corrupt });
    check(name, "baseline alterada (hash) ou ausente é BASELINE_CORRUPT: nunca PASS silencioso", cor.filter((c) => c.status === VS.CORRUPT).length >= 2 && visualExitCode(cor) === VISUAL_EXIT.INCONCLUSIVE && auditBaselines(corrupt).issues.length >= 2);


      }
    // 8) segredos e evidências
    const all = [...cap, ...c1]; let clean = true; try { for (const c of all) assertNoSecrets({ ...c, preconditions: undefined }); assertNoSecrets(loadManifest(bl)); } catch { clean = false; }
    check(name, "nenhum metadado (células, manifesto de baselines) carrega segredo/e-mail/cookie", clean);
    const w = writeVisualReport(path.join(dir, "03-compare-aprovado"), { meta: { mode: "compare", sourceSha: SHA, browsers: [{ name, version: session.version }], pages: ["painel", "formulario"] }, cells: c1 });
    const ev = verifyEvidence(path.join(dir, "03-compare-aprovado")); check(name, "manifesto de evidências confere (SHA-256 de cada arquivo)", ev.files > 8 && ev.bad.length === 0 && w.exit === VISUAL_EXIT.OK, `${ev.files} arquivos`);
    const victim = path.join(dir, "03-compare-aprovado", c1[0].captured.file); writeFileSync(victim, Buffer.concat([readFileSync(victim), Buffer.from("x")]));
    check(name, "evidência adulterada é apontada pela verificação do manifesto", verifyEvidence(path.join(dir, "03-compare-aprovado")).bad.length === 1);

    }
    if (has("d6")) {
    // 6) D6 com navegador real
    const d6page = (path_, target = { css: "button#primary" }) => ({ id: "d6", path: path_, user: "guest", steps: [], target });
    const ctx = { cdp: session.cdp, browserName: name, version: session.version, baseUrl: app.url, filesDir };
    const cell = (page) => captureCell(ctx, page, VPS[1], "light");
    const expect = async (label, setup, page, status, cause) => { await setup(); const r = await cell(page); check(name, `D6 ${label} → ${status}/${cause}`, r.status === status && (cause instanceof RegExp ? cause.test(r.cause) : r.cause === cause), `${r.status}/${r.cause}: ${String(r.detail).slice(0, 140)}`); return r; };
    app.setD6("ok");
    await expect("página saudável monta e captura", async () => {}, d6page("/mod"), CAPTURE.OK, "captured");
    await expect("módulo principal com HTTP 404 (defeito do produto)", async () => app.setD6("404"), d6page("/mod"), CAPTURE.FUNCTIONAL_FAIL, "critical-resource-http-error");
    await expect("módulo principal com HTTP 500", async () => app.setD6("500"), d6page("/mod"), CAPTURE.FUNCTIONAL_FAIL, "critical-resource-http-error");
    await expect("gateway indisponível (503)", async () => app.setD6("503"), d6page("/mod"), CAPTURE.INCONCLUSIVE, "environment-gateway-unavailable");
    await expect("conexão encerrada ao carregar o módulo (rede)", async () => app.setD6("reset"), d6page("/mod"), CAPTURE.INCONCLUSIVE, "environment-resource-load-failed");
    await expect("resposta truncada do módulo (rede)", async () => app.setD6("truncado"), d6page("/mod"), CAPTURE.INCONCLUSIVE, /environment-resource-load-failed|unknown-network-error|not-mounted/);
    app.setD6("ok");
    // falha ambiental injetada pelo próprio navegador (CDP Fetch): equivalente ao ERR_CACHE_READ_FAILURE do C24 (aquele código específico só o Chromium sabe gerar)
    await session.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*app.js*", requestStage: "Request" }] });
    const hook = (m) => { const d = JSON.parse(m.data); if (d.method === "Fetch.requestPaused") session.cdp.send("Fetch.failRequest", { requestId: d.params.requestId, errorReason: "Failed" }).catch(() => {}); };
    session.cdp.ws.addEventListener("message", hook);
    await expect("falha de rede injetada no recurso crítico (net::ERR_FAILED, como o ERR_CACHE_READ_FAILURE do C24)", async () => {}, d6page("/mod"), CAPTURE.INCONCLUSIVE, "environment-resource-load-failed");
    session.cdp.ws.removeEventListener("message", hook); await session.cdp.send("Fetch.disable");
    // fonte web pendente: a interface ainda não está pronta e a captura TEM de se recusar (e capturar quando a fonte chega)
    app.holdFont(true); const held = await cell(d6page("/fonte", { css: "#texto" })); check(name, `fonte web pendente → sem captura (INCONCLUSIVE fonts-not-loaded/not-settled)`, held.status === CAPTURE.INCONCLUSIVE && /fonts-not-loaded|not-settled/.test(held.cause), `${held.status}/${held.cause}`);
    app.holdFont(false); const freed = await cell(d6page("/fonte", { css: "#texto" })); check(name, "fonte web liberada → captura real", freed.status === CAPTURE.OK, `${freed.status}/${freed.cause}`);
    await expect("app nunca monta e nada explica (#root vazio, sem erro)", async () => {}, d6page("/vazio", { css: "#nada" }), CAPTURE.INCONCLUSIVE, "not-mounted-no-evidence");
    await expect("exceção não tratada ao montar", async () => {}, d6page("/excecao", { css: "#nada" }), CAPTURE.FUNCTIONAL_FAIL, "app-crashed-on-mount");
    await expect("redirecionamento indevido (a rota termina em outra página que até tem o elemento)", async () => {}, d6page("/redireciona", { css: "#outra" }), CAPTURE.FUNCTIONAL_FAIL, "unexpected-redirect");
    await expect("página de erro do produto no lugar do conteúdo", async () => {}, d6page("/negado", { css: "h1" }), CAPTURE.FUNCTIONAL_FAIL, "unexpected-error-page");
    await expect("elemento realmente ausente numa página que montou (não é ambiente)", async () => {}, d6page("/painel", { css: "#nao-existe" }), CAPTURE.INCONCLUSIVE, "anchor-missing");

    // 7) o executor FUNCIONAL real (runScenarios) usa a mesma classificação — MISSING só em página que montou
    const scen = (id, p, css) => ({ id, user: "guest", path: p, measure: "text", variant: id, steps: [], target: { css }, kind: "text" });
    const fun = async (mode, p, css) => { app.setD6(mode); const rep = new Report(); await runScenarios({ cdp: session.cdp, browserName: name, version: session.version, baseUrl: app.url, scenarios: [scen("f-" + mode, p, css)], viewports: [VPS[1]], report: rep, filesDir }); return rep; };
    const rOk = await fun("ok", "/mod", "button#primary"); check(name, "executor funcional: página saudável mede normalmente (sem FAIL/MISSING/UNMEASURABLE)", rOk.rows.length > 0 && rOk.rows.every((r) => r.status === STATUS.PASS), JSON.stringify(rOk.counts()));
    const r404 = await fun("404", "/mod", "button#primary"); check(name, "executor funcional: módulo 404 → FAIL de carregamento (não MISSING)", r404.rows.some((r) => r.status === STATUS.FAIL && r.kind === "carregamento") && !r404.rows.some((r) => r.status === STATUS.MISSING), r404.rows.map((r) => `${r.status}:${r.kind}`).join(","));
    const rReset = await fun("reset", "/mod", "button#primary"); check(name, "executor funcional: falha de rede ao carregar o módulo → UNMEASURABLE com a causa (não MISSING)", rReset.rows.some((r) => r.status === STATUS.UNMEASURABLE && /environment-resource-load-failed/.test(r.detail)) && !rReset.rows.some((r) => r.status === STATUS.MISSING), rReset.rows.map((r) => `${r.status}:${r.kind}`).join(","));
    const rMiss = await fun("ok", "/painel", "#nao-existe"); check(name, "executor funcional: elemento ausente em página montada continua MISSING (severidade não reduzida)", rMiss.rows.some((r) => r.status === STATUS.MISSING) && !rMiss.rows.some((r) => r.status === STATUS.UNMEASURABLE && r.kind === "carregamento"), rMiss.rows.map((r) => `${r.status}:${r.kind}`).join(","));
    const rRedir = await fun("ok", "/redireciona", "#nao-existe"); check(name, "executor funcional: redirecionamento indevido → FAIL (não MISSING)", rRedir.rows.some((r) => r.status === STATUS.FAIL && /unexpected-redirect/.test(r.detail)), rRedir.rows.map((r) => `${r.status}:${r.kind}`).join(","));


    }
    if (has("dynamic")) { // texto dinâmico: duas capturas de uma página cujo conteúdo muda a cada segundo têm de sair IDÊNTICAS, e só data/hora são normalizadas
      const dctx = { cdp: session.cdp, browserName: name, version: session.version, baseUrl: app.url, filesDir }; const dpage = { id: "datas", path: "/datas", user: "guest", steps: [], target: { css: "#criado" } };
      const c1 = await captureCell(dctx, dpage, VPS[1], "light"); await new Promise((r) => setTimeout(r, 1300)); const c2 = await captureCell(dctx, dpage, VPS[1], "light");
      check(name, "dinâmico: página com data/hora do servidor (muda a cada segundo) → duas capturas com 1,3 s de intervalo saem com o MESMO SHA-256", c1.status === CAPTURE.OK && c2.status === CAPTURE.OK && c1.meta.imageSha256 === c2.meta.imageSha256, `${c1.status}/${c2.status} ${String(c1.meta.imageSha256).slice(0, 10)} ${String(c2.meta.imageSha256).slice(0, 10)}`);
      check(name, "dinâmico: a captura registra os nós normalizados (3: criado, vence, ISO) com retângulos exatos", c1.meta.dynamicText?.count === 3 && c1.meta.dynamicText.nodes.every((n) => n.w > 0 && n.h > 0 && n.kinds.length > 0), JSON.stringify(c1.meta.dynamicText?.nodes?.map((n) => n.kinds.join("+"))));
      const texts = (c1.fingerprint?.elements ?? []).map((e) => e.text);
      check(name, "dinâmico: datas e horas viram dígitos 0 (formato preservado) e os números que NÃO são data/hora ficam intactos", texts.some((t) => t.startsWith("Criado em 00/00/0000, 00:00:00")) && texts.some((t) => t.startsWith("Qtd 12 · R$ 12,50 · 5 kg")) && !texts.some((t) => /Criado em \d\d\/\d\d\/20(?!00)/.test(t) && !t.includes("00/00/0000")), texts.filter((t) => /Criado|Qtd/.test(t)).join(" | "));
      // modo de captura por página: página alta (rodapé de 1000px) em 375x812 → página inteira × só o viewport (caso do diálogo modal)
      app.setVariant("altura"); const pp = { id: "painel", path: "/painel", user: "guest", steps: [], target: { css: "button#primary" } };
      const full = await captureCell(dctx, pp, VPS[0], "light"); const vpo = await captureCell(dctx, { ...pp, capture: { fullPage: false } }, VPS[0], "light"); app.setVariant("base");
      check(name, "modo por página: fullPage:false captura só o viewport (812px) e fullPage:true a página inteira; os modos têm versões de configuração diferentes", full.status === CAPTURE.OK && vpo.status === CAPTURE.OK && full.meta.captureMode === "full-page" && vpo.meta.captureMode === "viewport" && full.meta.height > 1500 && vpo.meta.height === 812 && full.meta.captureConfigVersion !== vpo.meta.captureConfigVersion, `${full.meta.captureMode}:${full.meta.height} ${vpo.meta.captureMode}:${vpo.meta.height}`);
    }
    if (has("long")) { // M04: página longa (14.000 px) = captura SEGMENTADA, completa, costurada sem emendas; idêntica a uma captura única do navegador
      const lctx = { cdp: session.cdp, browserName: name, version: session.version, baseUrl: app.url, filesDir }; const lpage = { id: "longa", path: "/longa", user: "guest", steps: [], target: { css: "#topo" } };
      const lc = await captureCell(lctx, lpage, VPS[0], "light"); const lm = lc.meta; const dec = lc.png ? decodePng(lc.png) : null;
      check(name, "página longa: capturada por SEGMENTOS, completa (altura da imagem = altura do documento), com continuidade verificada e manifesto por segmento", lc.status === CAPTURE.OK && lm.docHeight >= 13900 && dec?.height === lm.docHeight && lm.complete === true && lm.segments?.count >= 3 && lm.segments.continuityChecked === lm.segments.count - 1 && lm.segments.list.every((q) => /^[0-9a-f]{64}$/.test(q.sha256)), `status=${lc.status} doc=${lm.docHeight} img=${dec?.height} seg=${lm.segments?.count} cont=${lm.segments?.continuityChecked}`);
      const whole = await session.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: dec?.width ?? 375, height: lm.docHeight, scale: 1 } }, 60000);
      const wd = decodePng(Buffer.from(whole.data, "base64")); const same = dec && wd.width === dec.width && wd.height === dec.height && Buffer.compare(Buffer.from(wd.data), Buffer.from(dec.data)) === 0;
      check(name, "página longa: a imagem costurada é IDÊNTICA à captura única do navegador (nenhuma linha repetida, faltando ou deslocada; elemento fixed aparece uma vez)", !!same, same ? "idêntica" : "diferente");
      const lc2 = await captureCell(lctx, lpage, VPS[0], "light");
      check(name, "página longa: duas capturas independentes têm o mesmo SHA-256 (determinismo da costura)", lc.meta.imageSha256 === lc2.meta.imageSha256, `${String(lc.meta.imageSha256).slice(0, 10)} ${String(lc2.meta.imageSha256).slice(0, 10)}`);
    }
    if (has("clock")) { // M04: relógio congelado no navegador: valores de tempo reais e estáveis, SEM normalização de texto, fuso fixo
      const { FROZEN_CLOCK, browserClockScript } = await import("./lib/clock.mjs");
      await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: browserClockScript(FROZEN_CLOCK) }); await session.cdp.send("Emulation.setTimezoneOverride", { timezoneId: FROZEN_CLOCK.timezone });
      const cctx = { cdp: session.cdp, browserName: name, version: session.version, baseUrl: app.url, filesDir, clock: FROZEN_CLOCK }; const cpage = { id: "relogio", path: "/relogio", user: "guest", steps: [], target: { css: "#fixo" } };
      const k1 = await captureCell(cctx, cpage, VPS[1], "light"); await new Promise((r) => setTimeout(r, 1300)); const k2 = await captureCell(cctx, cpage, VPS[1], "light");
      const kt = (k1.fingerprint?.elements ?? []).map((e) => e.text).join(" | ");
      check(name, "relógio: duas capturas com 1,3 s de intervalo têm o MESMO SHA-256 (o tempo não anda dentro da página)", k1.status === CAPTURE.OK && k2.status === CAPTURE.OK && k1.meta.imageSha256 === k2.meta.imageSha256, `${k1.status}/${k2.status} ${k1.cause ?? ""} ${String(k1.detail ?? "").slice(0, 160)}`);
      check(name, "relógio: a página mostra o instante congelado REAL (ISO, hora local em São Paulo, fuso) — não zeros", kt.includes("ISO 2026-03-16T15:00:00.000Z") && kt.includes("Local 16/03/2026, 12:00:00") && kt.includes("America/Sao_Paulo"), kt.slice(0, 220));
      check(name, "relógio: nenhuma normalização de texto (nós normalizados = 0, motivo registrado) e 'Lote 10:30 · Sala 12:45 · Ref 2031-09-09' sai intacto", k1.meta.dynamicText?.count === 0 && k1.meta.dynamicText?.disabled === "relogio-congelado" && kt.includes("Lote 10:30 · Sala 12:45 · Ref 2031-09-09"), JSON.stringify(k1.meta.dynamicText));
      check(name, "relógio: o instante e o fuso ficam registrados no meta da captura e na identidade da configuração", k1.meta.clock?.iso === FROZEN_CLOCK.iso && k1.meta.clock?.timezone === FROZEN_CLOCK.timezone && /^cc-/.test(k1.meta.captureConfigVersion), JSON.stringify(k1.meta.clock));
    }
  } catch (e) { check(name, "o autoteste concluiu sem exceção inesperada", false, String(e.stack ?? e).slice(0, 300).replace(/\s+/g, " ")); } finally { await session.close().catch(() => {}); await app.close(); rmSync(filesDir, { recursive: true, force: true }); }
}

for (const b of wanted) await perBrowser(b);
const report = { geradoEm: new Date().toISOString(), node: process.version, navegadores: wanted, total: results.length, falhas: failures, resultados: results };
writeFileSync(path.join(OUT, "selftest-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\nAutoteste visual: ${results.length - failures}/${results.length} verificações como esperado · relatório ${path.join(OUT, "selftest-report.json")}`);
process.exit(failures ? 4 : 0);
