import { z } from "zod";

/**
 * Política de senha NOVA (Fase 89; docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §25.16): mínimo de 8 caracteres e
 * teto de 72 BYTES em UTF-8. O bcrypt só considera os primeiros 72 bytes — acima disso trunca em silêncio, o que faria
 * duas senhas diferentes valerem igual. A API REJEITA em vez de truncar. (Alternativa não adotada: prehash versionado.)
 *
 * Só se aplica ao DEFINIR uma senha (cadastro, e futuras troca/definição). O LOGIN não valida o teto: contas antigas
 * com senha longa continuam entrando como antes, e a resposta de login nunca revela a política.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const passwordByteLength = (value: string): number => new TextEncoder().encode(value).length;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .refine((v) => passwordByteLength(v) <= PASSWORD_MAX_BYTES, `A senha pode ter no máximo ${PASSWORD_MAX_BYTES} bytes (acentos e símbolos contam mais de 1)`);
