import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";

/** O cadastro de fonte só exige o mínimo (2) e não tem máximo; o teto desta edição é o mesmo da edição do nome da organização. */
export const SOURCE_NAME_MIN = 2;
export const SOURCE_NAME_MAX = 120;

// caracteres de controle (C0 e DEL) nunca fazem parte de um nome
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]");

/**
 * Edição do NOME da fonte (somente `sources.name`). Corpo ESTRITO: tipo, conector, endereço/método de acesso, credencial, organização
 * autorizadora, permissões, notas de política, status, estado de conexão, frequência/limite de execução e qualquer outro campo ⇒ 400.
 */
export const schema = z
  .object({
    sourceId: z.coerce.number().int().positive(),
    name: z
      .string({ error: "Informe o nome da fonte" })
      .transform((v) => v.trim())
      .pipe(
        z
          .string()
          .min(SOURCE_NAME_MIN, "Informe o nome da fonte (mínimo de 2 caracteres)")
          .max(SOURCE_NAME_MAX, `O nome pode ter no máximo ${SOURCE_NAME_MAX} caracteres`)
          .refine((v) => !CONTROL_CHARS.test(v), "O nome não pode conter caracteres de controle")
      ),
  })
  .strict();

export type OutputType = {
  /** `false` quando o nome informado já era o atual (nada foi escrito nem auditado). */
  changed: boolean;
  source: { id: number; name: string };
};

export const postSourceName = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/source-name`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    let message = "";
    try {
      message = superjson.parse<{ message?: string }>(await result.text()).message ?? "";
    } catch {
      // corpo que não é JSON (ex.: 502 do proxy): o status continua sendo repassado
    }
    throw new ApiRequestError(message || "Não foi possível alterar o nome da fonte", result.status);
  }

  return superjson.parse<OutputType>(await result.text());
};
