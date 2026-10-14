import { z } from "zod";
import { canonicalizeUnitForWrite } from "./unitVocabulary.js";

/**
 * Campo de unidade para NOVAS gravações (Fase 99C). Aceita só unidade canônica ou alias comprovado e grava o rótulo canônico ("unidades" -> "unidade"). Desconhecida,
 * ambígua ou ausente é recusada com uma mensagem que diz qual campo precisa de revisão. A versão opcional aceita vazio/ausente e NÃO inventa unidade.
 */
function checked(fieldLabel: string, allowEmpty: boolean) {
  return z.string().max(50, `A ${fieldLabel} é longa demais`).transform((value, ctx): string => {
    if (allowEmpty && value.trim() === "") return "";
    const r = canonicalizeUnitForWrite(value, fieldLabel);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.message });
      return z.NEVER;
    }
    return r.label;
  });
}

export function requiredUnitInput(fieldLabel = "unidade") {
  return checked(fieldLabel, false);
}

export function optionalUnitInput(fieldLabel = "unidade") {
  return checked(fieldLabel, true).optional();
}
