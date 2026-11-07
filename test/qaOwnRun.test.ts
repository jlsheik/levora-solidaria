// M13 — registro de propriedade dos verificadores de desenvolvimento (dev/own-run.mjs): o navegador e o servidor de um verificador passam a ser registrados com IDENTIDADE (PID + instante de criação),
// para que uma interrupção à força seja recuperada por `qa:visual --cleanup` e nunca por correspondência de linha de comando. Sem navegador, sem banco; só o próprio processo do teste é registrado.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const own = await load("dev/own-run.mjs");

describe("dev/own-run.mjs", () => {
  it("instala SIGINT/SIGTERM, registra o filho próprio com instante de criação e apaga o registro no fim", async () => {
    const handlers: Record<string, () => Promise<void>> = {}; const proc = { on: (s: string, f: () => Promise<void>) => { handlers[s] = f; }, exit: vi.fn() };
    const r = own.ownRun({ proc }); expect(Object.keys(handlers).sort()).toEqual(["SIGINT", "SIGTERM"]);
    r.onSpawn(process.pid, "teste-proprio", { profile: "levora-qa-profile-sintetico" }); await Promise.all(r.state.pending);
    const rec = r.state.s.children.find((c: { pid: number }) => c.pid === process.pid); expect(rec).toBeTruthy(); expect(String(rec.start ?? "")).not.toBe(""); // identidade comprovada, não só PID
    expect(existsSync(r.state.file)).toBe(true); await r.end(); expect(existsSync(r.state.file)).toBe(false);
  });
  it("SIGTERM executa a limpeza registrada, apaga o registro e sai com o código pedido (sem encerrar nada por nome)", async () => {
    const handlers: Record<string, () => Promise<void>> = {}; const proc = { on: (s: string, f: () => Promise<void>) => { handlers[s] = f; }, exit: vi.fn() };
    const r = own.ownRun({ proc, exitCode: 3 }); const spy = vi.fn(); r.cleanups.add("limpeza sintética", spy);
    await handlers.SIGTERM(); expect(spy).toHaveBeenCalledTimes(1); expect(proc.exit).toHaveBeenCalledWith(3); expect(existsSync(r.state.file)).toBe(false);
  });
  it("o verificador de avisos (que abre navegador e servidor) usa o registro de propriedade — o arquivo pertence ao PR B; sem ele (árvore do PR A isolado) a verificação é dispensada", () => {
    const file = path.join(ROOT, "dev/toast-real-check.mjs"); if (!existsSync(file)) return; const src = readFileSync(file, "utf8");
    expect(src).toContain("ownRun()"); expect(src).toContain("onSpawn: own.onSpawn"); expect(src).toContain("onProfile: own.onProfile"); expect(src).toContain("await own.end()");
  });
  it("nenhum verificador de desenvolvimento usa encerramento global ou por linha de comando", () => {
    const dir = path.join(ROOT, "dev"); for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs") && !n.startsWith("visual-mutants"))) expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/taskkill|Stop-Process|pkill|killall|wmic/);
  });
});
