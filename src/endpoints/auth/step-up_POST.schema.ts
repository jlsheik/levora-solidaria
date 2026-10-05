import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";

export const schema = z
  .object({ code: z.string().trim().min(1).max(16).optional(), recoveryCode: z.string().trim().min(1).max(40).optional() })
  .strict()
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), { message: "Informe o código do autenticador ou um código de recuperação" });

export const postStepUp = (body: z.input<typeof schema>) => authRequest<{ message: string }>("POST", "step-up", schema.parse(body));
