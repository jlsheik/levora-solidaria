import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";

export const schema = z.object({ token: z.string().trim().min(8).max(200) }).strict();

export type OutputType = { purpose: "owner" | "owner_recovery"; email: string; expiresInSeconds: number };

/** O token vai no CORPO (nunca na URL: URL aparece em logs de acesso e no histórico do navegador). */
export const postBootstrapActivate = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "bootstrap-activate", schema.parse(body));
