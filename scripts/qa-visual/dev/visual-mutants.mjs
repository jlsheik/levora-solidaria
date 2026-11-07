#!/usr/bin/env node
// Mutantes do QA visual (M02): cada um copia scripts/qa-visual para uma pasta temporária, aplica UMA sabotagem e exige que os testes a reprovem.
//   camada "unit"     → test/qaVisualRegression.test.ts, test/qaVisualReview.test.ts e test/qaVisualClock.test.ts (config vitest.qavisual.config.ts) com QA_VISUAL_ROOT apontando para a cópia (sem navegador)
//   camada "selftest" → visual-selftest.mjs (Chrome real) na cópia, só nas seções necessárias
// Regras de honestidade: (1) o código original tem de PASSAR antes; (2) o mutante de controle (inócuo) tem de PASSAR; (3) "detectado" só vale se os testes RODARAM e algum falhou —
// erro de inicialização (SyntaxError, importação quebrada, sem relatório) é INVÁLIDO, nunca prova de proteção; (4) âncora ausente/ambígua aborta.
// Uso: node scripts/qa-visual/dev/visual-mutants.mjs [--only id,id] [--skip-selftest]   → <repo>/qa-visual-mutants-results.txt (ou --out FILE)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url)); const SRC = path.resolve(here, ".."); const REPO = path.resolve(SRC, "..", "..");
const { values: o } = parseArgs({ options: { only: { type: "string" }, "skip-selftest": { type: "boolean", default: false }, out: { type: "string" } } });
const OUT = path.resolve(o.out ?? path.join(REPO, "qa-visual-mutants-results.txt"));
const P = (n) => `\${${n}}`;

// [id, camada, arquivo, descrição, [[achar, trocar, {all?}]], seções do autoteste]
const M = [
  ["m00-controle-inocuo", "unit", "lib/png.mjs", "CONTROLE: só um comentário; os testes TÊM de passar", [["export class PngError extends Error {", "// controle (sem efeito)\nexport class PngError extends Error {"]]],
  ["m01-comparacao-desativada", "unit", "lib/visualrun.mjs", "desativa a comparação de pixels (sempre IDENTICAL)", [["const cmp = compareImages(base, cur, { tolerance: page.tolerance, masks: page.masks });", 'const cmp = { verdict: "IDENTICAL", reasons: [], metrics: { diffPixels: 0, aaTolerated: 0, tolerance: { maxDiffPixels: 0 }, shape: "none", bbox: null }, clusters: [], diffImage: cur };']]],
  ["m02-fail-vira-pass-no-comparador", "unit", "lib/imagediff.mjs", "substitui o veredito DIFFERENT por WITHIN_TOLERANCE", [['else { verdict = "DIFFERENT";', 'else { verdict = "WITHIN_TOLERANCE";']]],
  ["m03-fail-vira-pass-no-resultado", "unit", "lib/visualrun.mjs", "a célula vira sempre VISUAL_PASS", [['const status = cmp.verdict === "IDENTICAL" || cmp.verdict === "WITHIN_TOLERANCE" ? VS.PASS : VS.REGRESSION;', "const status = VS.PASS;"]]],
  ["m04-aceita-candidata", "unit", "lib/baseline.mjs", "uma candidata passa a valer como referência aprovada", [["const id = cellId(cell);\n  const approved = m.entries.find((e) => e.id === id && e.state === BASELINE_STATE.APPROVED);", "const id = cellId(cell);\n  const approved = m.entries.find((e) => e.id === id && e.state !== BASELINE_STATE.SUPERSEDED);"]]],
  ["m05-captura-ja-nasce-aprovada", "unit", "lib/baseline.mjs", "a captura nasce APPROVED (aprovação automática)", [["state: BASELINE_STATE.CANDIDATE, ...(approved", "state: BASELINE_STATE.APPROVED, ...(approved"]]],
  ["m06-ignora-viewport", "unit", "lib/baseline.mjs", "a identidade da célula ignora o viewport", [["export const cellId = ({ pageId, browser, viewport, theme }) => `${pageId}__${browser}__${viewport}__${theme}`;", "export const cellId = ({ pageId, browser, theme }) => `${pageId}__${browser}__${theme}`;"]]],
  ["m07-ignora-tema", "unit", "lib/baseline.mjs", "a identidade da célula ignora o tema", [["export const cellId = ({ pageId, browser, viewport, theme }) => `${pageId}__${browser}__${viewport}__${theme}`;", "export const cellId = ({ pageId, browser, viewport }) => `${pageId}__${browser}__${viewport}`;"]]],
  ["m08-omite-evidencia-no-manifesto", "unit", "lib/visualrun.mjs", "o manifesto de evidências sai vazio", [["const manifest = files.sort().map(", "const manifest = files.slice(0, 0).map("]]],
  ["m09-ignora-falha-de-carregamento", "unit", "lib/loadhealth.mjs", "classifyLoad sempre diz MEASURABLE (ignora falha de carregamento)", [["export function classifyLoad(ev) {", 'export function classifyLoad(ev) {\n  return { verdict: LOAD.MEASURABLE, cause: "mounted", mounted: true, redirected: false, detail: "" };']]],
  ["m10-regressao-de-produto-vira-unmeasurable", "unit", "lib/loadhealth.mjs", "recurso crítico com HTTP 4xx/5xx do produto vira UNMEASURABLE", [["if (productHttp.length) return { verdict: LOAD.FAIL,", "if (productHttp.length) return { verdict: LOAD.UNMEASURABLE,"]]],
  ["m11-redirecionamento-vira-unmeasurable", "unit", "lib/loadhealth.mjs", "redirecionamento indevido vira UNMEASURABLE", [['if (redirected) return { verdict: LOAD.FAIL, cause: "unexpected-redirect", mounted, redirected, detail: `a rota ${want} terminou em ${here} (redirecionamento indevido)` };', 'if (redirected) return { verdict: LOAD.UNMEASURABLE, cause: "unexpected-redirect", mounted, redirected, detail: `a rota ${want} terminou em ${here} (redirecionamento indevido)` };']]],
  ["m12-ambiente-vira-fail", "unit", "lib/loadhealth.mjs", "falha de rede/cache do navegador vira FAIL de produto", [['if (envNet.length) return { verdict: LOAD.UNMEASURABLE,', 'if (envNet.length) return { verdict: LOAD.FAIL,']]],
  ["m13-sem-evidencia-vira-missing", "unit", "lib/loadhealth.mjs", "app que não montou sem evidência volta a ser MEASURABLE (→ MISSING)", [['return { verdict: LOAD.UNMEASURABLE, cause: "not-mounted-no-evidence"', 'return { verdict: LOAD.MEASURABLE, cause: "not-mounted-no-evidence"']]],
  ["m14-aprova-sem-revisor", "unit", "lib/baseline.mjs", "aprovação sem revisor", [['if (!reviewer || String(reviewer).trim().length < 2) throw new BaselineError("NO_REVIEWER", "a aprovação exige o nome do revisor (--reviewer)");', ""]]],
  ["m15-substitui-aprovada-sem-replace", "unit", "lib/baseline.mjs", "substitui a baseline aprovada sem --replace", [['if (prev && !replace) throw new BaselineError("WOULD_REPLACE",', 'if (false) throw new BaselineError("WOULD_REPLACE",']]],
  ["m16-ignora-stale-de-config", "unit", "lib/baseline.mjs", "ignora configuração de captura diferente", [["if (approved.captureConfigVersion !== captureConfigVersion) return", "if (false) return"]]],
  ["m17-ignora-stale-de-navegador", "unit", "lib/baseline.mjs", "ignora versão principal do navegador diferente", [["if (approved.browserMajor !== null && cur !== null && approved.browserMajor !== cur) return", "if (false) return"]]],
  ["m18-nao-confere-hash-da-baseline", "unit", "lib/baseline.mjs", "usa a baseline sem conferir o SHA-256", [["if (sha256(buf) !== approved.imageSha256) return { status: RESOLUTION.CORRUPT", "if (false) return { status: RESOLUTION.CORRUPT"]]],
  ["m19-tolerancia-alta-generica", "unit", "lib/imagediff.mjs", "tolerância padrão alta (5000 pixels)", [["maxDiffPixels: 0, maxClusterPixels: 0 });", "maxDiffPixels: 5000, maxClusterPixels: 5000 });"]]],
  ["m20-antialiasing-amplo-demais", "unit", "lib/imagediff.mjs", "a tolerância de anti-aliasing aceita deslocamentos de até 5px", [["for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 ||", "for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 ||"]]],
  ["m21-vazamento-de-segredo", "unit", "lib/baseline.mjs", "desliga a recusa de segredos nos metadados", [["export function assertNoSecrets(value, extraSecrets = []) {", "export function assertNoSecrets(value, extraSecrets = []) {\n  return;"]]],
  ["m22-exit-0-sem-baseline", "unit", "lib/visualrun.mjs", "célula sem baseline aprovada não impede o exit 0", [["if (c[VS.MISSING] || c[VS.CANDIDATE_ONLY] || c[VS.STALE] || c[VS.CANDIDATE_CREATED]) return VISUAL_EXIT.NOT_HOMOLOGATED;", ""]]],
  ["m23-exit-ignora-falha-funcional", "unit", "lib/visualrun.mjs", "regressão/falha funcional não dá exit 1", [["if (c[VS.REGRESSION] || c[VS.FUNCTIONAL_FAIL]) return VISUAL_EXIT.FAIL;", ""]]],
  ["m24-mascara-sem-justificativa", "unit", "lib/imagediff.mjs", "aceita máscara sem justificativa", [['if (!m || typeof m.reason !== "string" || m.reason.trim().length < 8) throw new MaskError(', "if (false) throw new MaskError("]]],
  ["m25-png-sem-crc", "unit", "lib/png.mjs", "o decodificador PNG ignora o CRC dos blocos", [['if (crc32(buf, pos + 4, pos + 8 + len) !== buf.readUInt32BE(pos + 8 + len)) throw new PngError("BAD_CRC"', 'if (false) throw new PngError("BAD_CRC"']]],
  ["m26-dimensoes-ignoradas", "unit", "lib/imagediff.mjs", "a comparação ignora dimensões diferentes", [["if (base.width !== cur.width || base.height !== cur.height) {", "if (false) {"]]],
  ["m27-elemento-removido-nao-reportado", "unit", "lib/fingerprint.mjs", "a impressão de layout não reporta elemento removido", [['if (!c) { add("removed", k,', 'if (!c) { continue; add("removed", k,']]],
  ["m28-versao-de-config-fixa", "unit", "lib/capture.mjs", "a versão da configuração de captura nunca muda", [["export const captureConfigVersion = (cfg = CAPTURE_CONFIG) => `cc-${createHash(\"sha256\").update(JSON.stringify(cfg)).digest(\"hex\").slice(0, 10)}`;", 'export const captureConfigVersion = (cfg = CAPTURE_CONFIG) => "cc-0000000000";']]],
  ["m29-revisao-ignora-overflow-horizontal", "unit", "lib/review.mjs", "a análise de candidata não aponta rolagem horizontal", [['if (fingerprint.doc.w > w + 1) add("horizontal-overflow"', 'if (false) add("horizontal-overflow"']]],
  ["m30-revisao-ignora-tema-errado", "unit", "lib/review.mjs", "a análise não aponta tema escuro com imagem clara", [['if (meta.theme === "dark" && lum > 140)', "if (false)"]]],
  ["m31-determinismo-diferente-vira-identico", "unit", "lib/review.mjs", "duas capturas diferentes contam como idênticas", [['if (a.captured.sha256 === b.captured.sha256) { cells.push({ id, status: "IDENTICAL"', 'if (true) { cells.push({ id, status: "IDENTICAL"']]],
  ["m32-determinismo-nao-confere-hash", "unit", "lib/review.mjs", "o determinismo compara PNG sem conferir o SHA-256 do relatório", [["if (sha(pa) !== a.captured.sha256 || sha(pb) !== b.captured.sha256) {", "if (false) {"]]],
  ["m33-galeria-sem-escape-de-html", "unit", "lib/gallery.mjs", "a galeria não escapa HTML", [['export const esc = (s) => String(s ?? "").replace(/[&<>"\']/g,', 'export const esc = (s) => String(s ?? "").replace(/[§]/g,']]],
  ["m34-galeria-sem-aviso-de-aprovacao", "unit", "lib/gallery.mjs", "a galeria não avisa que está aguardando aprovação", [["const wait = m.summary.approved === 0;", "const wait = false;"]]],
  ["m35-galeria-mostra-candidata-no-lugar-da-aprovada", "unit", "lib/gallery.mjs", "a candidata mais nova substitui a aprovada na galeria", [["if (!cur || (e.state === BASELINE_STATE.APPROVED && cur.state !== BASELINE_STATE.APPROVED) || (e.state === cur.state && String(e.capturedAt) > String(cur.capturedAt))) by.set(e.id, e);", "by.set(e.id, e);"]]],
  ["m36-galeria-nao-confere-hash-do-png", "unit", "lib/gallery.mjs", "a galeria exibe PNG sem conferir o SHA-256", [['if (sha256(buf) !== e.imageSha256) throw new Error("SHA-256 do PNG não confere com o manifesto");', ""]]],
  ["m37-galeria-sem-origem-obrigatoria", "unit", "lib/gallery.mjs", "a galeria aceita origem indefinida (produto × fixture)", [['if (!["produto", "fixture"].includes(sourceKind)) throw new Error(', "if (false) throw new Error("]]],
  ["m38-estabilidade-aceita-qualquer-diferenca", "unit", "lib/capture.mjs", "a estabilidade de pixels aceita diferença perceptível entre capturas", [['return r.verdict === "IDENTICAL" || r.verdict === "WITHIN_TOLERANCE" ?', "return true ?"]]],
  ["m39-estabilidade-exige-bytes-identicos", "unit", "lib/capture.mjs", "a estabilidade volta a exigir bytes idênticos (o defeito real encontrado no produto)", [['  let ia, ib; try { ia = decodePng(a); ib = decodePng(b); } catch { return { stable: false, mode: "unreadable" }; }', '  return { stable: false, mode: "different" };\n  let ia, ib; try { ia = decodePng(a); ib = decodePng(b); } catch { return { stable: false, mode: "unreadable" }; }']]],
  ["m40-normalizacao-ignora-hora", "unit", "lib/capture.mjs", "o critério de texto dinâmico deixa de normalizar horas isoladas", [["|\\b\\d{2}:\\d{2}(?::\\d{2})?\\b`,", "`,"]]],
  ["m41-normalizacao-nao-troca-digitos", "unit", "lib/capture.mjs", "o normalizador (Node) deixa os dígitos como estão", [['return m.replace(/\\d/g, "0"); });\n  return { text: out, matches };', 'return m; });\n  return { text: out, matches };']]],
  ["s08-captura-sem-normalizar-texto-dinamico", "selftest", "lib/capture.mjs", "a captura não normaliza data/hora (duas capturas do mesmo conjunto passam a diferir)", [["const dyn = JSON.parse(await cdp.eval(NORMALIZE_SOURCE));", 'const dyn = { version: "x", count: 0, nodeCount: 0, nodes: [] };']], "dynamic"],
  ["s09-captura-ignora-modo-da-pagina", "selftest", "lib/capture.mjs", "a captura ignora o modo declarado pela página (diálogo deixa de ser só viewport)", [["const cfg = { ...baseCfg, ...(page.capture ?? {}) };", "const cfg = { ...baseCfg };"]], "dynamic"],
  // ---- M04: relógio de teste congelado e captura segmentada ----
  ["m42-banco-pg_catalog-antes-do-qa_clock", "unit", "lib/clock.mjs", "o search_path do banco põe pg_catalog antes de qa_clock (o now() real voltaria a valer)", [["SET search_path = qa_clock, pg_catalog, public;", "SET search_path = pg_catalog, qa_clock, public;"]]],
  ["m43-relogio-do-navegador-anda", "unit", "lib/clock.mjs", "o script injetado no navegador devolve o relógio real em Date.now()", [["static now() { return T0; } }\n    Object.defineProperty", "static now() { return R.now(); } }\n    Object.defineProperty"]]],
  ["m44-relogio-do-servidor-anda", "unit", "lib/clock-preload.mjs", "o pré-carregamento do servidor não congela Date.now()", [["static now() { return read(); }", "static now() { return RealDate.now(); }"]]],
  ["m45-config-com-relogio-mantem-normalizacao", "unit", "lib/capture.mjs", "com relógio congelado a normalização de texto continua ligada na configuração", [["dynamicText: null, clock:", "dynamicText: CAPTURE_CONFIG.dynamicText, clock:"]]],
  ["m46-segmentos-sem-verificar-continuidade", "unit", "lib/capture.mjs", "a costura não verifica a continuidade entre segmentos", [["if (Buffer.compare(Buffer.from(a1), Buffer.from(b1)) !== 0) throw", "if (false) throw"]]],
  ["m47-segmentos-duplicam-sobreposicao", "unit", "lib/capture.mjs", "a costura repete as linhas de sobreposição", [["const skip = i === 0 ? 0 : ov;", "const skip = 0;"]]],
  ["m48-segmento-curto-nao-detectado", "unit", "lib/capture.mjs", "um segmento mais curto que o pedido (região não capturada) passa despercebido", [["if (img.height !== hh) throw", "if (false) throw"]]],
  ["m49-pagina-longa-truncada-declarada-completa", "unit", "lib/capture.mjs", "documento maior que o limite duro deixa de ser marcado como truncado", [["truncated: fullH > cfg.maxHeight, segments: { count", "truncated: false, segments: { count"]]],
  ["s10-captura-com-relogio-ainda-normaliza-texto", "selftest", "lib/capture.mjs", "com o relógio congelado a captura ainda troca dígitos de data/hora por zero", [["if (cfg.clock) { meta.dynamicText", "if (false) { meta.dynamicText"]], "clock"],
  ["s11-pagina-longa-nao-segmenta", "selftest", "lib/capture.mjs", "páginas longas voltam a ser capturadas numa só chamada (sem manifesto de segmentos)", [["if (h <= cfg.segmentHeight) return", "if (true) return"]], "long"],
  // ---- M05: relógio com instantes distintos na semente; abas rolaveis nao sao 'fora da tela' ----
  ["m50-aba-rolavel-conta-como-fora-da-tela", "unit", "lib/review.mjs", "a revisão volta a acusar 'controle fora da tela' para abas dentro de contêiner com rolagem horizontal", [["const off = els.filter((e) => !e.hscroll && ", "const off = els.filter((e) => "]]],
  ["m51-semente-avanca-por-leitura-de-relogio", "unit", "lib/clock-preload.mjs", "a semente volta a avançar o relógio a cada leitura (não reproduzível) em vez de só quando pedido", [["() => T0 - window * 1000 + offset :", "() => T0 - window * 1000 + (offset += 7) :"]]],
  ["m52-relogio-da-semente-nao-congela-depois", "unit", "lib/clock.mjs", "o now() do banco continua avançando depois da semente (a fase de execução também usa a sequência)", [["const seeded = seedTicks > 0;", "const seeded = true;"]]],
  // ---- M06: segurança de processos (camada "proc": test/qaProcessSafety.test.ts, processos sintéticos; nenhum navegador real é tocado) ----
  ["p00-controle-inocuo", "proc", "lib/procowner.mjs", "CONTROLE: só um comentário; a suíte de segurança de processos TEM de passar", [["export const OWNER_MARKER = ", "// controle (sem efeito)\nexport const OWNER_MARKER = "]]],
  ["p01-pid-reutilizado-aceito", "proc", "lib/procowner.mjs", "a identidade ignora o instante de criação (um PID reaproveitado por outro programa passaria como nosso)", [["if (row.start !== rec.start) return { owned: false,", "if (false) return { owned: false,"]]],
  ["p02-encerra-sem-verificar-identidade", "proc", "lib/procowner.mjs", "killOwned encerra o PID registrado sem conferir a identidade", [["if (!v.owned) { out.preserved.push(", "if (false) { out.preserved.push("]]],
  ["p03-descendente-sem-ordem-de-criacao", "proc", "lib/procowner.mjs", "um PPID reciclado (filho mais velho que o pai) passa a ser tratado como descendente", [["if (a === null || b === null || b < a) continue;", "if (a === null || b === null) continue;"]]],
  ["p04-sucesso-falso-sem-confirmar", "proc", "lib/procowner.mjs", "killOwned declara o processo encerrado sem conferir que ele sumiu", [["if (still === false) out.killed.push(t.pid);", "if (true) out.killed.push(t.pid);"]]],
  ["p05-killtree-aceita-pid-solto", "proc", "lib/procowner.mjs", "killTree volta a aceitar um número de PID (sem handle) como prova de propriedade", [['if (!child || typeof child !== "object" || !Number.isInteger(child.pid) || typeof child.kill !== "function") {', "if (!child) {"]]],
  ["p06-diretorio-de-outra-execucao-apagado", "proc", "lib/orphans.mjs", "a recuperação apaga diretório cujo marcador pertence a OUTRA execução", [["if (m.trim() !== runId) return", "if (false) return"]]],
  ["p07-diretorio-sem-marcador-apagado", "proc", "lib/orphans.mjs", "a recuperação apaga diretório sem marcador de propriedade", [["if (m === null) return", "if (false) return"]]],
  ["p08-diretorio-em-uso-apagado", "proc", "lib/orphans.mjs", "a recuperação apaga diretório que um processo ainda usa", [["if (table && table.some((p) => (p.cmd || \"\").includes(dir))) return", "if (false) return"]]],
  ["p09-execucao-viva-nao-bloqueia", "proc", "lib/orphans.mjs", "uma execução viva (identidade confere) deixa de bloquear a recuperação", [["if (verifyOwnership(o, table).owned) return { ...empty, busy: true, pid: o.pid };", "if (false) return { ...empty, busy: true, pid: o.pid };"]]],
  ["p10-sinal-nao-executa-limpeza", "proc", "lib/orphans.mjs", "SIGINT/SIGTERM deixam de executar a limpeza da execução", [["try { await cleanups.runAll(); }", "try { await 0; }"]]],
  ["p11-falha-no-inicio-do-navegador-deixa-perfil", "proc", "lib/browser.mjs", "se o navegador falha ao iniciar, o perfil temporário exclusivo não é removido", [["    await cleanup();\n    throw e;", "    throw e;"]]],
  ["p12-reintroduz-taskkill-por-nome", "proc", "lib/browser.mjs", "(INERTE: só texto) reintroduz um encerramento global por nome de imagem no código do QA", [["export { killTree };", 'export { killTree };\nconst _global = "taskkill /IM chrome.exe /F";']]],
  ["p13-reintroduz-wmic-por-linha-de-comando", "proc", "lib/stack.mjs", "(INERTE: só texto) reintroduz encerramento por linha de comando via wmic", [["import { killTree } from \"./browser.mjs\";", 'import { killTree } from "./browser.mjs";\nconst _g = "wmic process call terminate";']]],
  ["p14-process-kill-fora-do-modulo-de-propriedade", "proc", "lib/browser.mjs", "(INERTE: só texto) process.kill(SIGKILL) por PID solto fora de lib/procowner.mjs", [["export { killTree };", 'export { killTree };\nconst _k = (pid) => process.kill(pid, "SIGKILL");']]],
  ["s00-controle-inocuo", "selftest", "lib/png.mjs", "CONTROLE: só um comentário; o autoteste real TEM de passar", [["export class PngError extends Error {", "// controle (sem efeito)\nexport class PngError extends Error {"]], "core,d6"],
  ["s01-executor-funcional-ignora-d6", "selftest", "lib/runner.mjs", "o executor funcional volta a registrar MISSING para app que não montou", [["if (load.verdict === LOAD.FAIL) ctx.report.add(", "if (false) ctx.report.add("], ["else if (load.verdict === LOAD.UNMEASURABLE) addUnmeasurable(", "else if (false) addUnmeasurable("]], "d6"],
  ["s02-captura-ignora-ancora", "selftest", "lib/capture.mjs", "captura mesmo sem o elemento-âncora (página quebrada vira imagem)", [["if (!anchored) {", "if (false) {"]], "d6"],
  ["s03-captura-ignora-contrato-de-carga", "selftest", "lib/capture.mjs", "captura mesmo com redirecionamento indevido/página de erro", [["if (loadOk.verdict !== LOAD.MEASURABLE) return stop(", "if (false) return stop("]], "d6"],
  ["s04-comparar-grava-candidata", "selftest", "lib/visualrun.mjs", "o modo compare passa a gravar candidatas", [['if (mode === "capture") { // gera CANDIDATAS', 'if (true) { // gera CANDIDATAS']], "core"],
  ["s05-omite-imagem-de-diferenca", "selftest", "lib/visualrun.mjs", "a regressão é detectada, mas a imagem de diferença não é gravada", [['if (c.cmp.verdict !== "IDENTICAL") {', "if (false) {"]], "core,variants"],
  ["s06-ignora-tema-na-captura", "selftest", "lib/capture.mjs", "a captura nunca aplica o tema", [["    await setTheme(cdp, theme);\n", "", { all: true }]], "core"],
  ["s07-ignora-estabilidade-de-fontes", "selftest", "lib/capture.mjs", "captura sem esperar o carregamento das fontes e sem a espera de rede ociosa", [[`pre.fonts = await cdp.eval("Promise.race([document.fonts.ready.then(() => document.fonts.status), new Promise((r) => setTimeout(() => r(document.fonts.status), 4000))])"); // limite: fonte pendente não pendura a captura`, 'pre.fonts = "loaded";'], ["if (!settled) return stop(", "if (false) return stop("]], "d6"],
];

const sel = o.only ? new Set(o.only.split(",")) : null;
const list = M.filter(([id, layer]) => (!sel || sel.has(id)) && !(o["skip-selftest"] && layer === "selftest"));
const lines = []; const log = (l) => { lines.push(l); console.log(l); };
const root = mkdtempSync(path.join(tmpdir(), "levora-visual-mutants-"));

function mutate(id, file, edits) {
  const dst = path.join(root, id); cpSync(SRC, path.join(dst, "qa-visual"), { recursive: true, filter: (p) => !/visual-baselines/.test(p) });
  const f = path.join(dst, "qa-visual", file); let s = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  for (const [a, b, opt] of edits) { const n = s.split(a).length - 1; if (n < 1 || (!opt?.all && n !== 1)) throw new Error(`ÂNCORA ${n === 0 ? "ausente" : "ambígua"} em ${id} (${file}): ${a.slice(0, 70)}`); s = s.split(a).join(b); }
  writeFileSync(f, s); return path.join(dst, "qa-visual");
}
const run = (cmd, args, env, timeout) => new Promise((res) => { const p = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); const t = setTimeout(() => p.kill("SIGKILL"), timeout); p.on("close", (code) => { clearTimeout(t); res({ code, out }); }); });
const vitest = path.join(REPO, "node_modules", "vitest", "vitest.mjs");

async function evaluate([id, layer, file, desc, edits, sections]) {
  let dir; try { dir = mutate(id, file, edits); } catch (e) { return { id, desc, verdict: "ABORT", why: e.message }; }
  if (layer === "unit" || layer === "proc") {
    const cfg = layer === "proc" ? ["vitest.qaprocess.config.ts", "test/qaProcessSafety.test.ts"] : ["vitest.qavisual.config.ts"];
    const r = await run(process.execPath, [vitest, "run", "-c", ...cfg], { QA_VISUAL_ROOT: dir }, 300000);
    const ran = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(r.out) || /Tests\s+(\d+) failed/.exec(r.out); const failed = /Tests\s+(\d+) failed/.exec(r.out);
    if (!ran) return { id, desc, verdict: "INVALID", why: `os testes não rodaram (erro de inicialização): ${r.out.split("\n").filter((l) => /Error|error/.test(l)).slice(0, 2).join(" | ").slice(0, 200)}` };
    const first = (r.out.match(/FAIL\s+test\/qa(?:Visual(?:Regression|Review)|ProcessSafety)\.test\.ts > ([^\n]+)/) ?? [])[1];
    return { id, desc, verdict: failed ? "DETECTED" : "SURVIVED", why: failed ? `${failed[1]} teste(s) reprovaram; ex.: ${String(first).slice(0, 150)}` : "todos os testes passaram com o código sabotado" };
  }
  const outDir = path.join(root, id, "out");
  const r = await run(process.execPath, [path.join(dir, "visual-selftest.mjs"), "--browser", "chrome", "--sections", sections ?? "all", "--out", outDir], {}, 900000);
  const rep = path.join(outDir, "selftest-report.json");
  if (!existsSync(rep)) return { id, desc, verdict: "INVALID", why: `o autoteste não gerou relatório (erro de inicialização): ${r.out.split("\n").slice(-3).join(" | ").slice(0, 200)}` };
  const j = JSON.parse(readFileSync(rep, "utf8")); const bad = j.resultados.filter((x) => !x.ok);
  return { id, desc, verdict: bad.length ? "DETECTED" : "SURVIVED", why: bad.length ? `${bad.length} verificação(ões) reprovaram; ex.: ${bad[0].name.slice(0, 150)}` : `autoteste real passou (${j.total} verificações) com o código sabotado` };
}

// 1) o código ORIGINAL tem de passar (unit + autoteste nas seções usadas)
const base = await run(process.execPath, [vitest, "run", "-c", "vitest.qavisual.config.ts"], {}, 180000);
const bm = /Tests\s+(\d+) passed \((\d+)\)/.exec(base.out) ?? /Tests\s+(\d+) passed/.exec(base.out);
log(`BASE (unit)     código original: ${/Tests\s+\d+ failed/.test(base.out) || !bm ? "FALHA — mutantes inválidos" : `passa ${bm[1]} testes`}`);
if (/Tests\s+\d+ failed/.test(base.out) || !bm) { writeFileSync(OUT, lines.join("\n") + "\n"); process.exit(2); }

const baseP = list.some((m) => m[1] === "proc") ? await run(process.execPath, [vitest, "run", "-c", "vitest.qaprocess.config.ts", "test/qaProcessSafety.test.ts"], {}, 300000) : null;
if (baseP) { const okP = /Tests\s+\d+ passed/.test(baseP.out) && !/Tests\s+\d+ failed/.test(baseP.out); log(`BASE (proc)     código original: ${okP ? "passa a suíte de segurança de processos" : "FALHA — mutantes de processos inválidos"}`); if (!okP) { writeFileSync(OUT, lines.join("\n") + "\n"); process.exit(2); } }

const results = []; const unit = list.filter((m) => m[1] === "unit" || m[1] === "proc"); const st = list.filter((m) => m[1] === "selftest");
for (const m of unit) { const r = await evaluate(m); results.push(r); log(`${r.verdict.padEnd(9)} ${r.id} — ${r.desc}  ⇒ ${r.why}`); }
let next = 0; await Promise.all([0, 1].map(async () => { while (next < st.length) { const m = st[next++]; const r = await evaluate(m); results.push(r); log(`${r.verdict.padEnd(9)} ${r.id} — ${r.desc}  ⇒ ${r.why}`); } }));
const control = results.filter((r) => r.id.includes("-controle-") || r.id.startsWith("s00") || r.id.startsWith("m00") || r.id.startsWith("p00")); const real = results.filter((r) => !control.includes(r));
const ctlOk = control.every((r) => r.verdict === "SURVIVED"); const det = real.filter((r) => r.verdict === "DETECTED").length; const badOnes = real.filter((r) => r.verdict !== "DETECTED");
log(`CONTROLES: ${control.map((r) => `${r.id}=${r.verdict}`).join(", ")} → ${ctlOk ? "OK (inócuos passam: a mecânica funciona)" : "FALHARAM: nenhum resultado vale"}`);
log(`RESUMO mutantes: ${det}/${real.length} detectados; não detectados/inválidos: ${badOnes.length ? badOnes.map((r) => `${r.id}(${r.verdict})`).join(", ") : "nenhum"}`);
writeFileSync(OUT, lines.join("\n") + "\n"); rmSync(root, { recursive: true, force: true });
process.exit(ctlOk && !badOnes.length ? 0 : 1);
