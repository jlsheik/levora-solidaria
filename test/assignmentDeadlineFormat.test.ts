import { describe, it, expect } from "vitest";
import { remainingMs, urgencyOf, formatRemaining, CLOSED_REASON_LABELS, SOON_THRESHOLD_MS } from "../src/helpers/assignmentDeadline";

describe("apresentação do prazo (relógio do servidor, não o do navegador)", () => {
  const due = "2026-10-20T12:00:00.000Z";
  it("tempo restante = vencimento − (agora do SERVIDOR na consulta + tempo decorrido); o relógio absoluto do navegador não entra", () => {
    // o navegador está com o relógio adiantado em 10 dias, mas só o intervalo medido (fetchedAt → now) importa
    const browserSkew = 10 * 86_400_000;
    expect(remainingMs(due, "2026-10-20T09:00:00.000Z", 1_000_000 + browserSkew, 1_000_000 + browserSkew)).toBe(3 * 3_600_000);
    expect(remainingMs(due, "2026-10-20T09:00:00.000Z", 1_000_000 + browserSkew, 1_000_000 + browserSkew + 60_000)).toBe(3 * 3_600_000 - 60_000);
    expect(remainingMs(due, "2026-10-20T09:00:00.000Z", 5_000, 1_000)).toBe(3 * 3_600_000); // relógio andando para trás: nunca soma tempo negativo
  });
  it("urgência: ok, próximo do vencimento (< 12 h) e vencido (no instante exato já é vencido)", () => {
    expect(urgencyOf(SOON_THRESHOLD_MS)).toBe("ok");
    expect(urgencyOf(SOON_THRESHOLD_MS - 1)).toBe("soon");
    expect(urgencyOf(1)).toBe("soon");
    expect(urgencyOf(0)).toBe("expired");
    expect(urgencyOf(-5)).toBe("expired");
  });
  it("formatação legível", () => {
    expect(formatRemaining(72 * 3_600_000)).toBe("3 dias");
    expect(formatRemaining(26 * 3_600_000)).toBe("1 dia e 2 h");
    expect(formatRemaining(5 * 3_600_000 + 20 * 60_000)).toBe("5 h 20 min");
    expect(formatRemaining(3 * 3_600_000)).toBe("3 h");
    expect(formatRemaining(45 * 60_000)).toBe("45 min");
    expect(formatRemaining(30_000)).toBe("menos de 1 min");
    expect(formatRemaining(0)).toBe("prazo vencido");
    expect(formatRemaining(-1)).toBe("prazo vencido");
  });
  it("todo motivo de encerramento aceito pelo banco tem rótulo para a organização", () => {
    for (const reason of ["prazo_expirado", "reserva_expirada", "oferta_cancelada_admin", "oferta_expirada_admin", "oferta_expirada_automatica", "oferta_encerrada"]) {
      expect(CLOSED_REASON_LABELS[reason], reason).toBeTruthy();
    }
  });
});
