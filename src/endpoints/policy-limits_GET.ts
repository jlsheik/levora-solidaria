import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { POLICY_LIMIT_DEFS, POLICY_LIMIT_KEYS, getEffectivePolicyLimits, getGlobalPolicyLimits } from "../helpers/policyLimits.js";
import { schema, type OutputType } from "./policy-limits_GET.schema.js";
import superjson from "superjson";

/** M33 — limites de autonomia vistos por uma organização (somente leitura; `automacao.leia`): padrão, global, restrição própria e efetivo (o mais restritivo). */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });
    await requirePermissionToRead(user.id, input.organizationId, "automacao.leia");

    const [global, effective, own] = await Promise.all([
      getGlobalPolicyLimits(db),
      getEffectivePolicyLimits(db, input.organizationId),
      db.selectFrom("policyLimits").select(["key", "value"]).where("organizationId", "=", input.organizationId).execute(),
    ]);
    const ownByKey = new Map(own.map((r) => [r.key, (r.value as { v?: number | string[] } | null)?.v]));

    const hist = await db
      .selectFrom("auditLog as a")
      .leftJoin("users as u", "u.id", "a.actorUserId")
      .select(["a.entityId", "a.createdAt", "a.organizationId", "u.displayName"])
      .where("a.action", "=", "politica.limite_alterado")
      .where((eb) => eb.or([eb("a.organizationId", "=", input.organizationId), eb("a.organizationId", "is", null)]))
      .orderBy("a.id", "desc")
      .limit(20)
      .execute();
    const history = hist.map((h) => {
      return { key: h.entityId ?? "", scope: (h.organizationId === null ? "global" : "organizacao") as "global" | "organizacao", byName: h.organizationId === null ? null : h.displayName, at: h.createdAt.toISOString() };
    });

    const copy = (v: number | string[]) => (Array.isArray(v) ? [...v] : v);
    const output: OutputType = {
      limits: POLICY_LIMIT_KEYS.map((key) => ({
        key,
        kind: POLICY_LIMIT_DEFS[key].kind,
        defaultValue: copy(POLICY_LIMIT_DEFS[key].default),
        globalValue: copy(global[key]),
        organizationValue: ownByKey.get(key) === undefined ? null : copy(ownByKey.get(key) as number | string[]),
        effectiveValue: copy(effective[key]),
      })),
      history,
    };
    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao ler limites de política:", error);
    return buildErrorResponse(error, "Não foi possível carregar os limites de política");
  }
}
