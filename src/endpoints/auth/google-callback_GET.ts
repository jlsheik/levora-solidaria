import { handleOauthCallback } from "../../helpers/oauthCallback.js";
import { googleAdapter } from "../../helpers/oauthProviders.js";

/** Callback do Authorization Code Flow do Google (Fase 92). Toda a lógica é do fluxo OAuth compartilhado (Fase 93): ver helpers/oauthCallback.tsx. */
export async function handle(request: Request) {
  return handleOauthCallback(request, googleAdapter);
}
