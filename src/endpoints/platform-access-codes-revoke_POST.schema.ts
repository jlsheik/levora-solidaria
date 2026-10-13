import { z } from "zod";
import { apiRequest } from "../helpers/authClient.js";

export const schema = z.object({ id: z.number().int().positive() }).strict();

export const postPlatformAccessCodesRevoke = (body: z.input<typeof schema>) => apiRequest<{ message: string }>("POST", "platform-access-codes-revoke", schema.parse(body));
