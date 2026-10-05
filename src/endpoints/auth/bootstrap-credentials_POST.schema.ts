import { z } from "zod";
import { authRequest } from "../../helpers/authClient.js";
import { newPasswordSchema } from "../../helpers/passwordPolicy.js";

export const schema = z
  .object({
    displayName: z.string().trim().min(1, "Informe o nome").max(80).optional(),
    password: newPasswordSchema.optional(),
  })
  .strict();

export const postBootstrapCredentials = (body: z.input<typeof schema>) => authRequest<{ ok: true }>("POST", "bootstrap-credentials", schema.parse(body));
