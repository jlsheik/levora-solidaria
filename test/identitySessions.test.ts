import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { evaluateSession, SESSION_POLICY } from "../src/helpers/sessionPolicy";
import { rotateSession } from "../src/helpers/sessionLifecycle";
import { getServerSessionOrThrow, NotAuthenticatedError } from "../src/helpers/getSetServerSession";
import { ipPrefix } from "../src/helpers/loginAudit";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as postLogout } from "../src/endpoints/auth/logout_POST";
import { handle as getSession } from "../src/endpoints/auth/session_GET";
import { handle as rawPostRegister } from "../src/endpoints/auth/register_with_password_POST";
import { withFreshAccessCode } from "./helpers";
// Fase 91: o cadastro exige código de acesso; estes testes (de outros comportamentos) recebem um código ativo novo automaticamente.
const postRegister = withFreshAccessCode(rawPostRegister);
import { createAuthenticatedUser, createPlatformAdmin, createSessionCookie, createTestUser, buildRequest, parseJson } from "./helpers";

const PASSWORD = "senha-de-teste-123";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const login = (email: string, password = PASSWORD, ip?: string) =>
  postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email, password }, ip }));
const cookieOf = (res: Response) => res.headers.get("Set-Cookie")!.split(";")[0];
const maxAgeOf = (res: Response) => Number(/Max-Age=(\d+)/.exec(res.headers.get("Set-Cookie") ?? "")?.[1]);
const sessionIdOf = async (cookie: string) => (await getServerSessionOrThrow(new Request("http://localhost/x", { headers: { cookie } }))).id;
const whoAmI = (cookie: string) => getSession(buildRequest("auth/session", { cookie }));
const ago = (ms: number) => new Date(Date.now() - ms);
const setTimes = async (cookie: string, times: { createdAt?: Date; lastAccessed?: Date; absoluteExpiresAt?: Date }) =>
  db.updateTable("sessions").set(times).where("id", "=", await sessionIdOf(cookie)).execute();

describe("sessionPolicy — evaluateSession (puro)", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const base = { createdAt: new Date(now.getTime() - HOUR), lastAccessed: new Date(now.getTime() - MIN), absoluteExpiresAt: new Date(now.getTime() + 29 * DAY), now };

  it("valores da política: standard 7 d ocioso / 30 d absoluto; platform 60 min / 8 h", () => {
    expect(SESSION_POLICY.standard).toEqual({ idleMs: 7 * DAY, absoluteMs: 30 * DAY });
    expect(SESSION_POLICY.platform).toEqual({ idleMs: 60 * MIN, absoluteMs: 8 * HOUR });
  });

  it("ocioso: no limite exato já é inválido (>=), um ms antes é válido", () => {
    expect(evaluateSession({ ...base, tier: "platform", lastAccessed: new Date(now.getTime() - (60 * MIN - 1)) }).valid).toBe(true);
    expect(evaluateSession({ ...base, tier: "platform", lastAccessed: new Date(now.getTime() - 60 * MIN) })).toEqual({ valid: false, reason: "idle" });
    expect(evaluateSession({ ...base, tier: "standard", lastAccessed: new Date(now.getTime() - (7 * DAY - 1)) }).valid).toBe(true);
    expect(evaluateSession({ ...base, tier: "standard", lastAccessed: new Date(now.getTime() - 7 * DAY) })).toEqual({ valid: false, reason: "idle" });
  });

  it("absoluto: plataforma limita por created_at + 8 h mesmo que a linha guarde 30 d; standard usa a linha", () => {
    const created = new Date(now.getTime() - 8 * HOUR);
    expect(evaluateSession({ ...base, tier: "platform", createdAt: created })).toEqual({ valid: false, reason: "absolute" });
    expect(evaluateSession({ ...base, tier: "standard", createdAt: created }).valid).toBe(true);
    expect(evaluateSession({ ...base, tier: "standard", absoluteExpiresAt: now })).toEqual({ valid: false, reason: "absolute" });
    const ok = evaluateSession({ ...base, tier: "platform", createdAt: new Date(now.getTime() - 7 * HOUR) });
    expect(ok.valid && ok.effectiveAbsoluteExpiresAt.getTime()).toBe(now.getTime() + HOUR);
  });

  it("created_at/last_accessed nulos não quebram (sessões antigas)", () => {
    expect(evaluateSession({ tier: "standard", createdAt: null, lastAccessed: null, absoluteExpiresAt: new Date(now.getTime() + DAY), now }).valid).toBe(true);
  });
});

describe("expiração de sessão imposta (ociosa e absoluta) com a linha como autoridade", () => {
  it("standard: 6 d ocioso vale; 8 d ocioso = 401 e a linha é removida", async () => {
    const u = await createAuthenticatedUser();
    await setTimes(u.cookie, { lastAccessed: ago(6 * DAY) });
    expect((await whoAmI(u.cookie)).status).toBe(200);
    await setTimes(u.cookie, { lastAccessed: ago(8 * DAY) });
    expect((await whoAmI(u.cookie)).status).toBe(401);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.userId).execute()).toHaveLength(0);
  });

  it("standard: teto absoluto de 30 d vale MESMO com uso recente (o JWT ainda válido não ressuscita a sessão)", async () => {
    const u = await createAuthenticatedUser();
    await setTimes(u.cookie, { createdAt: ago(29 * DAY), absoluteExpiresAt: new Date(Date.now() + DAY), lastAccessed: ago(MIN) });
    expect((await whoAmI(u.cookie)).status).toBe(200);
    await setTimes(u.cookie, { absoluteExpiresAt: ago(1000) });
    expect((await whoAmI(u.cookie)).status).toBe(401);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.userId).execute()).toHaveLength(0);
  });

  it("plataforma: 59 min ocioso vale; 61 min = 401; 7 h de vida vale; 9 h de vida = 401 mesmo com uso recente", async () => {
    const admin = await createPlatformAdmin();
    await setTimes(admin.cookie, { lastAccessed: ago(59 * MIN) });
    expect((await whoAmI(admin.cookie)).status).toBe(200);
    await setTimes(admin.cookie, { lastAccessed: ago(61 * MIN) });
    expect((await whoAmI(admin.cookie)).status).toBe(401);

    const admin2 = await createPlatformAdmin();
    await setTimes(admin2.cookie, { createdAt: ago(7 * HOUR), lastAccessed: ago(MIN) });
    expect((await whoAmI(admin2.cookie)).status).toBe(200);
    await setTimes(admin2.cookie, { createdAt: ago(9 * HOUR), lastAccessed: ago(MIN) });
    expect((await whoAmI(admin2.cookie)).status).toBe(401);
  });

  it("o tier é dinâmico: a mesma sessão ociosa há 2 h vale como usuário comum e deixa de valer quando ganha acesso de plataforma (e volta a valer se revogado)", async () => {
    const u = await createAuthenticatedUser();
    await setTimes(u.cookie, { lastAccessed: ago(2 * HOUR) });
    expect((await whoAmI(u.cookie)).status).toBe(200); // atualiza last_accessed para agora
    await setTimes(u.cookie, { lastAccessed: ago(2 * HOUR) });
    await db.insertInto("platformAccess").values({ userId: u.userId, level: "admin" }).execute();
    expect((await whoAmI(u.cookie)).status).toBe(401);
    const u2 = await createAuthenticatedUser();
    await db.insertInto("platformAccess").values({ userId: u2.userId, level: "admin", status: "revoked", revokedAt: new Date() }).execute();
    await setTimes(u2.cookie, { lastAccessed: ago(2 * HOUR) });
    expect((await whoAmI(u2.cookie)).status).toBe(200);
  });

  it("uso mantém a sessão viva no ocioso, mas NUNCA estende o absoluto", async () => {
    const u = await createAuthenticatedUser();
    const id = await sessionIdOf(u.cookie);
    const before = await db.selectFrom("sessions").select(["absoluteExpiresAt", "createdAt"]).where("id", "=", id).executeTakeFirstOrThrow();
    for (let i = 0; i < 3; i++) expect((await whoAmI(u.cookie)).status).toBe(200);
    const after = await db.selectFrom("sessions").select(["absoluteExpiresAt", "createdAt", "lastAccessed"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(after.absoluteExpiresAt.getTime()).toBe(before.absoluteExpiresAt.getTime());
    expect(after.createdAt?.getTime()).toBe(before.createdAt?.getTime());
  });

  it("limpeza oportunista nunca derruba sessão válida e remove as vencidas (coleta de lixo)", async () => {
    const stale = await createAuthenticatedUser();
    await setTimes(stale.cookie, { absoluteExpiresAt: ago(DAY) });
    const live = await createAuthenticatedUser();
    // várias requisições: a limpeza probabilística (10 %) roda em algumas
    for (let i = 0; i < 60; i++) expect((await whoAmI(live.cookie)).status).toBe(200);
    expect((await whoAmI(stale.cookie)).status).toBe(401);
  });
});

describe("cookie/JWT limitados ao teto absoluto", () => {
  it("login: usuário comum recebe Max-Age 7 d; a linha nasce com absoluto ≈ 30 d, primary_method=password e id novo a cada login", async () => {
    const u = await createTestUser();
    const r1 = await login(u.email);
    const r2 = await login(u.email);
    expect(r1.status).toBe(200);
    expect(maxAgeOf(r1)).toBe(7 * 24 * 3600);
    const id1 = await sessionIdOf(cookieOf(r1));
    const id2 = await sessionIdOf(cookieOf(r2));
    expect(id1).not.toBe(id2);
    const row = await db.selectFrom("sessions").selectAll().where("id", "=", id1).executeTakeFirstOrThrow();
    expect(row.primaryMethod).toBe("password");
    expect(Math.abs(row.absoluteExpiresAt.getTime() - (row.createdAt!.getTime() + 30 * DAY))).toBeLessThan(2000);
    expect(row.expiresAt.getTime()).toBe(row.absoluteExpiresAt.getTime());
  });

  it("session_GET perto do teto absoluto devolve Max-Age curto e não estende a linha", async () => {
    const u = await createAuthenticatedUser();
    const id = await sessionIdOf(u.cookie);
    const absolute = new Date(Date.now() + HOUR);
    await db.updateTable("sessions").set({ absoluteExpiresAt: absolute }).where("id", "=", id).execute();
    const res = await whoAmI(u.cookie);
    expect(res.status).toBe(200);
    const maxAge = maxAgeOf(res);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(maxAge).toBeGreaterThan(3500);
    const row = await db.selectFrom("sessions").select("absoluteExpiresAt").where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.absoluteExpiresAt.getTime()).toBe(absolute.getTime());
  });

  it("login de titular de plataforma devolve Max-Age ≤ 8 h? (o cookie dura o mínimo entre 7 d e o absoluto da linha) e platformLevel na resposta", async () => {
    const admin = await createPlatformAdmin();
    // Fase 90: titular de plataforma só tem sessão depois do 2º fator (senha + TOTP)
    const first = await login(admin.email);
    expect((await parseJson<{ mfaRequired: boolean }>(first)).mfaRequired).toBe(true);
    expect(first.headers.getSetCookie().some((c) => c.startsWith("floot_built_app_session="))).toBe(false);
    await db.updateTable("mfaMethods").set({ lastUsedStep: null }).where("userId", "=", admin.userId).execute();
    const { handle: verifyHandle } = await import("../src/endpoints/auth/mfa-verify_POST");
    const { totpCodeAtStep, stepAt } = await import("../src/helpers/totp");
    const { TEST_TOTP_SECRET } = await import("./helpers");
    const challengeCookie = first.headers.getSetCookie().find((c) => c.startsWith("levora_challenge="))!.split(";")[0];
    const res = await verifyHandle(buildRequest("auth/mfa-verify", { method: "POST", cookie: challengeCookie, body: { code: totpCodeAtStep(TEST_TOTP_SECRET, stepAt(Date.now())) } }));
    expect(res.status).toBe(200);
    const body = await parseJson<{ user: { role: string; platformLevel: string } }>(res);
    expect(body.user).toMatchObject({ role: "admin", platformLevel: "admin" });
    // O teto de 8 h da plataforma é imposto pela linha/validação; o cookie segue o teto gravado (30 d) limitado a 7 d.
    expect(maxAgeOf(res)).toBeLessThanOrEqual(7 * 24 * 3600);
  });
});

describe("rotação de sessão", () => {
  it("cria id novo, remove o antigo (cookie antigo = 401) e HERDA created_at e o absoluto (nunca prolonga)", async () => {
    const u = await createAuthenticatedUser();
    const oldId = await sessionIdOf(u.cookie);
    const created = ago(20 * DAY);
    const absolute = new Date(Date.now() + 10 * DAY);
    await db.updateTable("sessions").set({ createdAt: created, absoluteExpiresAt: absolute, primaryMethod: "google", mfaVerifiedAt: ago(HOUR) }).where("id", "=", oldId).execute();

    const rotated = await rotateSession(oldId, { reauth: true });
    expect(rotated.newId).not.toBe(oldId);
    expect(await db.selectFrom("sessions").select("id").where("id", "=", oldId).executeTakeFirst()).toBeUndefined();
    const row = await db.selectFrom("sessions").selectAll().where("id", "=", rotated.newId).executeTakeFirstOrThrow();
    expect(row.createdAt?.getTime()).toBe(created.getTime());
    expect(row.absoluteExpiresAt.getTime()).toBe(absolute.getTime());
    expect(row.primaryMethod).toBe("google");
    expect(row.mfaVerifiedAt).not.toBeNull();
    expect(row.lastReauthAt).not.toBeNull();
    expect((await whoAmI(u.cookie)).status).toBe(401);
  });

  it("rotacionar sessão inexistente/ já rotacionada = NotAuthenticatedError", async () => {
    await expect(rotateSession("0".repeat(64))).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("CONCORRÊNCIA: duas rotações do mesmo id — uma vence, a outra perde; resta exatamente 1 sessão do usuário", async () => {
    const u = await createAuthenticatedUser();
    const id = await sessionIdOf(u.cookie);
    const results = await Promise.allSettled([rotateSession(id), rotateSession(id), rotateSession(id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(NotAuthenticatedError);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.userId).execute()).toHaveLength(1);
  });

  it("rotação não afeta as OUTRAS sessões do mesmo usuário", async () => {
    const u = await createAuthenticatedUser();
    const other = await createSessionCookie(u.userId);
    await rotateSession(await sessionIdOf(u.cookie));
    expect((await whoAmI(other)).status).toBe(200);
  });
});

describe("user_passwords UNIQUE(user_id) e limite de 72 bytes", () => {
  it("segunda senha para o mesmo usuário é recusada (23505) — 0..1 por usuário", async () => {
    const u = await createTestUser(); // já tem 1 senha
    let code: string | undefined;
    try {
      await db.insertInto("userPasswords").values({ userId: u.id, passwordHash: "x" }).execute();
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("23505");
  });

  it("CONCORRÊNCIA: duas inserções simultâneas de senha para o mesmo usuário — exatamente uma vence", async () => {
    const [u] = await db.insertInto("users").values({ email: "sem-senha@example.com", displayName: "S" }).returning("id").execute();
    const results = await Promise.allSettled([1, 2, 3].map((n) => db.insertInto("userPasswords").values({ userId: u.id, passwordHash: `h${n}` }).execute()) as Promise<unknown>[]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.selectFrom("userPasswords").select("id").where("userId", "=", u.id).execute()).toHaveLength(1);
  });

  const register = (email: string, password: string) =>
    postRegister(buildRequest("auth/register_with_password", { method: "POST", body: { email, password, displayName: "Teste" } }));

  it("cadastro: 72 bytes passa e a pessoa entra; 73 bytes e 74 bytes (acentos) são REJEITADOS (400), não truncados", async () => {
    const p72 = "a".repeat(72);
    expect((await register("p72@example.com", p72)).status).toBe(200);
    expect((await login("p72@example.com", p72)).status).toBe(200);
    const r73 = await register("p73@example.com", "a".repeat(73));
    expect(r73.status).toBe(400);
    expect((await parseJson<{ message: string }>(r73)).message).toMatch(/72 bytes/);
    expect((await register("p74@example.com", "ç".repeat(37))).status).toBe(400); // 37 × 2 = 74 bytes
    expect((await register("p36@example.com", "ç".repeat(36))).status).toBe(200); // 72 bytes
    expect(await db.selectFrom("users").select("id").where("email", "=", "p73@example.com").execute()).toHaveLength(0);
    expect((await register("curta@example.com", "1234567")).status).toBe(400);
  });

  it("o login NÃO impõe o teto (contas antigas com senha longa continuam entrando) e não vaza a política", async () => {
    const u = await createTestUser();
    const res = await login(u.email, "x".repeat(200));
    expect(res.status).toBe(401); // credencial errada — mesma resposta de qualquer senha errada
    expect((await parseJson<{ message: string }>(res)).message).not.toMatch(/72/);
  });
});

describe("auditoria de login/logout", () => {
  it("login ok gera usuario.login_realizado (metodo, ipPrefix) sem e-mail/senha/IP completo/token", async () => {
    const u = await createTestUser();
    const res = await login(u.email, PASSWORD, "203.0.113.77");
    expect(res.status).toBe(200);
    const events = await db.selectFrom("auditLog").selectAll().where("action", "=", "usuario.login_realizado").execute();
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(u.id);
    expect(events[0].organizationId).toBeNull();
    expect(events[0].metadata).toEqual({ metodo: "senha", ipPrefix: "203.0.113.0/24" });
    const dump = JSON.stringify(events);
    for (const secret of [u.email, PASSWORD, "203.0.113.77", cookieOf(res).split("=")[1]]) expect(dump).not.toContain(secret);
  });

  it("falha de login: evento só na PRIMEIRA falha por e-mail+IP (limite de volume); outro IP gera novo; e-mail digitado nunca é gravado", async () => {
    const u = await createTestUser();
    for (let i = 0; i < 3; i++) expect((await login(u.email, "errada-errada", "198.51.100.5")).status).toBe(401);
    expect(await db.selectFrom("auditLog").select("id").where("action", "=", "usuario.login_falhou").execute()).toHaveLength(1);
    await login(u.email, "errada-errada", "198.51.100.200"); // mesmo /24 → mesma chave
    expect(await db.selectFrom("auditLog").select("id").where("action", "=", "usuario.login_falhou").execute()).toHaveLength(1);
    await login(u.email, "errada-errada", "192.0.2.9"); // outro prefixo
    await login("inexistente@example.com", "errada-errada", "192.0.2.9");
    const events = await db.selectFrom("auditLog").selectAll().where("action", "=", "usuario.login_falhou").orderBy("id", "asc").execute();
    expect(events).toHaveLength(3);
    expect(events[0].actorUserId).toBe(u.id);
    expect(events[2].actorUserId).toBeNull(); // e-mail inexistente: sem usuário
    expect(events[0].metadata).toEqual({ metodo: "senha", motivo: "credenciais_invalidas", ipPrefix: "198.51.100.0/24" });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(u.email);
    expect(dump).not.toContain("inexistente@example.com");
    expect(dump).not.toContain("errada-errada");
  });

  it("a resposta de login não muda: e-mail inexistente e senha errada continuam indistinguíveis (corpo e status)", async () => {
    const u = await createTestUser();
    const a = await login(u.email, "errada-errada", "192.0.2.50");
    const b = await login("naoexiste@example.com", "errada-errada", "192.0.2.51");
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it("login BLOQUEADO (5 falhas) gera no máximo 1 evento bloqueio_temporario por e-mail+IP/10 min e não inclui o e-mail", async () => {
    const u = await createTestUser();
    for (let i = 0; i < 5; i++) await login(u.email, "errada-errada", "198.51.100." + (10 + i));
    for (let i = 0; i < 3; i++) expect((await login(u.email, PASSWORD, "198.51.100.77")).status).toBe(429);
    const blocked = (await db.selectFrom("auditLog").select("metadata").where("action", "=", "usuario.login_falhou").execute()).filter((e) => (e.metadata as { motivo?: string }).motivo === "bloqueio_temporario");
    expect(blocked).toHaveLength(1);
    expect(JSON.stringify(blocked)).not.toContain(u.email);
  });

  it("logout gera usuario.logout; repetir o logout (sessão já removida) não gera outro evento", async () => {
    const u = await createAuthenticatedUser();
    expect((await postLogout(buildRequest("auth/logout", { method: "POST", cookie: u.cookie }))).status).toBe(200);
    expect((await postLogout(buildRequest("auth/logout", { method: "POST", cookie: u.cookie }))).status).toBe(200);
    const events = await db.selectFrom("auditLog").select(["actorUserId", "metadata"]).where("action", "=", "usuario.logout").execute();
    expect(events).toEqual([{ actorUserId: u.userId, metadata: {} }]);
    expect((await whoAmI(u.cookie)).status).toBe(401);
  });

  it("CONCORRÊNCIA: 12 logins simultâneos de usuários diferentes — todos entram, 12 eventos, hash-chain íntegra, sem deadlock", async () => {
    const users = await Promise.all(Array.from({ length: 12 }, () => createTestUser()));
    const results = await Promise.all(users.map((u) => login(u.email)));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(await db.selectFrom("auditLog").select("id").where("action", "=", "usuario.login_realizado").execute()).toHaveLength(12);
    const chain = await verifyAuditLogChain();
    expect(chain.integra).toBe(true);
  });

  it("CONCORRÊNCIA: logins e logouts misturados do mesmo usuário — cada sessão independente, cadeia íntegra", async () => {
    const u = await createTestUser();
    const cookies = (await Promise.all([1, 2, 3, 4].map(() => login(u.email)))).map(cookieOf);
    await Promise.all(cookies.slice(0, 2).map((c) => postLogout(buildRequest("auth/logout", { method: "POST", cookie: c }))));
    expect((await whoAmI(cookies[2])).status).toBe(200);
    expect((await whoAmI(cookies[0])).status).toBe(401);
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });
});

describe("ipPrefix", () => {
  it("reduz IPv4 a /24 e IPv6 a /48; valores desconhecidos passam como estão", () => {
    expect(ipPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix("desconhecido")).toBe("desconhecido");
  });
});
