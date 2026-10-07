import { handleOauthStart } from "../../helpers/oauthStart.js";
import { microsoftAdapter } from "../../helpers/oauthProviders.js";
import { schema } from "./microsoft-start_POST.schema.js";

/** Início do fluxo Microsoft (Fase 93): ver helpers/oauthStart.tsx e helpers/microsoftOidc.tsx. */
export async function handle(request: Request) {
  return handleOauthStart(request, microsoftAdapter, schema);
}
