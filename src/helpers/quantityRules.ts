import { z } from "zod";

/**
 * Regras ÚNICAS de quantidade nas entradas do núcleo (estoque, recebimento, necessidade, atribuição, oportunidade).
 * Todas as colunas de quantidade são NUMERIC(12,3): máximo 999.999.999,999 e no máximo 3 casas decimais. Sem esta validação,
 * 0,0004 virava 0,000 no banco (violando o CHECK ⇒ HTTP 500) e 0,0006 seria gravado como 0,001 enquanto a resposta/auditoria
 * informariam outro valor. Aqui o valor inválido vira 400 de validação e NADA é persistido. Arquivo sem dependência de servidor
 * (usado também pelos schemas importados pelo frontend).
 */
export const QUANTITY_MAX = 999999999.999;

const hasAtMostThreeDecimals = (v: number) => Math.round(v * 1000) / 1000 === v;

/**
 * Arredonda para a escala da coluna (3 casas). Soma/subtração de quantidades em `number` acumulam erro binário
 * (0,1 + 0,2 = 0,30000000000000004): toda comparação ou diferença de quantidades passa por aqui.
 */
export const roundQuantity = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Entrada ESTRITA: só número JS ou string decimal (`12.345`). `true`, `null`, lista, objeto, string vazia, hexadecimal e notação
 * científica NÃO viram quantidade (`z.coerce.number()` transformava `true` em 1 e `null`/`""` em 0 sem aviso de tipo).
 */
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;
const strictNumber = (message: string) =>
  z.preprocess(
    (value) => {
      if (typeof value === "number") return value;
      if (typeof value === "string" && DECIMAL_STRING.test(value.trim())) return Number(value.trim());
      return Number.NaN;
    },
    z.number({ invalid_type_error: message, required_error: message })
  );

/** Quantidade POSITIVA (recebida, necessária, alocada, ofertada…). */
export const positiveQuantity = (message: string) =>
  strictNumber(message)
    .refine((v) => v > 0, message)
    .refine((v) => v <= QUANTITY_MAX, "Quantidade acima do máximo permitido")
    .refine(hasAtMostThreeDecimals, "No máximo 3 casas decimais");

/** Quantidade COM SINAL e diferente de zero (lançamento de estoque; o tipo define o sinal final). */
export const nonZeroQuantity = (message: string) =>
  strictNumber(message)
    .refine((v) => v !== 0, message)
    .refine((v) => Math.abs(v) <= QUANTITY_MAX, "Quantidade acima do máximo permitido")
    .refine(hasAtMostThreeDecimals, "No máximo 3 casas decimais");
