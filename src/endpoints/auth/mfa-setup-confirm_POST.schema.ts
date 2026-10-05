import { z } from "zod";
import type { User } from "../../helpers/User.js";
import { authRequest } from "../../helpers/authClient.js";

export const schema = z.object({ code: z.string().trim().min(1).max(16) }).strict();

/** `recoveryCodes`: exibidos UMA vez (o backend nunca os devolve de novo). `user` só vem quando a confirmação cria a sessão. */
export type OutputType = { recoveryCodes: string[]; user?: User };

export const postMfaSetupConfirm = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "mfa-setup-confirm", schema.parse(body));
