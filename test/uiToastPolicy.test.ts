/**
 * M12 — política de duração dos avisos: proporcional ao texto, com mínimo igual ao padrão anterior (4 s), folga dobrada e teto para erros/avisos, duração explícita preservada,
 * e instalação idempotente sobre o `toast` do Sonner sem remover nem alterar o tipo/mensagem. Sem banco, sem navegador.
 */
import { describe, it, expect, vi } from "vitest";
import { toastDurationFor, installToastDurations, TOAST_DEFAULT_MS, TOAST_MAX_MS, TOAST_IMPORTANT_MIN_MS, TOAST_IMPORTANT_MAX_MS } from "../src/components/toastPolicy";

describe("toastDurationFor", () => {
  it("mensagem curta mantém o padrão anterior de 4 s", () => { expect(toastDurationFor(20, "success")).toBe(TOAST_DEFAULT_MS); expect(toastDurationFor(0, "info")).toBe(TOAST_DEFAULT_MS); });
  it("mensagem de 220 caracteres deixa de durar 4 s: ≥ 15 s (≈14 caracteres/s) e ≤ teto", () => {
    const d = toastDurationFor(220, "info"); expect(d).toBeGreaterThanOrEqual(15000); expect(d).toBeLessThanOrEqual(TOAST_MAX_MS);
    expect(220 / (d / 1000)).toBeLessThanOrEqual(15); // caracteres por segundo
  });
  it("mensagem comum tem teto de 20 s mesmo com texto enorme", () => { expect(toastDurationFor(1e6, "info")).toBe(TOAST_MAX_MS); expect(toastDurationFor(1e6, "success")).toBe(TOAST_MAX_MS); });
  it("erro tem o mínimo de 8 s mesmo curto, folga maior que a de sucesso e nunca é permanente", () => {
    expect(toastDurationFor(10, "error")).toBe(TOAST_IMPORTANT_MIN_MS);
    expect(toastDurationFor(220, "error")).toBeGreaterThan(toastDurationFor(220, "info"));
    expect(toastDurationFor(100000, "error")).toBe(TOAST_IMPORTANT_MAX_MS); expect(Number.isFinite(toastDurationFor(1e9, "warning"))).toBe(true);
  });
  it("entrada inválida não quebra nem encurta abaixo do padrão", () => { for (const n of [NaN, -5, Infinity * 0]) expect(toastDurationFor(n, "success")).toBe(TOAST_DEFAULT_MS); });
  it("é monótona no tamanho do texto", () => { let prev = 0; for (let n = 0; n <= 600; n += 10) { const d = toastDurationFor(n, "info"); expect(d).toBeGreaterThanOrEqual(prev); prev = d; } });
});

describe("installToastDurations", () => {
  const make = () => { const calls: { kind: string; msg: unknown; data: Record<string, unknown> | undefined }[] = []; const t: Record<string, unknown> = {}; for (const k of ["success", "info", "message", "warning", "error"]) t[k] = (msg: unknown, data?: Record<string, unknown>) => { calls.push({ kind: k, msg, data }); return k; }; return { t, calls }; };
  it("aplica a duração calculada quando a chamada não traz duration e preserva a mensagem, o tipo e a descrição", () => {
    const { t, calls } = make(); installToastDurations(t); const long = "x".repeat(220);
    expect((t.error as (m: string, d?: object) => unknown)(long, { description: "detalhe" })).toBe("error");
    expect(calls[0].msg).toBe(long); expect(calls[0].data?.description).toBe("detalhe"); expect(calls[0].data?.duration).toBe(toastDurationFor(227, "error"));
  });
  it("duração explícita é respeitada (nada é encurtado nem alongado por baixo dos panos)", () => { const { t, calls } = make(); installToastDurations(t); (t.warning as (m: string, d?: object) => unknown)("aviso", { duration: 12000 }); expect(calls[0].data?.duration).toBe(12000); });
  it("é idempotente: a 2ª instalação não troca nem reenvolve as funções", () => { const { t } = make(); installToastDurations(t); const antes = [t.success, t.info, t.message, t.warning, t.error]; installToastDurations(t); expect([t.success, t.info, t.message, t.warning, t.error]).toEqual(antes); });
  it("é idempotente: instalar duas vezes não empilha envoltórios", () => { const { t, calls } = make(); installToastDurations(t); installToastDurations(t); (t.success as (m: string) => unknown)("ok"); expect(calls).toHaveLength(1); });
  it("não altera o tipo: error continua error, success continua success", () => { const { t, calls } = make(); installToastDurations(t); (t.error as (m: string) => unknown)("a"); (t.success as (m: string) => unknown)("b"); expect(calls.map((c) => c.kind)).toEqual(["error", "success"]); });
  it("mensagem que não é texto (nó React) usa o padrão e não quebra", () => { const { t, calls } = make(); installToastDurations(t); (t.info as (m: unknown) => unknown)({ type: "div" }); expect(calls[0].data?.duration).toBe(TOAST_DEFAULT_MS); void vi; });
});
