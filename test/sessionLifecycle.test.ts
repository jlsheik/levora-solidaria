/**
 * Ciclo de vida e expiração das sessões (Fase 94, investigação de `sessions.expires_at`). Estes testes DESCREVEM o comportamento efetivo, medido contra as rotas
 * reais, e travam o contrato:
 *   - quem decide se uma sessão ainda autoriza uma requisição são DUAS coisas: (1) o `exp` do JWT do cookie (7 dias, renovado a cada `session_GET`) e (2) a EXISTÊNCIA da
 *     linha em `sessions` (logout/exclusão de conta apagam a linha = revogação imediata);
 *   - `sessions.expires_at` é gravado no login (login + 7 dias) e NUNCA lido nem atualizado: não decide nada (ver docs/SECURITY.md).
 * Tempo controlado: tokens com `exp` explícito e `vi.useFakeTimers({ toFake: ["Date"] })` só no teste de fronteira — sem esperas reais e sem alterar o relógio do sistema.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { SignJWT } from "jose";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "../src/helpers/db";
import { SessionExpirationSeconds } from "../src/helpers/getSetServerSession";
import { SESSION_POLICY } from "../src/helpers/sessionPolicy";
import { handle as getSession } from "../src/endpoints/auth/session_GET";
import { handle as postLogout } from "../src/endpoints/auth/logout_POST";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as getNeeds } from "../src/endpoints/needs_GET";
import { buildApp } from "../server/index";
import { createAuthenticatedUser, createTestOrganization, createTestUser, buildRequest, parseJson } from "./helpers";

const COOKIE = "floot_built_app_session";
const secret = new TextEncoder().encode(process.env.JWT_SECRET);

/** Token de sessão com exp/secret explícitos (para cenários de tempo e de falsificação). */
async function token(sessionId: string, opts: { exp?: number; key?: Uint8Array } = {}) {
  const now = Date.now();
  return new SignJWT({ id: sessionId, createdAt: now, lastAccessed: now })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(now / 1000) + SessionExpirationSeconds)
    .sign(opts.key ?? secret);
}
const sessionIdOf = async (userId: number) => (await db.selectFrom("sessions").select(["id"]).where("userId", "=", userId).executeTakeFirstOrThrow()).id;
const cookieFor = (t: string) => `${COOKIE}=${t}`;
const asSession = (cookie: string) => buildRequest("auth/session", { cookie });
const asNeeds = (cookie: string | undefined, org: number) => buildRequest(`needs?organizationId=${org}`, { cookie });
const decode = (setCookie: string) => JSON.parse(Buffer.from(setCookie.split(`${COOKIE}=`)[1].split(";")[0].split(".")[1], "base64url").toString());

afterEach(() => { vi.useRealTimers(); });

describe("o que autoriza uma requisição", () => {
  it("sessão válida dentro do prazo: 200 na sessão e na rota protegida; o cookie é renovado (+7 dias) e lastAccessed avança no banco", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id;
    const sid = await sessionIdOf(u.userId);
    const before = (await db.selectFrom("sessions").select(["lastAccessed"]).where("id", "=", sid).executeTakeFirstOrThrow()).lastAccessed!;
    await new Promise((r) => setTimeout(r, 15));
    const res = await getSession(asSession(u.cookie)); expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`Max-Age=${SessionExpirationSeconds}`);
    const p = decode(setCookie); expect(p.exp - p.iat).toBe(SessionExpirationSeconds);
    expect((await db.selectFrom("sessions").select(["lastAccessed"]).where("id", "=", sid).executeTakeFirstOrThrow()).lastAccessed!.getTime()).toBeGreaterThan(before.getTime());
    expect((await getNeeds(asNeeds(u.cookie, org))).status).toBe(200);
  });

  it("ausente / lixo / assinada com outro segredo → 401 'Not authenticated', todos iguais e sem eco do token", async () => {
    const u = await createAuthenticatedUser(); const sid = await sessionIdOf(u.userId);
    const forged = await token(sid, { key: new TextEncoder().encode("outro-segredo-qualquer-0000000000000000") });
    const cases: Array<[string, string | undefined]> = [["sem cookie", undefined], ["lixo", cookieFor("nao-e-um-jwt")], ["vazio", `${COOKIE}=`], ["outro segredo", cookieFor(forged)]];
    const bodies = new Set<string>();
    for (const [label, cookie] of cases) {
      const res = await getSession(buildRequest("auth/session", { cookie })); const text = await res.text();
      expect(res.status, label).toBe(401); expect(res.headers.get("set-cookie"), label).toBeNull();
      expect(text, label).not.toContain(sid); expect(text, label).not.toContain(forged.slice(0, 20));
      bodies.add(text);
    }
    expect(bodies.size).toBe(1); // mesma resposta: quem chama não distingue o motivo
  });

  it("JWT EXPIRADO com a linha ainda viva e `expires_at` no futuro → 401 (o `exp` do cookie vale; a coluna não protege nem libera)", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const sid = await sessionIdOf(u.userId);
    const expired = cookieFor(await token(sid, { exp: Math.floor(Date.now() / 1000) - 5 }));
    const row = await db.selectFrom("sessions").select(["expiresAt"]).where("id", "=", sid).executeTakeFirstOrThrow();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now()); // a coluna diria "ainda válida"
    expect((await getSession(asSession(expired))).status).toBe(401);
    expect((await getNeeds(asNeeds(expired, org))).status).toBe(401);
    expect((await getSession(asSession(u.cookie))).status).toBe(200); // a sessão em si segue válida com um token em dia
  });

  it("fronteira temporal do JWT: válido 1 s antes do `exp`, EXPIRADO no instante exato do `exp` (semântica do jose: exp <= agora ⇒ expirado)", async () => {
    const u = await createAuthenticatedUser(); const sid = await sessionIdOf(u.userId);
    const exp = Math.floor(Date.now() / 1000) + 3600; const t = cookieFor(await token(sid, { exp }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((exp - 1) * 1000); expect((await getSession(asSession(t))).status).toBe(200);
    vi.setSystemTime(exp * 1000); expect((await getSession(asSession(t))).status).toBe(401);
    vi.setSystemTime((exp + 1) * 1000); expect((await getSession(asSession(t))).status).toBe(401);
  });

  it("`sessions.expires_at` NÃO é lida: com a coluna no passado (e a linha recente) o token em dia continua autorizando — a coluna é um instantâneo do login, sem efeito", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const sid = await sessionIdOf(u.userId);
    await db.updateTable("sessions").set({ expiresAt: new Date(Date.now() - 24 * 3600 * 1000) }).where("id", "=", sid).execute();
    expect((await getSession(asSession(u.cookie))).status).toBe(200);
    expect((await getNeeds(asNeeds(u.cookie, org))).status).toBe(200);
    const after = await db.selectFrom("sessions").select(["expiresAt"]).where("id", "=", sid).executeTakeFirstOrThrow();
    expect(after.expiresAt.getTime()).toBeLessThan(Date.now()); // e a renovação do cookie tampouco a atualiza
  });

  it("a renovação desliza o cookie (exp = agora + 7 dias) mas não renova `expires_at`: o prazo do cookie e o da coluna divergem com o uso", async () => {
    const u = await createAuthenticatedUser(); const sid = await sessionIdOf(u.userId);
    const loginExpiry = (await db.selectFrom("sessions").select(["expiresAt"]).where("id", "=", sid).executeTakeFirstOrThrow()).expiresAt.getTime();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 5 * 24 * 3600 * 1000); // 5 dias depois
    const res = await getSession(asSession(u.cookie)); expect(res.status).toBe(200);
    const p = decode(res.headers.get("set-cookie")!);
    expect(p.exp * 1000).toBeGreaterThan(loginExpiry + 4 * 24 * 3600 * 1000); // cookie agora vai até ~12 dias após o login
    vi.useRealTimers();
    expect((await db.selectFrom("sessions").select(["expiresAt"]).where("id", "=", sid).executeTakeFirstOrThrow()).expiresAt.getTime()).toBe(loginExpiry); // coluna intocada
  });

  it("sessão revogada (linha apagada) antes do vencimento do cookie → 401 em tudo; e sessão inexistente nunca é recriada nem renovada", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const sid = await sessionIdOf(u.userId);
    await db.deleteFrom("sessions").where("id", "=", sid).execute();
    const s = await getSession(asSession(u.cookie)); expect(s.status).toBe(401); expect(s.headers.get("set-cookie")).toBeNull(); // não há renovação
    expect((await getNeeds(asNeeds(u.cookie, org))).status).toBe(401);
    expect(await db.selectFrom("sessions").select(["id"]).where("id", "=", sid).execute()).toHaveLength(0);
  });

  it("logout apaga a linha, limpa o cookie, e o mesmo cookie deixa de autorizar; repetir o logout é idempotente (200, nada a apagar); logout com cookie expirado é 401 e não autoriza nada", async () => {
    const u = await createAuthenticatedUser(); const sid = await sessionIdOf(u.userId);
    const out = await postLogout(buildRequest("auth/logout", { method: "POST", cookie: u.cookie })); expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await getSession(asSession(u.cookie))).status).toBe(401);
    const again = await postLogout(buildRequest("auth/logout", { method: "POST", cookie: u.cookie }));
    expect(again.status).toBe(200); expect(again.headers.get("set-cookie")).toContain("Max-Age=0"); // idempotente: o cookie assinado ainda é íntegro, mas a linha já não existe e nada é autorizado
    expect((await getSession(asSession(u.cookie))).status).toBe(401);
    const u2 = await createAuthenticatedUser(); const sid2 = await sessionIdOf(u2.userId);
    const expired = cookieFor(await token(sid2, { exp: Math.floor(Date.now() / 1000) - 5 }));
    expect((await postLogout(buildRequest("auth/logout", { method: "POST", cookie: expired }))).status).toBe(401);
    expect((await getSession(asSession(expired))).status).toBe(401);
    void sid;
  });

  it("excluir a conta apaga as sessões (ON DELETE CASCADE): o cookie antigo deixa de valer", async () => {
    const u = await createAuthenticatedUser();
    await db.deleteFrom("users").where("id", "=", u.userId).execute();
    expect((await getSession(asSession(u.cookie))).status).toBe(401);
  });

  it("login cria uma sessão por login (ids distintos, `expires_at` = teto absoluto de 30 dias, cookie com prazo ocioso de 7 dias) e as sessões são independentes: revogar uma não afeta a outra", async () => {
    const user = await createTestUser({ email: `multi-${Date.now()}@teste.org` });
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email: user.email, password: "senha-de-teste-123" } }));
      expect(res.status).toBe(200); cookies.push(res.headers.get("set-cookie")!.split(";")[0]);
      // identidade (§25.15): o cookie/JWT vive no máximo o prazo ocioso (7 dias), mesmo que a linha guarde o teto absoluto de 30 dias
      expect(Number(/Max-Age=(\d+)/.exec(res.headers.get("set-cookie") ?? "")?.[1])).toBe(SessionExpirationSeconds);
    }
    const rows = await db.selectFrom("sessions").select(["id", "createdAt", "expiresAt"]).where("userId", "=", user.id).execute();
    expect(rows).toHaveLength(2); expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    for (const r of rows) expect(Math.abs(r.expiresAt.getTime() - (r.createdAt!.getTime() + SESSION_POLICY.standard.absoluteMs))).toBeLessThan(2000);
    expect((await postLogout(buildRequest("auth/logout", { method: "POST", cookie: cookies[0] }))).status).toBe(200);
    expect((await getSession(asSession(cookies[0]))).status).toBe(401);
    expect((await getSession(asSession(cookies[1]))).status).toBe(200);
  });

  it("limpeza de sessões ociosas apaga só linhas com lastAccessed há mais de 7 dias (não usa `expires_at`)", async () => {
    const u = await createAuthenticatedUser(); const other = await createAuthenticatedUser();
    const sidOld = await sessionIdOf(other.userId);
    await db.updateTable("sessions").set({ lastAccessed: new Date(Date.now() - 8 * 24 * 3600 * 1000) }).where("id", "=", sidOld).execute();
    vi.spyOn(Math, "random").mockReturnValue(0); // força a limpeza probabilística (10%) a rodar nesta requisição
    try { expect((await getSession(asSession(u.cookie))).status).toBe(200); } finally { vi.restoreAllMocks(); }
    expect(await db.selectFrom("sessions").select(["id"]).where("id", "=", sidOld).execute()).toHaveLength(0);
    expect(await db.selectFrom("sessions").select(["id"]).where("userId", "=", u.userId).execute()).toHaveLength(1);
  });
});

describe("acesso direto à API (Express real) e isolamento entre organizações", () => {
  let server: Server; let base: string;
  beforeAll(async () => { server = (await buildApp()).listen(0); await new Promise<void>((r) => server.once("listening", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(() => { server.close(); });
  const get = (path: string, cookie?: string) => fetch(`${base}/_api/v1/${path}`, { headers: cookie ? { Cookie: cookie } : {} });

  it("autenticação ausente / sessão expirada / sessão revogada → 401; sessão válida em organização alheia → 403 (autorização ≠ autenticação)", async () => {
    const a = await createAuthenticatedUser(); const orgA = (await createTestOrganization(a.userId)).id;
    const b = await createAuthenticatedUser(); const orgB = (await createTestOrganization(b.userId)).id;
    const sidA = await sessionIdOf(a.userId);
    expect((await get(`needs?organizationId=${orgA}`)).status).toBe(401);
    expect((await get(`needs?organizationId=${orgA}`, cookieFor(await token(sidA, { exp: Math.floor(Date.now() / 1000) - 1 })))).status).toBe(401);
    expect((await get(`needs?organizationId=${orgA}`, a.cookie)).status).toBe(200);
    expect((await get(`needs?organizationId=${orgB}`, a.cookie)).status).toBe(403); // sessão válida, outra organização
    await db.deleteFrom("sessions").where("id", "=", sidA).execute();
    expect((await get(`needs?organizationId=${orgA}`, a.cookie)).status).toBe(401);
  });
});
