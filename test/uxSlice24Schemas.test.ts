/**
 * Slice de UX (Ciclo 24) — os três z.enum com mensagem pt-BR, exercitados DIRETAMENTE nos schemas reais (src/helpers/*FormSchemas)
 * (os selects da interface sempre têm valor válido, então estas mensagens não são alcançáveis por cliques):
 * valor inválido ou ausente → mensagem em português, sem texto padrão do zod; valores válidos continuam aceitos.
 */
import { describe, it, expect } from "vitest";
import { newSourceSchema, newDiscoverySchema } from "../src/helpers/platformFormSchemas";
import { movementSchema } from "../src/helpers/inventoryFormSchemas";
import { SourceTypeArrayValues, OpportunityUrgencyArrayValues } from "../src/helpers/schema";

const messagesAt = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, field: string) =>
  (r.error?.issues ?? []).filter((i) => i.path[0] === field).map((i) => i.message);

describe("tipo da fonte (newSourceSchema)", () => {
  const base = { name: "Fonte QA", connectorKey: "manual" };
  it.each([undefined, "inexistente", ""])("valor %j → 'Selecione o tipo da fonte' (sem texto do zod)", (type) => {
    const r = newSourceSchema.safeParse({ ...base, type });
    expect(r.success).toBe(false);
    expect(messagesAt(r, "type")).toEqual(["Selecione o tipo da fonte"]);
  });
  it.each(SourceTypeArrayValues)("valor válido %s continua aceito, inalterado", (type) => {
    const r = newSourceSchema.safeParse({ ...base, type });
    expect(r.success).toBe(true);
    expect(r.data?.type).toBe(type);
  });
});

describe("urgência (newDiscoverySchema)", () => {
  const base = { sourceId: 1, title: "Doação QA" };
  it.each(["urgentissima", ""])("valor inválido %j → 'Selecione a urgência'", (urgency) => {
    const r = newDiscoverySchema.safeParse({ ...base, urgency });
    expect(r.success).toBe(false);
    expect(messagesAt(r, "urgency")).toEqual(["Selecione a urgência"]);
  });
  it("ausente → padrão 'media' (comportamento preservado)", () => {
    const r = newDiscoverySchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data?.urgency).toBe("media");
  });
  it.each(OpportunityUrgencyArrayValues)("valor válido %s continua aceito, inalterado", (urgency) => {
    const r = newDiscoverySchema.safeParse({ ...base, urgency });
    expect(r.success).toBe(true);
    expect(r.data?.urgency).toBe(urgency);
  });
});

describe("tipo de movimentação (movementSchema)", () => {
  const base = { quantity: 5, reason: "Ajuste QA" };
  it.each([undefined, "saida", ""])("valor %j → 'Selecione o tipo de movimentação'", (type) => {
    const r = movementSchema.safeParse({ ...base, type });
    expect(r.success).toBe(false);
    expect(messagesAt(r, "type")).toEqual(["Selecione o tipo de movimentação"]);
  });
  it.each(["entrada", "ajuste"])("valor válido %s continua aceito, inalterado", (type) => {
    const r = movementSchema.safeParse({ ...base, type });
    expect(r.success).toBe(true);
    expect(r.data?.type).toBe(type);
  });
});
