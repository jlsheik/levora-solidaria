/**
 * Fase 51 — fecha SEC-03 (enumeração de e-mail no cadastro) e SEC-04
 * (timing side-channel no login) da auditoria de segurança (Fase 47).
 *
 * A medição de timing em si (150 amostras por cenário, metodologia e
 * resultados) foi feita com um script temporário, documentada no
 * relatório da Fase 51 e removida depois — não faz sentido como teste de
 * CI permanente (benchmark de latência é inerentemente instável em
 * ambiente de CI compartilhado). O que ESTE arquivo garante de forma
 * estável é o comportamento funcional que sustenta a mitigação: a
 * resposta pública nunca distingue e-mail existente de inexistente, nem
 * no cadastro nem no login.
 */
import { describe, it, expect } from "vitest";
import { handle as rawPostRegister } from "../src/endpoints/auth/register_with_password_POST";
import { withFreshAccessCode } from "./helpers";
// Fase 91: o cadastro exige código de acesso; estes testes (de outros comportamentos) recebem um código ativo novo automaticamente.
const postRegister = withFreshAccessCode(rawPostRegister);
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { buildRequest, parseJson } from "./helpers";

describe("Fase 51 — SEC-03: cadastro nunca revela se o e-mail já tinha conta", () => {
  it("resposta para e-mail NOVO e para e-mail JÁ EXISTENTE é idêntica em status, corpo e ausência de Set-Cookie", async () => {
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        ip: "ip-enum-fixture",
        body: { email: "enum-existente@example.com", password: "senha-valida-123", displayName: "Já Registrada" },
      })
    );

    const responseNovo = await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        ip: "ip-enum-novo",
        body: { email: "enum-novo@example.com", password: "senha-valida-123", displayName: "Pessoa Nova" },
      })
    );
    const responseExistente = await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        ip: "ip-enum-existente-tentativa",
        body: { email: "enum-existente@example.com", password: "qualquer-outra-123", displayName: "Tentativa" },
      })
    );

    expect(responseNovo.status).toBe(responseExistente.status);
    expect(responseNovo.status).toBe(200);
    expect(responseNovo.headers.get("Set-Cookie")).toBeNull();
    expect(responseExistente.headers.get("Set-Cookie")).toBeNull();

    const bodyNovo = await parseJson<{ message: string }>(responseNovo);
    const bodyExistente = await parseJson<{ message: string }>(responseExistente);
    expect(bodyNovo.message).toBe(bodyExistente.message);
  });

  it("cadastro nunca cria sessão, mesmo para um e-mail genuinamente novo — login continua sendo um passo separado", async () => {
    const response = await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "sem-sessao-automatica@example.com", password: "senha-valida-123", displayName: "Pessoa" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const body = await parseJson<Record<string, unknown>>(response);
    expect(body).not.toHaveProperty("user");
  });

  it("tentar 'cadastrar' um e-mail já existente não altera a senha nem o nome da conta original", async () => {
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "nao-sobrescreve@example.com", password: "senha-original-123", displayName: "Nome Original" },
      })
    );
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        ip: "ip-nao-sobrescreve",
        body: { email: "nao-sobrescreve@example.com", password: "senha-invasora-123", displayName: "Nome Invasor" },
      })
    );

    const loginComSenhaOriginal = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "nao-sobrescreve@example.com", password: "senha-original-123" },
      })
    );
    expect(loginComSenhaOriginal.status).toBe(200);
    const { user } = await parseJson<{ user: { displayName: string } }>(loginComSenhaOriginal);
    expect(user.displayName).toBe("Nome Original");

    const loginComSenhaInvasora = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "nao-sobrescreve@example.com", password: "senha-invasora-123" },
      })
    );
    expect(loginComSenhaInvasora.status).toBe(401);
  });
});

describe("Fase 51 — SEC-04: login não distingue usuário inexistente de senha incorreta", () => {
  it("status e mensagem são idênticos para usuário inexistente e senha errada", async () => {
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "sec04-existente@example.com", password: "senha-correta-123", displayName: "Pessoa" },
      })
    );

    const senhaErrada = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "sec04-existente@example.com", password: "senha-errada-123" },
      })
    );
    const usuarioInexistente = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "sec04-nao-existe@example.com", password: "qualquer-coisa-123" },
      })
    );

    expect(senhaErrada.status).toBe(usuarioInexistente.status);
    expect(senhaErrada.status).toBe(401);
    const bodyA = await parseJson<{ message: string }>(senhaErrada);
    const bodyB = await parseJson<{ message: string }>(usuarioInexistente);
    expect(bodyA.message).toBe(bodyB.message);
  });

  it("o hash dummy usado para equalizar timing nunca é confundido com uma senha real válida", async () => {
    // Mesmo que alguém soubesse a senha-dummy usada internamente para
    // equalizar o tempo de resposta (ela nem é secreta — está comentada
    // no código-fonte), isso nunca pode autenticar contra um usuário que
    // não existe: o branch de "usuário não existe" sempre devolve
    // auth_failed, o resultado de compare() é descartado.
    const response = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: {
          email: "ninguem-tem-essa-conta@example.com",
          password: "dummy-password-para-equalizar-timing-nunca-corresponde-a-senha-real",
        },
      })
    );
    expect(response.status).toBe(401);
  });
});
