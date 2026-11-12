import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { POLICY_LIMIT_DEFS, POLICY_LIMIT_KEYS, getGlobalPolicyLimits } from "../helpers/policyLimits.js";
import type { OutputType } from "./platform-policy-limits_GET.schema.js";
import superjson from "superjson";

const PENDING_DECISIONS = [
  "Quem pode alterar um limite global (somente o proprietário da plataforma? dupla confirmação?).",
  "Faixa aceitável de cada limite global (hoje os padrões em código são ponto de partida a revisar pelo proprietário).",
  "Se um limite global pode ficar MENOS restritivo que o padrão em código, e com qual justificativa registrada.",
  "Como comunicar às organizações uma mudança global.",
];

/** M34 — limites globais vistos pela equipe da plataforma (SOMENTE LEITURA). A escrita global ainda não tem regra de negócio definida e, por isso, não foi implementada. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const global = await getGlobalPolicyLimits(db);
    const counts = await db.selectFrom("policyLimits").select(["key", (eb) => eb.fn.countAll<string>().as("n")]).where("organizationId", "is not", null).groupBy("key").execute();
    const byKey = new Map(counts.map((c) => [c.key, Number(c.n)]));
    const copy = (v: number | string[]) => (Array.isArray(v) ? [...v] : v);
    const output: OutputType = {
      limits: POLICY_LIMIT_KEYS.map((key) => ({ key, kind: POLICY_LIMIT_DEFS[key].kind, defaultValue: copy(POLICY_LIMIT_DEFS[key].default), globalValue: copy(global[key]), organizationsRestricting: byKey.get(key) ?? 0 })),
      globalWriteEnabled: false,
      pendingDecisions: PENDING_DECISIONS,
    };
    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao ler limites globais:", error);
    return buildErrorResponse(error, "Não foi possível carregar os limites globais");
  }
}
