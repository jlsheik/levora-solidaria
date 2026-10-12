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

/** Quantidade POSITIVA (recebida, necessária, alocada, ofertada…). */
export const positiveQuantity = (message: string) =>
  z.coerce
    .number({ invalid_type_error: message })
    .positive(message)
    .max(QUANTITY_MAX, "Quantidade acima do máximo permitido")
    .refine(hasAtMostThreeDecimals, "No máximo 3 casas decimais");

/** Quantidade COM SINAL e diferente de zero (lançamento de estoque; o tipo define o sinal final). */
export const nonZeroQuantity = (message: string) =>
  z.coerce
    .number({ invalid_type_error: message })
    .refine((v) => v !== 0, message)
    .refine((v) => Math.abs(v) <= QUANTITY_MAX, "Quantidade acima do máximo permitido")
    .refine(hasAtMostThreeDecimals, "No máximo 3 casas decimais");
