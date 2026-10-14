/**
 * Fase 99B — contrato do vocabulário de unidades (puro, sem banco).
 * Classificar NÃO é converter nem corrigir: nenhum teste aqui espera mudança de valor ou de quantidade.
 */
import { describe, it, expect } from "vitest";
import {
  AMBIGUOUS_UNIT_VALUES,
  UNIT_VOCABULARY,
  classifyUnit,
  getCanonicalUnit,
  needsClassificationReview,
  unitKey,
} from "../src/helpers/unitVocabulary";

describe("unitVocabulary — classificação", () => {
  it("1: unidade canônica é classificada como canônica", () => {
    const c = classifyUnit("kg");
    expect(c.kind).toBe("canonica");
    expect(c.canonicalId).toBe("quilograma");
    expect(c.canonicalLabel).toBe("kg");
    expect(c.dimension).toBe("massa");
  });

  it("2: alias comprovado (plural da mesma palavra) aponta para a mesma unidade", () => {
    const plural = classifyUnit("unidades");
    const singular = classifyUnit("unidade");
    expect(plural.kind).toBe("alias");
    expect(singular.kind).toBe("canonica");
    expect(plural.canonicalId).toBe(singular.canonicalId);
    expect(classifyUnit("litros").canonicalId).toBe(classifyUnit("litro").canonicalId);
    expect(classifyUnit("caixas").canonicalId).toBe(classifyUnit("caixa").canonicalId);
  });

  it("3: variação só de caixa e espaços é classificada como o valor canônico", () => {
    for (const v of ["KG", " KG ", "Kg", "kg\t", "  kg"]) {
      const c = classifyUnit(v);
      expect(c.kind, v).toBe("canonica");
      expect(c.canonicalId, v).toBe("quilograma");
    }
    expect(classifyUnit("  UNIDADES ").canonicalId).toBe("unidade");
    expect(unitKey("  Litros   ")).toBe("litros");
    expect(unitKey("a   b")).toBe("a b");
  });

  it("4: valor desconhecido é preservado como desconhecido, sem canônico presumido", () => {
    for (const v of ["x", "peça", "pacote", "saco de 20kg", "L"]) {
      const c = classifyUnit(v);
      expect(c.kind, v).toBe("desconhecida");
      expect(c.canonicalId, v).toBeNull();
      expect(c.canonicalLabel, v).toBeNull();
      expect(c.raw, v).toBe(v);
    }
  });

  it("5: valor ambíguo não é classificado automaticamente (candidatos só informativos)", () => {
    const un = classifyUnit("un");
    expect(un.kind).toBe("ambigua");
    expect(un.canonicalId).toBeNull();
    expect(un.candidates).toEqual(["unidade"]);
    for (const v of ["galão", "galões", "GALÕES"]) {
      const g = classifyUnit(v);
      expect(g.kind, v).toBe("ambigua");
      expect(g.canonicalId, v).toBeNull();
    }
    expect(needsClassificationReview("ambigua")).toBe(true);
    expect(needsClassificationReview("desconhecida")).toBe(true);
    expect(needsClassificationReview("canonica")).toBe(false);
  });

  it("6: embalagem não é confundida com unidade de conteúdo", () => {
    const caixa = classifyUnit("caixa");
    expect(caixa.dimension).toBe("embalagem");
    expect(caixa.canonicalId).not.toBe(classifyUnit("unidade").canonicalId);
    expect(classifyUnit("caixas").canonicalId).toBe("caixa");
    // Nenhum alias de embalagem aponta para contagem ou massa, e vice-versa.
    const packaging = UNIT_VOCABULARY.filter((u) => u.dimension === "embalagem");
    for (const u of packaging) {
      for (const other of UNIT_VOCABULARY.filter((o) => o.dimension !== "embalagem")) {
        expect(other.aliases).not.toContain(u.id);
        for (const a of u.aliases) expect(other.aliases).not.toContain(a);
      }
    }
  });

  it("7: unidades distintas não são tratadas como aliases", () => {
    const ids = ["kg", "ml", "litro", "unidade", "caixa"].map((v) => classifyUnit(v).canonicalId);
    expect(new Set(ids).size).toBe(5);
    expect(classifyUnit("ml").canonicalId).not.toBe(classifyUnit("litro").canonicalId);
    expect(classifyUnit("g").kind).toBe("desconhecida");
    expect(classifyUnit("quilo").kind).toBe("desconhecida");
    expect(classifyUnit("mililitro").kind).toBe("desconhecida");
    // Nenhum alias aparece em duas unidades e nenhum valor ambíguo é também alias.
    const all = UNIT_VOCABULARY.flatMap((u) => [...u.aliases]);
    expect(new Set(all).size).toBe(all.length);
    for (const a of AMBIGUOUS_UNIT_VALUES) expect(all).not.toContain(a.key);
  });

  it("8: unidade nula, vazia ou só de espaços tem classificação explícita 'ausente'", () => {
    for (const v of [null, undefined, "", "   ", "\t\n"]) {
      const c = classifyUnit(v);
      expect(c.kind).toBe("ausente");
      expect(c.canonicalId).toBeNull();
    }
    expect(classifyUnit(null).raw).toBeNull();
  });

  it("9: classificar não altera o valor histórico (o bruto volta idêntico e o objeto de entrada não muda)", () => {
    const stored = { unit: " KG " };
    const before = JSON.stringify(stored);
    const c = classifyUnit(stored.unit);
    expect(c.raw).toBe(" KG ");
    expect(JSON.stringify(stored)).toBe(before);
    expect(c.canonicalLabel).toBe("kg");
  });

  it("10: o mesmo texto em campos de semântica diferente não é convertido — a classificação não depende do campo", () => {
    // A função só recebe o texto: nenhuma informação de campo/entidade pode alterar a classe, e nada converte quantidade.
    expect(classifyUnit("caixa")).toEqual(classifyUnit("caixa"));
    expect(Object.keys(classifyUnit("kg")).sort()).toEqual(["candidates", "canonicalId", "canonicalLabel", "dimension", "explanation", "kind", "raw"]);
  });

  it("11: o vocabulário não contém fator de conversão nem relação entre unidades", () => {
    for (const u of UNIT_VOCABULARY) {
      expect(Object.keys(u).sort()).toEqual(["aliases", "description", "dimension", "equivalence", "id", "label"]);
      expect(JSON.stringify(u)).not.toMatch(/factor|fator_|conversion|conversao_/i);
    }
    expect(getCanonicalUnit("quilograma")?.label).toBe("kg");
    expect(getCanonicalUnit("inexistente")).toBeUndefined();
  });

  it("12: classificação determinística e sem exceção para qualquer entrada suportada", () => {
    const inputs = ["kg", "KG", " ", "", "x", "un", "galões", "çãõ", "😀", "a".repeat(5000), "\u0000", null, undefined, "Caixas", "ml", "L"];
    for (const v of inputs) {
      const a = classifyUnit(v);
      const b = classifyUnit(v);
      expect(a).toEqual(b);
      expect(["canonica", "alias", "ambigua", "desconhecida", "ausente"]).toContain(a.kind);
      // Só canônica/alias têm unidade canônica.
      expect(a.canonicalId !== null).toBe(a.kind === "canonica" || a.kind === "alias");
    }
  });

  it("não remove acento nem aproxima grafias (diferente do normalize() do matching)", () => {
    expect(classifyUnit("peça").kind).toBe("desconhecida");
    expect(classifyUnit("peca").kind).toBe("desconhecida");
    expect(unitKey("Galão")).not.toBe(unitKey("galao"));
  });
});
