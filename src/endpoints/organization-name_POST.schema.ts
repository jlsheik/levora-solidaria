import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";

/** Limite do nome cadastral (o cadastro inicial só exige o mínimo; este é o teto desta edição). */
export const ORGANIZATION_NAME_MIN = 2;
export const ORGANIZATION_NAME_MAX = 120;

// caracteres de controle (C0 e DEL) nunca fazem parte de um nome
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]");

/**
 * Edição do NOME da organização (primeira entrega de edição de dados). SOMENTE `organizations.name`: slug, tipo, status, cidade, estado,
 * documento, proprietário e membros não são aceitos (corpo estrito: campo desconhecido ⇒ 400). Convenção de texto do sistema: espaços
 * externos removidos; vazio ou só espaços é recusado.
 */
export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    name: z
      .string({ required_error: "Informe o nome da organização", invalid_type_error: "Informe o nome da organização" })
      .transform((v) => v.trim())
      .pipe(
        z
          .string()
          .min(ORGANIZATION_NAME_MIN, "Informe o nome da organização (mínimo de 2 caracteres)")
          .max(ORGANIZATION_NAME_MAX, `O nome pode ter no máximo ${ORGANIZATION_NAME_MAX} caracteres`)
          .refine((v) => !CONTROL_CHARS.test(v), "O nome não pode conter caracteres de controle")
      ),
  })
  .strict();

export type OutputType = {
  /** `false` quando o nome informado já era o atual (nada foi alterado nem auditado). */
  changed: boolean;
  organization: { id: number; name: string; slug: string; type: string; status: string; city: string; state: string };
};

export const postOrganizationName = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organization-name`, {
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
    throw new ApiRequestError(message || "Não foi possível alterar o nome da organização", result.status);
  }

  return superjson.parse<OutputType>(await result.text());
};
