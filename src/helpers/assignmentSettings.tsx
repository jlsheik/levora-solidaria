import type { Kysely, Transaction } from "kysely";
import type { DB } from "./schema.js";

/**
 * Política global das atribuições automáticas (Fase 98).
 *  - Prazo de resposta: 72 horas por padrão, o MESMO para todas as organizações, configurável só por admin da plataforma (faixa 1–720 h). É gravado em cada atribuição
 *    no momento da criação (`response_due_at`), então mudar o valor afeta apenas as atribuições futuras.
 *  - Pausa de reatribuição: 7 dias depois de uma expiração por prazo, a mesma organização não é escolhida automaticamente de novo para a MESMA oportunidade
 *    (não é recusa: depois da pausa ela volta a ser considerada). Valor fixo da política desta fase.
 * Sem linha em `platform_assignment_settings` vale o padrão.
 */
export const DEFAULT_RESPONSE_DEADLINE_HOURS = 72;
export const MIN_RESPONSE_DEADLINE_HOURS = 1;
export const MAX_RESPONSE_DEADLINE_HOURS = 720;
export const REASSIGNMENT_PAUSE_DAYS = 7;

type Db = Kysely<DB> | Transaction<DB>;

export async function getResponseDeadlineHours(db: Db): Promise<number> {
  const row = await db.selectFrom("platformAssignmentSettings").select("responseDeadlineHours").where("id", "=", 1).executeTakeFirst();
  const h = row?.responseDeadlineHours;
  return typeof h === "number" && h >= MIN_RESPONSE_DEADLINE_HOURS && h <= MAX_RESPONSE_DEADLINE_HOURS ? h : DEFAULT_RESPONSE_DEADLINE_HOURS;
}
