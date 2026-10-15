/**
 * Fase 99E — política ÚNICA de data efetiva da destinação (backend, testes e, depois, relatórios usam estas funções).
 *
 * - Timestamps persistidos são SEMPRE instantes (UTC); a DATA DE NEGÓCIO é calculada num fuso IANA explícito, nunca no fuso da máquina que roda o Node nem no do navegador.
 * - Fuso de negócio: configuração GLOBAL desta versão (`America/Sao_Paulo`); não há fuso por organização.
 * - "Hoje" e os limites são DATAS CIVIS no fuso de negócio, não diferenças de 168 horas. Regras: futura é rejeitada; de hoje até 7 dias corridos atrás (inclusive: hoje − 7 é aceita) é
 *   a janela normal; de 8 dias atrás em diante é RETROATIVA e exige autorização administrativa + justificativa + auditoria.
 * - O instante de referência vem do relógio do servidor/banco; o navegador só informa a data escolhida.
 */
export const BUSINESS_TIMEZONE = "America/Sao_Paulo";
export const MAX_RETROACTIVE_DAYS = 7;

/** Data civil (YYYY-MM-DD) de um instante no fuso informado. */
export function businessDateOf(instant: Date, timeZone: string = BUSINESS_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Aceita só `YYYY-MM-DD` de uma data REAL do calendário (rejeita 2026-02-30, 2026-13-01, "10/05/2026", horas, espaços). */
export function parseCivilDate(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  if (y < 2000) return null;
  return { y, m, d };
}

/** Dias corridos CIVIS entre duas datas (b − a); independe de horário de verão e de horas. */
export function civilDaysBetween(a: string, b: string): number {
  const pa = parseCivilDate(a);
  const pb = parseCivilDate(b);
  if (!pa || !pb) throw new Error("data civil inválida");
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

export type EffectiveDateCheck =
  | { ok: true; businessToday: string; daysAgo: number; /** true = mais de 7 dias corridos atrás: exige autorização + justificativa */ retroactive: boolean }
  | { ok: false; reason: "formato_invalido" | "futura" };

export function checkEffectiveDate(deliveredOn: string, now: Date, timeZone: string = BUSINESS_TIMEZONE): EffectiveDateCheck {
  if (!parseCivilDate(deliveredOn)) return { ok: false, reason: "formato_invalido" };
  const today = businessDateOf(now, timeZone);
  const daysAgo = civilDaysBetween(deliveredOn, today);
  if (daysAgo < 0) return { ok: false, reason: "futura" };
  return { ok: true, businessToday: today, daysAgo, retroactive: daysAgo > MAX_RETROACTIVE_DAYS };
}
