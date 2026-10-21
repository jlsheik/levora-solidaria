/**
 * Fase 89.1 — auditoria dos caminhos que poderiam inutilizar o ÚNICO Platform Owner, invariante "exatamente 1 owner
 * ativo" sob sequências concorrentes, comportamento da sessão em transferência/revogação, JWT×linha e senha (bytes).
 * Não cria funcionalidade: só exercita o que já existe.
 */
import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { db } from "../src/helpers/db";
import { getPlatformLevel } from "../src/helpers/platformAccess";
import { grantPlatformAdmin, revokePlatformAccess, transferPlatformOwnership } from "../src/helpers/platformAccessAdmin";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as postLogout } from "../src/endpoints/auth/logout_POST";
import { handle as getSession } from "../src/endpoints/auth/session_GET";
import { handle as rawPostRegister } from "../src/endpoints/auth/register_with_password_POST";
import { withFreshAccessCode } from "./helpers";
// Fase 91: o cadastro exige código de acesso; estes testes (de outros comportamentos) recebem um código ativo novo automaticamente.
const postRegister = withFreshAccessCode(rawPostRegister);
import { handle as postAccountDelete } from "../src/endpoints/auth/account-delete_POST";
import { handle as postOrgStatus } from "../src/endpoints/platform-organizations-status_POST";
import { handle as getPlatformOrganizations } from "../src/endpoints/platform-organizations_GET";
import { handle as postMemberLeave } from "../src/endpoints/organization-members-leave_POST";
import { generatePasswordHash } from "../src/helpers/generatePasswordHash";
import { fullLogin } from "./mfaHarness";
import { createPlatformAdmin, createPlatformOwner, createTestUser, createTestOrganization, addMembership, createAuthenticatedUser, buildRequest, parseJson, createSessionCookie } from "./helpers";

const PASSWORD = "senha-de-teste-123";
const DAY = 24 * 3600 * 1000;

const owners = async () => (await db.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").execute()).map((r) => r.userId);
const login = (email: string, password = PASSWORD, ip?: string) => postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email, password }, ip }));
const cookieOf = (res: Response) => res.headers.get("Set-Cookie")!.split(";")[0];
const who = async (cookie: string) => parseJson<{ user: { role: string; platformLevel: string | null } }>(await getSession(buildRequest("auth/session", { cookie })));
const platformCall = (cookie: string) => getPlatformOrganizations(buildRequest("platform-organizations", { cookie }));

describe("Platform Owner único — todos os caminhos EXISTENTES que poderiam inutilizá-lo", () => {
  it("excluir conta / anonimizar: bloqueado (409 + trigger); estado do owner intacto", async () => {
    const owner = await createPlatformOwner();
    const res = await postAccountDelete(buildRequest("auth/account-delete", { method: "POST", cookie: owner.cookie, body: { password: PASSWORD } }));
    expect(res.status).toBe(409);
    await expect(db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", owner.userId).execute()).rejects.toThrow(/não pode ser anonimizado/);
    expect(await owners()).toEqual([owner.userId]);
    expect((await platformCall(owner.cookie)).status).toBe(200);
  });

  it("revogar acesso / rebaixar / apagar linha: recusados pela aplicação E pelo banco", async () => {
    const owner = await createPlatformOwner();
    await createPlatformAdmin();
    await expect(db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: owner.userId, targetUserId: owner.userId }))).rejects.toThrow();
    await expect(db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", owner.userId).execute()).rejects.toThrow(/último Platform Owner/);
    await expect(db.updateTable("platformAccess").set({ level: "admin" }).where("userId", "=", owner.userId).execute()).rejects.toThrow(/último Platform Owner/);
    await expect(db.deleteFrom("platformAccess").where("userId", "=", owner.userId).execute()).rejects.toThrow();
    expect(await owners()).toEqual([owner.userId]);
  });

  it("desativação/saída de MEMBRO e suspensão de ORGANIZAÇÃO não afetam platform_access nem a autenticação do owner", async () => {
    const owner = await createPlatformOwner();
    const other = await createAuthenticatedUser();
    const org = await createTestOrganization(other.userId);
    await addMembership(org.id, owner.userId, "proprietario");
    // o owner da plataforma sai da organização (há outro proprietário) e a plataforma suspende a organização
    expect((await postMemberLeave(buildRequest("organization-members-leave", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id } }))).status).toBe(200);
    expect((await postOrgStatus(buildRequest("platform-organizations-status", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, status: "suspensa" } }))).status).toBe(200);
    expect(await getPlatformLevel(owner.userId)).toBe("owner");
    expect((await platformCall(owner.cookie)).status).toBe(200);
    expect((await login(owner.email)).status).toBe(200);
  });

  it("logout: só encerra a sessão; o owner volta a entrar e recebe o tier de plataforma", async () => {
    const owner = await createPlatformOwner();
    expect((await postLogout(buildRequest("auth/logout", { method: "POST", cookie: owner.cookie }))).status).toBe(200);
    expect((await platformCall(owner.cookie)).status).toBe(401);
    // Fase 90: o login do owner exige o 2º fator (senha + TOTP) antes de haver sessão
    const again = await fullLogin(owner.email, owner.userId);
    expect((await who(again)).user).toMatchObject({ platformLevel: "owner" });
    expect(await owners()).toEqual([owner.userId]);
  });

  it("expiração de sessão (ociosa 60 min / absoluta 8 h): o owner perde só a sessão e entra de novo", async () => {
    const owner = await createPlatformOwner();
    await db.updateTable("sessions").set({ lastAccessed: new Date(Date.now() - 2 * 3600 * 1000) }).where("userId", "=", owner.userId).execute();
    expect((await platformCall(owner.cookie)).status).toBe(401);
    expect((await login(owner.email)).status).toBe(200);
    expect(await owners()).toEqual([owner.userId]);
  });

  it("bloqueio por tentativas de login (5/15 min por e-mail): é TEMPORÁRIO, não toca platform_access e termina sozinho — risco P-6 documentado (DoS de login), não perda de acesso", async () => {
    const owner = await createPlatformOwner();
    for (let i = 0; i < 5; i++) expect((await login(owner.email, "errada-errada", `203.0.113.${i + 1}`)).status).toBe(401);
    expect((await login(owner.email, PASSWORD, "203.0.113.99")).status).toBe(429); // senha CERTA, mas bloqueada
    expect(await getPlatformLevel(owner.userId)).toBe("owner");
    // a janela passa (15 min): o bloqueio expira sem intervenção
    await db.updateTable("loginAttempts").set({ attemptedAt: new Date(Date.now() - 16 * 60 * 1000) }).execute();
    expect((await login(owner.email, PASSWORD, "203.0.113.98")).status).toBe(200);
  });

  it("cadastro com o e-mail do owner não altera conta, senha, nem platform_access", async () => {
    const owner = await createPlatformOwner();
    const before = await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", owner.userId).executeTakeFirstOrThrow();
    const res = await postRegister(buildRequest("auth/register_with_password", { method: "POST", body: { email: owner.email.toUpperCase(), password: "outra-senha-qualquer-1", displayName: "Invasor" } }));
    expect(res.status).toBe(200);
    const after = await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", owner.userId).executeTakeFirstOrThrow();
    expect(after.passwordHash).toBe(before.passwordHash);
    expect((await db.selectFrom("users").select("displayName").where("id", "=", owner.userId).executeTakeFirstOrThrow()).displayName).not.toBe("Invasor");
    expect(await owners()).toEqual([owner.userId]);
  });

  it("não existem (no HEAD desta fase) endpoints de troca de senha, logout global, desativação/suspensão de usuário nem alteração de e-mail/role — nada mais a auditar", async () => {
    const { readdirSync } = await import("node:fs");
    const files = [...readdirSync("src/endpoints"), ...readdirSync("src/endpoints/auth")].join("\n");
    expect(files).not.toMatch(/password-change|password-reset|sessions-revoke|logout-all|users-status|users-suspend|users-role|profile_POST|platform-access(?!-codes)/);
  });
});

describe("invariante do owner: exatamente 1 owner ativo (casos 1–10)", () => {
  it("1–2: primeiro owner; segundo owner recusado", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await db.insertInto("platformAccess").values({ userId: a.id, level: "owner" }).execute();
    await expect(db.insertInto("platformAccess").values({ userId: b.id, level: "owner" }).execute()).rejects.toMatchObject({ code: "23505" });
    expect(await owners()).toEqual([a.id]);
  });

  it("3: transferência para admin; 4/7: duas transferências simultâneas — uma só vence", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    const c = await createPlatformAdmin();
    const rs = await Promise.allSettled([
      db.transaction().execute((t) => transferPlatformOwnership(t, { actorUserId: a.userId, targetUserId: b.userId })),
      db.transaction().execute((t) => transferPlatformOwnership(t, { actorUserId: a.userId, targetUserId: c.userId })),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await owners()).toHaveLength(1);
    expect(await owners()).not.toContain(a.userId);
  });

  it("5: revogar o owner sem substituto — recusado; 6: revogar o owner e promover o substituto NA MESMA transação — aceito", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await db.insertInto("platformAccess").values([{ userId: a.id, level: "owner" }, { userId: b.id, level: "admin" }]).execute();
    await expect(db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", a.id).execute()).rejects.toThrow(/último Platform Owner/);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", a.id).execute();
      await trx.updateTable("platformAccess").set({ level: "owner" }).where("userId", "=", b.id).execute();
    });
    expect(await owners()).toEqual([b.id]);
  });

  it("8–9: excluir/anonimizar o owner — recusados (cobertos acima e em identityPlatformAccess)", async () => {
    const o = await createPlatformOwner();
    expect((await postAccountDelete(buildRequest("auth/account-delete", { method: "POST", cookie: o.cookie, body: { password: PASSWORD } }))).status).toBe(409);
  });

  it("10 (propriedade): 6 rodadas de operações CONCORRENTES embaralhadas (conceder, revogar, transferir, excluir conta) — após cada rodada: exatamente 1 owner ativo e nenhum titular ativo anonimizado", async () => {
    const owner = await createPlatformOwner();
    const pool = [await createPlatformAdmin(), await createPlatformAdmin(), await createPlatformAdmin()];
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let round = 0; round < 6; round++) {
      const current = (await owners())[0];
      const ops: Promise<unknown>[] = [];
      for (let k = 0; k < 5; k++) {
        const target = pool[rnd(pool.length)].userId;
        const actor = rnd(3) === 0 ? pool[rnd(pool.length)].userId : current; // às vezes um não-owner tenta
        const kind = rnd(4);
        if (kind === 0) ops.push(db.transaction().execute((t) => grantPlatformAdmin(t, { actorUserId: actor, targetUserId: target })).catch(() => undefined));
        else if (kind === 1) ops.push(db.transaction().execute((t) => revokePlatformAccess(t, { actorUserId: actor, targetUserId: target })).catch(() => undefined));
        else if (kind === 2) ops.push(db.transaction().execute((t) => transferPlatformOwnership(t, { actorUserId: actor, targetUserId: target })).catch(() => undefined));
        else {
          const u = await db.selectFrom("users").select("email").where("id", "=", target).executeTakeFirstOrThrow();
          ops.push(login(u.email).then((r) => postAccountDelete(buildRequest("auth/account-delete", { method: "POST", cookie: cookieOf(r), body: { password: PASSWORD } }))).catch(() => undefined));
        }
      }
      await Promise.all(ops);
      expect(await owners(), `rodada ${round}`).toHaveLength(1);
      const anonymizedHolders = await db
        .selectFrom("platformAccess")
        .innerJoin("users", "users.id", "platformAccess.userId")
        .select("users.id")
        .where("platformAccess.status", "=", "active")
        .where("users.anonymizedAt", "is not", null)
        .execute();
      expect(anonymizedHolders, `rodada ${round}`).toEqual([]);
    }
    void owner;
  }, 120000);
});

describe("sessão × transferência/revogação de acesso (comportamento ATUAL e lacunas para a Fase 90)", () => {
  it("transferência A→B: a sessão de A segue válida mas continua com tier de plataforma (A ainda é admin ativo); a de B passa a owner na próxima requisição", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    await db.transaction().execute((t) => transferPlatformOwnership(t, { actorUserId: a.userId, targetUserId: b.userId }));
    expect((await who(a.cookie)).user).toMatchObject({ platformLevel: "admin", role: "admin" });
    expect((await who(b.cookie)).user).toMatchObject({ platformLevel: "owner", role: "admin" });
    expect((await platformCall(a.cookie)).status).toBe(200);
  });

  it("revogação do acesso (B revoga A): a sessão de A NÃO é removida (lacuna conhecida → Fase 90) mas perde o privilégio NA HORA (poder relido do banco) e cai para o tier padrão", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    await db.transaction().execute((t) => transferPlatformOwnership(t, { actorUserId: a.userId, targetUserId: b.userId }));
    await db.transaction().execute((t) => revokePlatformAccess(t, { actorUserId: b.userId, targetUserId: a.userId }));
    expect((await platformCall(a.cookie)).status).toBe(403); // privilégio some imediatamente
    expect((await who(a.cookie)).user).toMatchObject({ platformLevel: null, role: "user" });
    // sessão ainda existe e agora segue a política padrão (idle 7 d): uma ociosa há 2 h continua válida
    await db.updateTable("sessions").set({ lastAccessed: new Date(Date.now() - 2 * 3600 * 1000) }).where("userId", "=", a.userId).execute();
    expect((await who(a.cookie)).user.role).toBe("user");
    expect(await owners()).toEqual([b.userId]);
  });

  it("a mesma sessão antiga nunca mantém privilégio errado: ganhar acesso aplica o tier de plataforma (60 min) imediatamente", async () => {
    const u = await createAuthenticatedUser();
    await db.updateTable("sessions").set({ lastAccessed: new Date(Date.now() - 90 * 60 * 1000) }).where("userId", "=", u.userId).execute();
    await db.insertInto("platformAccess").values({ userId: u.userId, level: "admin" }).execute();
    expect((await platformCall(u.cookie)).status).toBe(401);
  });
});

describe("JWT × linha da sessão", () => {
  const encoder = new TextEncoder();
  async function forgeJwt(sessionId: string, expSecondsFromNow: number) {
    return new SignJWT({ id: sessionId, createdAt: Date.now(), lastAccessed: Date.now() })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow)
      .sign(encoder.encode(process.env.JWT_SECRET));
  }

  it("JWT válido + linha expirada = 401; JWT EXPIRADO + linha válida = 401; JWT válido + linha válida = 200", async () => {
    const u = await createAuthenticatedUser();
    const row = await db.selectFrom("sessions").select("id").where("userId", "=", u.userId).executeTakeFirstOrThrow();

    const good = `floot_built_app_session=${await forgeJwt(row.id, 3600)}`;
    expect((await getSession(buildRequest("auth/session", { cookie: good }))).status).toBe(200);

    const expiredJwt = `floot_built_app_session=${await forgeJwt(row.id, -60)}`;
    expect((await getSession(buildRequest("auth/session", { cookie: expiredJwt }))).status).toBe(401);
    expect(await db.selectFrom("sessions").select("id").where("id", "=", row.id).execute()).toHaveLength(1); // linha continua; só o transporte expirou

    await db.updateTable("sessions").set({ absoluteExpiresAt: new Date(Date.now() - 1000) }).where("id", "=", row.id).execute();
    expect((await getSession(buildRequest("auth/session", { cookie: good }))).status).toBe(401);
  });

  it("JWT de uma sessão inexistente / assinado com outro segredo = 401", async () => {
    const forged = `floot_built_app_session=${await new SignJWT({ id: "0".repeat(64) }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(encoder.encode("outro-segredo"))}`;
    expect((await getSession(buildRequest("auth/session", { cookie: forged }))).status).toBe(401);
    expect((await getSession(buildRequest("auth/session", { cookie: `floot_built_app_session=${await forgeJwt("0".repeat(64), 3600)}` }))).status).toBe(401);
  });

  it("session_GET renova o cookie (idle) mas o Max-Age nunca ultrapassa o que resta do absoluto, mesmo chamado repetidamente", async () => {
    const u = await createAuthenticatedUser();
    await db.updateTable("sessions").set({ absoluteExpiresAt: new Date(Date.now() + 600 * 1000) }).where("userId", "=", u.userId).execute();
    let last = Infinity;
    for (let i = 0; i < 3; i++) {
      const r = await getSession(buildRequest("auth/session", { cookie: u.cookie }));
      const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers.get("Set-Cookie")!)![1]);
      expect(maxAge).toBeLessThanOrEqual(600);
      expect(maxAge).toBeLessThanOrEqual(last);
      last = maxAge;
    }
  });
});

describe("senha — bytes, não caracteres", () => {
  const register = (email: string, password: string) => postRegister(buildRequest("auth/register_with_password", { method: "POST", body: { email, password, displayName: "T" } }));
  const exists = async (email: string) => (await db.selectFrom("users").select("id").where("email", "=", email).execute()).length;

  it("exatamente 72 bytes (ASCII, multibyte e emoji) passam; 73 falham; vazia e < 8 falham", async () => {
    expect((await register("b72a@example.com", "a".repeat(72))).status).toBe(200); // 72 chars = 72 bytes
    expect((await register("b72b@example.com", "é".repeat(36))).status).toBe(200); // 36 chars = 72 bytes
    expect((await register("b72c@example.com", "😀".repeat(18))).status).toBe(200); // 18 chars = 72 bytes
    expect((await register("b73a@example.com", "a".repeat(73))).status).toBe(400);
    expect((await register("b73b@example.com", "é".repeat(36) + "a")).status).toBe(400); // 36 chars + 1 = 73 bytes
    expect((await register("b73c@example.com", "😀".repeat(18) + "a")).status).toBe(400);
    expect((await register("b0@example.com", "")).status).toBe(400);
    expect((await register("b7@example.com", "1234567")).status).toBe(400);
    expect(await exists("b72a@example.com")).toBe(1);
    expect(await exists("b72b@example.com")).toBe(1);
    expect(await exists("b73a@example.com")).toBe(0);
    expect(await exists("b73c@example.com")).toBe(0);
    expect(await exists("b0@example.com")).toBe(0);
  });

  it("72 BYTES com poucos caracteres (ex.: 18 emojis) conta como 72, não como 18 — a contagem é em bytes UTF-8", async () => {
    expect([..."😀".repeat(18)].length).toBe(18);
    expect(new TextEncoder().encode("😀".repeat(18)).length).toBe(72);
    const r = await register("emoji19@example.com", "😀".repeat(19)); // 19 chars, 76 bytes
    expect(r.status).toBe(400);
  });

  it("senha LEGADA acima de 72 bytes: o login continua funcionando como antes (não é rejeitado pelo teto) — comportamento do bcrypt: só os 72 primeiros bytes valem", async () => {
    const long = "L".repeat(100);
    const user = await createTestUser();
    await db.updateTable("userPasswords").set({ passwordHash: await generatePasswordHash(long) }).where("userId", "=", user.id).execute();
    expect((await login(user.email, long)).status).toBe(200);
    // consequência conhecida e antiga do bcrypt (agora impedida de nascer pelo teto no cadastro):
    expect((await login(user.email, long.slice(0, 72))).status).toBe(200);
    expect((await login(user.email, long.slice(0, 71))).status).toBe(401);
  });

  it("UNIQUE(user_id) em user_passwords continua valendo", async () => {
    const u = await createTestUser();
    await expect(db.insertInto("userPasswords").values({ userId: u.id, passwordHash: "x" }).execute()).rejects.toMatchObject({ code: "23505" });
  });
});

describe("rotateSession — consumidores nesta fase", () => {
  it("rotateSession só tem os consumidores previstos (ativar/desativar MFA, step-up e reauth por identidade); troca de senha/vínculos ficam para fases seguintes", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const ALLOWED = ["mfa-disable_POST.ts", "mfa-setup-confirm_POST.ts", "oauthCallback.tsx", "step-up_POST.ts"]; // Fase 90 (MFA/step-up) + Fase 92.1/93 (reauth por identidade no callback OAuth compartilhado)
    const { join } = await import("node:path");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const users = walk("src").concat(walk("server")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("sessionLifecycle")).filter((f) => readFileSync(f, "utf8").includes("rotateSession"));
    expect(users.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual(ALLOWED);
    void createSessionCookie;
  });
});
