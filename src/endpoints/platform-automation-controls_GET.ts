import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { getAutomationState } from "../helpers/automationControls.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import superjson from "superjson";

/** M33 — estado da pausa/emergência GLOBAL (somente a equipe da plataforma; leitura). */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const state = await getAutomationState(db, null);
    return new Response(superjson.stringify({ global: state.global }), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao ler a automação da plataforma:", error);
    return buildErrorResponse(error, "Não foi possível carregar a automação da plataforma");
  }
}
