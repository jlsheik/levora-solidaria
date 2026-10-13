import { z } from "zod";
import type { User } from "../../helpers/User.js";
import { authRequest } from "../../helpers/authClient.js";

/** Exatamente um dos dois: código TOTP de 6 dígitos OU recovery code. */
export const schema = z
  .object({
    code: z.string().trim().min(1).max(16).optional(),
    recoveryCode: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), { message: "Informe o código do autenticador ou um código de recuperação" });

export type OutputType = { user: User };

export const postMfaVerify = (body: z.input<typeof schema>) => authRequest<OutputType>("POST", "mfa-verify", schema.parse(body));
