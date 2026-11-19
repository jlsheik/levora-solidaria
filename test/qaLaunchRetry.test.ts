/**
 * G7 — arranque do Chrome (run 44181731270: "não abriu a porta de depuração a tempo", sem pista). Cobre: diagnóstico da falha de arranque (tempo, estado, perfil, carga,
 * memória, stderr higienizado e LIMITADO) e a regra de recuperação: UMA nova tentativa, só para falha de ARRANQUE; nunca para erro depois da sessão; duas falhas = falha.
 * Nada aqui abre o Chrome: o executável é o próprio Node (recusa as opções e sai) e o lançador é injetado.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @ts-expect-error módulo .mjs sem tipos
import { launchBrowser } from "../scripts/qa-visual/lib/browser.mjs";

const startupErr = (m: string) => Object.assign(new Error(m), { startup: true });
const perfis = () => readdirSync(tmpdir()).filter((n) => n.startsWith("levora-qa-profile-"));

describe("G7 — falha de arranque do navegador: diagnóstico e uma única nova tentativa", () => {
  it("1ª falha de arranque + 2ª ok → devolve a sessão da 2ª, marca a recuperação e registra a 1ª falha (não some em silêncio)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {}); const sessao: any = { cdp: {} };
    const launch = vi.fn().mockRejectedValueOnce(startupErr("sem porta [pid 1]")).mockResolvedValueOnce(sessao);
    const b = await launchBrowser("x", { a: 1 }, launch);
    expect(launch).toHaveBeenCalledTimes(2); expect(launch).toHaveBeenNthCalledWith(2, "x", { a: 1 });
    expect(b).toBe(sessao); expect(b.arranque).toEqual({ tentativas: 2, primeiraFalha: "sem porta [pid 1]" });
    expect(log.mock.calls.join("\n")).toContain("tentativa 1 de 2"); log.mockRestore();
  });

  it("2 falhas de arranque → FALHA (nunca aprova), com as duas mensagens e a lista de tentativas; exatamente 2 chamadas", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const launch = vi.fn().mockRejectedValueOnce(startupErr("A: porta")).mockRejectedValueOnce(startupErr("B: porta"));
    const e: any = await launchBrowser("x", {}, launch).then(() => null, (x: any) => x);
    expect(launch).toHaveBeenCalledTimes(2); expect(e).toBeInstanceOf(Error); expect(e.message).toContain("B: porta"); expect(e.message).toContain("AMBAS as tentativas falharam"); expect(e.message).toContain("A: porta");
    expect(e.tentativas).toEqual(["A: porta", "B: porta"]); log.mockRestore();
  });

  it("erro que NÃO é de arranque (sessão já existente, CDP, qualquer outro) não é repetido", async () => {
    const launch = vi.fn().mockRejectedValue(new Error("falha ao conectar no CDP"));
    await expect(launchBrowser("x", {}, launch)).rejects.toThrow("falha ao conectar no CDP"); expect(launch).toHaveBeenCalledTimes(1);
  });

  it("sucesso na 1ª tentativa: uma chamada só, sem marca de recuperação", async () => {
    const s: any = { cdp: {} }; const launch = vi.fn().mockResolvedValue(s); const b = await launchBrowser("x", {}, launch);
    expect(b).toBe(s); expect(launch).toHaveBeenCalledTimes(1); expect(b.arranque).toBeUndefined();
  });

  it("a 2ª tentativa só começa DEPOIS da 1ª terminar (sequencial, sem processos simultâneos)", async () => {
    const ordem: string[] = []; let n = 0;
    const launch = vi.fn(async () => { const i = ++n; ordem.push(`ini${i}`); await new Promise((r) => setTimeout(r, 20)); ordem.push(`fim${i}`); if (i === 1) throw startupErr("falhou"); return { cdp: {} }; });
    const log = vi.spyOn(console, "log").mockImplementation(() => {}); await launchBrowser("x", {}, launch as any); log.mockRestore();
    expect(ordem).toEqual(["ini1", "fim1", "ini2", "fim2"]);
  });

  it("executável que sai ao iniciar (real, sem Chrome): 2 tentativas, perfis NOVOS e distintos, perfis apagados, diagnóstico completo e stderr LIMITADO e higienizado", async () => {
    const antes = new Set(perfis()); const log = vi.spyOn(console, "log").mockImplementation(() => {}); const pids: number[] = [];
    const e: any = await launchBrowser(process.execPath, { onSpawn: (pid: number) => pids.push(pid), startupMs: 3000 }).then(() => null, (x: any) => x); const linhas = log.mock.calls.map((c) => String(c[0])); log.mockRestore();
    expect(e?.startup).toBe(true); expect(pids).toHaveLength(2); expect(pids[0]).not.toBe(pids[1]);
    expect(linhas).toHaveLength(2); expect(linhas[0]).toContain("tentativa 1 de 2"); expect(linhas[1]).toContain("tentativa 2 de 2");
    const perfilDe = (l: string) => /levora-qa-profile-(\w+)/.exec(l)?.[1]; expect(perfilDe(linhas[0])).toBeDefined(); expect(perfilDe(linhas[0])).not.toBe(perfilDe(linhas[1])); // 2ª usa perfil novo
    expect(e.launch).toMatchObject({ vivo: false, perfilCriado: true, crashDirCriado: true, portaEscrita: false }); expect(typeof e.launch.decorridoMs).toBe("number"); expect(e.launch.stderrBytes).toBeGreaterThan(0);
    expect(e.message).toMatch(/carga [\d.]+; memória/); expect(e.message).toContain("perfil criado"); expect(e.message).toContain("porta não escrita");
    expect(e.message.length).toBeLessThan(5500); // cauda curta: 12 linhas × 300 caracteres no máximo + metadados (+ resumo da 1ª, 500)
    const depois = perfis().filter((n) => !antes.has(n)); expect(depois).toEqual([]); // nenhum perfil descartável sobrou
  });

  it("executável inexistente (ENOENT) não vira laço: erro claro, sem processo pendurado", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const e: any = await launchBrowser("/nao/existe/chrome-g7", { startupMs: 500 }).then(() => null, (x: any) => x); log.mockRestore();
    expect(e).toBeInstanceOf(Error); expect(e.startup).toBeUndefined(); expect(e.message).toContain("ENOENT"); // erro claro (vira ENV em run.mjs), não é repetido
  });

  it("o prazo de arranque (padrão 15 s) é o mesmo da G6; nada na matriz foi afrouxado", () => {
    const b = readFileSync("scripts/qa-visual/lib/browser.mjs", "utf8");
    expect(b).toContain("startupMs = 15000"); expect(b).toContain("Math.ceil(startupMs / 150)"); expect(existsSync("scripts/qa-visual/lib/browser.mjs")).toBe(true);
  });
});
