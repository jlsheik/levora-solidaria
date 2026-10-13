/**
 * Fase 93 — ciclo de vida de contas Microsoft-only e reautenticação por identidade (o MESMO mecanismo provider-agnóstico da Fase 92.1).
 * Microsoft SINTÉTICA (microsoftHarness.ts): prova a NOSSA máquina de estados, não a Microsoft real. Sem sleeps/retries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { db } from "../src/helpers/db";
import { handle as deleteAccount } from "../src/endpoints/auth/account-delete_POST";
import { handle as accountMethods } from "../src/endpoints/auth/account-methods_GET";
import { handle as logout } from "../src/endpoints/auth/logout_POST";
import { handle as stepUp } from "../src/endpoints/auth/step-up_POST";
import { handle as mfaVerify } from "../src/endpoints/auth/mfa-verify_POST";
import { handle as startHandler } from "../src/endpoints/auth/microsoft-start_POST";
import { handle as callbackHandler } from "../src/endpoints/auth/microsoft-callback_GET";
import { handle as googleStart } from "../src/endpoints/auth/google-start_POST";
import { handle as sessionGet } from "../src/endpoints/auth/session_GET";
import { issueRecoveryCodes } from "../src/helpers/mfa";
import { buildRequest, createSessionCookie, createTestUser, enrollTestMfa, makeAccessCode, parseJson, testTotp } from "./helpers";
import { installGoogle } from "./googleHarness";
import {
  approve, callback, challengeCookieOf, installMicrosoft, location, reauthWithMicrosoft, REDIRECT_URI, sessionCookieOf, sessionPair, startFlow, type MicrosoftSim, type MsClaims,
} from "./microsoftHarness";

let sim: MicrosoftSim;
beforeEach(async () => {
  sim = await installMicrosoft();
});
afterEach(() => {
  vi.useRealTimers();
  sim.uninstall();
});

const MIN = 60 * 1000;
const U = { sub: "ms-only-1", email: "so-microsoft@contoso.com", name: "Só Microsoft" };
const post = (path: string, body: unknown, cookie?: string) => buildRequest(path, { method: "POST", body, cookie });
const del = (cookie: string, body: Record<string, unknown> = { confirmation: "EXCLUIR" }) => deleteAccount(post("auth/account-delete", body, cookie));
const bodyCode = async (res: Response) => (await parseJson<{ code?: string }>(res)).code;
const userRow = (id: number) => db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const sessionsOf = (userId: number) => db.selectFrom("sessions").selectAll().where("userId", "=", userId).execute();
const audits = (...actions: string[]) => db.selectFrom("auditLog").selectAll().where("action", "in", actions).orderBy("id").execute();

/** Cadastro REAL (código → Microsoft) de uma conta Microsoft-only; devolve o cookie de sessão. */
async function microsoftOnly(claims: MsClaims = U) {
  const { code } = await makeAccessCode();
  const flow = await startFlow("signup", code);
  const res = await callback(flow, approve(sim, flow, claims));
  expect(location(res)).toBe("/");
  const user = await db.selectFrom("users").selectAll().where("email", "=", claims.email!).executeTakeFirstOrThrow();
  return { userId: user.id, cookie: sessionPair(res)! };
}

describe("conta Microsoft-only: estado e métodos", () => {
  it("sem senha, com identidade Microsoft, sem MFA; nunca é criada uma senha (nem fake)", async () => {
    const { userId, cookie } = await microsoftOnly();
    const res = await accountMethods(buildRequest("auth/account-methods", { cookie }));
    expect(await parseJson(res)).toEqual({ hasPassword: false, providers: ["microsoft"], mfaActive: false });
    expect(await db.selectFrom("userPasswords").selectAll().where("userId", "=", userId).execute()).toHaveLength(0);
  });

  it("login e sessão funcionam sem nenhum endpoint exigir senha; logout encerra a sessão e a invalida para reautenticar/excluir; novo login continua possível", async () => {
    const { userId, cookie } = await microsoftOnly();
    expect((await sessionGet(buildRequest("auth/session", { cookie }))).status).toBe(200);
    const flow = await startFlow("login");
    expect(location(await callback(flow, approve(sim, flow, U)))).toBe("/");
    expect((await sessionsOf(userId)).length).toBe(2);
    expect((await logout(post("auth/logout", {}, cookie))).status).toBe(200);
    expect((await sessionGet(buildRequest("auth/session", { cookie }))).status).toBe(401);
    expect((await del(cookie)).status).toBe(401);
    expect((await startHandler(post("auth/microsoft-start", { intent: "reauth" }, cookie))).status).toBe(401);
  });
});

describe("account-delete de conta Microsoft-only exige reautenticação da identidade (mecanismo genérico)", () => {
  it("sessão SOZINHA não basta: 403 reauth_social_required; nada é excluído", async () => {
    const { userId, cookie } = await microsoftOnly();
    const res = await del(cookie);
    expect(res.status).toBe(403);
    expect(await bodyCode(res)).toBe("reauth_social_required");
    expect((await userRow(userId)).anonymizedAt).toBeNull();
    expect(await db.selectFrom("userIdentities").selectAll().where("userId", "=", userId).execute()).toHaveLength(1);
  });

  it("confirmação digitada é obrigatória: ausente ou errada ⇒ 400, mesmo com reauth recente; senha não é caminho para quem não tem senha", async () => {
    const { userId, cookie } = await microsoftOnly();
    const re = await reauthWithMicrosoft(sim, cookie, U);
    expect(location(re.res)).toBe("/?reauth=ok");
    expect(await bodyCode(await del(re.cookie!, {}))).toBe("confirmacao_necessaria");
    expect((await del(re.cookie!, { confirmation: "excluir" })).status).toBe(400);
    expect((await del(re.cookie!, { password: "qualquer-coisa" })).status).toBe(400);
    expect((await userRow(userId)).anonymizedAt).toBeNull();
  });

  it("fluxo completo: reauth Microsoft → sessão rotacionada com carimbo primário (SEM tocar o step-up do MFA) → exclusão → identidade apagada, código segue redimido, a conta não volta", async () => {
    const { userId, cookie } = await microsoftOnly();
    const code = await db.selectFrom("registrationAccessCodes").select(["id"]).executeTakeFirstOrThrow();
    const re = await reauthWithMicrosoft(sim, cookie, U);
    expect(location(re.res)).toBe("/?reauth=ok");
    expect(re.res.headers.get("cache-control")).toBe("no-store");
    expect(re.cookie).not.toBe(cookie); // id rotacionado
    expect((await sessionGet(buildRequest("auth/session", { cookie }))).status).toBe(401);
    const [session] = await sessionsOf(userId);
    expect(session.primaryReauthAt).not.toBeNull();
    expect(session.primaryMethod).toBe("microsoft");
    expect(session.lastReauthAt).toBeNull(); // o step-up do 2º fator NÃO foi tocado
    expect(session.mfaVerifiedAt).toBeNull();

    const res = await del(re.cookie!);
    expect(res.status).toBe(200);
    const user = await userRow(userId);
    expect(user.anonymizedAt).not.toBeNull();
    expect(user.email).not.toBe(U.email);
    expect(await db.selectFrom("userIdentities").selectAll().execute()).toHaveLength(0);
    expect(await sessionsOf(userId)).toHaveLength(0);
    expect(await db.selectFrom("userPasswords").selectAll().execute()).toHaveLength(0);
    const row = await db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", code.id).executeTakeFirstOrThrow();
    expect(row.redeemedAt).not.toBeNull();
    expect(row.redeemedByUserId).toBe(userId);
    expect((await audits("usuario.reauth_microsoft")).map((a) => a.actorUserId)).toEqual([userId]);
    expect((await audits("usuario.conta_excluida")).map((a) => a.actorUserId)).toEqual([userId]);

    const again = await startFlow("login");
    expect(location(await callback(again, approve(sim, again, U)))).toBe("/login?microsoft=erro&motivo=nao_vinculada");
    expect((await startHandler(post("auth/microsoft-start", { intent: "signup", accessCode: "LEV-0000-0000-0000-0000-0000" }))).status).toBe(400);
  });

  it("a janela é curta (5 min, nunca no futuro) e o carimbo é POR SESSÃO: outro login da mesma conta não herda a reautenticação", async () => {
    const { userId, cookie } = await microsoftOnly();
    const re = await reauthWithMicrosoft(sim, cookie, U);
    await db.updateTable("sessions").set({ primaryReauthAt: new Date(Date.now() - 6 * MIN) }).where("userId", "=", userId).execute();
    expect(await bodyCode(await del(re.cookie!))).toBe("reauth_social_required");
    await db.updateTable("sessions").set({ primaryReauthAt: new Date(Date.now() + 10 * MIN) }).where("userId", "=", userId).execute();
    expect((await del(re.cookie!)).status).toBe(403);
    await db.updateTable("sessions").set({ primaryReauthAt: new Date() }).where("userId", "=", userId).execute();
    const flow = await startFlow("login");
    const other = sessionPair(await callback(flow, approve(sim, flow, U)))!;
    expect(await bodyCode(await del(other))).toBe("reauth_social_required");
    expect((await userRow(userId)).anonymizedAt).toBeNull();
  });
});

describe("reautenticação: ownership, IDOR, replay e provedor", () => {
  it("identidade de OUTRO usuário (ou desconhecida, ou de outro tenant) ⇒ falha, nada é carimbado, nada é movido", async () => {
    const a = await microsoftOnly({ ...U, sub: "sub-a", email: "a@contoso.com" });
    const b = await microsoftOnly({ ...U, sub: "sub-b", email: "b@contoso.com" });
    const wrongUser = await reauthWithMicrosoft(sim, a.cookie, { sub: "sub-b", email: "b@contoso.com" });
    expect(location(wrongUser.res)).toBe("/?reauth=erro");
    expect(sessionCookieOf(wrongUser.res)).toBeUndefined();
    expect(location((await reauthWithMicrosoft(sim, a.cookie, { sub: "sub-desconhecida" })).res)).toBe("/?reauth=erro");
    // mesmo sub, mas em OUTRO tenant: outra identidade
    expect(location((await reauthWithMicrosoft(sim, a.cookie, { sub: "sub-a", tid: "5a3b9c1e-7d2f-4e8a-b6c4-1f0e9d8c7b6a" })).res)).toBe("/?reauth=erro");
    for (const id of [a.userId, b.userId]) expect((await sessionsOf(id))[0].primaryReauthAt).toBeNull();
    expect(await db.selectFrom("userIdentities").select(["userId", "subject"]).orderBy("id").execute()).toEqual([{ userId: a.userId, subject: "sub-a" }, { userId: b.userId, subject: "sub-b" }]);
    expect((await del(a.cookie)).status).toBe(403);
    expect(JSON.stringify((await audits("usuario.microsoft_identity_rejected")).map((r) => r.metadata))).toContain("identidade_de_outro_usuario");
  });

  it("callback de OUTRA tentativa: state/cookie de A com a sessão de B ⇒ rejeitado; sem o cookie de vínculo, nem com a sessão certa", async () => {
    const a = await microsoftOnly({ ...U, sub: "sub-a", email: "a@contoso.com" });
    const b = await microsoftOnly({ ...U, sub: "sub-b", email: "b@contoso.com" });
    const flowA = await startFlow("reauth", undefined, undefined, a.cookie);
    const res = await callback(flowA, approve(sim, flowA, { sub: "sub-a", email: "a@contoso.com" }), { cookie: `${b.cookie}; ${flowA.binding}` });
    expect(location(res)).toBe("/?reauth=erro");
    for (const id of [a.userId, b.userId]) expect((await sessionsOf(id))[0].primaryReauthAt).toBeNull();
    const flowA2 = await startFlow("reauth", undefined, undefined, a.cookie);
    expect(location(await callback(flowA2, approve(sim, flowA2, { sub: "sub-a", email: "a@contoso.com" }), { cookie: a.cookie }))).toBe("/?reauth=erro");
  });

  it("o usuário da reautenticação vem da SESSÃO: userId/provider/accessCode/tid no corpo são rejeitados; na query, ignorados; sem sessão ⇒ 401", async () => {
    const a = await microsoftOnly({ ...U, sub: "sub-a", email: "a@contoso.com" });
    for (const body of [{ intent: "reauth", userId: 999 }, { intent: "reauth", provider: "google" }, { intent: "reauth", accessCode: "LEV-0000-0000-0000-0000-0000" }, { intent: "reauth", tid: "x" }]) {
      expect((await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body, cookie: a.cookie }))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body: { intent: "reauth" } }))).status).toBe(401);
    expect((await db.selectFrom("oauthAttempts").selectAll().execute()).filter((x) => x.intent === "reauth")).toHaveLength(0);
    const flow = await startFlow("reauth", undefined, undefined, a.cookie);
    const attempt = await db.selectFrom("oauthAttempts").selectAll().where("intent", "=", "reauth").executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ userId: a.userId, accessCodeId: null, provider: "microsoft" });
    const qs = new URLSearchParams({ state: flow.state, code: approve(sim, flow, { sub: "sub-a", email: "a@contoso.com" }), user_id: "999", userId: "999", provider: "google", tid: "x", sub: "sub-b" });
    const res = await callbackHandler(buildRequest(`auth/microsoft-callback?${qs}`, { method: "GET", cookie: `${a.cookie}; ${flow.binding}` }));
    expect(location(res)).toBe("/?reauth=ok");
    expect((await sessionsOf(a.userId))[0].primaryReauthAt).not.toBeNull();
  });

  it("reauth é POR PROVEDOR: conta sem identidade Microsoft (só senha, ou só Google) ⇒ 409 microsoft_nao_vinculado; conta Microsoft-only não inicia reauth do Google", async () => {
    const pw = await createTestUser({ email: "so-senha@example.com" });
    const res = await startHandler(post("auth/microsoft-start", { intent: "reauth" }, await createSessionCookie(pw.id)));
    expect(res.status).toBe(409);
    expect(await bodyCode(res)).toBe("microsoft_nao_vinculado");

    const g = await installGoogle();
    try {
      const gUser = await createTestUser({ email: "so-google@example.com" });
      await db.insertInto("userIdentities").values({ userId: gUser.id, provider: "google", issuer: "https://accounts.google.com", subject: "g-1" }).execute();
      expect(await bodyCode(await startHandler(post("auth/microsoft-start", { intent: "reauth" }, await createSessionCookie(gUser.id))))).toBe("microsoft_nao_vinculado");
      const ms = await microsoftOnly();
      const cross = await googleStart(post("auth/google-start", { intent: "reauth" }, ms.cookie));
      expect(cross.status).toBe(409);
      expect(await bodyCode(cross)).toBe("google_nao_vinculado");
    } finally {
      g.uninstall();
    }
  });

  it("REPLAY do callback de reauth: a 2ª chamada não rotaciona nem carimba de novo; cancelamento volta com segurança", async () => {
    const { userId, cookie } = await microsoftOnly();
    const re = await reauthWithMicrosoft(sim, cookie, U);
    expect(location(re.res)).toBe("/?reauth=ok");
    const before = await sessionsOf(userId);
    const replay = await callback(re.flow, re.code, { cookie: `${re.cookie}; ${re.flow.binding}` });
    expect(location(replay)).toBe("/login?microsoft=erro&motivo=falha");
    const after = await sessionsOf(userId);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after[0].primaryReauthAt?.getTime()).toBe(before[0].primaryReauthAt?.getTime());
    expect((await audits("usuario.reauth_microsoft")).length).toBe(1);

    const flow = await startFlow("reauth", undefined, undefined, re.cookie!);
    await db.updateTable("sessions").set({ primaryReauthAt: null }).where("userId", "=", userId).execute();
    const cancelled = await callback(flow, undefined, { error: "access_denied", cookie: `${re.cookie}; ${flow.binding}` });
    expect(location(cancelled)).toBe("/?reauth=erro");
    expect(sessionCookieOf(cancelled)).toBeUndefined();
    expect((await sessionGet(buildRequest("auth/session", { cookie: re.cookie! }))).status).toBe(200);
    expect((await sessionsOf(userId))[0].primaryReauthAt).toBeNull();
  });

  it("o redirect URI vem SÓ da configuração: query/Host/Origin/Referer não o alteram", async () => {
    const { cookie } = await microsoftOnly();
    const flow = await startFlow("reauth", undefined, undefined, cookie);
    const qs = new URLSearchParams({ state: flow.state, code: approve(sim, flow, U), redirect_uri: "https://evil.example/cb" });
    const req = buildRequest(`auth/microsoft-callback?${qs}`, { method: "GET", cookie: `${cookie}; ${flow.binding}` });
    req.headers.set("host", "evil.example");
    req.headers.set("origin", "https://evil.example");
    req.headers.set("referer", "https://evil.example/");
    expect(location(await callbackHandler(req))).toBe("/?reauth=ok");
    expect(sim.tokenRequests.at(-1)!.get("redirect_uri")).toBe(REDIRECT_URI);
  });
});

describe("MFA: a Microsoft NÃO substitui o MFA LEVORA (login, reauth e exclusão)", () => {
  async function microsoftWithMfa() {
    const { userId } = await microsoftOnly({ ...U, sub: "sub-mfa", email: "mfa-social@contoso.com" });
    await enrollTestMfa(userId);
    await db.deleteFrom("sessions").where("userId", "=", userId).execute();
    const flow = await startFlow("login");
    const res = await callback(flow, approve(sim, flow, { sub: "sub-mfa", email: "mfa-social@contoso.com" }));
    expect(location(res)).toBe("/login?microsoft=mfa");
    expect(sessionCookieOf(res)).toBeUndefined();
    const verified = await mfaVerify(buildRequest("auth/mfa-verify", { method: "POST", cookie: challengeCookieOf(res)!.split(";")[0], body: { code: await testTotp() } }));
    expect(verified.status).toBe(200);
    return { userId, cookie: sessionPair(verified)! };
  }
  const ageMfa = (userId: number) => {
    const old = new Date(Date.now() - 11 * MIN);
    return db.updateTable("sessions").set({ mfaVerifiedAt: old, lastReauthAt: old }).where("userId", "=", userId).execute();
  };

  it("com MFA ativo: reauth Microsoft SOZINHO não basta (403 reauth_required); o step-up TOTP também é necessário; e o step-up SOZINHO não basta (reauth_social_required)", async () => {
    const { userId, cookie } = await microsoftWithMfa();
    await ageMfa(userId);
    const su = await stepUp(post("auth/step-up", { code: await testTotp(1) }, cookie));
    expect(su.status).toBe(200);
    const afterStepUp = sessionPair(su)!;
    expect(await bodyCode(await del(afterStepUp))).toBe("reauth_social_required");

    await ageMfa(userId);
    const re = await reauthWithMicrosoft(sim, afterStepUp, { sub: "sub-mfa", email: "mfa-social@contoso.com" });
    expect(location(re.res)).toBe("/?reauth=ok");
    const [s] = await sessionsOf(userId);
    expect(s.primaryReauthAt).not.toBeNull();
    expect(s.lastReauthAt!.getTime()).toBeLessThan(Date.now() - 10 * MIN); // o carimbo do MFA continua velho
    const blocked = await del(re.cookie!);
    expect(blocked.status).toBe(403);
    expect(await bodyCode(blocked)).toBe("reauth_required");
    expect((await userRow(userId)).anonymizedAt).toBeNull();

    const recovery = await db.transaction().execute((trx) => issueRecoveryCodes(trx, userId));
    const su2 = await stepUp(post("auth/step-up", { recoveryCode: recovery[0] }, re.cookie!));
    expect(su2.status).toBe(200);
    expect((await del(sessionPair(su2)!)).status).toBe(200);
    expect((await userRow(userId)).anonymizedAt).not.toBeNull();
    expect(await db.selectFrom("mfaMethods").selectAll().where("userId", "=", userId).execute()).toHaveLength(0);
  });

  it("sem MFA: reauth Microsoft basta (não exige MFA que a conta não tem)", async () => {
    const { userId, cookie } = await microsoftOnly();
    const re = await reauthWithMicrosoft(sim, cookie, U);
    expect((await del(re.cookie!)).status).toBe(200);
    expect((await userRow(userId)).anonymizedAt).not.toBeNull();
  });
});

describe("concorrência (sem sleeps, sem retries)", () => {
  it("duas exclusões simultâneas ⇒ exatamente uma conclui; 1 auditoria de exclusão; estado consistente", async () => {
    const { userId, cookie } = await microsoftOnly();
    const re = await reauthWithMicrosoft(sim, cookie, U);
    const results = await Promise.all([del(re.cookie!), del(re.cookie!), del(re.cookie!)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 401)).toBe(true);
    expect((await audits("usuario.conta_excluida")).length).toBe(1);
    expect((await userRow(userId)).anonymizedAt).not.toBeNull();
    expect(await db.selectFrom("userIdentities").selectAll().execute()).toHaveLength(0);
  });

  it("dois reauths simultâneos da MESMA sessão ⇒ exatamente um rotaciona; uma só sessão viva", async () => {
    const { userId, cookie } = await microsoftOnly();
    const f1 = await startFlow("reauth", undefined, undefined, cookie);
    const f2 = await startFlow("reauth", undefined, undefined, cookie);
    const [r1, r2] = await Promise.all([
      callback(f1, approve(sim, f1, U), { cookie: `${cookie}; ${f1.binding}` }),
      callback(f2, approve(sim, f2, U), { cookie: `${cookie}; ${f2.binding}` }),
    ]);
    expect([location(r1), location(r2)].sort()).toEqual(["/?reauth=erro", "/?reauth=ok"]);
    expect(await sessionsOf(userId)).toHaveLength(1);
  });

  it("H: reauth × logout — ou o reauth conclui (sessão rotacionada viva) ou falha (nenhuma sessão); nunca 'ok' sem sessão", async () => {
    for (let round = 0; round < 3; round++) {
      const claims = { sub: `rl-${round}`, email: `rl${round}@contoso.com` };
      const { userId, cookie } = await microsoftOnly(claims);
      const flow = await startFlow("reauth", undefined, undefined, cookie);
      const [res] = await Promise.all([callback(flow, approve(sim, flow, claims), { cookie: `${cookie}; ${flow.binding}` }), logout(post("auth/logout", {}, cookie))]);
      const live = await sessionsOf(userId);
      if (location(res) === "/?reauth=ok") expect(live).toHaveLength(1);
      else {
        expect(location(res)).toBe("/?reauth=erro");
        expect(live).toHaveLength(0);
      }
    }
  });

  it("I: reauth com sessão EXPIRADA ⇒ falha neutra, nada carimbado", async () => {
    const { userId, cookie } = await microsoftOnly();
    const flow = await startFlow("reauth", undefined, undefined, cookie);
    await db.updateTable("sessions").set({ absoluteExpiresAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() - 1000) }).where("userId", "=", userId).execute();
    expect(location(await callback(flow, approve(sim, flow, U), { cookie: `${cookie}; ${flow.binding}` }))).toBe("/?reauth=erro");
    expect(await sessionsOf(userId)).toHaveLength(0);
  });

  it("reauth × step-up (MFA) simultâneos: ambos rotacionam a MESMA sessão ⇒ exatamente um vence, uma só sessão viva", async () => {
    const { userId, cookie } = await microsoftOnly({ ...U, sub: "sub-race", email: "race@contoso.com" });
    await enrollTestMfa(userId);
    await db.updateTable("sessions").set({ mfaVerifiedAt: new Date(), lastReauthAt: new Date() }).where("userId", "=", userId).execute();
    const flow = await startFlow("reauth", undefined, undefined, cookie);
    const [re, su] = await Promise.all([
      callback(flow, approve(sim, flow, { sub: "sub-race", email: "race@contoso.com" }), { cookie: `${cookie}; ${flow.binding}` }),
      stepUp(post("auth/step-up", { code: await testTotp(1) }, cookie)),
    ]);
    expect([location(re) === "/?reauth=ok", su.status === 200].filter(Boolean).length).toBe(1);
    expect(await sessionsOf(userId)).toHaveLength(1);
  });
});

describe("arquitetura e frontend (varredura estática)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("o ciclo de vida é provider-agnóstico: nenhum fluxo social cria senha e account-delete só conhece o requisito genérico", () => {
    for (const f of ["src/helpers/oauthCallback.tsx", "src/helpers/oauthStart.tsx", "src/endpoints/auth/microsoft-callback_GET.ts", "src/endpoints/auth/microsoft-start_POST.ts"]) {
      expect(read(f), f).not.toMatch(/insertInto\(\s*["']userPasswords["']/);
    }
    expect(read("src/endpoints/auth/account-delete_POST.ts")).toMatch(/isPrimaryReauthFresh/);
    expect(read("src/helpers/accountReauth.tsx")).not.toMatch(/^import .*(google|microsoft)/im);
    expect(readdirSync("src/endpoints/auth").filter((f) => /apple/i.test(f))).toEqual([]);
  });

  it("login: 'Entrar com Microsoft' (intent=login); cadastro: 'Continuar com Microsoft' SÓ no ramo em que o código já foi validado; exclusão: reauth pelo provedor da conta", () => {
    expect(read("src/components/PasswordLoginForm.tsx")).toMatch(/<MicrosoftButton intent="login">Entrar com Microsoft<\/MicrosoftButton>/);
    const form = read("src/components/PasswordRegisterForm.tsx");
    expect(form).toMatch(/<MicrosoftButton intent="signup" accessCode=\{accessCode\}>/);
    const gated = form.slice(form.indexOf("{!codeValid ? ("));
    expect(gated.indexOf("<MicrosoftButton")).toBeGreaterThan(gated.indexOf(") : ("));
    expect(form.slice(0, form.indexOf("{!codeValid ? ("))).not.toMatch(/<MicrosoftButton/);
    const dlg = read("src/components/DeleteAccountDialog.tsx");
    expect(dlg).toMatch(/<MicrosoftButton intent="reauth">/);
    expect(dlg).toMatch(/providers\.includes\("microsoft"\)/); // o provedor vem dos MÉTODOS da conta (servidor), não de escolha do cliente
    expect(dlg).not.toMatch(/localStorage|sessionStorage|URLSearchParams/);
  });

  it("o código de acesso só viaja no CORPO do POST: nada de URL/query/storage/histórico no botão genérico, no da Microsoft e no cliente do start", () => {
    for (const f of ["src/components/OauthStartButton.tsx", "src/components/MicrosoftButton.tsx", "src/endpoints/auth/microsoft-start_POST.schema.ts"]) {
      expect(read(f), f).not.toMatch(/localStorage|sessionStorage|indexedDB|history\.(push|replace)State|useSearchParams|location\.(search|hash)|URLSearchParams/);
    }
    expect(read("src/endpoints/auth/microsoft-start_POST.schema.ts")).toContain('authRequest<OutputType>("POST", "microsoft-start"');
    const login = read("src/pages/login.tsx");
    expect(login).toMatch(/replace: true/);
    expect(login).toMatch(/params\.has\("microsoft"\)/);
    expect(login).not.toMatch(/accessCode|localStorage|sessionStorage/);
    expect(code("src/components/MicrosoftButton.tsx")).not.toMatch(/token|secret/i);
  });
});
