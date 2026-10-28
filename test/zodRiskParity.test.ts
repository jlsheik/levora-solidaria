/**
 * Paridade zod 3 → 4 dos schemas de ENDPOINT classificados como "risco de comportamento" (defaults, coerção, preprocess, superRefine, refine, enums, datas).
 * Os snapshots em `__zod_contracts__/risk-*.json` foram gerados com o zod 3.25.76 (estado do commit de testes, anterior à migração) e devem permanecer
 * IDÊNTICOS no zod 4: para cada entrada, sucesso/falha, DADOS parseados (defaults, coerções, trims) e, nas falhas, caminho + quantidade de issues + mensagens
 * do projeto. Mensagens PADRÃO do zod (inglês) são normalizadas porque o texto delas muda entre versões e não é contrato.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { schema as impactReport } from "../src/endpoints/impact-report_GET.schema";
import { schema as needsPost } from "../src/endpoints/needs_POST.schema";
import { schema as opportunityRegistry } from "../src/endpoints/opportunity-registry_POST.schema";
import { schema as organizationInvites } from "../src/endpoints/organization-invites_POST.schema";
import { schema as platformAccessCodes } from "../src/endpoints/platform-access-codes_GET.schema";
import { schema as destinationCorrection } from "../src/endpoints/stock-destination-correction_POST.schema";
import { schema as destinationsGet } from "../src/endpoints/stock-destinations_GET.schema";
import { schema as regularizationCases } from "../src/endpoints/unit-regularization-cases_GET.schema";
import { schema as regularizationValidate } from "../src/endpoints/unit-regularization-validate_POST.schema";
import { schema as auditLogVerify } from "../src/endpoints/audit-log-verify_GET.schema";
import { schema as bootstrapCredentials } from "../src/endpoints/auth/bootstrap-credentials_POST.schema";
import { schema as mfaSetupBegin } from "../src/endpoints/auth/mfa-setup-begin_POST.schema";
import { schema as backgroundTasks } from "../src/endpoints/background-tasks_GET.schema";
import { schema as backgroundTasksRetry } from "../src/endpoints/background-tasks-retry_POST.schema";
import { schema as matchEvaluations } from "../src/endpoints/match-evaluations_GET.schema";
import { schema as opportunityMatch } from "../src/endpoints/opportunity-registry-match_POST.schema";
import { newPasswordSchema } from "../src/helpers/passwordPolicy";
import { z } from "zod";

// `z.coerce.date()` com texto sem fuso (ex.: "7", "abc") usa o fuso LOCAL do processo: sem fixar o TZ os snapshots mudam entre a máquina de quem gerou e a CI (UTC).
let tzAntes: string | undefined;
beforeAll(() => { tzAntes = process.env.TZ; process.env.TZ = "UTC"; });
afterAll(() => { if (tzAntes === undefined) delete process.env.TZ; else process.env.TZ = tzAntes; });

type AnySchema = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

const ZOD_DEFAULT = /^(Expected |Required$|Invalid\b|String must|Number must|Array must|Unrecognized key|Too (small|big)\b|Input )/;
const norm = (m: string) => (ZOD_DEFAULT.test(m) ? "<padrão do zod>" : m);

function contract(schema: AnySchema, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true as const, data: JSON.parse(JSON.stringify(r.data ?? null)) };
  const issues = r.error!.issues.map((i) => ({ path: i.path.map(String).join("."), message: norm(i.message) }));
  issues.sort((a, b) => (a.path + a.message).localeCompare(b.path + b.message));
  return { ok: false as const, issues };
}

const omit = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };
const PROBES: unknown[] = ["", null, 123, true, "abc", "0", "-1", "1e3", " 7 ", "2026-02-30", "27/10/2026", 1.5, -5, 1e12, {}, "x".repeat(2100)]; // [] fica fora: o zod 4 acumula a issue de tamanho além da de tipo (ver teste dedicado abaixo)

function battery(base: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [["valido", base], ["vazio", {}], ["chave-extra", { ...base, campoDesconhecido: 1 }]];
  for (const k of Object.keys(base)) {
    out.push([`${k}:ausente`, omit(base, k)]);
    PROBES.forEach((p, i) => out.push([`${k}:sonda${i}`, { ...base, [k]: p }]));
  }
  out.push(["corpo:string", "texto"], ["corpo:nulo", null], ["corpo:lista", []]);
  return out;
}

// Entradas de query string chegam como texto; os de corpo, tipadas. As bases abaixo devem ser VÁLIDAS (verificado no primeiro teste).
const CASES: Array<[string, AnySchema, Record<string, unknown>, Array<[string, unknown]>]> = [
  ["impact-report_GET", impactReport as AnySchema, { organizationId: "1", startDate: "2026-10-01", endDate: "2026-10-31", itemId: "3", needId: "4", destinationDateBasis: "efetiva" },
    [["so-obrigatorios", { organizationId: "1", startDate: "2026-10-01", endDate: "2026-10-31" }], ["basis-vazio", { organizationId: "1", startDate: "2026-10-01", endDate: "2026-10-31", destinationDateBasis: "" }], ["basis-nulo", { organizationId: "1", startDate: "2026-10-01", endDate: "2026-10-31", destinationDateBasis: null }], ["eventType-invalido", { organizationId: "1", startDate: "2026-10-01", endDate: "2026-10-31", eventType: "zzz" }], ["destinationType-invalido", { organizationId: "1", startDate: "2026-10-01", endDate: "2026-10-31", destinationType: "zzz" }], ["datas-invalidas", { organizationId: "1", startDate: "nao-e-data", endDate: "2026-10-31" }]]],
  ["needs_POST", needsPost as AnySchema, { organizationId: 1, title: "Arroz 5kg", description: "d", itemId: 2, quantityNeeded: "10", unit: "kg", priority: "alta" },
    [["so-obrigatorios", { organizationId: 1, title: "Arroz 5kg", quantityNeeded: 10, unit: "kg" }], ["prioridade-nula", { organizationId: 1, title: "Arroz 5kg", quantityNeeded: 10, unit: "kg", priority: null }]]],
  ["opportunity-registry_POST", opportunityRegistry as AnySchema, { sourceId: 1, title: "Doação de arroz", quantity: 5, unit: "kg", urgency: "alta", confidence: 50, expiresAt: "2026-12-31" },
    [["so-obrigatorios", { sourceId: 1, title: "Doação de arroz" }], ["urgencia-nula", { sourceId: 1, title: "Doação de arroz", urgency: null }], ["data-invalida", { sourceId: 1, title: "Doação de arroz", expiresAt: "nunca" }]]],
  ["organization-invites_POST", organizationInvites as AnySchema, { organizationId: 1, email: "  Pessoa@Exemplo.com ", role: "operador" }, [["papel-proprietario", { organizationId: 1, email: "a@b.com", role: "proprietario" }]]],
  ["platform-access-codes_GET", platformAccessCodes as AnySchema, { q: " abc ", createdFrom: "2026-10-01", createdTo: "2026-10-31", limit: "20", offset: "5" },
    [["vazio-total", {}], ["limite-zero", { limit: "0" }], ["limite-101", { limit: "101" }], ["offset-negativo", { offset: "-1" }], ["status-invalido", { status: "zzz" }]]],
  ["stock-destination-correction_POST", destinationCorrection as AnySchema, { organizationId: 1, destinationId: "12", deliveredOn: "2026-10-27", peopleServed: 3, peopleUnit: "pessoas", notes: "obs", reason: "motivo ok", idempotencyKey: "abcdefgh12" },
    [["nada-a-corrigir", { organizationId: 1, destinationId: "12", reason: "motivo ok", idempotencyKey: "abcdefgh12" }], ["pessoas-sem-unidade", { organizationId: 1, destinationId: "12", peopleServed: 3, reason: "motivo ok", idempotencyKey: "abcdefgh12" }], ["unidade-sem-pessoas", { organizationId: 1, destinationId: "12", peopleUnit: "familias", notes: "x", reason: "motivo ok", idempotencyKey: "abcdefgh12" }], ["nulos-aceitos", { organizationId: 1, destinationId: "12", deliveredOn: null, peopleServed: null, peopleUnit: null, notes: "obs", reason: "motivo ok", idempotencyKey: "abcdefgh12" }]]],
  ["stock-destinations_GET", destinationsGet as AnySchema, { organizationId: "1", itemId: "2", basis: "efetiva", from: "2026-10-01", to: "2026-10-31", limit: "20" },
    [["so-obrigatorios", { organizationId: "1" }], ["tudo-vazio-exceto-org", { organizationId: "1", itemId: "", needId: "", destinationType: "", state: "", basis: "", from: "", to: "", limit: "", beforeId: "" }], ["tudo-nulo-exceto-org", { organizationId: "1", itemId: null, basis: null, limit: null, from: null }], ["intervalo-invertido", { organizationId: "1", from: "2026-10-31", to: "2026-10-01" }], ["limite-101", { organizationId: "1", limit: "101" }], ["beforeId-invalido", { organizationId: "1", beforeId: "abc" }]]],
  ["unit-regularization-cases_GET", regularizationCases as AnySchema, { organizationId: "1", order: "recentes" }, [["so-org", { organizationId: "1" }], ["status-invalido", { organizationId: "1", status: "zzz" }], ["order-invalido", { organizationId: "1", order: "zzz" }], ["status-nulo", { organizationId: "1", status: null }]]],
  ["unit-regularization-validate_POST", regularizationValidate as AnySchema, { organizationId: 1, caseId: 2, decision: "devolver", note: "  explicação suficiente " },
    [["aprovar-sem-nota", { organizationId: 1, caseId: 2, decision: "aprovar" }], ["aprovar-nota-vazia", { organizationId: 1, caseId: 2, decision: "aprovar", note: "   " }], ["devolver-sem-nota", { organizationId: 1, caseId: 2, decision: "devolver" }], ["devolver-nota-curta", { organizationId: 1, caseId: 2, decision: "devolver", note: "abc" }], ["devolver-nota-so-espacos", { organizationId: 1, caseId: 2, decision: "devolver", note: "      " }], ["nota-501", { organizationId: 1, caseId: 2, decision: "aprovar", note: "x".repeat(501) }]]],
  ["audit-log-verify_GET", auditLogVerify as AnySchema, {}, [["chave-extra-ignorada", { qualquer: 1 }]]],
  ["bootstrap-credentials_POST", bootstrapCredentials as AnySchema, { displayName: "  Pessoa Teste ", password: "SenhaForte123!" }, [["so-nome", { displayName: "x" }], ["senha-curta", { password: "curta" }], ["senha-73-bytes", { password: "a".repeat(73) }], ["nome-81", { displayName: "x".repeat(81) }]]],
  ["mfa-setup-begin_POST", mfaSetupBegin as AnySchema, { password: "qualquer" }, [["sem-senha", {}]]],
  ["background-tasks_GET", backgroundTasks as AnySchema, {}, [["chave-extra-ignorada", { qualquer: 1 }]]],
  ["background-tasks-retry_POST", backgroundTasksRetry as AnySchema, { runId: "5" }, []],
  ["match-evaluations_GET", matchEvaluations as AnySchema, { opportunityId: "7" }, []],
  ["opportunity-registry-match_POST", opportunityMatch as AnySchema, { opportunityId: 7 }, []],
  ["passwordPolicy.newPasswordSchema", z.object({ password: newPasswordSchema }) as AnySchema, { password: "SenhaForte123!" }, [["so-espacos", { password: "        " }], ["72-bytes", { password: "a".repeat(72) }], ["73-bytes", { password: "a".repeat(73) }], ["multibyte-37", { password: "é".repeat(37) }], ["multibyte-36", { password: "é".repeat(36) }], ["7-chars", { password: "abcdefg" }], ["8-chars", { password: "abcdefgh" }]]],
];

describe("diferença conhecida zod 3 → 4: array no lugar de texto", () => {
  // zod 3 para na issue de tipo; zod 4 pode acrescentar a issue de tamanho do MESMO campo (inclusive a mensagem do projeto). A rejeição e o caminho são idênticos.
  const CASES_ARRAY: Array<[string, AnySchema, Record<string, unknown>, string]> = [
    ["needs_POST", needsPost as AnySchema, CASES[1][2], "title"],
    ["opportunity-registry_POST", opportunityRegistry as AnySchema, CASES[2][2], "title"],
    ["platform-access-codes_GET", platformAccessCodes as AnySchema, CASES[4][2], "q"],
    ["stock-destination-correction_POST", destinationCorrection as AnySchema, CASES[5][2], "notes"],
    ["stock-destination-correction_POST", destinationCorrection as AnySchema, CASES[5][2], "reason"],
  ];
  for (const [name, schema, base, field] of CASES_ARRAY) {
    it(`${name}.${field} = []: rejeitado, com ao menos uma issue no campo, sem sucesso parcial`, () => {
      const r = schema.safeParse({ ...base, [field]: [] });
      expect(r.success).toBe(false);
      expect(r.error!.issues.some((i) => i.path.join(".") === field)).toBe(true);
    });
  }
});

describe("paridade zod 3 → 4 dos schemas de risco de comportamento", () => {
  for (const [name, schema, base, extra] of CASES) {
    it(`${name}: a base do contrato é válida`, () => expect(contract(schema, base).ok).toBe(true));
    it(`${name}: snapshot diferencial (sucesso, dados parseados, issues)`, async () => {
      const table: Record<string, unknown> = {};
      for (const [vname, input] of [...battery(base), ...extra]) table[vname] = contract(schema, input);
      await expect(JSON.stringify(table, null, 2) + "\n").toMatchFileSnapshot(`./__zod_contracts__/risk-${name}.json`);
    });
  }
});
