import { handleOauthCallback } from "../../helpers/oauthCallback.js";
import { microsoftAdapter } from "../../helpers/oauthProviders.js";

/** Callback do Authorization Code Flow da Microsoft (Fase 93): ver helpers/oauthCallback.tsx e helpers/microsoftOidc.tsx. */
export async function handle(request: Request) {
  return handleOauthCallback(request, microsoftAdapter);
}
