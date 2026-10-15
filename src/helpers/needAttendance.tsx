/**
 * Fase 99F — FONTE ÚNICA do ATENDIMENTO FINAL de uma necessidade: deriva SOMENTE das destinações (`stock_destinations`), nunca de `need_fulfillments` (suprimento recebido da rede),
 * nunca de `need_resolutions` e nunca do texto de um movimento. Conceitos (nunca somados entre si):
 *   - físico destinado: quantidade que saiu do estoque ligada à necessidade (líquida de reversões), contabilizável ou não;
 *   - aplicado (= "atendido"): parcela que conta para a necessidade — só originais das três finalidades de atendimento, mesma organização, unidade comprovadamente igual
 *     (`is_countable`, decidido no registro, sem conversão), líquida de reversões; `correction` nunca soma (não tem quantidade) e `reversal` só reduz;
 *   - excedente: parcela física autorizada acima do que faltava (`surplus_quantity`), visível mas NUNCA contada como atendimento adicional;
 *   - unidade incompatível: físico destinado com `is_countable = false` (fica no histórico físico, não avança o atendimento).
 * Fórmula por original contabilizável: contribuição = LEAST(aplicada, física − revertida) (a reversão consome primeiro o excedente). É a mesma da função SQL `need_applied_total`
 * (migration 0021), que o gatilho `stock_destination_need_cap` usa para impedir, no banco, que a soma aplicada passe da quantidade solicitada.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "./schema.js";
import { roundQuantity } from "./quantityRules.js";

export interface NeedAttendance {
  /** Físico líquido destinado à necessidade (contabilizável ou não). */
  physicalNet: number;
  /** Aplicado ao atendimento (líquido de reversões). */
  appliedNet: number;
  /** Excedente físico autorizado ainda existente (líquido de reversões). */
  surplusNet: number;
  /** Físico destinado com unidade incompatível (não conta). */
  unitIncompatiblePhysical: number;
  destinationCount: number;
}

const EMPTY: NeedAttendance = { physicalNet: 0, appliedNet: 0, surplusNet: 0, unitIncompatiblePhysical: 0, destinationCount: 0 };

export async function getNeedAttendanceBatch(executor: Transaction<DB> | Kysely<DB>, needIds: number[]): Promise<Map<number, NeedAttendance>> {
  const result = new Map<number, NeedAttendance>();
  if (needIds.length === 0) return result;
  const rows = await sql<{ needId: number; physical: string; applied: string; incompatible: string; n: string }>`
    SELECT d.need_id,
      COALESCE(SUM(d.quantity - COALESCE(r.reversed, 0)), 0) AS physical,
      COALESCE(SUM(LEAST(COALESCE(d.applied_quantity, d.quantity), d.quantity - COALESCE(r.reversed, 0))) FILTER (WHERE d.is_countable IS TRUE), 0) AS applied,
      COALESCE(SUM(d.quantity - COALESCE(r.reversed, 0)) FILTER (WHERE d.is_countable IS NOT TRUE), 0) AS incompatible,
      COUNT(*) AS n
    FROM stock_destinations d
    LEFT JOIN (SELECT reverses_destination_id AS id, SUM(quantity) AS reversed FROM stock_destinations WHERE entry_type = 'reversal' GROUP BY reverses_destination_id) r ON r.id = d.id
    WHERE d.entry_type = 'original' AND d.need_id IN (${sql.join(needIds)})
    GROUP BY d.need_id`.execute(executor);
  for (const r of rows.rows) {
    const physical = roundQuantity(Number(r.physical));
    const applied = roundQuantity(Number(r.applied));
    const incompatible = roundQuantity(Number(r.incompatible));
    result.set(Number(r.needId), {
      physicalNet: physical,
      appliedNet: applied,
      surplusNet: Math.max(0, roundQuantity(physical - incompatible - applied)),
      unitIncompatiblePhysical: incompatible,
      destinationCount: Number(r.n),
    });
  }
  return result;
}

export async function getNeedAttendance(executor: Transaction<DB> | Kysely<DB>, needId: number): Promise<NeedAttendance> {
  return (await getNeedAttendanceBatch(executor, [needId])).get(needId) ?? EMPTY;
}

export type NeedProgressState =
  | "sem_atendimento"
  | "parcial"
  | "atendida"
  /** `atendida` por uma versão anterior (baixa automática/resolução administrativa), sem destinação estruturada que a comprove. */
  | "atendida_historica"
  | "cancelada";

export interface NeedAttendanceProgress {
  requested: number;
  /** Atendido: quantidade aplicada limitada à solicitada. */
  attended: number;
  /** Ainda necessário (nunca negativo). */
  remaining: number;
  percent: number;
  physicalDestined: number;
  surplus: number;
  unitIncompatibleDestined: number;
  state: NeedProgressState;
}

export function computeAttendanceProgress(requested: number, attendance: NeedAttendance, status: "aberta" | "atendida" | "cancelada"): NeedAttendanceProgress {
  const attended = Math.min(requested, attendance.appliedNet);
  const remaining = Math.max(0, roundQuantity(requested - attended));
  const percent = requested > 0 ? Math.min(100, Math.floor((attended / requested) * 1000) / 10) : 0;
  let state: NeedProgressState;
  if (status === "cancelada") state = "cancelada";
  else if (status === "atendida") state = remaining === 0 ? "atendida" : "atendida_historica";
  else state = attended === 0 ? "sem_atendimento" : "parcial";
  return { requested, attended: roundQuantity(attended), remaining, percent, physicalDestined: attendance.physicalNet, surplus: attendance.surplusNet, unitIncompatibleDestined: attendance.unitIncompatiblePhysical, state };
}

/** Quanto FALTA para o atendimento final (nunca negativo) — usado para decidir aplicação, excedente e `atendida`. */
export const remainingToAttend = (requested: number, attendance: NeedAttendance) => Math.max(0, roundQuantity(requested - attendance.appliedNet));
