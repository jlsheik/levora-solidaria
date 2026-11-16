import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching.js";
import { schema } from "./opportunity-registry-match_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const result = await runMatchingForOpportunity(input.opportunityId, user.id, "manual");

    return new Response(superjson.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao rodar matching:", error);
    return buildErrorResponse(error, "Não foi possível rodar o matching");
  }
}
