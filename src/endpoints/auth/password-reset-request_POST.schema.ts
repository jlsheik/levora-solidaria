import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";

export const schema = z.object({ email: z.string().trim().min(1, "Informe seu e-mail").max(254, "E-mail inválido").email("Informe um e-mail válido") }).strict();

/** Resposta ÚNICA (202) para qualquer e-mail válido: exista a conta ou não, seja elegível ou não, o envio funcione ou não. */
export type OutputType = { message: string };

export const postPasswordResetRequest = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "password-reset-request", schema.parse(body));
