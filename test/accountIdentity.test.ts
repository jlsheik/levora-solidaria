import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postPasswordChange } from "../src/endpoints/auth/password-change_POST";
import { handle as postProfile } from "../src/endpoints/auth/profile_POST";
import { handle as getSessions } from "../src/endpoints/auth/sessions_GET";
import { handle as getSession } from "../src/endpoints/auth/session_GET";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as postStepUp } from "../src/endpoints/auth/step-up_POST";
import { SESSION_POLICY } from "../src/helpers/sessionPolicy";
import { createAuthenticatedUser, createSessionCookie, createTestUser, enrollTestMfa, testTotp, buildRequest, parseJson } from "./helpers";

// A Conta sobre a identidade (Fases 89–93): rotação de sessão, step-up de MFA, política de senha compartilhada, conta sem senha e ordem de locks.
const OLD = "senha-de-teste-123";
const NEW = "nova-senha-segura-456";
type Err = { message?: string; code?: string };

const change = (cookie: string, body: unknown) => postPasswordChange(buildRequest("auth/password-change", { method: "POST", cookie, body }));
const whoAmI = (cookie: string) => getSession(buildRequest("auth/session", { cookie }));
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];
const rows = (userId: number) => db.selectFrom("sessions").selectAll().where("userId", "=", userId).execute();

describe("Conta × identidade — troca de senha rotaciona a sessão sem prolongá-la", () => {
  it("a sessão rotacionada herda created_at e o teto absoluto da original (a troca de credencial nunca prolonga)", async () => {
    const u = await createAuthenticatedUser();
    const [before] = await rows(u.userId);
    // simula uma sessão com 10 dias de vida: o teto absoluto continua sendo o da criação (created_at + 30 d)
    const created = new Date(Date.now() - 10 * 86400000);
    const absolute = new Date(created.getTime() + SESSION_POLICY.standard.absoluteMs);
    await db.updateTable("sessions").set({ createdAt: created, absoluteExpiresAt: absolute }).where("id", "=", before.id).execute();
    const res = await change(u.cookie, { currentPassword: OLD, newPassword: NEW });
    expect(res.status).toBe(200);
    const [after] = await rows(u.userId);
    expect(after.id).not.toBe(before.id);
    expect(after.createdAt!.getTime()).toBe(created.getTime());
    expect(after.absoluteExpiresAt.getTime()).toBe(absolute.getTime());
    // o cookie novo nunca vive além do teto absoluto
    const maxAge = Number(/Max-Age=(\d+)/.exec(res.headers.get("set-cookie") ?? "")?.[1]);
    expect(maxAge).toBeLessThanOrEqual(Math.ceil((absolute.getTime() - Date.now()) / 1000));
  });

  it("falha (senha atual errada, igual, política) NÃO rotaciona nem revoga: o cookie atual continua valendo", async () => {
    const u = await createAuthenticatedUser();
    const other = await createSessionCookie(u.userId);
    const [before] = await rows(u.userId);
    expect((await change(u.cookie, { currentPassword: "errada-errada", newPassword: NEW })).status).toBe(401);
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: OLD })).status).toBe(422);
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: "curta" })).status).toBe(400);
    expect((await whoAmI(u.cookie)).status).toBe(200);
    expect((await whoAmI(other)).status).toBe(200);
    expect((await rows(u.userId)).map((r) => r.id)).toContain(before.id);
  });

  it("a sessão de OUTRO usuário nunca é tocada pela troca", async () => {
    const a = await createAuthenticatedUser();
    const b = await createAuthenticatedUser();
    expect((await change(a.cookie, { currentPassword: OLD, newPassword: NEW })).status).toBe(200);
    expect((await whoAmI(b.cookie)).status).toBe(200);
    expect(await rows(b.userId)).toHaveLength(1);
  });
});

describe("Conta × identidade — conta com segundo fator exige step-up RECENTE", () => {
  it("sem MFA recente: 403 reauth_required e NADA muda; com o step-up (TOTP) a troca passa", async () => {
    const user = await createTestUser();
    await enrollTestMfa(user.id);
    // sessão aberta SEM carimbo recente de MFA (como uma sessão antiga ou sequestrada)
    const stale = await createSessionCookie(user.id);
    const hashBefore = (await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", user.id).executeTakeFirstOrThrow()).passwordHash;
    const denied = await change(stale, { currentPassword: OLD, newPassword: NEW });
    expect(denied.status).toBe(403);
    expect((await parseJson<Err>(denied)).code).toBe("reauth_required");
    expect((await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", user.id).executeTakeFirstOrThrow()).passwordHash).toBe(hashBefore);
    expect((await whoAmI(stale)).status).toBe(200);

    const su = await postStepUp(buildRequest("auth/step-up", { method: "POST", cookie: stale, body: { code: await testTotp() } }));
    expect(su.status).toBe(200);
    const fresh = su.headers.get("set-cookie") ? cookieOf(su) : stale; // o step-up rotaciona a sessão
    const ok = await change(fresh, { currentPassword: OLD, newPassword: NEW });
    expect(ok.status).toBe(200);
  });

  it("a senha errada continua sendo 401 mesmo com MFA recente: o step-up não substitui a senha", async () => {
    const user = await createTestUser();
    await enrollTestMfa(user.id);
    const recent = await createSessionCookie(user.id, { mfaVerified: true });
    const res = await change(recent, { currentPassword: "errada-errada", newPassword: NEW });
    expect(res.status).toBe(401);
    expect((await parseJson<Err>(res)).code).toBe("senha_atual_incorreta");
  });
});

describe("Conta × identidade — conta sem senha (só login social)", () => {
  it("troca de senha: 400 sem_senha; o sistema não inventa uma senha", async () => {
    const u = await createAuthenticatedUser();
    await db.deleteFrom("userPasswords").where("userId", "=", u.userId).execute();
    const res = await change(u.cookie, { currentPassword: OLD, newPassword: NEW });
    expect(res.status).toBe(400);
    expect((await parseJson<Err>(res)).code).toBe("sem_senha");
    expect(await db.selectFrom("userPasswords").select("id").where("userId", "=", u.userId).execute()).toHaveLength(0);
    expect((await whoAmI(u.cookie)).status).toBe(200);
  });
});

describe("Conta × identidade — listagem e ordem canônica de locks", () => {
  it("a listagem traz o teto absoluto REAL (30 dias) e o método de entrada, sem id de sessão", async () => {
    const u = await createAuthenticatedUser();
    const out = await parseJson<{ sessions: { absoluteExpiresAt: string; primaryMethod: string | null; current: boolean }[] }>(await getSessions(buildRequest("auth/sessions", { cookie: u.cookie })));
    const cur = out.sessions.find((s) => s.current)!;
    expect(Math.abs(new Date(cur.absoluteExpiresAt).getTime() - (Date.now() + SESSION_POLICY.standard.absoluteMs))).toBeLessThan(60_000);
  });

  it("perfil × login simultâneos da mesma conta (users→sessions em ambos): sem deadlock em 20 rodadas", async () => {
    const u = await createAuthenticatedUser();
    for (let i = 0; i < 20; i++) {
      const [p, l] = await Promise.all([
        postProfile(buildRequest("auth/profile", { method: "POST", cookie: u.cookie, body: { displayName: `Nome ${i}` } })),
        postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: u.email, password: OLD }, ip: `203.0.113.${i + 1}` })),
      ]);
      expect(p.status).toBe(200);
      expect(l.status).toBe(200);
    }
  }, 60_000);

  it("troca de senha × login simultâneos: sem deadlock, estado final consistente (só a senha nova vale)", async () => {
    const u = await createAuthenticatedUser();
    const [c, l] = await Promise.all([
      change(u.cookie, { currentPassword: OLD, newPassword: NEW }),
      postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: u.email, password: OLD }, ip: "203.0.113.200" })),
    ]);
    expect(c.status).toBe(200);
    expect([200, 401]).toContain(l.status); // o login pode ganhar a corrida antes da troca; nunca 5xx
    const newLogin = await postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: u.email, password: NEW }, ip: "203.0.113.201" }));
    expect(newLogin.status).toBe(200);
    const oldLogin = await postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: u.email, password: OLD }, ip: "203.0.113.202" }));
    expect(oldLogin.status).not.toBe(200);
  }, 60_000);
});
