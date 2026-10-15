/**
 * Fase 99B — vocabulário CENTRALIZADO de unidades (fonte única da classificação).
 *
 * O que isto É: um catálogo em código que diz, para um valor de unidade como está gravado no
 * banco, se ele é uma unidade canônica conhecida, um alias comprovadamente equivalente, um valor
 * ambíguo ou um valor desconhecido.
 *
 * O que isto NÃO é:
 *  - NÃO é conversão. Não existe fator de conversão em lugar nenhum deste arquivo, e "classificar"
 *    nunca altera, corrige ou reinterpreta um valor armazenado (a função só LÊ e devolve o valor
 *    bruto junto da classificação).
 *  - NÃO é `normalize()` de opportunityMatching.tsx (que remove acentos e é usado só na comparação
 *    do matching/ledger, sem significado metrológico). As duas coisas não se misturam: a chave de
 *    classificação abaixo é mais estrita (não remove acento) e a equivalência vem da TABELA, não
 *    de semelhança textual.
 *
 * Regra de equivalência (docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md, seção 10.6): um
 * alias só entra aqui quando representa EXATAMENTE a mesma unidade — diferença de caixa/espaços,
 * singular/plural da mesma palavra. Embalagem (caixa, galão...) nunca vira unidade de conteúdo;
 * quilograma, grama, litro e mililitro são unidades distintas entre si; semelhança textual não
 * prova equivalência. O que não está provado fica `ambigua` (há mais de uma leitura plausível, e
 * a decisão é humana) ou `desconhecida` (nada foi provado) — nunca é mapeado para "a unidade
 * mais provável".
 *
 * Origem dos valores: inventário da Fase 99B (docs/ROADMAP_ATUAL.md e
 * docs/UNIDADES_INVENTARIO_99B.md): só entram valores efetivamente encontrados no código,
 * sementes, fixtures e testes do repositório — nenhum banco real de produção foi consultado.
 *
 * As fases seguintes (99C em diante) devem validar recebimentos e destinações usando ESTE módulo,
 * sem duplicar listas de aliases em telas ou endpoints.
 */

export type UnitDimension = "contagem" | "massa" | "volume" | "embalagem";

export interface CanonicalUnit {
  /** Identificador estável (nunca muda; é o que as fases futuras vão referenciar). */
  readonly id: string;
  /** Rótulo de exibição, separado do identificador. */
  readonly label: string;
  readonly description: string;
  readonly dimension: UnitDimension;
  /** Grafias comprovadas como a MESMA unidade (já na forma da chave: minúsculas, espaços colapsados). Inclui a própria forma canônica. */
  readonly aliases: readonly string[];
  /** Por que as grafias acima são equivalentes (critério documentado, não heurística). */
  readonly equivalence: string;
}

export interface AmbiguousUnitValue {
  /** Chave (minúsculas, espaços colapsados) do valor ambíguo. */
  readonly key: string;
  /** Por que NÃO é classificado automaticamente. */
  readonly reason: string;
  /** Leituras plausíveis (ids canônicos ou descrições), só para o revisor humano — nunca aplicadas. */
  readonly candidates: readonly string[];
}

export const UNIT_VOCABULARY: readonly CanonicalUnit[] = [
  {
    id: "quilograma",
    label: "kg",
    description: "Quilograma (massa).",
    dimension: "massa",
    aliases: ["kg"],
    equivalence: "Símbolo kg; diferenças de caixa e espaços ('KG', ' KG ') não mudam a unidade.",
  },
  {
    id: "unidade",
    label: "unidade",
    description: "Contagem de itens individuais.",
    dimension: "contagem",
    aliases: ["unidade", "unidades"],
    equivalence: "Singular e plural da mesma palavra.",
  },
  {
    id: "litro",
    label: "litro",
    description: "Litro (volume).",
    dimension: "volume",
    aliases: ["litro", "litros"],
    equivalence: "Singular e plural da mesma palavra. Mililitro é outra unidade (não é alias).",
  },
  {
    id: "mililitro",
    label: "ml",
    description: "Mililitro (volume).",
    dimension: "volume",
    aliases: ["ml"],
    equivalence: "Símbolo ml. Não é equivalente a litro: converter exigiria um fator metrológico, fora do escopo.",
  },
  {
    id: "caixa",
    label: "caixa",
    description: "Embalagem do tipo caixa. É uma embalagem, não uma quantidade de conteúdo.",
    dimension: "embalagem",
    aliases: ["caixa", "caixas"],
    equivalence: "Singular e plural da mesma palavra. Uma caixa NÃO equivale a unidades de conteúdo sem quantidade por embalagem validada.",
  },
];

export const AMBIGUOUS_UNIT_VALUES: readonly AmbiguousUnitValue[] = [
  {
    key: "un",
    reason: "Abreviação usada em dados de demonstração; pode significar 'unidade', mas a equivalência não foi revisada e aprovada.",
    candidates: ["unidade"],
  },
  {
    key: "galão",
    reason: "Pode ser um recipiente (embalagem) ou uma medida de volume; as duas leituras são incompatíveis entre si.",
    candidates: ["embalagem", "volume"],
  },
  {
    key: "galões",
    reason: "Plural de 'galão', que pode ser recipiente (embalagem) ou medida de volume.",
    candidates: ["embalagem", "volume"],
  },
];

export type UnitClassificationKind =
  /** O valor é a própria forma canônica (a menos de caixa e espaços). */
  | "canonica"
  /** O valor é outro nome comprovado da mesma unidade canônica. */
  | "alias"
  /** Há mais de uma leitura plausível; não é classificado automaticamente. */
  | "ambigua"
  /** Nada comprova o significado. Continua sendo um valor histórico real. */
  | "desconhecida"
  /** Null, vazio ou só espaços: informação ausente. */
  | "ausente";

export const UNIT_CLASSIFICATION_KINDS: readonly UnitClassificationKind[] = ["canonica", "alias", "ambigua", "desconhecida", "ausente"];

export interface UnitClassification {
  /** O valor EXATAMENTE como está armazenado (nunca modificado). */
  readonly raw: string | null;
  readonly kind: UnitClassificationKind;
  /** Presente SOMENTE quando a equivalência está explicitamente comprovada (canonica/alias). */
  readonly canonicalId: string | null;
  readonly canonicalLabel: string | null;
  readonly dimension: UnitDimension | null;
  /** Explicação em português para a tela (por que está nesta classe). */
  readonly explanation: string;
  /** Só para `ambigua`: leituras plausíveis para o revisor (nunca aplicadas). */
  readonly candidates: readonly string[];
}

/**
 * Chave de classificação: apenas normalização SINTÁTICA (espaços nas pontas e repetidos, caixa).
 * Não remove acento nem aproxima grafias: "peça" e "peca" continuam valores diferentes.
 */
export function unitKey(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

const CANONICAL_BY_ID = new Map<string, CanonicalUnit>(UNIT_VOCABULARY.map((u) => [u.id, u]));
const ALIAS_INDEX = new Map<string, CanonicalUnit>();
for (const unit of UNIT_VOCABULARY) {
  for (const alias of unit.aliases) {
    if (alias !== unitKey(alias)) throw new Error(`unitVocabulary: alias "${alias}" não está na forma de chave`);
    if (ALIAS_INDEX.has(alias)) throw new Error(`unitVocabulary: alias "${alias}" aparece em mais de uma unidade`);
    ALIAS_INDEX.set(alias, unit);
  }
}
const AMBIGUOUS_INDEX = new Map<string, AmbiguousUnitValue>();
for (const entry of AMBIGUOUS_UNIT_VALUES) {
  if (entry.key !== unitKey(entry.key)) throw new Error(`unitVocabulary: valor ambíguo "${entry.key}" não está na forma de chave`);
  if (ALIAS_INDEX.has(entry.key) || AMBIGUOUS_INDEX.has(entry.key)) throw new Error(`unitVocabulary: "${entry.key}" é ao mesmo tempo alias e ambíguo (ou duplicado)`);
  AMBIGUOUS_INDEX.set(entry.key, entry);
}

export function getCanonicalUnit(id: string): CanonicalUnit | undefined {
  return CANONICAL_BY_ID.get(id);
}

/**
 * Classifica um valor de unidade lido do banco. Pura e determinística; nunca lança, nunca
 * modifica o valor, nunca converte quantidades.
 */
export function classifyUnit(raw: string | null | undefined): UnitClassification {
  const value = raw ?? null;
  if (value === null || unitKey(value) === "") {
    return {
      raw: value,
      kind: "ausente",
      canonicalId: null,
      canonicalLabel: null,
      dimension: null,
      explanation: "Unidade não informada. A quantidade não pode ser presumida em nenhuma unidade.",
      candidates: [],
    };
  }
  const key = unitKey(value);
  const unit = ALIAS_INDEX.get(key);
  if (unit) {
    const isCanonicalForm = key === unitKey(unit.label);
    return {
      raw: value,
      kind: isCanonicalForm ? "canonica" : "alias",
      canonicalId: unit.id,
      canonicalLabel: unit.label,
      dimension: unit.dimension,
      explanation: isCanonicalForm
        ? `Unidade canônica "${unit.label}" (${unit.description})`
        : `Outro nome comprovado da unidade canônica "${unit.label}" (${unit.equivalence})`,
      candidates: [],
    };
  }
  const ambiguous = AMBIGUOUS_INDEX.get(key);
  if (ambiguous) {
    return {
      raw: value,
      kind: "ambigua",
      canonicalId: null,
      canonicalLabel: null,
      dimension: null,
      explanation: `${ambiguous.reason} Aguarda revisão humana: não é classificado automaticamente.`,
      candidates: ambiguous.candidates,
    };
  }
  return {
    raw: value,
    kind: "desconhecida",
    canonicalId: null,
    canonicalLabel: null,
    dimension: null,
    explanation: "Valor histórico ainda sem classificação: nada comprova a que unidade corresponde. Permanece como está.",
    candidates: [],
  };
}

/** Rótulos de interface das classes (um só lugar, para telas e testes). */
export const UNIT_CLASSIFICATION_LABELS: Record<UnitClassificationKind, string> = {
  canonica: "Canônica",
  alias: "Alias confirmado",
  ambigua: "Ambígua",
  desconhecida: "Desconhecida",
  ausente: "Não informada",
};

/** Classes que ainda dependem de revisão humana antes da regularização da Fase 99C. */
export function needsClassificationReview(kind: UnitClassificationKind): boolean {
  return kind === "ambigua" || kind === "desconhecida";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 99C — uso do vocabulário nos FLUXOS DE ESCRITA e na comparação de unidades (ainda sem nenhuma conversão).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Unidades aceitas para NOVAS gravações: rótulo (é o texto gravado e exibido) e identificador estável. */
export const UNIT_WRITE_OPTIONS: ReadonlyArray<{ id: string; label: string; dimension: UnitDimension }> = UNIT_VOCABULARY.map((u) => ({ id: u.id, label: u.label, dimension: u.dimension }));

export type UnitWriteCheck =
  | { ok: true; /** texto a gravar: o rótulo canônico (ex.: "unidades" -> "unidade") */ label: string; canonicalId: string; changed: boolean }
  | { ok: false; kind: "ausente" | "ambigua" | "desconhecida"; message: string };

/**
 * Valida uma unidade que será GRAVADA agora (cadastro novo ou alteração da própria unidade). Só aceita unidade canônica ou alias comprovado e devolve o rótulo
 * canônico. Valor desconhecido/ambíguo/ausente NUNCA é aceito nem trocado em silêncio: a mensagem diz qual campo precisa de revisão. Não toca em registros antigos.
 */
export function canonicalizeUnitForWrite(raw: string | null | undefined, fieldLabel = "unidade"): UnitWriteCheck {
  const c = classifyUnit(raw);
  const choices = UNIT_WRITE_OPTIONS.map((o) => o.label).join(", ");
  if (c.kind === "canonica" || c.kind === "alias") return { ok: true, label: c.canonicalLabel!, canonicalId: c.canonicalId!, changed: c.raw !== c.canonicalLabel };
  if (c.kind === "ausente") return { ok: false, kind: "ausente", message: `Informe a ${fieldLabel}. Escolha uma destas: ${choices}.` };
  if (c.kind === "ambigua") return { ok: false, kind: "ambigua", message: `A ${fieldLabel} "${(raw ?? "").trim()}" é ambígua e precisa de revisão antes de ser usada. Escolha uma destas: ${choices}.` };
  return { ok: false, kind: "desconhecida", message: `A ${fieldLabel} "${(raw ?? "").trim()}" não é reconhecida. Escolha uma destas: ${choices}.` };
}

/** Texto antigo usado pelo matching/ledger (aparar + sem acento + minúsculas). Mantido só como comparação de IDENTIDADE de texto entre valores sem classificação. */
function legacyTextKey(text: string): string {
  return text.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Duas unidades representam a MESMA unidade? Sim se as duas são canônica/alias da mesma unidade canônica. Se alguma NÃO está classificada, só vale a identidade de texto
 * (mesmo comportamento de antes da Fase 99C, por isso nenhum fluxo existente muda para valores desconhecidos). Nunca é conversão: "caixa" ≠ "unidade", "kg" ≠ "g".
 */
export function unitsEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const ca = classifyUnit(a);
  const cb = classifyUnit(b);
  if (ca.canonicalId && cb.canonicalId) return ca.canonicalId === cb.canonicalId;
  if (ca.canonicalId || cb.canonicalId) return legacyTextKey(a) === legacyTextKey(b); // um classificado e outro não: só se o texto for o mesmo
  return legacyTextKey(a) === legacyTextKey(b);
}

export type ReceiptUnitCheck =
  | { compatible: true; reason: "mesma_unidade" }
  | { compatible: false; reason: "unidade_ausente" | "unidade_diferente" | "unidade_nao_classificada"; detail: string };

/**
 * Compatibilidade entre a unidade da OFERTA e a unidade canônica do ITEM no recebimento.
 *  - oferta SEM unidade (NULL, vazia ou só espaços): a unidade é DESCONHECIDA, nunca presumida compatível. Vira caso de regularização: a quantidade só entra no estoque depois
 *    de uma conferência física validada na unidade canônica do item (Fase 99C, correção definitiva);
 *  - mesma unidade (canônica/alias ou mesmo texto): segue o fluxo normal;
 *  - qualquer outra coisa: divergência -> caso de regularização. Nunca se tenta converter.
 */
export function checkOfferUnitAgainstItem(offerUnit: string | null | undefined, itemUnit: string): ReceiptUnitCheck {
  const offer = classifyUnit(offerUnit);
  if (offer.kind === "ausente") {
    return { compatible: false, reason: "unidade_ausente", detail: `A oferta não informa unidade: a quantidade não pode ser presumida em "${itemUnit.trim()}". Confira fisicamente a quantidade na unidade do item.` };
  }
  if (unitsEquivalent(offerUnit, itemUnit)) return { compatible: true, reason: "mesma_unidade" };
  const item = classifyUnit(itemUnit);
  if (offer.canonicalId && item.canonicalId) {
    return { compatible: false, reason: "unidade_diferente", detail: `A oferta está em "${offer.canonicalLabel}" e o item em "${item.canonicalLabel}": são unidades diferentes e o sistema não converte.` };
  }
  return { compatible: false, reason: "unidade_nao_classificada", detail: `Não há equivalência comprovada entre a unidade da oferta ("${(offerUnit ?? "").trim()}") e a do item ("${itemUnit.trim()}").` };
}
