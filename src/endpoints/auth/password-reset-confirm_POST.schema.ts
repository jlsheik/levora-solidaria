import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";
import { newPasswordSchema } from "../../helpers/passwordPolicy.js";

export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES, newPasswordSchema } from "../../helpers/passwordPolicy.js";

export const schema = z
  .object({
    token: z.string().trim().min(1).max(128),
    newPassword: newPasswordSchema,
    /** Obrigatório (um dos dois) quando a conta tem segundo fator ativo. */
    totpCode: z.string().trim().min(1).max(16).optional(),
    recoveryCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => !(v.totpCode && v.recoveryCode), { message: "Informe apenas um tipo de código" });

export type OutputType = { message: string };

/** Códigos de erro: `link_expirado`, `link_utilizado`, `link_invalido`, `senha_igual`, `mfa_obrigatorio`, `mfa_invalido`, `mfa_bloqueado` (429). */
export const postPasswordResetConfirm = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "password-reset-confirm", schema.parse(body));
