import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postRegister } from "../src/endpoints/auth/register_with_password_POST";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { buildRequest, parseJson } from "./helpers";

function decodeJwtExpirationSeconds(setCookieHeader: string): { iat: number; exp: number } {
  const token = setCookieHeader.split("floot_built_app_session=")[1].split(";")[0];
  const payloadBase64 = token.split(".")[1];
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf-8"));
  return { iat: payload.iat, exp: payload.exp };
}

describe("cadastro e login por senha", () => {
  it("cadastra um novo usuário e já retorna uma sessão autenticada (cookie de sessão)", async () => {
    const response = await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "nova@example.com", password: "senha-valida-123", displayName: "Nova Pessoa" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("floot_built_app_session=");
    const data = await parseJson<{ user: { email: string } }>(response);
    expect(data.user.email).toBe("nova@example.com");
  });

  it("recusa cadastro com e-mail já em uso (409)", async () => {
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "duplicado@example.com", password: "senha-valida-123", displayName: "Primeira" },
      })
    );
    const response = await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "duplicado@example.com", password: "outra-senha-123", displayName: "Segunda" },
      })
    );
    expect(response.status).toBe(409);
  });

  it("autentica com e-mail e senha corretos", async () => {
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "login@example.com", password: "senha-correta-123", displayName: "Pessoa" },
      })
    );

    const response = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "login@example.com", password: "senha-correta-123" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("floot_built_app_session=");
  });

  it("recusa senha incorreta (401) e não vaza se o e-mail existe", async () => {
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "senhaerrada@example.com", password: "senha-correta-123", displayName: "Pessoa" },
      })
    );

    const response = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "senhaerrada@example.com", password: "senha-completamente-errada" },
      })
    );
    expect(response.status).toBe(401);

    const responseInexistente = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "nao-existe@example.com", password: "qualquer-coisa-123" },
      })
    );
    expect(responseInexistente.status).toBe(401);
  });

  it("bloqueia temporariamente após 5 tentativas de senha incorreta (429)", async () => {
    await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "forcabruta@example.com", password: "senha-correta-123", displayName: "Pessoa" },
      })
    );

    for (let i = 0; i < 5; i++) {
      const attempt = await postLogin(
        buildRequest("auth/login_with_password", {
          method: "POST",
          body: { email: "forcabruta@example.com", password: "senha-errada" },
        })
      );
      expect(attempt.status).toBe(401);
    }

    // A 6ª tentativa, mesmo com a senha certa, deve ficar bloqueada.
    const blocked = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "forcabruta@example.com", password: "senha-correta-123" },
      })
    );
    expect(blocked.status).toBe(429);

    const attempts = await db
      .selectFrom("loginAttempts")
      .select(["success"])
      .where("email", "=", "forcabruta@example.com")
      .execute();
    expect(attempts.filter((a) => !a.success).length).toBeGreaterThanOrEqual(5);
  });

  describe("rate limiting por IP (independente do bloqueio por e-mail)", () => {
    it("bloqueia login (429) após muitas tentativas do mesmo IP, mesmo variando o e-mail", async () => {
      const ip = "ip-varredura-login";
      for (let i = 0; i < 20; i++) {
        const response = await postLogin(
          buildRequest("auth/login_with_password", {
            method: "POST",
            ip,
            body: { email: `inexistente-${i}@example.com`, password: "qualquer-coisa-123" },
          })
        );
        expect(response.status).toBe(401);
      }

      const blocked = await postLogin(
        buildRequest("auth/login_with_password", { method: "POST", ip, body: { email: "mais-um@example.com", password: "qualquer-coisa-123" } })
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBeTruthy();
    });

    it("não bloqueia um IP diferente mesmo depois do outro ter sido limitado", async () => {
      const ip = "ip-varredura-login-2";
      for (let i = 0; i < 20; i++) {
        await postLogin(buildRequest("auth/login_with_password", { method: "POST", ip, body: { email: `x-${i}@example.com`, password: "qualquer-coisa-123" } }));
      }
      const outroIp = await postLogin(
        buildRequest("auth/login_with_password", { method: "POST", ip: "ip-limpo", body: { email: "outra-pessoa@example.com", password: "qualquer-coisa-123" } })
      );
      expect(outroIp.status).toBe(401); // não é 429 — este IP não fez nenhuma tentativa ainda
    });

    it("bloqueia (429) criação de contas em massa a partir do mesmo IP", async () => {
      const ip = "ip-fabrica-de-contas";
      for (let i = 0; i < 10; i++) {
        const response = await postRegister(
          buildRequest("auth/register_with_password", { method: "POST", ip, body: { email: `conta-${i}@example.com`, password: "senha-valida-123", displayName: `Conta ${i}` } })
        );
        expect(response.status).toBe(200);
      }

      const blocked = await postRegister(
        buildRequest("auth/register_with_password", { method: "POST", ip, body: { email: "conta-11@example.com", password: "senha-valida-123", displayName: "Conta 11" } })
      );
      expect(blocked.status).toBe(429);
    });
  });

  it("o JWT interno da sessão expira em 7 dias, batendo com o Max-Age do cookie (não em 1 dia)", async () => {
    const response = await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "expiracao@example.com", password: "senha-valida-123", displayName: "Pessoa" },
      })
    );
    const setCookie = response.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("Max-Age=604800"); // 7 dias em segundos

    const { iat, exp } = decodeJwtExpirationSeconds(setCookie);
    const secondsAteExpirar = exp - iat;
    // Margem pequena para o tempo de execução do teste em si, não para
    // mascarar uma regressão de verdade (1 dia = 86400s, bem longe disso).
    expect(secondsAteExpirar).toBeGreaterThan(604800 - 5);
    expect(secondsAteExpirar).toBeLessThanOrEqual(604800 + 5);
  });

  // Fase 4 (CSRF) do relatório de auditoria: este app não usa token CSRF
  // explícito porque a arquitetura já é resistente por design — ver
  // docs/SECURITY.md ("Por que CSRF não precisa de token aqui"). Este teste
  // trava a propriedade que sustenta essa análise (SameSite=Lax) para que
  // uma mudança futura não a rebaixe silenciosamente sem que ninguém perceba.
  it("cookie de sessão é HttpOnly + Secure + SameSite=Lax — a base da resistência a CSRF deste app", async () => {
    const response = await postRegister(
      buildRequest("auth/register_with_password", {
        method: "POST",
        body: { email: "csrf-cookie@example.com", password: "senha-valida-123", displayName: "Pessoa" },
      })
    );
    const setCookie = response.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });
});
