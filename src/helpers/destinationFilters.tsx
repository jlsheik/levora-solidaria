/**
 * Fase 99I — FONTE ÚNICA dos filtros de destinações (listagem/histórico e totais). Datas são datas CIVIS (AAAA-MM-DD) no calendário do fuso de negócio (America/Sao_Paulo), ambas INCLUSIVAS:
 *   - base `registro`: `created_at` da destinação original, comparada nos instantes [00:00 BRT de `from`, 00:00 BRT do dia seguinte a `to`) — a conversão é feita no BANCO com `AT TIME ZONE`;
 *   - base `efetiva`: data da entrega NO CALENDÁRIO, já com as correções documentais aplicadas (a mais recente correção de data vence; a original permanece intacta).
 * Situação (calculada sobre o acumulado até agora): `ativa` (sem reversão), `parcialmente_revertida`, `revertida`, `com_correcao` (tem ao menos uma correção documental).
 */
import { sql, type RawBuilder } from "kysely";
import { DESTINATION_TYPES, type DestinationType } from "./destinationRules.js";
import { parseCivilDate, civilDaysBetween } from "./businessDate.js";

export const DESTINATION_DATE_BASES = ["registro", "efetiva"] as const;
export type DestinationDateBasis = (typeof DESTINATION_DATE_BASES)[number];
export const DESTINATION_STATES = ["ativa", "parcialmente_revertida", "revertida", "com_correcao"] as const;
export type DestinationState = (typeof DESTINATION_STATES)[number];
export const MAX_FILTER_DAYS = 731;

export interface DestinationFilter {
  organizationId: number;
  itemId?: number | null;
  needId?: number | null;
  destinationType?: DestinationType | null;
  state?: DestinationState | null;
  basis?: DestinationDateBasis;
  /** AAAA-MM-DD, inclusivo. */
  from?: string | null;
  /** AAAA-MM-DD, inclusivo. */
  to?: string | null;
}

/** Valida o intervalo civil; devolve a mensagem de erro (ou null). Nunca confia no navegador. */
export function validateDateRange(from?: string | null, to?: string | null): string | null {
  for (const [label, v] of [["inicial", from], ["final", to]] as const) {
    if (v != null && parseCivilDate(v) === null) return `A data ${label} não é uma data real do calendário (AAAA-MM-DD)`;
  }
  if (from && to) {
    if (from > to) return "A data inicial precisa ser anterior ou igual à final";
    if (civilDaysBetween(from, to) > MAX_FILTER_DAYS) return `O intervalo máximo é de ${MAX_FILTER_DAYS} dias`;
  }
  return null;
}

export const isDestinationType = (v: string): v is DestinationType => (DESTINATION_TYPES as readonly string[]).includes(v);

/** Expressão SQL da data efetiva (DATE) de uma original `d`, com as correções documentais de data aplicadas. */
export const effectiveDateExpr: RawBuilder<unknown> = sql`coalesce(
  (SELECT c.delivered_on FROM stock_destinations c WHERE c.entry_type = 'correction' AND c.reverses_destination_id = d.id AND c.delivered_on IS NOT NULL ORDER BY c.id DESC LIMIT 1),
  d.delivered_on)`;

const REVERSED = sql`coalesce((SELECT sum(r.quantity) FROM stock_destinations r WHERE r.entry_type = 'reversal' AND r.reverses_destination_id = d.id), 0)`;

/** Fragmento `AND ...` para originais `d` (alias obrigatório). */
export function destinationWhere(f: DestinationFilter): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [sql`d.organization_id = ${f.organizationId} AND d.entry_type = 'original'`];
  if (f.itemId) parts.push(sql`d.item_id = ${f.itemId}`);
  if (f.needId) parts.push(sql`d.need_id = ${f.needId}`);
  if (f.destinationType) parts.push(sql`d.destination_type = ${f.destinationType}`);
  const basis = f.basis ?? "registro";
  if (basis === "registro") {
    if (f.from) parts.push(sql`d.created_at >= (${f.from}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
    if (f.to) parts.push(sql`d.created_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`);
  } else {
    if (f.from) parts.push(sql`${effectiveDateExpr} >= ${f.from}::date`);
    if (f.to) parts.push(sql`${effectiveDateExpr} <= ${f.to}::date`);
  }
  if (f.state === "ativa") parts.push(sql`${REVERSED} = 0`);
  if (f.state === "parcialmente_revertida") parts.push(sql`${REVERSED} > 0 AND ${REVERSED} < d.quantity`);
  if (f.state === "revertida") parts.push(sql`${REVERSED} >= d.quantity`);
  if (f.state === "com_correcao") parts.push(sql`EXISTS (SELECT 1 FROM stock_destinations c WHERE c.entry_type = 'correction' AND c.reverses_destination_id = d.id)`);
  return sql.join(parts.map((p) => sql`(${p})`), sql` AND `);
}
