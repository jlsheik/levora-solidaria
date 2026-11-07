// Orquestra a validação visual de UM navegador já aberto: captura real → (modo capture) candidatas | (modo compare) comparação com a baseline APROVADA.
// Resultado por célula com vocabulário PRÓPRIO, separado do QA funcional (PASS/FAIL/MISSING/UNMEASURABLE de `qa:visual`): um PASS funcional nunca vira PASS visual.
//
//   VISUAL_PASS         há baseline APROVADA válida e a comparação pixel a pixel ficou dentro da tolerância (IDENTICAL | WITHIN_TOLERANCE)
//   VISUAL_REGRESSION   há baseline aprovada válida e a imagem difere acima da tolerância (ou as dimensões mudaram)
//   FUNCTIONAL_FAIL     a página não cumpriu o contrato de carregamento (loadhealth: FAIL do produto); não há o que comparar
//   INCONCLUSIVE        não foi possível capturar/comparar em condições válidas (ambiente, render instável, imagem ilegível)
//   BASELINE_CORRUPT    a baseline aprovada não confere com o manifesto (arquivo ausente/alterado): evidência comprometida
//   MISSING_BASELINE    nenhuma baseline para a célula          ┐
//   CANDIDATE_ONLY      só há candidata, não aprovada           ├ NÃO HOMOLOGADO (não é aprovação nem falha)
//   STALE_BASELINE      baseline de outra config/versão do nav. ┘
//   CANDIDATE_CREATED   (modo capture) candidata gravada para revisão humana; nunca aprova
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { VIEWPORTS, viewportKey } from "./viewport.mjs";
import { login } from "./runner.mjs";
import { CAPTURE, CAPTURE_CONFIG, captureCell, captureConfigVersion, configFor } from "./capture.mjs";
import { RESOLUTION, addCandidate, assertNoSecrets, cellId, resolveBaseline } from "./baseline.mjs";
import { PngError, decodePng, encodePng } from "./png.mjs";
import { compareImages, triptych } from "./imagediff.mjs";
import { compareFingerprints } from "./fingerprint.mjs";

export const VS = Object.freeze({ PASS: "VISUAL_PASS", REGRESSION: "VISUAL_REGRESSION", FUNCTIONAL_FAIL: "FUNCTIONAL_FAIL", INCONCLUSIVE: "INCONCLUSIVE", CORRUPT: "BASELINE_CORRUPT",
  MISSING: "MISSING_BASELINE", CANDIDATE_ONLY: "CANDIDATE_ONLY", STALE: "STALE_BASELINE", CANDIDATE_CREATED: "CANDIDATE_CREATED" });
export const VISUAL_EXIT = Object.freeze({ OK: 0, FAIL: 1, INCONCLUSIVE: 2, ENV: 3, NOT_HOMOLOGATED: 6 });

const sha = (b) => createHash("sha256").update(b).digest("hex");
const w = (file, data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); return sha(Buffer.isBuffer(data) ? data : Buffer.from(data)); };

/** Compara uma captura com a baseline resolvida. Pura em relação ao disco de baselines (só lê o que `resolution` já trouxe). */
/** Regiões de ruído tolerado que valem para esta célula: `regions[].cells` (lista de ids de célula) restringe a região; sem `cells`, vale para todas as células da página. */
export function regionsForCell(page, cellId) {
  const rs = page?.tolerance?.regions; if (!rs) return undefined;
  return rs.filter((r) => !Array.isArray(r.cells) || (cellId !== undefined && r.cells.includes(cellId))).map(({ cells, ...r }) => r);
}
export function compareCaptured({ png, fingerprint, resolution, page, cellId }) {
  let base, cur;
  try { cur = decodePng(png); } catch (e) { return { status: VS.INCONCLUSIVE, cause: "capture-unreadable", detail: `a captura atual não pôde ser lida: ${e.message}` }; }
  try { base = decodePng(resolution.png); } catch (e) { return { status: VS.CORRUPT, cause: "baseline-unreadable", detail: `a baseline aprovada não pôde ser lida (${e instanceof PngError ? e.code : "erro"}): ${e.message}` }; }
  const tolerance = page.tolerance ? { ...page.tolerance, regions: regionsForCell(page, cellId) } : page.tolerance;
  const cmp = compareImages(base, cur, { tolerance, masks: page.masks });
  const fp = resolution.fingerprint && fingerprint ? compareFingerprints(resolution.fingerprint, fingerprint) : null;
  const status = cmp.verdict === "IDENTICAL" || cmp.verdict === "WITHIN_TOLERANCE" ? VS.PASS : VS.REGRESSION;
  const m = cmp.metrics;
  const detail = status === VS.PASS ? (cmp.verdict === "IDENTICAL" ? "pixels idênticos à baseline aprovada" : `dentro da tolerância (${m.diffPixels} px diferentes ≤ ${m.tolerance.maxDiffPixels}; ${m.aaTolerated} px de anti-aliasing tolerados)`)
    : cmp.verdict === "DIMENSION_MISMATCH" ? cmp.reasons[0] : `${cmp.reasons[0]}; forma da mudança: ${m.shape}; área ${m.bbox ? `${m.bbox.w}x${m.bbox.h}@${m.bbox.x},${m.bbox.y}` : "-"}${fp?.summary.total ? `; achados de layout: ${Object.entries(fp.summary.byType).map(([k, v]) => `${k}×${v}`).join(", ")}` : ""}`;
  return { status, cause: cmp.verdict, detail, cmp, fp, baseImg: base, curImg: cur };
}

export function summarizeVisual(cells) {
  const counts = Object.fromEntries(Object.values(VS).map((s) => [s, 0])); for (const c of cells) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return counts;
}
/** 1 regressão/falha funcional > 2 inconclusivo/baseline corrompida > 6 não homologado > 0. Nenhum resultado "visual" existe sem comparação com baseline aprovada. */
export function visualExitCode(cells) {
  if (!cells.length) return VISUAL_EXIT.INCONCLUSIVE;
  const c = summarizeVisual(cells);
  if (c[VS.REGRESSION] || c[VS.FUNCTIONAL_FAIL]) return VISUAL_EXIT.FAIL;
  if (c[VS.INCONCLUSIVE] || c[VS.CORRUPT]) return VISUAL_EXIT.INCONCLUSIVE;
  if (c[VS.MISSING] || c[VS.CANDIDATE_ONLY] || c[VS.STALE] || c[VS.CANDIDATE_CREATED]) return VISUAL_EXIT.NOT_HOMOLOGATED;
  return VISUAL_EXIT.OK;
}

/**
 * Executa as células deste navegador. opts: { session:{cdp,version}, browserName, baseUrl, mode: "capture"|"compare", pages, viewports, themes, baselineDir, outDir, sourceSha, filesDir, auth }.
 * Retorna a lista de registros de célula (também gravados em outDir).
 */
export async function runVisualForBrowser(opts) {
  const { session, browserName, baseUrl, mode, pages, themes, baselineDir, outDir, sourceSha, filesDir } = opts; const cdp = session.cdp;
  if (!["capture", "compare"].includes(mode)) throw new Error(`modo visual inválido: ${mode}`);
  const auth = opts.auth ?? { current: null }; const cells = []; const cfgVersion = captureConfigVersion(configFor(opts.clock));
  for (const user of ["guest", "owner", "volunteer"]) {
    const list = pages.filter((p) => p.user === user); if (!list.length) continue;
    let loggedIn = true;
    if (auth.current !== user) { await cdp.send("Network.clearBrowserCookies"); loggedIn = user === "guest" ? true : await login(cdp, baseUrl, user); auth.current = loggedIn ? user : null; }
    for (const page of list) for (const vp of (page.viewports ?? opts.viewports ?? VIEWPORTS)) for (const theme of themes) {
      const key = { pageId: page.id, browser: browserName, viewport: viewportKey(vp), theme }; const id = cellId(key);
      const rec = { id, ...key, route: page.path, browserVersion: session.version, mode, sourceSha };
      if (!loggedIn) { cells.push({ ...rec, status: VS.INCONCLUSIVE, cause: "login-failed", detail: `login como ${user} não concluiu` }); continue; }
      const cap = await captureCell({ cdp, browserName, version: session.version, baseUrl, filesDir, clock: opts.clock }, page, vp, theme);
      rec.preconditions = cap.preconditions; rec.captureMs = cap.ms;
      if (cap.status !== CAPTURE.OK) { cells.push({ ...rec, status: cap.status === CAPTURE.FUNCTIONAL_FAIL ? VS.FUNCTIONAL_FAIL : VS.INCONCLUSIVE, cause: cap.cause, detail: cap.detail }); continue; }
      rec.captured = { file: `screens/${id}.png`, sha256: w(path.join(outDir, `screens/${id}.png`), cap.png), width: cap.meta.width, height: cap.meta.height, docHeight: cap.meta.docHeight, truncatedHeight: cap.meta.truncatedHeight };
      rec.fingerprintFile = `fingerprints/${id}.json`; w(path.join(outDir, rec.fingerprintFile), JSON.stringify(cap.fingerprint));
      rec.dynamicText = cap.meta.dynamicText ?? null; rec.auth = cap.meta.auth; rec.capturedAt = cap.meta.capturedAt; rec.captureConfigVersion = cap.meta.captureConfigVersion;
      const res = resolveBaseline(baselineDir, key, { captureConfigVersion: captureConfigVersion({ ...configFor(opts.clock), ...(page.capture ?? {}) }), version: session.version });
      rec.resolution = { status: res.status, reason: res.reason, baselineState: res.entry?.state ?? null, baselineSha256: res.entry?.imageSha256 ?? null, approvedBy: res.entry?.approvedBy ?? null, baselineSourceSha: res.entry?.sourceSha ?? null };
      if (mode === "capture") { // gera CANDIDATAS; nunca aprova e nunca toca na aprovada. Se há aprovada válida, anexa a comparação só como informação para o revisor.
        let added; try { added = addCandidate(baselineDir, { ...cap.meta, sourceSha }, cap.png, cap.fingerprint); } catch (e) { cells.push({ ...rec, status: VS.INCONCLUSIVE, cause: e.code ?? "candidate-write-refused", detail: `candidata recusada: ${e.message}` }); continue; }
        rec.candidate = { file: added.entry.file, sha256: added.entry.imageSha256, created: added.created, supersedes: added.entry.supersedes ?? null };
        if (res.status === RESOLUTION.APPROVED) { const c = compareCaptured({ png: cap.png, fingerprint: cap.fingerprint, resolution: res, page, cellId: id }); rec.vsApproved = { status: c.status, detail: c.detail, diffPixels: c.cmp?.metrics.diffPixels ?? null }; }
        cells.push({ ...rec, status: VS.CANDIDATE_CREATED, cause: "candidate", detail: "candidata gravada para revisão humana; não é referência oficial até ser aprovada explicitamente" }); continue;
      }
      if (res.status === RESOLUTION.MISSING_BASELINE) { cells.push({ ...rec, status: VS.MISSING, cause: "missing-baseline", detail: res.reason }); continue; }
      if (res.status === RESOLUTION.CANDIDATE_ONLY) { cells.push({ ...rec, status: VS.CANDIDATE_ONLY, cause: "candidate-only", detail: res.reason }); continue; }
      if (res.status === RESOLUTION.STALE) { cells.push({ ...rec, status: VS.STALE, cause: "stale", detail: res.reason }); continue; }
      if (res.status === RESOLUTION.CORRUPT) { cells.push({ ...rec, status: VS.CORRUPT, cause: "baseline-corrupt", detail: res.reason }); continue; }
      const c = compareCaptured({ png: cap.png, fingerprint: cap.fingerprint, resolution: res, page, cellId: id });
      rec.baselineFile = `baselines/${id}.png`; if (res.png) w(path.join(outDir, rec.baselineFile), res.png);
      if (c.cmp) {
        rec.metrics = { ...c.cmp.metrics, tolerance: c.cmp.metrics.tolerance, masks: c.cmp.metrics.masks }; rec.verdict = c.cmp.verdict; rec.clusters = c.cmp.clusters.slice(0, 6);
        rec.layoutFindings = c.fp ? { summary: c.fp.summary, findings: c.fp.findings.slice(0, 30) } : null;
        if (c.cmp.verdict !== "IDENTICAL") {
          const diffPng = encodePng(c.cmp.diffImage); rec.diff = { file: `diffs/${id}.diff.png`, sha256: w(path.join(outDir, `diffs/${id}.diff.png`), diffPng) };
          if (c.baseImg && c.curImg && c.baseImg.width === c.curImg.width && c.baseImg.height === c.curImg.height) rec.triptych = { file: `diffs/${id}.triptych.png`, sha256: w(path.join(outDir, `diffs/${id}.triptych.png`), encodePng(triptych(c.baseImg, c.curImg, c.cmp.diffImage))) };
        }
      }
      cells.push({ ...rec, status: c.status, cause: c.cause, detail: c.detail });
    }
  }
  for (const c of cells) { // nenhum metadado de célula pode carregar segredo; se carregar, a célula deixa de valer (INCONCLUSIVE), nunca é gravada como está
    try { assertNoSecrets({ ...c, preconditions: undefined, layoutFindings: undefined }); } catch (e) { c.status = VS.INCONCLUSIVE; c.cause = "secret-in-metadata"; c.detail = `metadados recusados: ${e.message}`; delete c.preconditions; delete c.resolution; }
  }
  return cells;
}

/** Relatório JSON + Markdown + manifesto de evidências (SHA-256 de cada arquivo gerado). */
export function writeVisualReport(outDir, { meta, cells }) {
  const summary = summarizeVisual(cells); const exit = visualExitCode(cells);
  const report = { schema: 1, ...meta, geradoEm: new Date().toISOString(), captureConfig: { version: captureConfigVersion(), ...CAPTURE_CONFIG }, resumo: summary, codigoDeSaida: exit,
    homologado: exit === VISUAL_EXIT.OK, aviso: exit === VISUAL_EXIT.NOT_HOMOLOGATED ? "NÃO HOMOLOGADO: há células sem baseline aprovada válida (ausente, candidata ou desatualizada); isto não é aprovação visual" : undefined, celulas: cells };
  w(path.join(outDir, "visual-report.json"), JSON.stringify(report, null, 2) + "\n");
  const md = [`# Relatório visual — ${meta.mode}`, "", `SHA testado: \`${meta.sourceSha}\` · navegadores: ${meta.browsers.map((b) => `${b.name} ${b.version}`).join(", ")} · config de captura \`${captureConfigVersion()}\``, "",
    `Resultado: ${Object.entries(summary).filter(([, n]) => n).map(([k, n]) => `**${k}** ${n}`).join(" · ")} · código de saída **${exit}**${report.aviso ? `\n\n> ${report.aviso}` : ""}`, "",
    "| célula | status | detalhe | atual | baseline | diferença |", "|---|---|---|---|---|---|",
    ...cells.map((c) => `| ${c.id} | ${c.status} | ${String(c.detail ?? "").replace(/\|/g, "\\|").slice(0, 160)} | ${c.captured ? `[img](${c.captured.file})` : "-"} | ${c.baselineFile ? `[img](${c.baselineFile})` : "-"} | ${c.triptych ? `[painel](${c.triptych.file})` : c.diff ? `[diff](${c.diff.file})` : "-"} |`), ""].join("\n");
  w(path.join(outDir, "visual-report.md"), md);
  const files = []; const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); statSync(p).isDirectory() ? walk(p) : n !== "evidence-manifest.json" && files.push(p); } }; walk(outDir);
  const manifest = files.sort().map((p) => ({ file: path.relative(outDir, p).split(path.sep).join("/"), sha256: sha(readFileSync(p)), bytes: statSync(p).size }));
  w(path.join(outDir, "evidence-manifest.json"), JSON.stringify({ schema: 1, files: manifest }, null, 2) + "\n");
  return { report, exit };
}

/** Verifica o manifesto de evidências de uma pasta de saída: arquivo ausente ou alterado é divergência (evidência corrompida nunca é aceita em silêncio). */
export function verifyEvidence(outDir) {
  const m = JSON.parse(readFileSync(path.join(outDir, "evidence-manifest.json"), "utf8")); const bad = [];
  for (const f of m.files) { try { if (sha(readFileSync(path.join(outDir, f.file))) !== f.sha256) bad.push(`${f.file}: SHA-256 diverge`); } catch { bad.push(`${f.file}: ausente`); } }
  return { files: m.files.length, bad };
}
