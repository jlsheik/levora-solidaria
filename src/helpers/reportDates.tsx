/**
 * Datas da Prestação de Contas — CONTRATO do intervalo (Fase 85/86): SEMIABERTO `[startDate, endDate)`.
 * `startDate` é o início do dia escolhido em "De" (inclusivo); `endDate` é o início do dia SEGUINTE ao escolhido em
 * "Até" (EXCLUSIVO). O servidor compara `created_at >= startDate AND created_at < endDate` em todas as consultas.
 * Nunca usar `T23:59:59` como limite superior (deixaria de fora o último segundo do dia).
 * O fuso é o do navegador (o padrão do app); o servidor só recebe instantes (ISO).
 */

/** `YYYY-MM-DD` no calendário LOCAL do usuário (não UTC). */
export function localISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Início (00:00:00.000, fuso local) do dia `YYYY-MM-DD`. */
export function dayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

/** Início do dia SEGUINTE a `YYYY-MM-DD` — o limite superior EXCLUSIVO do intervalo. */
export function nextDayStart(iso: string): Date {
  const d = dayStart(iso);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Intervalo `[start, endExclusive)` para o par "De"/"Até" (ambos inclusivos na tela). */
export function reportRange(fromIso: string, toIso: string): { startDate: Date; endDate: Date } {
  return { startDate: dayStart(fromIso), endDate: nextDayStart(toIso) };
}
