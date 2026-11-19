import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { RETENTION_CATEGORIES, RETENTION_DECISIONS_PENDING } from "../helpers/retentionCatalog.js";
import { schema, type OutputType } from "./retention-preview_GET.schema.js";
import superjson from "superjson";

/**
 * M34 — classificação e SIMULAÇÃO de retenção dos registros da plataforma de agentes de uma organização (somente leitura, `automacao.leia`). Não existe política de retenção definida e este
 * endpoint NUNCA apaga nada: só conta o que existe e o que passaria de um prazo hipotético, para o proprietário decidir com dados. Tabelas e colunas vêm de um catálogo fixo em código (nunca do pedido).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId"), olderThanDays: url.searchParams.get("olderThanDays") ?? undefined });
    await requirePermissionToRead(user.id, input.organizationId, "automacao.leia");

    const rows: OutputType["rows"] = [];
    for (const c of RETENTION_CATEGORIES) {
      const table = sql.table(c.table);
      const org = sql.ref(c.orgColumn);
      const date = sql.ref(c.dateColumn);
      const r = await sql<{ total: string; oldest: Date | null; older: string | null }>`
        SELECT count(*)::text AS total, min(${date}) AS oldest,
               ${input.olderThanDays ? sql`count(*) FILTER (WHERE ${date} < now() - make_interval(days => ${input.olderThanDays}))::text` : sql`NULL`} AS older
          FROM ${table} WHERE ${org} = ${input.organizationId}`.execute(db);
      const row = r.rows[0];
      rows.push({ key: c.key, label: c.label, group: c.group, total: Number(row?.total ?? 0), oldestAt: row?.oldest ? new Date(row.oldest).toISOString() : null, olderThanSimulated: row?.older === null || row?.older === undefined ? null : Number(row.older), note: c.note });
    }
    const output: OutputType = { rows, retentionDefined: false, deletionEnabled: false, olderThanDays: input.olderThanDays ?? null, decisionsPending: [...RETENTION_DECISIONS_PENDING] };
    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao simular retenção:", error);
    return buildErrorResponse(error, "Não foi possível carregar a classificação de retenção");
  }
}
