/**
 * Fase 48 — fecha o achado SEC-02 da auditoria de segurança (Fase 47):
 * `users.email` permitia duas identidades diferentes por capitalização
 * ("Teste@x.com" vs "teste@x.com"). Ver db/migrations/0013_users_email_case_insensitive.sql
 * (índice único funcional sobre LOWER(email)) e as mudanças em
 * register_with_password_POST.ts (normaliza e checa de forma
 * case-insensitive).
 *
 * Atualizado na Fase 51 (SEC-03): register_with_password_POST não
 * distingue mais "e-mail já em uso" (antes 409) de "conta criada agora"
 * (200) — a resposta pública é sempre a mesma, para nunca revelar se um
 * e-mail já tinha conta. Os testes abaixo que antes checavam o 409
 * passaram a checar que a resposta é IDÊNTICA à de um cadastro novo, e que
 * a conta duplicada realmente não foi criada (via consulta direta ao
 * banco, não mais via status code).
 */
import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as postRegister } from "../src/endpoints/auth/register_with_password_POST";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as postInvite } from "../src/endpoints/organization-invites_POST";
import { handle as postInviteAccept } from "../src/endpoints/organization-invites-accept_POST";
import { buildRequest, parseJson, createAuthenticatedUser, createTestOrganization } from "./helpers";

function tokenFromAcceptUrl(acceptUrl: string): string {
  return acceptUrl.split("/convites/")[1];
}

describe("Fase 48 — identidade de e-mail case-insensitive", () => {
  describe("registro", () => {
    it("1. primeiro cadastro com um e-mail aceita normalmente e persiste normalizado (minúsculas)", async () => {
      const response = await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          body: { email: "Fase48Primeiro@Example.com", password: "senha-valida-123", displayName: "Pessoa" },
        })
      );
      expect(response.status).toBe(200);
      // Fase 51: a resposta não devolve mais dado de usuário — a prova de
      // que persistiu normalizado é consultar o banco diretamente.
      const row = await db.selectFrom("users").select("email").where(sql`LOWER(email)`, "=", "fase48primeiro@example.com").executeTakeFirst();
      expect(row?.email).toBe("fase48primeiro@example.com");
    });

    it("2. o mesmo e-mail exato devolve a mesma resposta pública (nunca um 409) e não cria uma segunda conta", async () => {
      const first = await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          body: { email: "fase48exato@example.com", password: "senha-valida-123", displayName: "A" },
        })
      );
      const second = await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          ip: "ip-fase48exato",
          body: { email: "fase48exato@example.com", password: "outra-senha-123", displayName: "B" },
        })
      );
      expect(second.status).toBe(first.status);
      expect(second.status).toBe(200);
      const firstBody = await parseJson<{ message: string }>(first);
      const secondBody = await parseJson<{ message: string }>(second);
      expect(secondBody.message).toBe(firstBody.message);

      const rows = await db.selectFrom("users").select("id").where("email", "=", "fase48exato@example.com").execute();
      expect(rows.length).toBe(1);
    });

    it("3. o mesmo e-mail em minúsculas não cria uma segunda conta quando o original tinha letras maiúsculas", async () => {
      await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          body: { email: "Fase48Lower@Example.com", password: "senha-valida-123", displayName: "A" },
        })
      );
      const response = await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          ip: "ip-fase48lower",
          body: { email: "fase48lower@example.com", password: "outra-senha-123", displayName: "B" },
        })
      );
      expect(response.status).toBe(200);
      const rows = await db.selectFrom("users").select("id").where(sql`LOWER(email)`, "=", "fase48lower@example.com").execute();
      expect(rows.length).toBe(1);
    });

    it("4. o mesmo e-mail em MAIÚSCULAS não cria uma segunda conta quando o original era minúsculo", async () => {
      await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          body: { email: "fase48upper@example.com", password: "senha-valida-123", displayName: "A" },
        })
      );
      const response = await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          ip: "ip-fase48upper",
          body: { email: "FASE48UPPER@EXAMPLE.COM", password: "outra-senha-123", displayName: "B" },
        })
      );
      expect(response.status).toBe(200);
      const rows = await db.selectFrom("users").select("id").where(sql`LOWER(email)`, "=", "fase48upper@example.com").execute();
      expect(rows.length).toBe(1);
    });

    it("5. e-mail com espaço externo é aceito e persistido já sem o espaço (regra canônica adotada na Fase 51: trim() antes da validação de formato)", async () => {
      const response = await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          body: { email: " fase48espaco@example.com ", password: "senha-valida-123", displayName: "A" },
        })
      );
      expect(response.status).toBe(200);
      const row = await db.selectFrom("users").select("email").where(sql`LOWER(email)`, "=", "fase48espaco@example.com").executeTakeFirst();
      expect(row?.email).toBe("fase48espaco@example.com");
    });

    it("6. login funciona independentemente da capitalização usada no cadastro ou no login", async () => {
      await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          body: { email: "Fase48Login@Example.com", password: "senha-correta-123", displayName: "Pessoa" },
        })
      );

      const response = await postLogin(
        buildRequest("auth/login_with_password", {
          method: "POST",
          body: { email: "FASE48LOGIN@EXAMPLE.COM", password: "senha-correta-123" },
        })
      );
      expect(response.status).toBe(200);
      const data = await parseJson<{ user: { email: string } }>(response);
      expect(data.user.email).toBe("fase48login@example.com");
    });
  });

  describe("banco como última barreira", () => {
    it("7. INSERT direto no banco com e-mail case-variant é rejeitado pela constraint (reproduzido em transação revertida)", async () => {
      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto("users").values({ email: "Fase48Db@Example.com", displayName: "A", role: "user" }).execute();
          await trx.insertInto("users").values({ email: "fase48db@example.com", displayName: "B", role: "user" }).execute();
        })
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("8. o índice único funcional sobre LOWER(email) realmente existe no Postgres", async () => {
      const result = await sql<{ indexdef: string }>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'users' AND indexname = 'idx_users_email_lower'
      `.execute(db);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].indexdef.toLowerCase()).toContain("lower(email)");
    });
  });

  describe("outros produtores de users.email", () => {
    it("9. convite não cria um usuário duplicado mesmo quando o e-mail do convite tem capitalização diferente da conta já registrada", async () => {
      const registered = await postRegister(
        buildRequest("auth/register_with_password", {
          method: "POST",
          body: { email: "fase48convite@example.com", password: "senha-valida-123", displayName: "Convidada" },
        })
      );
      expect(registered.status).toBe(200);

      const owner = await createAuthenticatedUser();
      const org = await createTestOrganization(owner.userId);

      // Contagem tirada DEPOIS de criar a pessoa registrada e o
      // proprietário (ambas contas legítimas, não relacionadas ao
      // convite) — o que este teste prova é que o convite em si (criação
      // + aceite) não adiciona nenhuma linha nova a users.
      const countBefore = await db.selectFrom("users").select(db.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();

      const inviteResponse = await postInvite(
        buildRequest("organization-invites", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: org.id, email: "Fase48Convite@Example.com", role: "operador" },
        })
      );
      expect(inviteResponse.status).toBe(200);
      const { acceptUrl } = await parseJson<{ acceptUrl: string }>(inviteResponse);
      const token = tokenFromAcceptUrl(acceptUrl);

      // A conta que aceita é a mesma já registrada (sessão própria, não
      // criada pelo convite) — login com a conta registrada originalmente.
      const loginResponse = await postLogin(
        buildRequest("auth/login_with_password", {
          method: "POST",
          body: { email: "fase48convite@example.com", password: "senha-valida-123" },
        })
      );
      const setCookie = loginResponse.headers.get("Set-Cookie")!;
      const cookie = setCookie.split(";")[0];

      const acceptResponse = await postInviteAccept(
        buildRequest("organization-invites-accept", { method: "POST", cookie, body: { token } })
      );
      expect(acceptResponse.status).toBe(200);

      const countAfter = await db.selectFrom("users").select(db.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
      expect(Number(countAfter.n)).toBe(Number(countBefore.n));
    });

    it("10. convite nunca consegue, por si só, gerar uma duplicata case-insensitive em users", async () => {
      const owner = await createAuthenticatedUser();
      const org = await createTestOrganization(owner.userId);

      // Convite para um e-mail que ainda não tem conta nenhuma — o convite
      // em si (organization_invites) não toca na tabela users.
      const inviteResponse = await postInvite(
        buildRequest("organization-invites", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: org.id, email: "Fase48SemConta@Example.com", role: "voluntario" },
        })
      );
      expect(inviteResponse.status).toBe(200);

      const matching = await db
        .selectFrom("users")
        .select("id")
        .where(sql`LOWER(email)`, "=", "fase48semconta@example.com")
        .execute();
      expect(matching.length).toBe(0);
    });
  });

  describe("concorrência", () => {
    it("11. duas requisições simultâneas de cadastro com o mesmo e-mail em capitalizações diferentes resultam em exatamente 1 linha em users, e as duas respostas são 200 (Fase 51: nunca mais um 409 — a proteção contra a corrida agora é inteiramente silenciosa, via índice único + catch de unique_violation)", async () => {
      const [first, second] = await Promise.all([
        postRegister(
          buildRequest("auth/register_with_password", {
            method: "POST",
            ip: "ip-fase48concorrente-a",
            body: { email: "Fase48Concorrente@Example.com", password: "senha-valida-123", displayName: "A" },
          })
        ),
        postRegister(
          buildRequest("auth/register_with_password", {
            method: "POST",
            ip: "ip-fase48concorrente-b",
            body: { email: "fase48concorrente@example.com", password: "senha-valida-123", displayName: "B" },
          })
        ),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const rows = await db
        .selectFrom("users")
        .select("id")
        .where(sql`LOWER(email)`, "=", "fase48concorrente@example.com")
        .execute();
      expect(rows.length).toBe(1);
    });
  });
});
