/**
 * Contrato de API da validação (zod): corpo inválido → 400 com `{ message }`, `message` é o JSON das issues (caminho + texto pt-BR do projeto),
 * sem exceção interna, sem pilha, sem detalhe sensível; sem sessão → 401 ANTES de validar. Escrito contra o zod 3 e deve passar igual no zod 4.
 * Endpoints reais, Postgres real e DESCARTÁVEL, sessão sintética.
 */
import { describe, it, expect } from "vitest";
import superjson from "superjson";
import { handle as organizationName } from "../src/endpoints/organization-name_POST";
import { handle as needDetails } from "../src/endpoints/need-details_POST";
import { handle as organizations } from "../src/endpoints/organizations_POST";
import { handle as needClosure } from "../src/endpoints/need-closure_POST";
import { handle as sourceName } from "../src/endpoints/source-name_POST";
import { handle as proof } from "../src/endpoints/stock-destination-proof_POST";
import { handle as reversal } from "../src/endpoints/stock-destination-reversal_POST";
import { handle as destinations } from "../src/endpoints/stock-destinations_POST";
import { buildRequest, createAuthenticatedUser } from "./helpers";

type Handler = (r: Request) => Promise<Response>;
interface Issue { path: Array<string | number>; message: string }

const CASES: Array<[string, string, Handler, unknown, string, string]> = [
  ["organization-name", "nome ausente", organizationName, { organizationId: 1 }, "name", "Informe o nome da organização"],
  ["organization-name", "nome com tipo errado", organizationName, { organizationId: 1, name: 5 }, "name", "Informe o nome da organização"],
  ["need-details", "título com tipo errado", needDetails, { organizationId: 1, needId: 1, title: 5 }, "title", "Informe um título para a necessidade"],
  ["need-details", "prioridade inválida", needDetails, { organizationId: 1, needId: 1, priority: "x" }, "priority", "Prioridade inválida"],
  ["organizations", "tipo inválido", organizations, { name: "Aa", type: "x", city: "Cc", state: "MG" }, "type", "Selecione o tipo de organização"],
  ["need-closure", "motivo ausente", needClosure, { action: "encerrar", organizationId: 1, needId: 1 }, "reasonCode", "Escolha o motivo do encerramento"],
  ["stock-destination-proof", "ação inválida", proof, { organizationId: 1, destinationId: "1", action: "x", reason: "motivo ok", idempotencyKey: "abcdefgh12" }, "action", "Escolha anexar ou remover"],
  ["stock-destination-reversal", "quantidade textual", reversal, { organizationId: 1, destinationId: "1", kind: "estorno_documental", quantity: "abc", reason: "motivo ok", idempotencyKey: "abcdefgh12" }, "quantity", "Informe a quantidade a reverter"],
  ["stock-destinations", "finalidade inválida", destinations, { organizationId: 1, itemId: 1, quantity: "2", destinationType: "x", deliveredOn: "2026-10-27", idempotencyKey: "abcdefgh12" }, "destinationType", "Escolha uma das finalidades da lista"],
];

describe("contrato de API: validação inválida", () => {
  for (const [endpoint, label, handler, body, path, expected] of CASES) {
    it(`${endpoint}: ${label} → 400, issue em "${path}" com o texto pt-BR, sem vazamento`, async () => {
      const user = await createAuthenticatedUser();
      const res = await handler(buildRequest(endpoint, { method: "POST", cookie: user.cookie, body }));
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const raw = await res.text();
      const parsed = superjson.parse<{ message: string }>(raw);
      expect(Object.keys(parsed)).toEqual(["message"]);
      expect(typeof parsed.message).toBe("string");
      // sem pilha, caminho de arquivo, SQL ou nome de módulo
      expect(raw).not.toMatch(/\bat\s+\S+\s+\(|node_modules|\.tsx?:\d+|SELECT |kysely|postgres|ZodError/i);
      // `message` é o JSON das issues; o campo certo traz o texto exato do projeto
      const issues = JSON.parse(parsed.message) as Issue[];
      expect(Array.isArray(issues)).toBe(true);
      const hit = issues.filter((i) => i.path.join(".") === path).map((i) => i.message);
      expect(hit).toContain(expected);
    });
  }

  it("source-name: autorização da plataforma vem ANTES da validação (usuário comum → 403 sem issues no corpo)", async () => {
    const user = await createAuthenticatedUser();
    const res = await sourceName(buildRequest("source-name", { method: "POST", cookie: user.cookie, body: { sourceId: 1 } }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toMatch(/"path"/);
  });

  it("corpo que não é JSON → 400 com mensagem fixa, sem detalhe do parser", async () => {
    const user = await createAuthenticatedUser();
    const res = await organizationName(new Request("http://localhost/_api/v1/organization-name", { method: "POST", headers: { cookie: user.cookie ?? "", "content-type": "application/json" }, body: "<html>não é json" }));
    expect(res.status).toBe(400);
    expect(superjson.parse<{ message: string }>(await res.text())).toEqual({ message: "Corpo da requisição inválido" });
  });

  it("sem sessão → 401 antes de qualquer validação (corpo inválido não vaza issues)", async () => {
    for (const [endpoint, , handler, body] of CASES.slice(0, 4)) {
      const res = await handler(buildRequest(endpoint, { method: "POST", body }));
      expect(res.status).toBe(401);
      const raw = await res.text();
      expect(raw).not.toMatch(/"path"/);
    }
  });

  it("corpo válido de formato passa da validação (não é 400)", async () => {
    const user = await createAuthenticatedUser();
    const res = await organizationName(buildRequest("organization-name", { method: "POST", cookie: user.cookie, body: { organizationId: 999999, name: "Associação Teste" } }));
    expect(res.status).not.toBe(400); // sem permissão na organização → 403, mas a validação aceitou
  });
});
