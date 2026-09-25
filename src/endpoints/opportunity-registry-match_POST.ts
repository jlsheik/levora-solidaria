import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching";
import { schema } from "./opportunity-registry-match_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const result = await runMatchingForOpportunity(input.opportunityId, user.id);

    return new Response(superjson.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao rodar matching:", error);
    return buildErrorResponse(error, "Não foi possível rodar o matching");
  }
}
