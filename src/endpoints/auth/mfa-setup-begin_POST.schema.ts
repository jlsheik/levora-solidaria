import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";

/** `password`: reautenticação da ativação voluntária (sessão). No contexto de challenge a senha já foi provada no login. */
export const schema = z.object({ password: z.string().min(1).optional() }).strict();

export type OutputType = { otpauthUri: string; manualKey: string };

export const postMfaSetupBegin = (body: z.input<typeof schema> = {}) => authRequest<OutputType>("POST", "mfa-setup-begin", schema.parse(body));
