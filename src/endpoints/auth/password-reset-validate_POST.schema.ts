import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";

export const schema = z.object({ token: z.string().trim().min(1).max(128) }).strict();

export type OutputType = { state: "valido"; mfaRequired: boolean } | { state: "expirado" | "utilizado" | "invalido" };

/** Estado do link (não consome nada). O token vai no CORPO — nunca na URL. */
export const postPasswordResetValidate = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "password-reset-validate", schema.parse(body));
