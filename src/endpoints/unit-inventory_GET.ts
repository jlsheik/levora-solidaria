import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { schema, type OutputType } from "./unit-inventory_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { filterUnitInventory, loadUnitInventory, summarizeUnitInventory, UNIT_SOURCES } from "../helpers/unitInventory.js";

/**
 * Fase 99B — diagnóstico SOMENTE LEITURA dos valores de unidade da organização.
 *
 * Autorização: `organizacao.gerencie` (proprietário e administrador) — permissão existente, sem
 * novo privilégio. Escopo: SEMPRE a organização informada (não há visão global nesta fase). Não
 * grava nada, não converte nem corrige valores; só agrega (GROUP BY) e classifica.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      source: url.searchParams.get("source") ?? undefined,
      classification: url.searchParams.get("classification") ?? undefined,
      value: url.searchParams.get("value") ?? undefined,
    });

    await requirePermissionToRead(user.id, input.organizationId, "organizacao.gerencie");

    const inventory = await loadUnitInventory(input.organizationId);
    const filtered = filterUnitInventory(inventory.rows, { source: input.source, classification: input.classification, value: input.value });

    const output: OutputType = {
      rows: filtered.map((r) => ({
        source: r.source as OutputType["rows"][number]["source"],
        sourceLabel: r.sourceLabel,
        rawValue: r.raw,
        occurrences: r.occurrences,
        classification: r.kind,
        canonicalId: r.canonicalId,
        canonicalLabel: r.canonicalLabel,
        dimension: r.dimension,
        explanation: r.explanation,
        candidates: [...r.candidates],
      })),
      summary: summarizeUnitInventory(inventory.rows),
      sources: UNIT_SOURCES.map((s) => {
        const own = inventory.rows.filter((r) => r.source === s.id);
        return {
          id: s.id as OutputType["sources"][number]["id"],
          label: s.label,
          meaning: s.meaning,
          distinctValues: own.length,
          occurrences: own.reduce((acc, r) => acc + r.occurrences, 0),
        };
      }),
      truncated: inventory.truncated,
    };

    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao montar o inventário de unidades:", error);
    return buildErrorResponse(error, "Falha ao carregar o inventário de unidades");
  }
}
