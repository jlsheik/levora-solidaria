import { describe, it, expect } from "vitest";
import { z } from "zod";
import superjson from "superjson";
import { buildErrorResponse, ConflictError } from "../src/helpers/errorResponse";
import { NotAuthenticatedError } from "../src/helpers/getSetServerSession";
import { OrganizationAccessError } from "../src/helpers/organizationAccess";
import { PlatformAccessError } from "../src/helpers/platformAccess";

/**
 * Fase 65 — teste do helper centralizado, não dos 49 endpoints
 * individualmente (comportamento é todo centralizado aqui, exatamente
 * como a própria fase pede: "preferir testes do helper/middleware
 * quando o comportamento for centralizado").
 *
 * Achado real de auditoria que este arquivo prova corrigido: antes desta
 * fase, `buildErrorResponse` repassava `error.message` ao cliente para
 * QUALQUER erro, inclusive erros reais do driver do Postgres (ex.:
 * "getaddrinfo ENOTFOUND <host>" para falha de conexão, ou
 * 'relation "x" does not exist' para uma query malformada) — confirmado
 * de verdade contra um Postgres real durante a investigação desta fase.
 * O teste "erro desconhecido" abaixo prova que isso nunca mais acontece.
 */
async function readBody(response: Response): Promise<{ message: string }> {
  return superjson.parse(await response.text());
}

describe("buildErrorResponse — classificação central de erros da API", () => {
  it("SyntaxError (corpo malformado, antes mesmo de chegar ao Zod) vira 400, não 500 (achado real de regressão desta fase)", async () => {
    let caught: unknown;
    try {
      superjson.parse("isto não é JSON/superjson válido {{{");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SyntaxError);
    const response = buildErrorResponse(caught, "Não foi possível completar a operação");
    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body.message).toBe("Corpo da requisição inválido");
  });

  it("ZodError vira 400, com a mensagem de validação preservada (comportamento inalterado)", async () => {
    let caught: unknown;
    try {
      z.object({ email: z.string().email() }).parse({ email: "não é um e-mail" });
    } catch (e) {
      caught = e;
    }
    const response = buildErrorResponse(caught, "mensagem de fallback não deveria aparecer aqui");
    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body.message).not.toBe("mensagem de fallback não deveria aparecer aqui");
    expect(body.message).toContain("email");
  });

  it("NotAuthenticatedError vira 401, com a mensagem própria da classe", async () => {
    const response = buildErrorResponse(new NotAuthenticatedError(), "fallback");
    expect(response.status).toBe(401);
    const body = await readBody(response);
    expect(body.message).toBe("Not authenticated");
  });

  it("OrganizationAccessError e PlatformAccessError viram 403", async () => {
    const r1 = buildErrorResponse(new OrganizationAccessError("Seu papel nesta organização não permite esta ação"), "fallback");
    expect(r1.status).toBe(403);
    const r2 = buildErrorResponse(new PlatformAccessError(), "fallback");
    expect(r2.status).toBe(403);
  });

  it("ConflictError vira 409, com a mensagem de conflito preservada (achado real: antes caía no default 400 via comparação de texto frágil)", async () => {
    const response = buildErrorResponse(new ConflictError("Esta oportunidade já foi recebida e não pode ter o status alterado por aqui"), "fallback");
    expect(response.status).toBe(409);
    const body = await readBody(response);
    expect(body.message).toBe("Esta oportunidade já foi recebida e não pode ter o status alterado por aqui");
  });

  it("um erro desconhecido (ex.: falha real de infraestrutura) vira 500, e NUNCA expõe error.message ao cliente", async () => {
    // Simula exatamente o que um erro real de conexão do driver `postgres`
    // parece (reproduzido de verdade contra um host inexistente durante a
    // investigação desta fase): .message contém o hostname interno.
    const infraError = new Error("getaddrinfo ENOTFOUND banco-interno.levora.local");
    const response = buildErrorResponse(infraError, "Não foi possível completar a operação");
    expect(response.status).toBe(500);
    const body = await readBody(response);
    expect(body.message).toBe("Não foi possível completar a operação");
    expect(body.message).not.toContain("ENOTFOUND");
    expect(body.message).not.toContain("banco-interno.levora.local");
  });

  it("um erro desconhecido sem fallbackMessage específico ainda assim nunca vaza SQL/stack", async () => {
    const sqlError = new Error('relation "users_secret_table" does not exist');
    const response = buildErrorResponse(sqlError, "Erro interno");
    expect(response.status).toBe(500);
    const body = await readBody(response);
    expect(body.message).toBe("Erro interno");
    expect(body.message).not.toContain("relation");
    expect(body.message).not.toContain("users_secret_table");
  });

  it("um valor não-Error lançado (ex.: throw de uma string) também vira 500 com a mensagem de fallback", async () => {
    const response = buildErrorResponse("algo não-Error foi lançado", "fallback seguro");
    expect(response.status).toBe(500);
    const body = await readBody(response);
    expect(body.message).toBe("fallback seguro");
  });
});
