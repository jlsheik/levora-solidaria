import { handleOauthStart } from "../../helpers/oauthStart.js";
import { googleAdapter } from "../../helpers/oauthProviders.js";
import { schema } from "./google-start_POST.schema.js";

/** Início do fluxo Google (Fase 92). Toda a lógica é do fluxo OAuth compartilhado (Fase 93): ver helpers/oauthStart.tsx. */
export async function handle(request: Request) {
  return handleOauthStart(request, googleAdapter, schema);
}
