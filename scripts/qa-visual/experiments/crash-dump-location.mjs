// G5 — experimento local isolado (NÃO faz parte do qa:visual nem do CI): qual mecanismo realmente leva o despejo de falha do Chrome para um diretório nosso?
// Derruba o renderizador pelo comando do próprio CDP (Page.crash) e compara: (A) BREAKPAD_DUMP_LOCATION (usado pela harness) e (B) --crash-dumps-dir (usado, sem efeito comprovado, na G4b).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findBrowser, launchBrowser } from "../lib/browser.mjs";
import { listCrashDumps } from "../lib/chromeprobe.mjs";

const exe = findBrowser("chrome"); if (!exe) { console.error("Chrome não encontrado"); process.exit(3); }
const dirB = mkdtempSync(path.join(tmpdir(), "levora-g5-flagdir-"));
const s = await launchBrowser(exe, { extraArgs: [`--crash-dumps-dir=${dirB}`] });
const out = { versao: s.version };
try {
  await s.cdp.send("Page.navigate", { url: "data:text/html,<title>x</title><p>ola</p>" });
  await new Promise((r) => setTimeout(r, 500));
  await s.cdp.send("Page.crash", {}, 5000, { probe: false }).catch(() => {});
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 500)); // o crashpad grava de forma assíncrona
  out.A_BREAKPAD_DUMP_LOCATION = listCrashDumps(s.crashDir);
  out.B_flag_crash_dumps_dir = listCrashDumps(dirB);
  out.crashDir = s.crashDir ? path.basename(s.crashDir) : null;
} finally { await s.close(); rmSync(dirB, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 1));
