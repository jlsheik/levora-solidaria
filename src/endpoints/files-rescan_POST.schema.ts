import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({ organizationId: z.coerce.number().int().positive(), fileId: z.coerce.number().int().positive() }).strict();
export type OutputType = { file: { id: number; scanStatus: string; scanMessage: string; released: boolean } };

export const postFilesRescan = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/files-rescan`, { method: "POST", body: superjson.stringify(validated), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const e = superjson.parse<{ message: string }>(await result.text());
    throw new Error(e.message || "Não foi possível reanalisar o arquivo");
  }
  return superjson.parse<OutputType>(await result.text());
};
