import { sql, type Kysely, type Transaction } from "kysely";
import type { DB, OpportunityStatus } from "./schema.js";
import { getEffectivePolicyLimits } from "./policyLimits.js";

/**
 * Categoria da oportunidade (M37). A categoria continua OPCIONAL no cadastro (decisão do proprietário pendente) e NÃO existe catálogo oficial de categorias no sistema: o campo é texto livre.
 * Por isso a validação aqui é só de FORMA (tamanho e caracteres), não de vocabulário — nenhuma categoria é inventada, nenhum valor padrão existe, e “categoria inexistente/proibida” não tem fonte
 * documental para ser aplicada (decisão pendente: catálogo). As categorias que têm REGRA (alto risco/revisão manual) vêm da política e são mostradas como sugestão, mas qualquer texto válido é aceito.
 */

export const CATEGORY_MIN = 2;
export const CATEGORY_MAX = 60;

/** Estados em que a categoria pode ser corrigida. `recebida` (já gerou entrada de estoque) e `cancelada` são finais: o histórico delas não pode ser contrariado. */
export const EDITABLE_STATUSES: readonly OpportunityStatus[] = ["registrada", "em_contato", "confirmada"];
export const isCategoryEditable = (status: OpportunityStatus) => EDITABLE_STATUSES.includes(status);

export function parseCategory(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Informe a categoria." };
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < CATEGORY_MIN) return { ok: false, message: `A categoria precisa ter ao menos ${CATEGORY_MIN} caracteres.` };
  if (value.length > CATEGORY_MAX) return { ok: false, message: `A categoria pode ter no máximo ${CATEGORY_MAX} caracteres.` };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _\-/]*$/u.test(value)) return { ok: false, message: "Use apenas letras, números, espaço, hífen, barra ou sublinhado (e comece por letra ou número)." };
  return { ok: true, value };
}

export type CategorySuggestionSource = "oportunidades" | "estoque" | "politica";
export interface CategorySuggestion { value: string; source: CategorySuggestionSource }

/** Sugestões REAIS (nada inventado): categorias já usadas nesta organização (ofertas e estoque) e as que têm regra na política efetiva. Sem repetição (sem diferenciar maiúsculas), no máximo 60. */
export async function listCategorySuggestions(executor: Kysely<DB> | Transaction<DB>, organizationId: number): Promise<CategorySuggestion[]> {
  const out = new Map<string, CategorySuggestion>();
  const add = (value: string | null | undefined, source: CategorySuggestionSource) => {
    const v = (value ?? "").trim().replace(/\s+/g, " ");
    if (!v || !parseCategory(v).ok) return;
    const k = v.toLowerCase();
    if (!out.has(k)) out.set(k, { value: v, source });
  };
  const policy = await getEffectivePolicyLimits(executor as Kysely<DB>, organizationId);
  for (const c of [...policy.HIGH_RISK_CATEGORIES, ...policy.MANUAL_REVIEW_REQUIRED_CATEGORIES]) add(c, "politica");
  const used = await sql<{ category: string; source: CategorySuggestionSource }>`
    SELECT DISTINCT category, 'oportunidades'::text AS source FROM donation_opportunities WHERE organization_id = ${organizationId} AND category IS NOT NULL AND btrim(category) <> ''
    UNION
    SELECT DISTINCT category, 'estoque'::text AS source FROM inventory_items WHERE organization_id = ${organizationId} AND category IS NOT NULL AND btrim(category) <> ''`.execute(executor);
  for (const r of used.rows) add(r.category, r.source);
  return [...out.values()].sort((a, b) => a.value.localeCompare(b.value, "pt-BR")).slice(0, 60);
}
