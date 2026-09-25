import { describe, it, expect } from "vitest";
import { keywordScore, normalize } from "../src/helpers/opportunityMatching";

describe("motor de correspondência — pontuação por palavra-chave (pura, sem banco)", () => {
  it("ignora acentuação e caixa ao normalizar texto", () => {
    expect(normalize("Cobertores e Roupões")).toBe("cobertores e roupoes");
  });

  it("reconhece correspondência quando uma palavra relevante aparece nos dois textos", () => {
    expect(keywordScore("Doação de cobertores de inverno", "Cobertor para família")).toBe(100);
  });

  it("não encontra correspondência entre categorias sem relação nenhuma", () => {
    expect(keywordScore("Computadores usados para doação", "Cesta básica de alimentos")).toBe(0);
  });

  it("ignora palavras curtas (menos de 4 letras) que gerariam falso positivo", () => {
    // "de" e "com" não contam como palavra relevante — só a raiz "roupa" bate.
    expect(keywordScore("Doação de roupas com boa qualidade", "Roupa infantil")).toBe(100);
    expect(keywordScore("Tenho um lote", "Um kit de bebê")).toBe(0);
  });

  it("retorna 0 quando algum dos textos não tem nenhuma palavra relevante", () => {
    expect(keywordScore("", "Cobertor")).toBe(0);
    expect(keywordScore("ab cd", "Cobertor de lã")).toBe(0);
  });
});
