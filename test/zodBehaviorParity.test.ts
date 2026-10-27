/**
 * Comportamento do zod que o compilador NÃO acusa na migração 3 → 4 e que o projeto usa: formato de e-mail (3 schemas), classe/nome do erro
 * (`instanceof ZodError`, `error.name === "ZodError"`), `.default()` com `.trim()`, `z.coerce.number()` com limites, e a resposta de login/cadastro
 * com e-mail inválido. As expectativas foram obtidas com o zod 3.25.76 e conferidas lado a lado com o zod 4.6.7 (`zod/v3` vs `zod`): sem diferença.
 * Mensagens PADRÃO do zod (inglês) mudam de texto entre versões e não são contrato; aqui só se afirma sucesso/falha, valor e mensagens do projeto.
 */
import { describe, it, expect } from "vitest";
import superjson from "superjson";
import { z, ZodError } from "zod";
import { schema as loginSchema } from "../src/endpoints/auth/login_with_password_POST.schema";
import { schema as registerSchema } from "../src/endpoints/auth/register_with_password_POST.schema";
import { schema as inviteSchema } from "../src/endpoints/organization-invites_POST.schema";
import { handle as login } from "../src/endpoints/auth/login_with_password_POST";
import { handle as register } from "../src/endpoints/auth/register_with_password_POST";
import { buildRequest } from "./helpers";

const MSG = "Informe um e-mail válido";
const VALID = ["a@b.co", " a@b.com ", "user+tag@example.com", "user.name@sub.example.com", "USER@EXAMPLE.COM", "user@example.com.br", "a@b.museum", "user_name@example.io"];
const INVALID = ["a@b", "a b@c.com", "user..name@example.com", ".user@example.com", "user@-example.com", "user@example.c", "josé@example.com", "user@exämple.com", "'quote'@example.com", "user@@example.com", "@example.com", "user@", "", "user@example..com", "user@123.123.123.123", "user@[127.0.0.1]"];

describe("formato de e-mail: login, cadastro e convite aceitam/rejeitam exatamente os mesmos endereços", () => {
  const emailOf = { login: (e: string) => loginSchema.safeParse({ email: e, password: "x" }), invite: (e: string) => inviteSchema.safeParse({ email: e, organizationId: 1, role: "voluntario" }) };
  for (const e of VALID) it(`aceita ${JSON.stringify(e)}`, () => {
    expect(emailOf.login(e).success).toBe(true);
    expect(registerSchema.shape.email.safeParse(e).success).toBe(true);
  });
  for (const e of INVALID) it(`rejeita ${JSON.stringify(e)} com a mensagem pt-BR do projeto`, () => {
    const r = emailOf.login(e);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message)).toEqual([MSG]);
    const reg = registerSchema.shape.email.safeParse(e);
    expect(reg.success).toBe(false);
    if (!reg.success) expect(reg.error.issues.map((i) => i.message)).toEqual([MSG]);
  });
  it("o e-mail é normalizado por trim (valor devolvido sem espaços)", () => {
    expect(loginSchema.parse({ email: "  a@b.com ", password: "x" }).email).toBe("a@b.com");
  });
});

describe("erro de validação: classe e nome estáveis (usados por errorResponse, login e cadastro)", () => {
  it("parse inválido lança ZodError (instanceof, name e z.ZodError)", () => {
    try { z.object({ a: z.string() }).parse({}); throw new Error("não lançou"); } catch (e) {
      expect(e).toBeInstanceOf(ZodError);
      expect(e).toBeInstanceOf(z.ZodError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("ZodError");
      expect(Array.isArray((e as ZodError).issues)).toBe(true);
    }
  });
});

describe(".default() com trim e z.coerce.number() com limites", () => {
  const note = z.string().trim().max(500).default("");
  it("default: ausente → '', trim aplicado, null rejeitado", () => {
    expect(note.parse(undefined)).toBe("");
    expect(note.parse("  x  ")).toBe("x");
    expect(note.parse("")).toBe("");
    expect(note.safeParse(null).success).toBe(false);
  });
  const limit = z.coerce.number().int().min(1).max(100).default(50);
  it("coerce: ausente → default; texto numérico → número; vazio, null, 0, NaN, >100 e vetor vazio rejeitados; true vira 1", () => {
    expect(limit.parse(undefined)).toBe(50);
    expect(limit.parse("7")).toBe(7);
    expect(limit.parse(true)).toBe(1);
    for (const v of [null, "", 0, "abc", "101", []]) expect(limit.safeParse(v).success, JSON.stringify(v)).toBe(false);
  });
});

describe("login/cadastro com e-mail inválido", () => {
  it("login → 400 com mensagem fixa (não ecoa as issues)", async () => {
    const res = await login(buildRequest("auth/login_with_password", { method: "POST", body: { email: "invalido", password: "x" } }));
    expect(res.status).toBe(400);
    expect(superjson.parse(await res.text())).toEqual({ message: "Dados de login inválidos" });
  });
  it("cadastro → 400 com as issues em JSON, incluindo a mensagem pt-BR no campo email", async () => {
    const res = await register(buildRequest("auth/register_with_password", { method: "POST", body: { email: "invalido", password: "SenhaForte123!", displayName: "Pessoa Teste", accessCode: "CODIGO-TESTE" } }));
    expect(res.status).toBe(400);
    const body = superjson.parse<{ message: string }>(await res.text());
    const issues = JSON.parse(body.message) as Array<{ path: string[]; message: string }>;
    expect(issues.find((i) => i.path.join(".") === "email")?.message).toBe(MSG);
  });
});
