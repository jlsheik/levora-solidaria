import { z } from "zod";
import superjson from "superjson";
import type { OpportunityStatus } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

/** M37 — situação da avaliação do Risk Engine para esta oportunidade; só vai para quem pode ler a automação (proprietário/administrador). Nada aqui é execução real. */
export type OpportunityAssessment = {
  runId: string;
  status: string;
  completeness: "completa" | "parcial" | "insuficiente" | null;
  decision: string | null;
  /** Pode pedir nova análise agora (há dado novo verificável e nada bloqueia)? */
  reevaluation: "elegivel" | "ainda_insuficiente" | "indisponivel" | "nao_aplicavel" | null;
  blockCode: string | null;
  categoryConsidered: string | null;
};

export type CategorySuggestion = { value: string; source: "oportunidades" | "estoque" | "politica" };

export type OutputType = {
  /** Categorias já usadas na organização ou com regra na política (nada inventado). */
  categorySuggestions?: CategorySuggestion[];
  /** O usuário pode ler a avaliação do agente e pedir nova análise (permissões de automação). */
  canSeeAssessment?: boolean;
  opportunities: Array<{
    id: number;
    title: string;
    description: string | null;
    category: string | null;
    quantityOffered: number | null;
    unit: string | null;
    donorName: string;
    donorContact: string | null;
    linkedNeedId: number | null;
    linkedNeedTitle: string | null;
    status: OpportunityStatus;
    createdByDisplayName: string;
    createdAt: string;
    /** M37: versão do registro (controle otimista da edição) e se ESTE usuário pode corrigir a categoria agora. */
    version?: number;
    canEditCategory?: boolean;
    assessment?: OpportunityAssessment | null;
  }>;
};

export const getOpportunities = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/opportunities?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as oportunidades");
  }

  return superjson.parse<OutputType>(await result.text());
};
