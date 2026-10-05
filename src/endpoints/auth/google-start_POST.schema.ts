import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";

/**
 * Início do fluxo Google. `login` NUNCA cria conta. `signup` exige o código de acesso (enviado só no CORPO deste POST: nunca na URL,
 * nunca ao Google — o servidor guarda apenas o id do código na tentativa OAuth).
 */
export const schema = z
  .object({
    intent: z.enum(["login", "signup", "reauth"]),
    accessCode: z.string().trim().min(1, "Informe o código de acesso").max(64, "Código de acesso inválido").optional(),
  })
  .strict()
  .refine((v) => (v.intent === "signup") === (v.accessCode !== undefined), { message: "Combinação inválida de intenção e código de acesso" });

export type OutputType = { authorizationUrl: string };

/** `reauth`: confirma de novo a identidade Google do usuário JÁ autenticado (ação crítica de conta sem senha). Exige sessão; não carrega código. */
export const postGoogleStart = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "google-start", schema.parse(body));
