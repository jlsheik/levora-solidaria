/**
 * M11 / R10 (residual) — espaço reservado aos avisos (toasts) quando há um diálogo aberto. Função pura, com a geometria REAL medida no Chrome (sonda `contentCoverage`):
 * a 375×812 o aviso de erro longo (202 px) cobria 100% da dica e do campo de link; agora o diálogo cede 226 px (16 de deslocamento + 202 de altura + 8 de folga).
 */
import { describe, it, expect } from "vitest";
import { computeToastReserve, toastStackHeight, DIALOG_MAX_HEIGHT_RATIO } from "../src/components/toastReserve";

const mobile = { viewportHeight: 812, dialogContent: { left: 42, right: 333 }, dialogNaturalHeight: 738.188, toastCount: 1, defaultOffset: 16 };
const mobileToast = (height: number) => ({ left: 16, right: 359, height });

describe("computeToastReserve (R10 residual)", () => {
  it("375×812: reserva = deslocamento + altura da pilha + folga (valores medidos no navegador)", () => {
    expect(computeToastReserve({ ...mobile, toast: mobileToast(58) })).toBe(82); // sucesso: 16 + 58 + 8 = 82
    expect(computeToastReserve({ ...mobile, toast: mobileToast(106) })).toBe(130); // erro curto
    expect(computeToastReserve({ ...mobile, toast: mobileToast(202) })).toBe(226); // erro longo
  });
  it("dois avisos empilhados: soma o espaçamento da pilha do Sonner (14 px)", () => {
    expect(toastStackHeight(82, 2)).toBe(96);
    expect(computeToastReserve({ ...mobile, toast: mobileToast(82), toastCount: 2 })).toBe(120); // 16 + 82 + 14 + 8
  });
  it("a pilha recolhida do Sonner mostra no máximo 3 avisos", () => {
    expect(toastStackHeight(60, 7)).toBe(60 + 2 * 14);
  });
  it("1280×900: o aviso encosta no conteúdo do diálogo pela direita (4 px) e na base: o diálogo cede", () => {
    const r = computeToastReserve({ viewportHeight: 900, dialogContent: { left: 384, right: 896 }, dialogNaturalHeight: 800, toast: { left: 892, right: 1252, height: 58 }, toastCount: 1, defaultOffset: 32 });
    expect(r).toBe(98); // 32 + 58 + 8
  });
  it("sem sobreposição horizontal: nada muda", () => {
    expect(computeToastReserve({ viewportHeight: 900, dialogContent: { left: 384, right: 880 }, dialogNaturalHeight: 800, toast: { left: 892, right: 1252, height: 58 }, toastCount: 1, defaultOffset: 32 })).toBe(0);
  });
  it("diálogo baixo (a borda inferior não invade a faixa do aviso): nada muda, o diálogo não se move", () => {
    expect(computeToastReserve({ ...mobile, dialogNaturalHeight: 300, toast: mobileToast(58) })).toBe(0);
  });
  it("sem aviso visível ou altura inválida: 0", () => {
    expect(computeToastReserve({ ...mobile, toastCount: 0, toast: mobileToast(58) })).toBe(0);
    expect(computeToastReserve({ ...mobile, toast: mobileToast(0) })).toBe(0);
  });
  it("janela muito baixa: o diálogo nunca é reduzido a menos da metade da janela (o aviso é que pode sobrepor)", () => {
    const r = computeToastReserve({ viewportHeight: 375, dialogContent: { left: 100, right: 700 }, dialogNaturalHeight: 600, toast: { left: 16, right: 359, height: 202 }, toastCount: 1, defaultOffset: 16 });
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(226); // menor que o necessário
    expect(375 - r - 32).toBeGreaterThanOrEqual(375 * 0.5 - 1); // a caixa do diálogo ocupa pelo menos ~metade da janela
  });
  it("o resultado é um inteiro par (geometria inteira, como no R12)", () => {
    for (const h of [57, 58.4, 101, 133.7, 202]) { const r = computeToastReserve({ ...mobile, toast: mobileToast(h) }); expect(Number.isInteger(r) && r % 2 === 0).toBe(true); }
  });
  it("a proporção usada como altura natural é a mesma do CSS do diálogo (85vh)", () => { expect(DIALOG_MAX_HEIGHT_RATIO).toBe(0.85); });
});
