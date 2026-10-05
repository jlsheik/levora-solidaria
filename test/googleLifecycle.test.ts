/**
 * Fase 92.1 — ciclo de vida de contas SOCIAIS (Google-only) e reautenticação por identidade. Google SINTÉTICO (googleHarness.ts):
 * prova a NOSSA máquina de estados, não o Google real. Sem sleeps/retries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { db } from "../src/helpers/db";
import { handle as deleteAccount } from "../src/endpoints/auth/account-delete_POST";
import { handle as accountMethods } from "../src/endpoints/auth/account-methods_GET";
import { handle as logout } from "../src/endpoints/auth/logout_POST";
import { handle as stepUp } from "../src/endpoints/auth/step-up_POST";
import { handle as mfaVerify } from "../src/endpoints/auth/mfa-verify_POST";
import { handle as startHandler } from "../src/endpoints/auth/google-start_POST";
import { handle as callbackHandler } from "../src/endpoints/auth/google-callback_GET";
import { handle as sessionGet } from "../src/endpoints/auth/session_GET";
import { isPrimaryReauthFresh } from "../src/helpers/accountReauth";
import { issueRecoveryCodes } from "../src/helpers/mfa";
import { buildRequest, createTestUser, enrollTestMfa, makeAccessCode, parseJson, testTotp } from "./helpers";
import {
  approve, callback, challengeCookieOf, installGoogle, location, reauthWithGoogle, sessionPair, startFlow, sessionCookieOf, REDIRECT_URI, type GoogleSim, type TokenClaims,
} from "./googleHarness";

let sim: GoogleSim;
beforeEach(async () => {
  sim = await installGoogle();
});
afterEach(() => {
  vi.useRealTimers();
  sim.uninstall();
});

const MIN = 60 * 1000;
const U = { sub: "g-only-1", email: "so-google@gmail.com", email_verified: true, name: "Só Google" };
const post = (path: string, body: unknown, cookie?: string) => buildRequest(path, { method: "POST", body, cookie });
const del = (cookie: string, body: Record<string, unknown> = { confirmation: "EXCLUIR" }) => deleteAccount(post("auth/account-delete", body, cookie));
const bodyCode = async (res: Response) => (await parseJson<{ code?: string }>(res)).code;
const userRow = (id: number) => db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const sessionsOf = (userId: number) => db.selectFrom("sessions").selectAll().where("userId", "=", userId).execute();
const audits = (...actions: string[]) => db.selectFrom("auditLog").selectAll().where("action", "in", actions).orderBy("id").execute();

/** Cadastro REAL (código → Google) de uma conta Google-only; devolve o cookie de sessão. */
async function googleOnly(claims: TokenClaims = U) {
  const { code } = await makeAccessCode();
  const flow = await startFlow("signup", code);
  const res = await callback(flow, approve(sim, flow, claims));
  expect(location(res)).toBe("/");
  const user = await db.selectFrom("users").selectAll().where("email", "=", claims.email!).executeTakeFirstOrThrow();
  return { userId: user.id, cookie: sessionPair(res)! };
}

describe("conta Google-only: estado e métodos", () => {
  it("sem senha, com identidade Google, sem MFA; nunca é criada uma senha (nem fake)", async () => {
    const { userId, cookie } = await googleOnly();
    const res = await accountMethods(buildRequest("auth/account-methods", { cookie }));
    expect(await parseJson(res)).toEqual({ hasPassword: false, providers: ["google"], mfaActive: false });
    expect(await db.selectFrom("userPasswords").selectAll().where("userId", "=", userId).execute()).toHaveLength(0);
    expect((await accountMethods(buildRequest("auth/account-methods"))).status).toBe(401);
  });

  it("login e sessão da conta Google-only funcionam sem nenhum endpoint exigir senha", async () => {
    const { userId, cookie } = await googleOnly();
    expect((await sessionGet(buildRequest("auth/session", { cookie }))).status).toBe(200);
    const flow = await startFlow("login");
    const res = await callback(flow, approve(sim, flow, U));
    expect(location(res)).toBe("/");
    expect((await sessionsOf(userId)).length).toBe(2);
  });

  it("logout encerra a sessão; depois dele a sessão não vale mais, nem para reautenticar nem para excluir", async () => {
    const { userId, cookie } = await googleOnly();
    expect((await logout(post("auth/logout", {}, cookie))).status).toBe(200);
    expect(await sessionsOf(userId)).toHaveLength(0);
    expect((await sessionGet(buildRequest("auth/session", { cookie }))).status).toBe(401);
    expect((await del(cookie)).status).toBe(401);
    const flow = await startFlow("login"); // um novo login Google continua possível
    expect(location(await callback(flow, approve(sim, flow, U)))).toBe("/");
  });
});

describe("account-delete de conta Google-only exige reautenticação da identidade", () => {
  it("sessão SOZINHA não basta: 403 reauth_social_required; nada é excluído", async () => {
    const { userId, cookie } = await googleOnly();
    const res = await del(cookie);
    expect(res.status).toBe(403);
    expect(await bodyCode(res)).toBe("reauth_social_required");
    expect((await userRow(userId)).anonymizedAt).toBeNull();
    expect(await db.selectFrom("userIdentities").selectAll().where("userId", "=", userId).execute()).toHaveLength(1);
    expect(await sessionsOf(userId)).toHaveLength(1);
  });

  it("confirmação digitada é obrigatória (contra execução acidental/CSRF): ausente ou errada ⇒ 400, mesmo com reauth recente", async () => {
    const { userId, cookie } = await googleOnly();
    const re = await reauthWithGoogle(sim, cookie, U);
    expect(location(re.res)).toBe("/?reauth=ok");
    const fresh = re.cookie!;
    const none = await del(fresh, {});
    expect(none.status).toBe(400);
    expect(await bodyCode(none)).toBe("confirmacao_necessaria");
    expect((await del(fresh, { confirmation: "excluir" })).status).toBe(400);
    expect((await del(fresh, { password: "qualquer-coisa" })).status).toBe(400); // senha não é um caminho para quem não tem senha
    expect((await userRow(userId)).anonymizedAt).toBeNull();
  });

  it("fluxo completo: reauth Google → sessão rotacionada com carimbo primário (SEM tocar o step-up do MFA) → exclusão → identidade apagada, código segue redimido", async () => {
    const { userId, cookie } = await googleOnly();
    const code = await db.selectFrom("registrationAccessCodes").select(["id"]).executeTakeFirstOrThrow();
    const re = await reauthWithGoogle(sim, cookie, U);
    expect(location(re.res)).toBe("/?reauth=ok");
    expect(re.res.headers.get("cache-control")).toBe("no-store");
    expect(re.cookie).toBeDefined();
    expect(re.cookie).not.toBe(cookie); // id rotacionado
    expect((await sessionGet(buildRequest("auth/session", { cookie }))).status).toBe(401); // o id antigo morreu
    const [session] = await sessionsOf(userId);
    expect(session.primaryReauthAt).not.toBeNull();
    expect(session.lastReauthAt).toBeNull(); // o step-up do 2º fator NÃO foi tocado
    expect(session.mfaVerifiedAt).toBeNull();

    const res = await del(re.cookie!);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(";")).toMatch(/floot_built_app_session=;|Max-Age=0|Expires=/);
    const user = await userRow(userId);
    expect(user.anonymizedAt).not.toBeNull();
    expect(user.email).not.toBe(U.email);
    expect(await db.selectFrom("userIdentities").selectAll().execute()).toHaveLength(0);
    expect(await sessionsOf(userId)).toHaveLength(0);
    expect(await db.selectFrom("userPasswords").selectAll().execute()).toHaveLength(0); // nenhuma senha foi criada no caminho
    const row = await db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", code.id).executeTakeFirstOrThrow();
    expect(row.redeemedAt).not.toBeNull();
    expect(row.redeemedByUserId).toBe(userId);
    expect((await audits("usuario.reauth_google")).map((a) => a.actorUserId)).toEqual([userId]);
    expect((await audits("usuario.conta_excluida")).map((a) => a.actorUserId)).toEqual([userId]);

    // a mesma Conta Google não entra mais e o código não volta
    const again = await startFlow("login");
    expect(location(await callback(again, approve(sim, again, U)))).toBe("/login?google=erro&motivo=nao_vinculada");
    expect((await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "signup", accessCode: "LEV-0000-0000-0000-0000-0000" } }))).status).toBe(400);
  });

  it("a janela é curta: reauth com mais de 5 min (ou carimbo no futuro) não vale; o servidor decide, não o cliente", async () => {
    const { userId, cookie } = await googleOnly();
    const re = await reauthWithGoogle(sim, cookie, U);
    await db.updateTable("sessions").set({ primaryReauthAt: new Date(Date.now() - 6 * MIN) }).where("userId", "=", userId).execute();
    const stale = await del(re.cookie!);
    expect(stale.status).toBe(403);
    expect(await bodyCode(stale)).toBe("reauth_social_required");
    await db.updateTable("sessions").set({ primaryReauthAt: new Date(Date.now() + 10 * MIN) }).where("userId", "=", userId).execute();
    expect((await del(re.cookie!)).status).toBe(403);
    expect(isPrimaryReauthFresh({ primaryReauthAt: new Date() })).toBe(true);
    expect(isPrimaryReauthFresh({ primaryReauthAt: null })).toBe(false);
    expect((await userRow(userId)).anonymizedAt).toBeNull();
  });

  it("o carimbo é POR SESSÃO: um login novo (outra sessão) da mesma conta não herda a reautenticação", async () => {
    const { cookie } = await googleOnly();
    await reauthWithGoogle(sim, cookie, U);
    const flow = await startFlow("login");
    const other = sessionPair(await callback(flow, approve(sim, flow, U)))!;
    const res = await del(other);
    expect(res.status).toBe(403);
    expect(await bodyCode(res)).toBe("reauth_social_required");
  });

  it("conta com SENHA: comportamento anterior intacto (senha obrigatória; confirmação digitada não substitui a senha)", async () => {
    const user = await createTestUser({ email: "com-senha@example.com" });
    const { createSessionCookie } = await import("./helpers");
    const cookie = await createSessionCookie(user.id);
    expect(await bodyCode(await del(cookie, {}))).toBe("senha_necessaria");
    expect((await del(cookie, { confirmation: "EXCLUIR" })).status).toBe(400);
    expect((await del(cookie, { password: "errada-123456" })).status).toBe(401);
    expect((await del(cookie, { password: "senha-de-teste-123" })).status).toBe(200);
  });

  it("conta sem senha E sem identidade externa não consegue excluir por este caminho (nenhum método para confirmar)", async () => {
    const user = await createTestUser({ email: "sem-metodo@example.com" });
    await db.deleteFrom("userPasswords").where("userId", "=", user.id).execute();
    const { createSessionCookie } = await import("./helpers");
    const cookie = await createSessionCookie(user.id);
    expect((await del(cookie)).status).toBe(400);
    expect((await userRow(user.id)).anonymizedAt).toBeNull();
  });
});

describe("reautenticação: ownership, IDOR e replay", () => {
  it("identidade de OUTRO usuário (ou desconhecida) na reautenticação ⇒ falha, nada é carimbado, nada é movido", async () => {
    const a = await googleOnly({ ...U, sub: "sub-a", email: "a@gmail.com" });
    const b = await googleOnly({ ...U, sub: "sub-b", email: "b@gmail.com" });
    const wrongUser = await reauthWithGoogle(sim, a.cookie, { sub: "sub-b", email: "b@gmail.com" });
    expect(location(wrongUser.res)).toBe("/?reauth=erro");
    expect(sessionCookieOf(wrongUser.res)).toBeUndefined();
    const unknown = await reauthWithGoogle(sim, a.cookie, { sub: "sub-desconhecida", email: "x@gmail.com" });
    expect(location(unknown.res)).toBe("/?reauth=erro");
    for (const id of [a.userId, b.userId]) expect((await sessionsOf(id))[0].primaryReauthAt).toBeNull();
    const identities = await db.selectFrom("userIdentities").select(["userId", "subject"]).orderBy("id").execute();
    expect(identities).toEqual([{ userId: a.userId, subject: "sub-a" }, { userId: b.userId, subject: "sub-b" }]);
    expect((await del(a.cookie)).status).toBe(403);
    const rejected = await audits("usuario.google_identity_rejected");
    expect(JSON.stringify(rejected.map((r) => r.metadata))).toContain("identidade_de_outro_usuario");
  });

  it("callback de OUTRA tentativa: state/cookie de A com a sessão de B (e vice-versa) ⇒ rejeitado, nenhum carimbo", async () => {
    const a = await googleOnly({ ...U, sub: "sub-a", email: "a@gmail.com" });
    const b = await googleOnly({ ...U, sub: "sub-b", email: "b@gmail.com" });
    const flowA = await startFlow("reauth", undefined, undefined, a.cookie);
    const gA = approve(sim, flowA, { sub: "sub-a", email: "a@gmail.com" });
    // atacante B tenta completar a tentativa de A com a SESSÃO de B (e o vínculo de A)
    const res = await callback(flowA, gA, { cookie: `${b.cookie}; ${flowA.binding}` });
    expect(location(res)).toBe("/?reauth=erro");
    for (const id of [a.userId, b.userId]) expect((await sessionsOf(id))[0].primaryReauthAt).toBeNull();
    // sem o cookie de vínculo, nem com a sessão certa
    const flowA2 = await startFlow("reauth", undefined, undefined, a.cookie);
    const res2 = await callback(flowA2, approve(sim, flowA2, { sub: "sub-a", email: "a@gmail.com" }), { cookie: a.cookie });
    expect(location(res2)).toBe("/?reauth=erro");
  });

  it("o usuário da reautenticação vem da SESSÃO: user_id/provider/accessCode no corpo ou na query são rejeitados/ignorados; sem sessão ⇒ 401", async () => {
    const a = await googleOnly({ ...U, sub: "sub-a", email: "a@gmail.com" });
    for (const body of [{ intent: "reauth", userId: 999 }, { intent: "reauth", provider: "microsoft" }, { intent: "reauth", accessCode: "LEV-0000-0000-0000-0000-0000" }]) {
      expect((await startHandler(buildRequest("auth/google-start", { method: "POST", body, cookie: a.cookie }))).status).toBe(400);
    }
    expect((await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "reauth" } }))).status).toBe(401);
    expect(await db.selectFrom("oauthAttempts").selectAll().execute().then((r) => r.filter((x) => x.intent === "reauth"))).toHaveLength(0);
    const flow = await startFlow("reauth", undefined, undefined, a.cookie);
    const attempt = await db.selectFrom("oauthAttempts").selectAll().where("intent", "=", "reauth").executeTakeFirstOrThrow();
    expect(attempt.userId).toBe(a.userId);
    expect(attempt.accessCodeId).toBeNull();
    expect(flow.state).toBeTruthy();
    // parâmetros extras no callback não mudam o dono da tentativa
    const qs = new URLSearchParams({ state: flow.state, code: approve(sim, flow, { sub: "sub-a", email: "a@gmail.com" }), user_id: "999", userId: "999", provider: "microsoft" });
    const res = await callbackHandler(buildRequest(`auth/google-callback?${qs}`, { method: "GET", cookie: `${a.cookie}; ${flow.binding}` }));
    expect(location(res)).toBe("/?reauth=ok");
    expect((await sessionsOf(a.userId))[0].primaryReauthAt).not.toBeNull();
  });

  it("conta SEM identidade Google não inicia reautenticação social (409)", async () => {
    const user = await createTestUser({ email: "so-senha@example.com" });
    const { createSessionCookie } = await import("./helpers");
    const res = await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "reauth" }, cookie: await createSessionCookie(user.id) }));
    expect(res.status).toBe(409);
    expect(await bodyCode(res)).toBe("google_nao_vinculado");
  });

  it("REPLAY do callback de reauth: a 2ª chamada não rotaciona nem carimba de novo; cancelamento volta com segurança", async () => {
    const { userId, cookie } = await googleOnly();
    const re = await reauthWithGoogle(sim, cookie, U);
    expect(location(re.res)).toBe("/?reauth=ok");
    const before = await sessionsOf(userId);
    const replay = await callback(re.flow, re.code, { cookie: `${re.cookie}; ${re.flow.binding}` });
    expect(location(replay)).toBe("/login?google=erro&motivo=falha"); // state já consumido: a tentativa nem é reconhecida (resposta neutra)
    const after = await sessionsOf(userId);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after[0].primaryReauthAt?.getTime()).toBe(before[0].primaryReauthAt?.getTime());
    expect((await audits("usuario.reauth_google")).length).toBe(1);

    // cancelamento no Google: volta ao app (continua logado), nada carimbado
    const flow = await startFlow("reauth", undefined, undefined, re.cookie!);
    await db.updateTable("sessions").set({ primaryReauthAt: null }).where("userId", "=", userId).execute();
    const cancelled = await callback(flow, undefined, { error: "access_denied", cookie: `${re.cookie}; ${flow.binding}` });
    expect(location(cancelled)).toBe("/?reauth=erro");
    expect(sessionCookieOf(cancelled)).toBeUndefined();
    expect((await sessionGet(buildRequest("auth/session", { cookie: re.cookie! }))).status).toBe(200);
    expect((await sessionsOf(userId))[0].primaryReauthAt).toBeNull();
  });

  it("o redirect URI vem SÓ da configuração: query/Host/Origin/Referer não o alteram", async () => {
    const { cookie } = await googleOnly();
    const flow = await startFlow("reauth", undefined, undefined, cookie);
    const qs = new URLSearchParams({ state: flow.state, code: approve(sim, flow, U), redirect_uri: "https://evil.example/cb" });
    const req = buildRequest(`auth/google-callback?${qs}`, { method: "GET", cookie: `${cookie}; ${flow.binding}` });
    req.headers.set("host", "evil.example");
    req.headers.set("origin", "https://evil.example");
    req.headers.set("referer", "https://evil.example/");
    const res = await callbackHandler(req);
    expect(location(res)).toBe("/?reauth=ok");
    expect(sim.tokenRequests.at(-1)!.get("redirect_uri")).toBe(REDIRECT_URI);
  });
});

describe("MFA: Google NÃO substitui o MFA LEVORA (login, reauth e exclusão)", () => {
  async function googleWithMfa() {
    const { userId } = await googleOnly({ ...U, sub: "sub-mfa", email: "mfa-social@gmail.com" });
    await enrollTestMfa(userId);
    await db.deleteFrom("sessions").where("userId", "=", userId).execute();
    const flow = await startFlow("login");
    const res = await callback(flow, approve(sim, flow, { sub: "sub-mfa", email: "mfa-social@gmail.com" }));
    expect(location(res)).toBe("/login?google=mfa");
    expect(sessionCookieOf(res)).toBeUndefined();
    const verified = await mfaVerify(buildRequest("auth/mfa-verify", { method: "POST", cookie: challengeCookieOf(res)!.split(";")[0], body: { code: await testTotp() } }));
    expect(verified.status).toBe(200);
    return { userId, cookie: sessionPair(verified)! };
  }
  const ageMfa = (userId: number) => {
    const old = new Date(Date.now() - 11 * MIN);
    return db.updateTable("sessions").set({ mfaVerifiedAt: old, lastReauthAt: old }).where("userId", "=", userId).execute();
  };

  it("com MFA ativo: reauth Google SOZINHO não basta (403 reauth_required); o step-up TOTP também é necessário; e o step-up SOZINHO não basta", async () => {
    const { userId, cookie } = await googleWithMfa();
    await ageMfa(userId); // MFA e step-up envelhecem (>10 min)

    // 1) só MFA (step-up), sem reauth da identidade ⇒ reauth_social_required
    const su = await stepUp(post("auth/step-up", { code: await testTotp(1) }, cookie));
    expect(su.status).toBe(200);
    const afterStepUp = sessionPair(su)!;
    expect(await bodyCode(await del(afterStepUp))).toBe("reauth_social_required");

    // 2) só reauth Google, com o MFA envelhecido ⇒ reauth_required (Google NÃO conta como MFA) e o step-up NÃO foi renovado
    await ageMfa(userId);
    const re = await reauthWithGoogle(sim, afterStepUp, { sub: "sub-mfa", email: "mfa-social@gmail.com" });
    expect(location(re.res)).toBe("/?reauth=ok");
    const [s] = await sessionsOf(userId);
    expect(s.primaryReauthAt).not.toBeNull();
    expect(s.lastReauthAt!.getTime()).toBeLessThan(Date.now() - 10 * MIN); // o carimbo do MFA continua velho
    const blocked = await del(re.cookie!);
    expect(blocked.status).toBe(403);
    expect(await bodyCode(blocked)).toBe("reauth_required");
    expect((await userRow(userId)).anonymizedAt).toBeNull();

    // 3) os dois (reauth Google herdado pela rotação do step-up + TOTP) ⇒ exclui
    const recovery = await db.transaction().execute((trx) => issueRecoveryCodes(trx, userId));
    const su2 = await stepUp(post("auth/step-up", { recoveryCode: recovery[0] }, re.cookie!));
    expect(su2.status).toBe(200);
    const ok = await del(sessionPair(su2)!);
    expect(ok.status).toBe(200);
    const user = await userRow(userId);
    expect(user.anonymizedAt).not.toBeNull();
    expect(await db.selectFrom("mfaMethods").selectAll().where("userId", "=", userId).execute()).toHaveLength(0);
  });

  it("sem MFA enrollment pendente de uma conta comum: reauth Google basta (sem exigir MFA que a conta não tem)", async () => {
    const { userId, cookie } = await googleOnly();
    const re = await reauthWithGoogle(sim, cookie, U);
    expect((await del(re.cookie!)).status).toBe(200);
    expect((await userRow(userId)).anonymizedAt).not.toBeNull();
  });
});

describe("concorrência (sem sleeps, sem retries)", () => {
  it("duas exclusões simultâneas ⇒ exatamente uma conclui; 1 auditoria de exclusão; estado consistente", async () => {
    const { userId, cookie } = await googleOnly();
    const re = await reauthWithGoogle(sim, cookie, U);
    const results = await Promise.all([del(re.cookie!), del(re.cookie!), del(re.cookie!)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 401)).toBe(true);
    expect((await audits("usuario.conta_excluida")).length).toBe(1);
    expect((await userRow(userId)).anonymizedAt).not.toBeNull();
    expect(await db.selectFrom("userIdentities").selectAll().execute()).toHaveLength(0);
  });

  it("dois reauths simultâneos da MESMA sessão ⇒ exatamente um rotaciona; uma só sessão viva", async () => {
    const { userId, cookie } = await googleOnly();
    const f1 = await startFlow("reauth", undefined, undefined, cookie);
    const f2 = await startFlow("reauth", undefined, undefined, cookie);
    const [r1, r2] = await Promise.all([
      callback(f1, approve(sim, f1, U), { cookie: `${cookie}; ${f1.binding}` }),
      callback(f2, approve(sim, f2, U), { cookie: `${cookie}; ${f2.binding}` }),
    ]);
    expect([location(r1), location(r2)].sort()).toEqual(["/?reauth=erro", "/?reauth=ok"]);
    expect(await sessionsOf(userId)).toHaveLength(1);
  });

  it("reauth × logout: ou o reauth conclui (sessão rotacionada viva) ou falha (nenhuma sessão); nunca 'ok' sem sessão", async () => {
    for (let round = 0; round < 3; round++) {
      const { userId, cookie } = await googleOnly({ ...U, sub: `rl-${round}`, email: `rl${round}@gmail.com` });
      const flow = await startFlow("reauth", undefined, undefined, cookie);
      const [res] = await Promise.all([callback(flow, approve(sim, flow, { sub: `rl-${round}`, email: `rl${round}@gmail.com` }), { cookie: `${cookie}; ${flow.binding}` }), logout(post("auth/logout", {}, cookie))]);
      const live = await sessionsOf(userId);
      if (location(res) === "/?reauth=ok") expect(live).toHaveLength(1);
      else {
        expect(location(res)).toBe("/?reauth=erro");
        expect(live).toHaveLength(0);
      }
    }
  });

  it("reauth com sessão EXPIRADA ⇒ falha neutra, nada carimbado", async () => {
    const { userId, cookie } = await googleOnly();
    const flow = await startFlow("reauth", undefined, undefined, cookie);
    await db.updateTable("sessions").set({ absoluteExpiresAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() - 1000) }).where("userId", "=", userId).execute();
    const res = await callback(flow, approve(sim, flow, U), { cookie: `${cookie}; ${flow.binding}` });
    expect(location(res)).toBe("/?reauth=erro");
    expect(await sessionsOf(userId)).toHaveLength(0);
  });

  it("reauth × step-up (MFA) simultâneos: ambos rotacionam a MESMA sessão ⇒ exatamente um vence, uma só sessão viva", async () => {
    const { userId, cookie } = await googleOnly({ ...U, sub: "sub-race", email: "race@gmail.com" });
    await enrollTestMfa(userId);
    await db.updateTable("sessions").set({ mfaVerifiedAt: new Date(), lastReauthAt: new Date() }).where("userId", "=", userId).execute();
    const flow = await startFlow("reauth", undefined, undefined, cookie);
    const [re, su] = await Promise.all([
      callback(flow, approve(sim, flow, { sub: "sub-race", email: "race@gmail.com" }), { cookie: `${cookie}; ${flow.binding}` }),
      stepUp(post("auth/step-up", { code: await testTotp(1) }, cookie)),
    ]);
    const successes = [location(re) === "/?reauth=ok", su.status === 200].filter(Boolean).length;
    expect(successes).toBe(1);
    expect(await sessionsOf(userId)).toHaveLength(1);
  });
});

describe("arquitetura geral (varredura estática)", () => {
  it("não existe 'account-delete do Google': o requisito é provider-agnóstico (reauth de identidade) e nenhuma senha é criada nos fluxos sociais", () => {
    expect(readdirSync("src/endpoints/auth").filter((f) => /google.*delete|delete.*google|google-account/i.test(f))).toEqual([]);
    const del = readFileSync("src/endpoints/auth/account-delete_POST.ts", "utf8");
    const code = del.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/google/i); // nada específico de provedor no CÓDIGO: só isPrimaryReauthFresh
    expect(del).toMatch(/isPrimaryReauthFresh/);
    for (const f of ["src/endpoints/auth/google-callback_GET.ts", "src/endpoints/auth/google-start_POST.ts", "src/helpers/oauthFlow.tsx", "src/endpoints/auth/account-methods_GET.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/insertInto\(\s*["']userPasswords["']/);
    }
    expect(readFileSync("src/helpers/accountReauth.tsx", "utf8")).not.toMatch(/^import .*google/im); // a política não depende do provedor
  });

  it("nenhuma credencial Google no código-fonte (só variáveis de ambiente) e os segredos não são impressos", () => {
    const oidc = readFileSync("src/helpers/googleOidc.tsx", "utf8");
    expect(oidc).not.toMatch(/apps\.googleusercontent\.com|GOCSPX|AIza/);
    expect(oidc).toMatch(/process\.env\.GOOGLE_CLIENT_SECRET/);
    expect(oidc).not.toMatch(/console\.(log|error|warn)/);
    const logs = readFileSync("src/endpoints/auth/google-callback_GET.ts", "utf8").split("\n").filter((l) => l.includes("console."));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => !/\.message|\.stack|,\s*error\s*\)/.test(l))).toBe(true); // só o NOME do erro, nunca a mensagem/stack (que podem ter token ou SQL)
  });

  it("frontend: o diálogo escolhe a forma de confirmar pelos MÉTODOS da conta e reage aos códigos do servidor (nunca decide sozinho)", () => {
    const dlg = readFileSync("src/components/DeleteAccountDialog.tsx", "utf8");
    expect(dlg).toMatch(/getAccountMethods/);
    expect(dlg).toMatch(/reauth_social_required/);
    expect(dlg).toMatch(/reauth_required/);
    expect(dlg).toMatch(/<GoogleButton intent="reauth">/);
    expect(dlg).not.toMatch(/localStorage|sessionStorage|URLSearchParams/);
  });
});
