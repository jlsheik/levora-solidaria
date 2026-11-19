import { z } from "zod";
import superjson from "superjson";

const optionalText = (re: RegExp, max: number) => z.string().trim().max(max).regex(re).optional();
export const AREAS = ["agentes", "automacao", "oportunidades", "politicas", "organizacao", "necessidades", "inventario", "destinacao", "aprovacoes", "acesso", "arquivos"] as const;

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Cursor: registros com id MENOR que este (página seguinte). */
  beforeId: z.string().regex(/^[0-9]{1,18}$/).optional(),
  /** Quando informado, devolve também quantos registros (mesmos filtros) chegaram DEPOIS deste id. */
  sinceId: z.string().regex(/^[0-9]{1,18}$/).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  area: z.enum(AREAS).optional(),
  action: optionalText(/^[a-z0-9_.]+$/, 80),
  entityType: optionalText(/^[a-z0-9_]+$/, 60),
  entityId: optionalText(/^[A-Za-z0-9_\-:.]+$/, 60),
  actorUserId: z.coerce.number().int().positive().optional(),
  actorType: z.enum(["user", "agent", "system"]).optional(),
  /** Resultado EXPLÍCITO gravado no registro. `nao_registrado` = sem resultado gravado (histórico/operação não instrumentada). */
  resultado: z.enum(["concluida", "recusada", "falhou", "pendente", "nao_registrado"]).optional(),
  correlationId: optionalText(/^[0-9a-fA-F-]{36}$/, 36),
});
export type Input = z.input<typeof schema>;

export type AuditEntryView = {
  id: string; action: string; entityType: string; entityId: string | null;
  actorType: "user" | "agent" | "system"; actorUserId: number | null; actorName: string | null;
  createdAt: string;
  /** null = resultado não registrado (nunca presumido, nunca deduzido do nome da ação). */
  outcome: "concluida" | "recusada" | "falhou" | "pendente" | null;
  /** Correlação persistida (M39); null = sem correlação. */
  correlationId: string | null;
  /** Identificador da operação pontual (metadata.correlacao, M36/M37). */
  operationId: string | null;
  /** 1 = formato histórico; 2 = hash cobre resultado e correlação. */
  recordVersion: number;
  chained: boolean;
};
export type OutputType = {
  entries: AuditEntryView[];
  nextCursor: string | null;
  /** Total filtrado (limitado a 10.000: `capped`). */
  total: { count: number; capped: boolean };
  /** Só com `sinceId`. */
  newerCount: number | null;
};

export const getAuditCenter = async (query: Input, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams();
  for (const [k, val] of Object.entries(v)) if (val !== undefined && val !== "") params.set(k, val instanceof Date ? val.toISOString() : String(val));
  const result = await fetch(`/_api/v1/audit-center?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a trilha de auditoria");
  }
  return superjson.parse<OutputType>(await result.text());
};
