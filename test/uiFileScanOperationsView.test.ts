/**
 * M32 — lógica de apresentação dos indicadores da análise antimalware (pura; sem banco, sem navegador).
 */
import { describe, it, expect } from "vitest";
import { ALERT_COPY, LEVEL_COPY, backlogMetrics, formatDurationMs, formatInstant, formatMinutes, modeLabel, scannerLine, summarize } from "../src/components/fileScanOperationsView";
import type { OutputType as Ops } from "../src/endpoints/file-scan-operations_GET.schema";

type Alert = Ops["alerts"][number];
const alert = (code: Alert["code"], level: Alert["level"]): Alert => ({ code, level, detail: "x" });
const CODES: Alert["code"][] = ["scanner_sem_resposta", "assinaturas_antigas", "assinaturas_desconhecidas", "backlog_envelhecido", "tarefas_abandonadas", "tentativas_esgotadas", "worker_sem_executar", "falhas_recentes"];
const scanner = (over: Partial<Ops["scanner"]> = {}): Ops["scanner"] => ({ configured: true, scanner: "clamd", reachable: true, ping: "PONG", engine: "ClamAV 1.5.4", signatureVersion: 28155, signatureDate: "2026-10-16T06:24:17.000Z", signatureAgeHours: 12, freshness: "atual", maxAgeHours: 48, checkedAt: "2026-10-16T18:00:00.000Z", error: null, ...over });
const backlog = (over: Partial<Ops["backlog"]> = {}): Ops["backlog"] => ({ pendente: 0, indisponivel: 0, infectado: 0, legadoNaoAnalisado: 0, aguardandoNovaTentativa: 0, abandonadas: 0, esgotadas: 0, pendenteMaisAntigoMinutos: null, indisponivelMaisAntigoMinutos: null, ...over });

describe("summarize — o resumo nunca esconde um limiar não definido nem um alerta", () => {
  it("todos em ordem ⇒ 'Tudo em ordem'", () => { const s = summarize({ alerts: CODES.map((c) => alert(c, "ok")) }); expect(s.tone).toBe("ok"); expect(s.headline).toBe("Tudo em ordem"); });
  it("qualquer alerta ⇒ atenção, com a contagem no singular e no plural", () => {
    expect(summarize({ alerts: [alert("falhas_recentes", "alerta"), alert("scanner_sem_resposta", "ok")] }).headline).toBe("1 sinal de atenção");
    const s = summarize({ alerts: [alert("falhas_recentes", "alerta"), alert("tentativas_esgotadas", "alerta"), alert("scanner_sem_resposta", "nao_definido")] }); expect(s.tone).toBe("attention"); expect(s.headline).toBe("2 sinais de atenção"); expect(s.undefinedCount).toBe(1);
  });
  it("sem alerta mas com limiar não definido ⇒ NUNCA 'em ordem'", () => {
    const s = summarize({ alerts: [alert("backlog_envelhecido", "nao_definido"), alert("worker_sem_executar", "nao_definido"), alert("scanner_sem_resposta", "ok")] });
    expect(s.tone).toBe("undefined"); expect(s.headline).toMatch(/2 limiares operacionais ainda não definidos/); expect(s.headline).not.toMatch(/em ordem/i);
    expect(summarize({ alerts: [alert("backlog_envelhecido", "nao_definido")] }).headline).toMatch(/1 limiar operacional ainda não definido/);
  });
});

describe("textos", () => {
  it("todo código de alerta do servidor tem título e explicação em português", () => { for (const c of CODES) { expect(ALERT_COPY[c].title.length).toBeGreaterThan(5); expect(ALERT_COPY[c].help.length).toBeGreaterThan(20); } });
  it("cada nível tem rótulo textual (não depende só de cor) e 'não definido' não é verde", () => {
    expect(LEVEL_COPY.ok).toEqual({ label: "Em ordem", tone: "ok" }); expect(LEVEL_COPY.alerta.label).toBe("Atenção"); expect(LEVEL_COPY.nao_definido.tone).toBe("undefined"); expect(LEVEL_COPY.nao_definido.label).toMatch(/não definido/i);
  });
  it("modo obrigatório e desativado", () => { expect(modeLabel("required")).toMatch(/Obrigatória/); expect(modeLabel("disabled")).toMatch(/Desativada/); });
});

describe("formatação — ausência de dado nunca vira zero", () => {
  it.each([[null, "—"], [undefined, "—"], [NaN, "—"], [-3, "—"], [0.2, "menos de 1 min"], [1, "1 min"], [59.4, "59 min"], [60, "1 h"], [200, "3 h 20 min"], [1440, "1 d"], [1560, "1 d 2 h"]])("formatMinutes(%s) = %s", (v, out) => { expect(formatMinutes(v as number | null)).toBe(out); });
  it("duração em ms/s", () => { expect(formatDurationMs(null)).toBe("—"); expect(formatDurationMs(250)).toBe("250 ms"); expect(formatDurationMs(1500)).toMatch(/^1,5 s$/); expect(formatDurationMs(-1)).toBe("—"); });
  it("instante inválido ou ausente ⇒ '—'", () => { expect(formatInstant(null)).toBe("—"); expect(formatInstant("lixo")).toBe("—"); expect(formatInstant("2026-10-16T18:00:00.000Z")).toMatch(/\d{2}\/\d{2}\/\d{2,4}/); });
});

describe("scannerLine", () => {
  it("respondendo, assinaturas dentro do limite ⇒ ok, com motor, base e idade", () => { const l = scannerLine({ scanner: scanner(), mode: "required" }); expect(l.state).toBe("Respondendo"); expect(l.tone).toBe("ok"); expect(l.detail).toMatch(/ClamAV 1\.5\.4/); expect(l.detail).toMatch(/base 28155/); expect(l.detail).toMatch(/12 h de idade/); });
  it("assinaturas antigas ⇒ atenção; idade desconhecida ⇒ não definido (nunca ok)", () => {
    expect(scannerLine({ scanner: scanner({ freshness: "antigo", signatureAgeHours: 200 }), mode: "required" }).tone).toBe("attention");
    expect(scannerLine({ scanner: scanner({ freshness: "desconhecido", maxAgeHours: null, signatureAgeHours: null }), mode: "required" }).tone).toBe("undefined");
  });
  it("sem resposta ⇒ atenção com o motivo; não configurado é atenção só quando a análise é obrigatória", () => {
    const down = scannerLine({ scanner: scanner({ reachable: false, ping: "sem_resposta", engine: null, error: "timeout" }), mode: "required" }); expect(down.tone).toBe("attention"); expect(down.detail).toMatch(/timeout/);
    expect(scannerLine({ scanner: scanner({ configured: false, reachable: false, ping: "nao_configurado" }), mode: "required" }).tone).toBe("attention");
    expect(scannerLine({ scanner: scanner({ configured: false, reachable: false, ping: "nao_configurado" }), mode: "disabled" }).tone).toBe("undefined");
  });
});

describe("backlogMetrics", () => {
  it("devolve os 9 indicadores na ordem de leitura, com contagens formatadas e idades como texto", () => {
    const m = backlogMetrics(backlog({ pendente: 1200, esgotadas: 3, pendenteMaisAntigoMinutos: 200, indisponivelMaisAntigoMinutos: null }));
    expect(m.map((x) => x.key)).toEqual(["pendente", "indisponivel", "aguardando", "abandonadas", "esgotadas", "infectado", "legado", "pendente-antigo", "indisponivel-antigo"]);
    expect(m[0].value).toBe((1200).toLocaleString("pt-BR")); expect(m.find((x) => x.key === "pendente-antigo")!.value).toBe("3 h 20 min"); expect(m.find((x) => x.key === "indisponivel-antigo")!.value).toBe("—");
  });
  it("abandonadas e esgotadas > 0 pedem atenção; zero não; indisponíveis e legado > 0 ficam como pendência (não verde)", () => {
    const z = backlogMetrics(backlog()); for (const k of ["abandonadas", "esgotadas", "indisponivel", "legado"]) expect(z.find((x) => x.key === k)!.tone).toBe("ok");
    const m = backlogMetrics(backlog({ abandonadas: 1, esgotadas: 2, indisponivel: 4, legadoNaoAnalisado: 5 }));
    expect(m.find((x) => x.key === "abandonadas")!.tone).toBe("attention"); expect(m.find((x) => x.key === "esgotadas")!.tone).toBe("attention");
    expect(m.find((x) => x.key === "indisponivel")!.tone).toBe("undefined"); expect(m.find((x) => x.key === "legado")!.tone).toBe("undefined");
  });
});
