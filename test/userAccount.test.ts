import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postPasswordChange } from "../src/endpoints/auth/password-change_POST";
import { handle as postProfile } from "../src/endpoints/auth/profile_POST";
import { handle as getSessions } from "../src/endpoints/auth/sessions_GET";
import { handle as postRevoke } from "../src/endpoints/auth/sessions-revoke_POST";
import { handle as postRevokeOthers } from "../src/endpoints/auth/sessions-revoke-others_POST";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as getSession } from "../src/endpoints/auth/session_GET";
import { handle as postLogout } from "../src/endpoints/auth/logout_POST";
import { handle as postAccountDelete } from "../src/endpoints/auth/account-delete_POST";
import { sessionHandle } from "../src/helpers/userSessions";
import { createAuthenticatedUser, createSessionCookie, buildRequest, parseJson } from "./helpers";

const OLD = "senha-de-teste-123"; // ver test/helpers.ts#createTestUser
const NEW = "nova-senha-segura-456";

type Err = { message?: string; code?: string; error?: string };
type SessionsOut = { sessions: { sessionHandle: string; createdAt: Date | null; lastAccessed: Date | null; absoluteExpiresAt: Date; primaryMethod: string | null; current: boolean }[] };

const change = (cookie: string, body: unknown, ip?: string) =>
  postPasswordChange(buildRequest("auth/password-change", { method: "POST", cookie, body, ip }));
const list = async (cookie: string) => parseJson<SessionsOut>(await getSessions(buildRequest("auth/sessions", { cookie })));
const revoke = (cookie: string, handle: string) => postRevoke(buildRequest("auth/sessions-revoke", { method: "POST", cookie, body: { sessionHandle: handle } }));
const revokeOthers = (cookie: string) => postRevokeOthers(buildRequest("auth/sessions-revoke-others", { method: "POST", cookie, body: {} }));
const whoAmI = (cookie: string) => getSession(buildRequest("auth/session", { cookie }));
const sessionIdOf = async (userId: number) => (await db.selectFrom("sessions").select("id").where("userId", "=", userId).execute()).map((r) => r.id);
const hashOf = async (userId: number) => (await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", userId).executeTakeFirstOrThrow()).passwordHash;
const auditFor = (userId: number, action: string) =>
  db.selectFrom("auditLog").selectAll().where("actorUserId", "=", userId).where("action", "=", action).execute();

describe("conta do usuário — troca de senha", () => {
  it("senha correta: troca, mantém a sessão atual, revoga as outras, login novo funciona e o antigo não", async () => {
    const u = await createAuthenticatedUser();
    const other1 = await createSessionCookie(u.userId);
    const other2 = await createSessionCookie(u.userId);

    const res = await change(u.cookie, { currentPassword: OLD, newPassword: NEW });
    expect(res.status).toBe(200);
    expect((await parseJson<{ revokedSessions: number }>(res)).revokedSessions).toBe(2);

    // Identidade: a sessão atual é ROTACIONADA na troca de senha (id novo; cookie novo na resposta); o cookie ANTIGO deixa de valer.
    expect((await whoAmI(u.cookie)).status).toBe(401);
    const rotatedCookie = res.headers.get("set-cookie")!.split(";")[0];
    expect(rotatedCookie).not.toBe(u.cookie);
    expect((await whoAmI(rotatedCookie)).status).toBe(200);
    expect((await whoAmI(other1)).status).toBe(401);
    expect((await whoAmI(other2)).status).toBe(401);
    expect(await sessionIdOf(u.userId)).toHaveLength(1);

    const loginNew = await postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: u.email, password: NEW } }));
    expect(loginNew.status).toBe(200);
    const loginOld = await postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: u.email, password: OLD } }));
    expect(loginOld.status).not.toBe(200);
  });

  it("senha atual incorreta: 401, nada muda (hash e sessões)", async () => {
    const u = await createAuthenticatedUser();
    await createSessionCookie(u.userId);
    const before = await hashOf(u.userId);
    const res = await change(u.cookie, { currentPassword: "errada-errada", newPassword: NEW });
    expect(res.status).toBe(401);
    expect((await parseJson<Err>(res)).code).toBe("senha_atual_incorreta");
    expect(await hashOf(u.userId)).toBe(before);
    expect(await sessionIdOf(u.userId)).toHaveLength(2);
    expect(await auditFor(u.userId, "usuario.senha_alterada")).toHaveLength(0);
  });

  it("política: curta, longa demais (72 bytes), igual à atual, campos extras e corpo sem senha atual", async () => {
    const u = await createAuthenticatedUser();
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: "curta" })).status).toBe(400);
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: "a".repeat(73) })).status).toBe(400);
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: "ç".repeat(37) })).status).toBe(400); // 74 bytes
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: "a".repeat(72) })).status).toBe(200);
    const u2 = await createAuthenticatedUser();
    const same = await change(u2.cookie, { currentPassword: OLD, newPassword: OLD });
    expect(same.status).toBe(422);
    expect((await parseJson<Err>(same)).code).toBe("senha_igual");
    expect((await change(u2.cookie, { currentPassword: OLD, newPassword: NEW, email: "x@y.com" })).status).toBe(400);
    expect((await change(u2.cookie, { newPassword: NEW })).status).toBe(400);
    expect((await change(u2.cookie, { currentPassword: "", newPassword: NEW })).status).toBe(400);
  });

  it("sem sessão: 401; com sessão revogada: 401 e nada muda", async () => {
    expect((await change("", { currentPassword: OLD, newPassword: NEW })).status).toBe(401);
    const u = await createAuthenticatedUser();
    await db.deleteFrom("sessions").where("userId", "=", u.userId).execute();
    const before = await hashOf(u.userId);
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: NEW })).status).toBe(401);
    expect(await hashOf(u.userId)).toBe(before);
  });

  it("rate limit por usuário: a 6ª tentativa errada em 15 min é 429 — e outro usuário não é afetado", async () => {
    const u = await createAuthenticatedUser();
    for (let i = 0; i < 5; i++) expect((await change(u.cookie, { currentPassword: "errada-errada", newPassword: NEW })).status).toBe(401);
    expect((await change(u.cookie, { currentPassword: OLD, newPassword: NEW })).status).toBe(429);
    const v = await createAuthenticatedUser();
    expect((await change(v.cookie, { currentPassword: OLD, newPassword: NEW })).status).toBe(200);
  });

  it("auditoria: usuario.senha_alterada só com a contagem — sem senha, hash, cookie ou token", async () => {
    const u = await createAuthenticatedUser();
    await createSessionCookie(u.userId);
    await change(u.cookie, { currentPassword: OLD, newPassword: NEW });
    const rows = await auditFor(u.userId, "usuario.senha_alterada");
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBeNull();
    expect(rows[0].metadata).toEqual({ outrasSessoesRevogadas: 1 });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(OLD);
    expect(dump).not.toContain(NEW);
    expect(dump).not.toContain(await hashOf(u.userId));
    expect(dump).not.toContain(u.cookie.split("=")[1]);
  });

  it("a senha do usuário B não é afetada pela troca do usuário A", async () => {
    const a = await createAuthenticatedUser();
    const b = await createAuthenticatedUser();
    const bCookie2 = await createSessionCookie(b.userId);
    const hashB = await hashOf(b.userId);
    await change(a.cookie, { currentPassword: OLD, newPassword: NEW });
    expect(await hashOf(b.userId)).toBe(hashB);
    expect((await whoAmI(b.cookie)).status).toBe(200);
    expect((await whoAmI(bCookie2)).status).toBe(200);
  });
});

describe("conta do usuário — perfil", () => {
  it("atualiza o nome (com trim), devolve o usuário, audita sem gravar o nome", async () => {
    const u = await createAuthenticatedUser();
    const res = await postProfile(buildRequest("auth/profile", { method: "POST", cookie: u.cookie, body: { displayName: "  Maria Souza  " } }));
    expect(res.status).toBe(200);
    const out = await parseJson<{ user: { displayName: string; email: string; role: string } }>(res);
    expect(out.user.displayName).toBe("Maria Souza");
    expect(out.user.email).toBe(u.email);
    const row = await db.selectFrom("users").select(["displayName"]).where("id", "=", u.userId).executeTakeFirstOrThrow();
    expect(row.displayName).toBe("Maria Souza");
    const audit = await auditFor(u.userId, "usuario.perfil_atualizado");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ campos: ["displayName"] });
    expect(JSON.stringify(audit)).not.toContain("Maria");
  });

  it("nome igual ao atual: 200 e sem evento de auditoria", async () => {
    const u = await createAuthenticatedUser({ displayName: "Mesmo Nome" });
    const res = await postProfile(buildRequest("auth/profile", { method: "POST", cookie: u.cookie, body: { displayName: "Mesmo Nome" } }));
    expect(res.status).toBe(200);
    expect(await auditFor(u.userId, "usuario.perfil_atualizado")).toHaveLength(0);
  });

  it("recusa vazio, só espaços, > 80 caracteres e qualquer campo extra (email/role/organização/id) sem alterar nada", async () => {
    const u = await createAuthenticatedUser({ displayName: "Original" });
    const post = (body: unknown) => postProfile(buildRequest("auth/profile", { method: "POST", cookie: u.cookie, body }));
    expect((await post({ displayName: "" })).status).toBe(400);
    expect((await post({ displayName: "    " })).status).toBe(400);
    expect((await post({ displayName: "x".repeat(81) })).status).toBe(400);
    expect((await post({ displayName: "Ok", email: "outro@example.com" })).status).toBe(400);
    expect((await post({ displayName: "Ok", role: "admin" })).status).toBe(400);
    expect((await post({ displayName: "Ok", organizationId: 1 })).status).toBe(400);
    expect((await post({ displayName: "Ok", id: 1 })).status).toBe(400);
    const row = await db.selectFrom("users").select(["displayName", "email", "role"]).where("id", "=", u.userId).executeTakeFirstOrThrow();
    expect(row).toEqual({ displayName: "Original", email: u.email, role: "user" });
  });

  it("só altera o PRÓPRIO usuário e exige sessão", async () => {
    const a = await createAuthenticatedUser({ displayName: "A" });
    const b = await createAuthenticatedUser({ displayName: "B" });
    await postProfile(buildRequest("auth/profile", { method: "POST", cookie: a.cookie, body: { displayName: "A2" } }));
    expect((await db.selectFrom("users").select("displayName").where("id", "=", b.userId).executeTakeFirstOrThrow()).displayName).toBe("B");
    expect((await postProfile(buildRequest("auth/profile", { method: "POST", body: { displayName: "X" } }))).status).toBe(401);
  });
});

describe("conta do usuário — sessões", () => {
  it("lista só as próprias sessões, marca a atual, sem id real, IP ou user agent", async () => {
    const a = await createAuthenticatedUser();
    const a2 = await createSessionCookie(a.userId);
    const b = await createAuthenticatedUser();
    const out = await list(a.cookie);
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions.filter((s) => s.current)).toHaveLength(1);
    const realIds = [...(await sessionIdOf(a.userId)), ...(await sessionIdOf(b.userId))];
    const dump = JSON.stringify(out);
    for (const id of realIds) expect(dump).not.toContain(id);
    expect(Object.keys(out.sessions[0]).sort()).toEqual(["absoluteExpiresAt", "createdAt", "current", "lastAccessed", "primaryMethod", "sessionHandle"]);
    const fromA2 = await list(a2);
    expect(fromA2.sessions.find((s) => s.current)?.sessionHandle).not.toBe(out.sessions.find((s) => s.current)?.sessionHandle);
    expect((await getSessions(buildRequest("auth/sessions"))).status).toBe(401);
  });

  it("revoga uma outra sessão: o cookie dela passa a dar 401, a atual segue; audita só o handle", async () => {
    const a = await createAuthenticatedUser();
    const other = await createSessionCookie(a.userId);
    const target = (await list(other)).sessions.find((s) => s.current)!;
    const res = await revoke(a.cookie, target.sessionHandle);
    expect(res.status).toBe(200);
    expect((await whoAmI(other)).status).toBe(401);
    expect((await whoAmI(a.cookie)).status).toBe(200);
    const audit = await auditFor(a.userId, "usuario.sessao_revogada");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ sessionHandle: target.sessionHandle });
  });

  it("recusa revogar a sessão atual (409), handle inventado ou malformado, e nada some", async () => {
    const a = await createAuthenticatedUser();
    await createSessionCookie(a.userId);
    const cur = (await list(a.cookie)).sessions.find((s) => s.current)!;
    const r409 = await revoke(a.cookie, cur.sessionHandle);
    expect(r409.status).toBe(409);
    expect((await parseJson<Err>(r409)).code).toBe("sessao_atual");
    expect((await revoke(a.cookie, "0123456789abcdef")).status).toBe(404);
    expect((await revoke(a.cookie, "nao-e-hex")).status).toBe(400);
    expect(await sessionIdOf(a.userId)).toHaveLength(2);
  });

  it("IDOR: handle de sessão de OUTRO usuário = 404 e a sessão do outro continua válida", async () => {
    const a = await createAuthenticatedUser();
    const b = await createAuthenticatedUser();
    const bHandle = sessionHandle((await sessionIdOf(b.userId))[0]);
    expect((await revoke(a.cookie, bHandle)).status).toBe(404);
    expect((await whoAmI(b.cookie)).status).toBe(200);
    expect(await auditFor(a.userId, "usuario.sessao_revogada")).toHaveLength(0);
  });

  it("revogar as outras: mantém só a atual; chamar de novo é idempotente (0) e sem nova auditoria", async () => {
    const a = await createAuthenticatedUser();
    const o1 = await createSessionCookie(a.userId);
    const o2 = await createSessionCookie(a.userId);
    const b = await createAuthenticatedUser();
    const res = await revokeOthers(a.cookie);
    expect((await parseJson<{ revoked: number }>(res)).revoked).toBe(2);
    expect((await whoAmI(o1)).status).toBe(401);
    expect((await whoAmI(o2)).status).toBe(401);
    expect((await whoAmI(a.cookie)).status).toBe(200);
    expect((await whoAmI(b.cookie)).status).toBe(200);
    expect((await parseJson<{ revoked: number }>(await revokeOthers(a.cookie))).revoked).toBe(0);
    const audit = await auditFor(a.userId, "usuario.sessoes_revogadas");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ quantidade: 2 });
  });

  it("sessão revogada não consegue usar nenhum endpoint da Conta", async () => {
    const a = await createAuthenticatedUser();
    const old = await createSessionCookie(a.userId);
    await revokeOthers(a.cookie);
    expect((await getSessions(buildRequest("auth/sessions", { cookie: old }))).status).toBe(401);
    expect((await revokeOthers(old)).status).toBe(401);
    expect((await change(old, { currentPassword: OLD, newPassword: NEW })).status).toBe(401);
    expect((await postProfile(buildRequest("auth/profile", { method: "POST", cookie: old, body: { displayName: "X" } }))).status).toBe(401);
  });

  it("logout continua funcionando e a sessão some da lista", async () => {
    const a = await createAuthenticatedUser();
    const other = await createSessionCookie(a.userId);
    await postLogout(buildRequest("auth/logout", { method: "POST", cookie: other }));
    expect((await list(a.cookie)).sessions).toHaveLength(1);
  });
});

describe("conta do usuário — exclusão de conta (LGPD) e Conta", () => {
  it("após excluir a conta nenhum cookie antigo acessa a Conta", async () => {
    const a = await createAuthenticatedUser();
    const other = await createSessionCookie(a.userId);
    const del = await postAccountDelete(buildRequest("auth/account-delete", { method: "POST", cookie: a.cookie, body: { password: OLD } }));
    expect(del.status).toBe(200);
    for (const c of [a.cookie, other]) {
      expect((await getSessions(buildRequest("auth/sessions", { cookie: c }))).status).toBe(401);
      expect((await change(c, { currentPassword: OLD, newPassword: NEW })).status).toBe(401);
    }
  });
});

describe("conta do usuário — concorrência", () => {
  it("A: duas trocas simultâneas com a mesma senha antiga — só uma vence; a outra recebe 401", async () => {
    const u = await createAuthenticatedUser();
    const second = await createSessionCookie(u.userId);
    const [r1, r2] = await Promise.all([
      change(u.cookie, { currentPassword: OLD, newPassword: "primeira-senha-nova-1" }),
      change(second, { currentPassword: OLD, newPassword: "segunda-senha-nova-2" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 401]);
    // Quem venceu manteve a sessão; a perdedora (ou revogada pela vencedora, ou senha atual incorreta) nunca altera nada.
    expect(await sessionIdOf(u.userId)).toHaveLength(1);
    expect(await auditFor(u.userId, "usuario.senha_alterada")).toHaveLength(1);
  });

  it("B: troca de senha e logout simultâneos da sessão atual — sem deadlock, estado final consistente", async () => {
    const u = await createAuthenticatedUser();
    await createSessionCookie(u.userId);
    const [r1, r2] = await Promise.all([
      change(u.cookie, { currentPassword: OLD, newPassword: NEW }),
      postLogout(buildRequest("auth/logout", { method: "POST", cookie: u.cookie })),
    ]);
    expect([200, 401]).toContain(r1.status);
    expect([200, 401]).toContain(r2.status);
    // Logout antes da troca: a troca é recusada (401) e a outra sessão permanece; troca antes: tudo encerra.
    expect(await sessionIdOf(u.userId)).toHaveLength(r1.status === 200 ? 0 : 1);
    const changed = (await auditFor(u.userId, "usuario.senha_alterada")).length;
    expect(changed).toBe(r1.status === 200 ? 1 : 0);
    // O hash só mudou se a troca retornou 200.
    const loginNew = await postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: u.email, password: NEW } }));
    expect(loginNew.status === 200).toBe(r1.status === 200);
  });

  it("C: troca de senha e 'revogar as outras' simultâneas — sem deadlock; sessão atual sobrevive", async () => {
    const u = await createAuthenticatedUser();
    const second = await createSessionCookie(u.userId);
    await createSessionCookie(u.userId);
    const [r1, r2] = await Promise.all([change(u.cookie, { currentPassword: OLD, newPassword: NEW }), revokeOthers(second)]);
    expect([200, 401]).toContain(r1.status);
    expect([200, 401]).toContain(r2.status);
    // `second` revoga as outras (incluindo u.cookie) OU é revogada pela troca; nunca ficam duas sessões "mortas e vivas".
    const left = await sessionIdOf(u.userId);
    expect(left.length).toBe(1);
  });

  it("D: duas revogações simultâneas da mesma sessão — uma 200 e a outra 404, uma só auditoria", async () => {
    const u = await createAuthenticatedUser();
    const target = await createSessionCookie(u.userId);
    const handle = (await list(target)).sessions.find((s) => s.current)!.sessionHandle;
    const second = await createSessionCookie(u.userId);
    const [r1, r2] = await Promise.all([revoke(u.cookie, handle), revoke(second, handle)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 404]);
    expect(await auditFor(u.userId, "usuario.sessao_revogada")).toHaveLength(1);
    expect(await sessionIdOf(u.userId)).toHaveLength(2);
  });

  it("revogações cruzadas simultâneas (A revoga B e B revoga A) — sem deadlock", async () => {
    const u = await createAuthenticatedUser();
    const other = await createSessionCookie(u.userId);
    const hA = (await list(u.cookie)).sessions.find((s) => s.current)!.sessionHandle;
    const hB = (await list(other)).sessions.find((s) => s.current)!.sessionHandle;
    const [r1, r2] = await Promise.all([revoke(u.cookie, hB), revoke(other, hA)]);
    expect([200, 401, 404]).toContain(r1.status);
    expect([200, 401, 404]).toContain(r2.status);
    expect((await sessionIdOf(u.userId)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("conta do usuário — contrato do cliente (smoke)", () => {
  it("política da nova senha e do nome é a mesma no cliente e no servidor; a rota /conta exige login", async () => {
    const { newPasswordSchema } = await import("../src/endpoints/auth/password-change_POST.schema");
    const { schema: profileSchema } = await import("../src/endpoints/auth/profile_POST.schema");
    expect(newPasswordSchema.safeParse("1234567").success).toBe(false);
    expect(newPasswordSchema.safeParse("12345678").success).toBe(true);
    expect(newPasswordSchema.safeParse("a".repeat(73)).success).toBe(false);
    expect(profileSchema.safeParse({ displayName: "  Ana  " })).toMatchObject({ success: true, data: { displayName: "Ana" } });
    expect(profileSchema.safeParse({ displayName: "Ana", role: "admin" }).success).toBe(false);
    const fs = await import("node:fs");
    expect(fs.readFileSync("src/pages/conta.pageLayout.tsx", "utf8")).toContain("UserRoute");
    expect(fs.readFileSync("src/App.tsx", "utf8")).toContain('path: "/conta"');
  });
});
