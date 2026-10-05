import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";

export const schema = z.object({ accessCode: z.string().trim().min(1, "Informe o código de acesso").max(64, "Código de acesso inválido") }).strict();

export type OutputType = { valid: true };

/** Valida sem consumir. 400 `codigo_indisponivel` para qualquer código inutilizável (mensagem única). */
export const postAccessCodeCheck = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "access-code-check", schema.parse(body));
