import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";
import { NeedPriorityArrayValues, type NeedPriority } from "../helpers/schema.js";

/**
 * Limites da EDIÇÃO cadastral. O cadastro (`needs_POST`) só exige título ≥ 3 e não tem máximo para título nem descrição; estes tetos
 * valem só quando o campo é ENVIADO na edição. Dados antigos acima do teto continuam válidos e visíveis em todo o sistema; como cada
 * campo é opcional na edição, uma descrição antiga longa não impede de corrigir só o título (e vice-versa). Nenhum dado é alterado automaticamente.
 */
export const NEED_TITLE_MIN = 3;
export const NEED_TITLE_MAX = 200;
export const NEED_DESCRIPTION_MAX = 2000;

const code = (n: number) => String.fromCharCode(n);
// título: nenhum caractere de controle (nem quebra de linha); descrição: controles só se não forem TAB/LF/CR
const TITLE_CONTROL = new RegExp("[" + code(0) + "-" + code(31) + code(127) + "]");
const DESCRIPTION_CONTROL = new RegExp("[" + code(0) + "-" + code(8) + code(11) + code(12) + code(14) + "-" + code(31) + code(127) + "]");

/**
 * Edição CADASTRAL da necessidade: SOMENTE `title`, `description` e `priority` (cada um opcional, pelo menos um). Corpo ESTRITO: quantidade,
 * unidade, item, organização de destino, status, id, autor e datas — ou qualquer outro campo — ⇒ 400. `description` vazia/só espaços ou `null` limpa o campo.
 */
export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    needId: z.coerce.number().int().positive(),
    title: z
      .string({ invalid_type_error: "Informe um título para a necessidade" })
      .transform((v) => v.trim())
      .pipe(
        z
          .string()
          .min(NEED_TITLE_MIN, "Informe um título para a necessidade (mínimo de 3 caracteres)")
          .max(NEED_TITLE_MAX, `O título pode ter no máximo ${NEED_TITLE_MAX} caracteres`)
          .refine((v) => !TITLE_CONTROL.test(v), "O título não pode conter caracteres de controle")
      )
      .optional(),
    description: z
      .string({ invalid_type_error: "Descrição inválida" })
      .nullable()
      .transform((v) => (v === null ? null : v.trim() === "" ? null : v.trim()))
      .pipe(
        z
          .string()
          .max(NEED_DESCRIPTION_MAX, `A descrição pode ter no máximo ${NEED_DESCRIPTION_MAX} caracteres`)
          .refine((v) => !DESCRIPTION_CONTROL.test(v), "A descrição não pode conter caracteres de controle")
          .nullable()
      )
      .optional(),
    priority: z.enum(NeedPriorityArrayValues, { errorMap: () => ({ message: "Prioridade inválida" }) }).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.description !== undefined || v.priority !== undefined, { message: "Informe ao menos um campo para alterar (título, descrição ou prioridade)" });

export type OutputType = {
  /** `false` quando nada mudou depois da normalização (nenhuma escrita nem auditoria). */
  changed: boolean;
  need: { id: number; title: string; description: string | null; priority: NeedPriority };
};

export const postNeedDetails = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/need-details`, {
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
    throw new ApiRequestError(message || "Não foi possível alterar a necessidade", result.status);
  }

  return superjson.parse<OutputType>(await result.text());
};
