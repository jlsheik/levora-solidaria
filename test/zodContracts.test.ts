/**
 * Contrato das MENSAGENS de validação em pt-BR e do comportamento dos schemas que usavam os parâmetros de erro do zod 3
 * (`required_error`, `invalid_type_error`, `errorMap`) — 9 arquivos — mais as regras de quantidade compartilhadas.
 *
 * Por que existe: o zod 4 IGNORA em silêncio esses parâmetros (a mensagem volta ao texto padrão em inglês) e nenhum outro teste citava essas
 * mensagens. Este arquivo foi escrito ANTES da migração, contra o zod 3, e deve passar igual no zod 4:
 *  1) tabela de mensagens EXATAS (texto pt-BR que o usuário vê);
 *  2) snapshot diferencial por schema (`__zod_contracts__/*.json`): para cada entrada, quais issues ocorrem (caminho + mensagem). Mensagens
 *     PADRÃO do zod são normalizadas para "<padrão do zod>" porque o texto padrão muda entre versões e não é contrato do projeto; o que
 *     é contrato é CAMINHO, QUANTIDADE e as mensagens que o projeto personalizou. Dados sintéticos, sem banco.
 */
import { describe, it, expect } from "vitest";
import { schema as needClosure } from "../src/endpoints/need-closure_POST.schema";
import { schema as needDetails } from "../src/endpoints/need-details_POST.schema";
import { schema as organizationName } from "../src/endpoints/organization-name_POST.schema";
import { schema as organizations } from "../src/endpoints/organizations_POST.schema";
import { schema as sourceName } from "../src/endpoints/source-name_POST.schema";
import { schema as destinationProof } from "../src/endpoints/stock-destination-proof_POST.schema";
import { schema as destinationReversal } from "../src/endpoints/stock-destination-reversal_POST.schema";
import { schema as stockDestinations } from "../src/endpoints/stock-destinations_POST.schema";
import { positiveQuantity, nonZeroQuantity, nonNegativeQuantity } from "../src/helpers/quantityRules";
import { DESTINATION_TYPES } from "../src/helpers/destinationRules";

type AnySchema = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

// texto PADRÃO das duas linhas do zod (3 e 4); mensagens do projeto (pt-BR) nunca começam assim
const ZOD_DEFAULT = /^(Expected |Required$|Invalid\b|String must|Number must|Array must|Unrecognized key|Too (small|big)\b|Input )/;
const norm = (m: string) => (ZOD_DEFAULT.test(m) ? "<padrão do zod>" : m);

function contract(schema: AnySchema, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true as const, data: JSON.parse(JSON.stringify(r.data ?? null)) };
  const issues = r.error!.issues.map((i) => ({ path: i.path.map(String).join("."), message: norm(i.message) }));
  issues.sort((a, b) => (a.path + a.message).localeCompare(b.path + b.message));
  return { ok: false as const, issues };
}

const msgAt = (schema: AnySchema, input: unknown, path: string): string[] => {
  const r = schema.safeParse(input);
  if (r.success) return [];
  return r.error!.issues.filter((i) => i.path.map(String).join(".") === path).map((i) => i.message);
};

const omit = <T extends Record<string, unknown>>(o: T, k: string) => { const c = { ...o }; delete c[k]; return c; };

function variants(base: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [["valido", base]];
  for (const k of Object.keys(base)) {
    out.push([`${k}:ausente`, omit(base, k)]);
    out.push([`${k}:null`, { ...base, [k]: null }]);
    out.push([`${k}:numero`, { ...base, [k]: 123 }]);
    out.push([`${k}:vazio`, { ...base, [k]: "" }]);
    out.push([`${k}:longo`, { ...base, [k]: "x".repeat(2100) }]);
    out.push([`${k}:booleano`, { ...base, [k]: true }]);
  }
  out.push(["chave-extra", { ...base, campoDesconhecido: 1 }]);
  out.push(["corpo-nao-objeto:string", "texto"]);
  out.push(["corpo-nao-objeto:nulo", null]);
  out.push(["corpo-nao-objeto:lista", []]);
  return out;
}

// base válida de stock-destinations: o tipo precisa satisfazer a regra de notas/vínculos
const destType = DESTINATION_TYPES.find((t) => stockDestinations.safeParse({ organizationId: 1, itemId: 1, quantity: "2", destinationType: t, deliveredOn: "2026-10-27", notes: "motivo suficiente para a regra", idempotencyKey: "abcdefgh12" }).success && !stockDestinations.safeParse({ organizationId: 1, itemId: 1, quantity: "2", destinationType: t, deliveredOn: "2026-10-27", idempotencyKey: "abcdefgh12" }).success === false)
  ?? DESTINATION_TYPES.find((t) => stockDestinations.safeParse({ organizationId: 1, itemId: 1, quantity: "2", destinationType: t, deliveredOn: "2026-10-27", notes: "motivo suficiente para a regra", idempotencyKey: "abcdefgh12" }).success)!;

const CASES: Array<[string, AnySchema, Record<string, unknown>]> = [
  ["need-closure-encerrar", needClosure as AnySchema, { action: "encerrar", organizationId: 1, needId: 2, reasonCode: "duplicidade", reasonText: "texto" }],
  ["need-closure-reabrir", needClosure as AnySchema, { action: "reabrir", organizationId: 1, needId: 2, reasonText: "motivo da reabertura" }],
  ["need-details", needDetails as AnySchema, { organizationId: 1, needId: 2, title: "Arroz", description: "Descrição", priority: "alta" }],
  ["organization-name", organizationName as AnySchema, { organizationId: 1, name: "Associação Teste" }],
  ["organizations", organizations as AnySchema, { name: "Associação Teste", type: "igreja", city: "Contagem", state: "mg" }],
  ["source-name", sourceName as AnySchema, { sourceId: 1, name: "Fonte Teste" }],
  ["stock-destination-proof", destinationProof as AnySchema, { organizationId: 1, destinationId: "123", action: "anexar", fileId: 5, reason: "motivo ok", idempotencyKey: "abcdefgh12" }],
  ["stock-destination-reversal", destinationReversal as AnySchema, { organizationId: 1, destinationId: "1", kind: "estorno_documental", quantity: "1.5", reason: "motivo ok", idempotencyKey: "abcdefgh12" }],
  ["stock-destinations", stockDestinations as AnySchema, { organizationId: 1, itemId: 1, quantity: "2", destinationType: destType, deliveredOn: "2026-10-27", notes: "motivo suficiente para a regra", idempotencyKey: "abcdefgh12" }],
];

describe("contrato de mensagens pt-BR (texto exato que o usuário vê)", () => {
  // [rótulo, schema, entrada, caminho, mensagem esperada]
  const MUST: Array<[string, AnySchema, unknown, string, string]> = [
    ["organization-name: nome ausente", organizationName as AnySchema, { organizationId: 1 }, "name", "Informe o nome da organização"],
    ["organization-name: nome com tipo errado", organizationName as AnySchema, { organizationId: 1, name: 123 }, "name", "Informe o nome da organização"],
    ["organization-name: nome nulo", organizationName as AnySchema, { organizationId: 1, name: null }, "name", "Informe o nome da organização"],
    ["organization-name: nome curto", organizationName as AnySchema, { organizationId: 1, name: " a " }, "name", "Informe o nome da organização (mínimo de 2 caracteres)"],
    ["source-name: nome ausente", sourceName as AnySchema, { sourceId: 1 }, "name", "Informe o nome da fonte"],
    ["source-name: nome com tipo errado", sourceName as AnySchema, { sourceId: 1, name: 5 }, "name", "Informe o nome da fonte"],
    ["need-details: título com tipo errado", needDetails as AnySchema, { organizationId: 1, needId: 2, title: 7 }, "title", "Informe um título para a necessidade"],
    ["need-details: descrição com tipo errado", needDetails as AnySchema, { organizationId: 1, needId: 2, description: 7 }, "description", "Descrição inválida"],
    ["need-details: prioridade inválida", needDetails as AnySchema, { organizationId: 1, needId: 2, priority: "urgentissima" }, "priority", "Prioridade inválida"],
    ["need-details: prioridade com tipo errado", needDetails as AnySchema, { organizationId: 1, needId: 2, priority: 3 }, "priority", "Prioridade inválida"],
    ["need-closure: motivo inválido", needClosure as AnySchema, { action: "encerrar", organizationId: 1, needId: 2, reasonCode: "x" }, "reasonCode", "Escolha o motivo do encerramento"],
    ["need-closure: motivo ausente", needClosure as AnySchema, { action: "encerrar", organizationId: 1, needId: 2 }, "reasonCode", "Escolha o motivo do encerramento"],
    ["organizations: tipo inválido", organizations as AnySchema, { name: "Aa", type: "x", city: "Cc", state: "MG" }, "type", "Selecione o tipo de organização"],
    ["organizations: tipo ausente", organizations as AnySchema, { name: "Aa", city: "Cc", state: "MG" }, "type", "Selecione o tipo de organização"],
    ["organizations: nome curto", organizations as AnySchema, { name: "A", type: "igreja", city: "Cc", state: "MG" }, "name", "Informe o nome da organização"],
    ["organizations: cidade curta", organizations as AnySchema, { name: "Aa", type: "igreja", city: "C", state: "MG" }, "city", "Informe a cidade"],
    ["organizations: sigla do estado", organizations as AnySchema, { name: "Aa", type: "igreja", city: "Cc", state: "Minas" }, "state", "Use a sigla do estado, ex: MG"],
    ["proof: ação inválida", destinationProof as AnySchema, { ...CASES[6][2], action: "x" }, "action", "Escolha anexar ou remover"],
    ["proof: ação ausente", destinationProof as AnySchema, omit(CASES[6][2], "action"), "action", "Escolha anexar ou remover"],
    ["proof: destinação inválida", destinationProof as AnySchema, { ...CASES[6][2], destinationId: "abc" }, "destinationId", "Destinação inválida"],
    ["proof: motivo curto", destinationProof as AnySchema, { ...CASES[6][2], reason: "oi" }, "reason", "Explique o motivo (mínimo de 5 caracteres)"],
    ["proof: chave de idempotência", destinationProof as AnySchema, { ...CASES[6][2], idempotencyKey: "curta" }, "idempotencyKey", "Chave de idempotência inválida"],
    ["reversal: tipo inválido", destinationReversal as AnySchema, { ...CASES[7][2], kind: "x" }, "kind", "Escolha o tipo da reversão"],
    ["reversal: tipo ausente", destinationReversal as AnySchema, omit(CASES[7][2], "kind"), "kind", "Escolha o tipo da reversão"],
    ["reversal: quantidade textual", destinationReversal as AnySchema, { ...CASES[7][2], quantity: "abc" }, "quantity", "Informe a quantidade a reverter"],
    ["reversal: quantidade ausente", destinationReversal as AnySchema, omit(CASES[7][2], "quantity"), "quantity", "Informe a quantidade a reverter"],
    ["reversal: quantidade nula", destinationReversal as AnySchema, { ...CASES[7][2], quantity: null }, "quantity", "Informe a quantidade a reverter"],
    ["reversal: quantidade zero", destinationReversal as AnySchema, { ...CASES[7][2], quantity: 0 }, "quantity", "Informe a quantidade a reverter"],
    ["reversal: motivo longo", destinationReversal as AnySchema, { ...CASES[7][2], reason: "x".repeat(501) }, "reason", "No máximo 500 caracteres"],
    ["destinations: finalidade inválida", stockDestinations as AnySchema, { ...CASES[8][2], destinationType: "x" }, "destinationType", "Escolha uma das finalidades da lista"],
    ["destinations: finalidade ausente", stockDestinations as AnySchema, omit(CASES[8][2], "destinationType"), "destinationType", "Escolha uma das finalidades da lista"],
    ["destinations: quantidade textual", stockDestinations as AnySchema, { ...CASES[8][2], quantity: "abc" }, "quantity", "Informe a quantidade física que sairá do estoque"],
    ["destinations: data efetiva", stockDestinations as AnySchema, { ...CASES[8][2], deliveredOn: "27/10/2026" }, "deliveredOn", "Informe a data efetiva no formato AAAA-MM-DD"],
    ["destinations: observações longas", stockDestinations as AnySchema, { ...CASES[8][2], notes: "x".repeat(1001) }, "notes", "No máximo 1000 caracteres"],
  ];
  for (const [label, schema, input, path, expected] of MUST) {
    it(label, () => {
      const messages = msgAt(schema, input, path);
      expect(messages, `nenhuma issue em "${path}"`).not.toHaveLength(0);
      expect(messages).toContain(expected);
      // a mensagem do projeto não pode ser substituída pelo texto padrão em inglês do zod
      for (const m of messages) expect(m, `texto padrão do zod vazou em "${path}"`).not.toMatch(ZOD_DEFAULT);
    });
  }

  it("refinamentos de objeto mantêm o texto (need-details sem nenhum campo; stock-destinations por finalidade)", () => {
    expect(contract(needDetails as AnySchema, { organizationId: 1, needId: 2 })).toEqual({
      ok: false, issues: [{ path: "", message: "Informe ao menos um campo para alterar (título, descrição ou prioridade)" }],
    });
    const attendance = DESTINATION_TYPES.find((t) => !stockDestinations.safeParse({ ...CASES[8][2], destinationType: t, needId: 5 }).success);
    expect(attendance, "deve existir uma finalidade que NÃO aceite vínculo com necessidade").toBeDefined();
    expect(msgAt(stockDestinations as AnySchema, { ...CASES[8][2], destinationType: attendance, needId: 5 }, "needId")).toContain("Só as finalidades de atendimento podem se vincular a uma necessidade");
  });
});

describe("regras de quantidade compartilhadas (quantityRules): mensagem única por tipo de falha", () => {
  const M = "Informe a quantidade X";
  const BAD = [undefined, null, "", "   ", "abc", "0x10", "1e3", true, [], {}, Number.NaN];
  for (const [nome, make] of [["positiveQuantity", positiveQuantity], ["nonZeroQuantity", nonZeroQuantity], ["nonNegativeQuantity", nonNegativeQuantity]] as const) {
    it(`${nome}: entradas que não são quantidade devolvem exatamente a mensagem informada, em UMA issue`, () => {
      for (const v of BAD) {
        const r = make(M).safeParse(v);
        expect(r.success, `${String(v)} não deveria ser aceito`).toBe(false);
        const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
        expect(msgs, `entrada ${JSON.stringify(v)}`).toEqual([M]);
      }
    });
    it(`${nome}: limites e casas decimais mantêm os textos fixos`, () => {
      const msgs = (v: unknown) => { const r = make(M).safeParse(v); return r.success ? [] : r.error.issues.map((i) => i.message); };
      expect(msgs(1e12)).toContain("Quantidade acima do máximo permitido");
      expect(msgs(1.2345)).toContain("No máximo 3 casas decimais");
    });
  }
  it("faixas: positiva rejeita 0/negativo; não-nula rejeita 0; não-negativa aceita 0 e rejeita negativo (mensagem do chamador)", () => {
    expect(positiveQuantity(M).safeParse(0).success).toBe(false);
    expect(positiveQuantity(M).safeParse(-1).success).toBe(false);
    expect(positiveQuantity(M).safeParse("12.345")).toMatchObject({ success: true, data: 12.345 });
    expect(nonZeroQuantity(M).safeParse(0).success).toBe(false);
    expect(nonZeroQuantity(M).safeParse(-3)).toMatchObject({ success: true, data: -3 });
    expect(nonNegativeQuantity(M).safeParse(0)).toMatchObject({ success: true, data: 0 });
    expect(nonNegativeQuantity(M).safeParse(-1).success).toBe(false);
  });
});

describe("snapshot diferencial por schema (caminho + mensagens do projeto; mensagens padrão normalizadas)", () => {
  for (const [name, schema, base] of CASES) {
    it(name, async () => {
      expect(contract(schema, base).ok, "a base do contrato deve ser VÁLIDA").toBe(true);
      const table: Record<string, unknown> = {};
      for (const [vname, input] of variants(base)) table[vname] = contract(schema, input);
      await expect(JSON.stringify(table, null, 2) + "\n").toMatchFileSnapshot(`./__zod_contracts__/${name}.json`);
    });
  }
  it("quantityRules (entradas variadas)", async () => {
    const inputs: unknown[] = [undefined, null, "", "abc", true, [], {}, Number.NaN, 0, -1, "0", "-1", "1e3", "0x10", "12.3456", 1e12, 1.2345, 12.345, "12.345", " 7 "];
    const table: Record<string, unknown> = {};
    for (const [nome, make] of [["positive", positiveQuantity], ["nonZero", nonZeroQuantity], ["nonNegative", nonNegativeQuantity]] as const)
      for (const v of inputs) table[`${nome}:${typeof v === "number" && Number.isNaN(v) ? "NaN" : JSON.stringify(v) ?? "undefined"}`] = contract(make("Informe a quantidade X") as AnySchema, v);
    await expect(JSON.stringify(table, null, 2) + "\n").toMatchFileSnapshot("./__zod_contracts__/quantity-rules.json");
  });
});
