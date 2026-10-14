/**
 * Apresentação do prazo de resposta das atribuições automáticas (Fase 98). Funções puras, sem dependência de React.
 * O tempo restante usa o relógio do SERVIDOR (`serverNow`, enviado pela API) corrigido pelo tempo decorrido desde a consulta; o relógio do navegador só mede esse intervalo,
 * nunca decide o vencimento (quem expira é a tarefa do servidor, com o relógio do banco).
 */
export const SOON_THRESHOLD_MS = 12 * 3_600_000; // "próximo do vencimento": menos de 12 horas

export type DeadlineUrgency = "ok" | "soon" | "expired";

/** Milissegundos restantes até o vencimento, pelo relógio do servidor. Negativo = vencido. */
export function remainingMs(responseDueAt: string, serverNowAtFetch: string, fetchedAtMs: number, nowMs: number): number {
  const elapsed = Math.max(0, nowMs - fetchedAtMs);
  return Date.parse(responseDueAt) - (Date.parse(serverNowAtFetch) + elapsed);
}

export function urgencyOf(ms: number): DeadlineUrgency {
  if (ms <= 0) return "expired";
  return ms < SOON_THRESHOLD_MS ? "soon" : "ok";
}

/** "2 dias e 3 h", "5 h 20 min", "45 min", "menos de 1 min"; vencido → "prazo vencido". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "prazo vencido";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "menos de 1 min";
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days} ${days === 1 ? "dia" : "dias"} e ${hours} h` : `${days} ${days === 1 ? "dia" : "dias"}`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

export const CLOSED_REASON_LABELS: Record<string, string> = {
  prazo_expirado: "Prazo de resposta expirado",
  reserva_expirada: "Reserva expirada",
  oferta_cancelada_admin: "Oferta cancelada pela equipe da Levora",
  oferta_expirada_admin: "Oferta encerrada pela equipe da Levora (expirada)",
  oferta_expirada_automatica: "Oferta expirou",
  oferta_encerrada: "Oferta encerrada",
};
