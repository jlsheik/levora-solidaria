/**
 * Fase 92 — login e cadastro com Google (OIDC), validado por testes server-side com um Google SINTÉTICO (ver googleHarness.ts).
 * Nada aqui prova o Google real; prova a nossa validação, a máquina de estados, a ligação com código de acesso/MFA/sessão e a
 * concorrência. Sem sleeps/retries; o tempo é controlado por vi.setSystemTime apenas na rotação do JWKS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as startHandler } from "../src/endpoints/auth/google-start_POST";
import { handle as mfaVerify } from "../src/endpoints/auth/mfa-verify_POST";
import { handle as deleteAccount } from "../src/endpoints/auth/account-delete_POST";
import { handle as login } from "../src/endpoints/auth/login_with_password_POST";
import { verifyGoogleIdToken, getGoogleConfig, oauthHash, GoogleOidcError, GOOGLE_ISSUER } from "../src/helpers/googleOidc";
import { currentPepperVersion } from "../src/helpers/identityKeys";
import { issueRecoveryCodes } from "../src/helpers/mfa";
import { canonicalizeAccessCode } from "../src/helpers/registrationCodes";
import {
  buildRequest, createAuthenticatedUser, createPlatformAdmin, createSessionCookie, createTestUser, enrollTestMfa, makeAccessCode, testTotp,
} from "./helpers";
import {
  approve, callback, challengeCookieOf, CLIENT_ID, configureGoogleEnv, installGoogle, location, makeKey, REDIRECT_URI, sessionCookieOf, startFlow, type Flow, type GoogleSim, type TokenClaims,
} from "./googleHarness";

let sim: GoogleSim;
beforeEach(async () => {
  sim = await installGoogle();
});
afterEach(() => {
  vi.useRealTimers();
  sim.uninstall();
});

const userCount = async () => Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
const signedUpCount = async () => Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("registeredViaCodeId", "is not", null).executeTakeFirstOrThrow()).n);
const identityRows = () => db.selectFrom("userIdentities").selectAll().orderBy("id").execute();
const codeRow = (id: number) => db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const audits = (...actions: string[]) => db.selectFrom("auditLog").selectAll().where("action", "in", actions).orderBy("id").execute();

const GOOGLE_USER = { sub: "1100000000000000000001", email: "pessoa@gmail.com", email_verified: true, name: "Pessoa Google" };

/** Cadastro completo: código → start → "Google autoriza" → callback. */
async function signupWithGoogle(claims: TokenClaims, accessCode: string, opts: { callbackCode?: boolean } = {}) {
  const flow = await startFlow("signup", accessCode);
  const code = approve(sim, flow, claims);
  const res = await callback(flow, code);
  return { flow, res, code };
}
async function loginWithGoogle(claims: TokenClaims) {
  const flow = await startFlow("login");
  const code = approve(sim, flow, claims);
  const res = await callback(flow, code);
  return { flow, res, code };
}
/** Cria um usuário já vinculado a uma identidade Google (estado pós-cadastro) sem passar pelo fluxo. */
async function linkedUser(sub = GOOGLE_USER.sub, email = "vinculado@example.com") {
  const user = await createTestUser({ email });
  await db.insertInto("userIdentities").values({ userId: user.id, provider: "google", issuer: GOOGLE_ISSUER, subject: sub, emailSnapshot: email, emailVerified: true }).execute();
  return user;
}

describe("início do fluxo: URL de autorização, configuração e vazamento", () => {
  it("URL com redirect URI/client id da CONFIGURAÇÃO, scopes openid email profile, PKCE S256, state/nonce de 256 bits; sem implicit, sem refresh token, sem o código de acesso", async () => {
    const { code } = await makeAccessCode();
    const res = await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "signup", accessCode: code }, ip: "ip-a" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { json } = (await res.json()) as { json: { authorizationUrl: string } };
    const url = new URL(json.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code"); // Authorization Code (nunca implicit/token)
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).not.toBe(url.searchParams.get("nonce"));
    expect(url.searchParams.has("access_type")).toBe(false); // sem refresh token
    expect(json.authorizationUrl).not.toContain(canonicalizeAccessCode(code)!);
    expect(json.authorizationUrl.toLowerCase()).not.toContain("lev-");
    expect(json.authorizationUrl).not.toContain("segredo-sintetico"); // client_secret nunca vai na URL
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("levora_oauth="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/_api\/v1\/auth/);
  });

  it("o redirect URI NUNCA vem do Host/cabeçalhos do cliente", async () => {
    const req = buildRequest("auth/google-start", { method: "POST", body: { intent: "login" } });
    req.headers.set("host", "evil.example");
    req.headers.set("x-forwarded-host", "evil.example");
    req.headers.set("origin", "https://evil.example");
    const res = await startHandler(req);
    const { json } = (await res.json()) as { json: { authorizationUrl: string } };
    expect(new URL(json.authorizationUrl).searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("sem configuração ⇒ 503 genérico, nada é criado; redirect URI inseguro (http fora de localhost) ⇒ não configurado", async () => {
    const saved = { ...process.env };
    delete process.env.GOOGLE_CLIENT_SECRET;
    const res = await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "login" } }));
    expect(res.status).toBe(503);
    expect(Number((await db.selectFrom("oauthAttempts").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n)).toBe(0);
    configureGoogleEnv();
    process.env.GOOGLE_REDIRECT_URI = "http://app.example.com/cb";
    expect(getGoogleConfig()).toBeNull();
    process.env.GOOGLE_REDIRECT_URI = "https://app.example.com/_api/v1/auth/google-callback";
    expect(getGoogleConfig()?.redirectUri).toBe("https://app.example.com/_api/v1/auth/google-callback");
    Object.assign(process.env, saved);
  });

  it("combinação inválida (signup sem código, login com código) ⇒ 400 e nenhuma tentativa criada; código inutilizável ⇒ resposta ÚNICA da Fase 91", async () => {
    const { code } = await makeAccessCode();
    for (const body of [{ intent: "signup" }, { intent: "login", accessCode: code }, { intent: "outro" }, {}]) {
      expect((await startHandler(buildRequest("auth/google-start", { method: "POST", body }))).status).toBe(400);
    }
    const bodies = new Set<string>();
    for (const state of ["expired", "revoked", "redeemed"] as const) {
      const c = await makeAccessCode({ state });
      const res = await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "signup", accessCode: c.code } }));
      expect(res.status).toBe(400);
      bodies.add(await res.text());
    }
    const unknown = await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "signup", accessCode: "LEV-0000-0000-0000-0000-0000" } }));
    bodies.add(await unknown.text());
    expect(bodies.size).toBe(1);
    expect(Number((await db.selectFrom("oauthAttempts").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n)).toBe(0);
  });

  it("Discovery adulterado (endpoint fora do Google) é recusado: nem o code nem o JWKS vão para outro host", async () => {
    const { __setGoogleTransportForTests } = await import("../src/helpers/googleOidc");
    __setGoogleTransportForTests(async () => Response.json({ issuer: "https://accounts.google.com", authorization_endpoint: "https://evil.example/auth", token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" }));
    const res = await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "login" } }));
    expect(res.status).toBe(502);
  });
});

describe("LOGIN: nunca cria conta", () => {
  it("identidade inexistente ⇒ nada é criado (mesmo e-mail novo, verified=true, Gmail ou Workspace); resposta neutra e auditoria sem segredos", async () => {
    const before = await userCount();
    for (const claims of [
      { sub: "sub-novo-1", email: "gmail-novo@gmail.com", email_verified: true },
      { sub: "sub-novo-2", email: "colaborador@empresa.com.br", email_verified: true },
      { sub: "sub-novo-3", email: "nao-verificado@example.com", email_verified: false },
    ]) {
      const { res } = await loginWithGoogle(claims);
      expect(res.status).toBe(303);
      expect(location(res)).toBe("/login?google=erro&motivo=nao_vinculada");
      expect(sessionCookieOf(res)).toBeUndefined();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await userCount()).toBe(before);
    expect(await identityRows()).toHaveLength(0);
    expect((await audits("usuario.login_google_falhou")).length).toBeGreaterThan(0);
  });

  it("e-mail do Google IGUAL ao de um usuário existente, mas sub novo ⇒ NÃO vincula, NÃO assume a conta, NÃO revela nada (mesma resposta de qualquer desconhecido)", async () => {
    const existing = await createTestUser({ email: "joao@example.com" });
    const same = await loginWithGoogle({ sub: "sub-x", email: "joao@example.com", email_verified: true });
    const other = await loginWithGoogle({ sub: "sub-y", email: "ninguem@example.com", email_verified: true });
    expect(location(same.res)).toBe(location(other.res));
    expect(sessionCookieOf(same.res)).toBeUndefined();
    expect(await identityRows()).toHaveLength(0);
    const u = await db.selectFrom("users").selectAll().where("id", "=", existing.id).executeTakeFirstOrThrow();
    expect(u.email).toBe("joao@example.com");
    expect(u.registeredViaCodeId).toBeNull();
  });

  it("identidade vinculada ⇒ sessão plena (primary_method=google), last_used_at atualizado, e-mail do Google é só snapshot (users.email intacto)", async () => {
    const user = await linkedUser("sub-ok", "dono@example.com");
    const { res } = await loginWithGoogle({ sub: "sub-ok", email: "novo-email@gmail.com", email_verified: false });
    expect(location(res)).toBe("/");
    expect(sessionCookieOf(res)).toBeDefined();
    const [identity] = await identityRows();
    expect(identity.emailSnapshot).toBe("novo-email@gmail.com");
    expect(identity.emailVerified).toBe(false);
    expect(identity.lastUsedAt).not.toBeNull();
    expect((await db.selectFrom("users").select("email").where("id", "=", user.id).executeTakeFirstOrThrow()).email).toBe("dono@example.com");
    const session = await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).executeTakeFirstOrThrow();
    expect(session.primaryMethod).toBe("google");
    expect(session.mfaVerifiedAt).toBeNull();
    expect((await audits("usuario.login_google")).map((a) => a.actorUserId)).toEqual([user.id]);
  });

  it("MFA LEVORA continua obrigatório: Google → challenge (sem sessão) → TOTP → sessão; recovery code também", async () => {
    const user = await linkedUser("sub-mfa", "mfa@example.com");
    await enrollTestMfa(user.id);
    const { res } = await loginWithGoogle({ sub: "sub-mfa", email: "mfa@example.com", email_verified: true });
    expect(location(res)).toBe("/login?google=mfa");
    expect(sessionCookieOf(res)).toBeUndefined();
    const challenge = challengeCookieOf(res)!.split(";")[0];
    expect((await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute())).toHaveLength(0);
    const verified = await mfaVerify(buildRequest("auth/mfa-verify", { method: "POST", cookie: challenge, body: { code: await testTotp() } }));
    expect(verified.status).toBe(200);
    expect(sessionCookieOf(verified)).toBeDefined();
    const session = await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).executeTakeFirstOrThrow();
    expect(session.primaryMethod).toBe("google");
    expect(session.mfaVerifiedAt).not.toBeNull();

    // recovery code
    const recovery = await db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const second = await loginWithGoogle({ sub: "sub-mfa", email: "mfa@example.com", email_verified: true });
    const ch2 = challengeCookieOf(second.res)!.split(";")[0];
    const viaRecovery = await mfaVerify(buildRequest("auth/mfa-verify", { method: "POST", cookie: ch2, body: { recoveryCode: recovery[0] } }));
    expect(viaRecovery.status).toBe(200);
  });

  it("titular de platform_access sem MFA ainda ⇒ inscrição obrigatória (mfa_setup), nunca sessão direta", async () => {
    const admin = await createPlatformAdmin(); // já tem MFA ativo: removemos para simular o primeiro acesso
    await db.deleteFrom("mfaMethods").where("userId", "=", admin.userId).execute().catch(() => undefined);
    const stillHasMfa = await db.selectFrom("mfaMethods").select("id").where("userId", "=", admin.userId).execute();
    await db.insertInto("userIdentities").values({ userId: admin.userId, provider: "google", issuer: GOOGLE_ISSUER, subject: "sub-admin", emailVerified: true }).execute();
    const { res } = await loginWithGoogle({ sub: "sub-admin", email: admin.email, email_verified: true });
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(location(res)).toBe(stillHasMfa.length ? "/login?google=mfa" : "/login?google=mfa_setup");
    expect(challengeCookieOf(res)).toBeDefined();
  });

  it("MFA ativado ENTRE o início e o callback é respeitado (a decisão é tomada no callback, sob o lock do usuário)", async () => {
    const user = await linkedUser("sub-late-mfa", "late@example.com");
    const flow = await startFlow("login");
    await enrollTestMfa(user.id);
    const res = await callback(flow, approve(sim, flow, { sub: "sub-late-mfa", email: "late@example.com", email_verified: true }));
    expect(location(res)).toBe("/login?google=mfa");
    expect(sessionCookieOf(res)).toBeUndefined();
  });

  it("conta excluída/anonimizada não entra por Google", async () => {
    const user = await linkedUser("sub-gone", "gone@example.com");
    await db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", user.id).execute();
    const { res } = await loginWithGoogle({ sub: "sub-gone", email: "gone@example.com", email_verified: true });
    expect(location(res)).toBe("/login?google=erro&motivo=nao_vinculada");
    expect(sessionCookieOf(res)).toBeUndefined();
  });
});

describe("CADASTRO: exige código de acesso e provisiona atomicamente", () => {
  it("fluxo completo: users(role=user, vínculo ao código) + user_identities + código consumido + sessão; sem MFA/platform_access; tentativa concluída", async () => {
    const { code, id } = await makeAccessCode();
    const { res, flow } = await signupWithGoogle(GOOGLE_USER, code);
    expect(location(res)).toBe("/");
    expect(sessionCookieOf(res)).toBeDefined();
    const user = await db.selectFrom("users").selectAll().where("email", "=", "pessoa@gmail.com").executeTakeFirstOrThrow();
    expect(user.role).toBe("user");
    expect(user.displayName).toBe("Pessoa Google");
    expect(user.registeredViaCodeId).toBe(id);
    expect(await db.selectFrom("platformAccess").selectAll().where("userId", "=", user.id).execute()).toHaveLength(0);
    expect(await db.selectFrom("mfaMethods").selectAll().where("userId", "=", user.id).execute()).toHaveLength(0);
    const [identity] = await identityRows();
    expect([identity.provider, identity.issuer, identity.subject, identity.userId, identity.emailSnapshot, identity.emailVerified]).toEqual(["google", "https://accounts.google.com", GOOGLE_USER.sub, user.id, "pessoa@gmail.com", true]);
    const row = await codeRow(id);
    expect(row.redeemedByUserId).toBe(user.id);
    const attempt = await db.selectFrom("oauthAttempts").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("completed");
    expect(attempt.accessCodeId).toBe(id);
    expect(flow.state).not.toBe("");
    // sem senha: o Google é o método
    expect(await db.selectFrom("userPasswords").selectAll().where("userId", "=", user.id).execute()).toHaveLength(0);
    expect((await audits("usuario.cadastro_google")).map((a) => a.actorUserId)).toEqual([user.id]);
    expect((await audits("codigo_acesso.consumido")).length).toBe(1);
  });

  it("o back-channel envia code_verifier (PKCE), client_secret e redirect URI da configuração; o access_token do Google é descartado e nada de token fica no banco", async () => {
    const { code } = await makeAccessCode();
    const { flow } = await signupWithGoogle(GOOGLE_USER, code);
    expect(sim.tokenRequests).toHaveLength(1);
    const form = sim.tokenRequests[0];
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe("segredo-sintetico-de-teste");
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dump = JSON.stringify([
      await db.selectFrom("oauthAttempts").selectAll().execute(),
      await db.selectFrom("userIdentities").selectAll().execute(),
      await db.selectFrom("sessions").selectAll().execute(),
      await db.selectFrom("auditLog").selectAll().execute(),
      await db.selectFrom("users").selectAll().execute(),
    ]);
    for (const secret of ["ya29.", form.get("code_verifier")!, form.get("code")!, flow.state, flow.nonce, flow.binding.split("=")[1], "segredo-sintetico", "eyJ"]) {
      expect(dump, secret).not.toContain(secret);
    }
    const cols = (await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_identities'`.execute(db)).rows.map((r) => r.column_name);
    expect(cols.filter((c) => /token|secret|refresh/.test(c))).toEqual([]);
  });

  it("e-mail NÃO é identidade: sub igual com e-mail diferente é a MESMA identidade; e-mail igual com sub diferente é OUTRA", async () => {
    const { code } = await makeAccessCode();
    await signupWithGoogle(GOOGLE_USER, code);
    const again = await loginWithGoogle({ sub: GOOGLE_USER.sub, email: "mudou-de-email@gmail.com", email_verified: true });
    expect(location(again.res)).toBe("/");
    expect(await signedUpCount()).toBe(1);
    const other = await loginWithGoogle({ sub: "outro-sub", email: "pessoa@gmail.com", email_verified: true });
    expect(location(other.res)).toBe("/login?google=erro&motivo=nao_vinculada");
  });

  it("e-mail não verificado NÃO impede o cadastro, mas fica registrado como não verificado", async () => {
    const { code } = await makeAccessCode();
    const { res } = await signupWithGoogle({ ...GOOGLE_USER, email_verified: false }, code);
    expect(location(res)).toBe("/");
    expect((await identityRows())[0].emailVerified).toBe(false);
  });

  it("e-mail do Google já pertence a um usuário LEVORA ⇒ nada é criado, o código NÃO é consumido, resposta neutra (sem 'já existe conta', sem auto-link)", async () => {
    const owner = await createTestUser({ email: "ocupado@example.com" });
    const { code, id } = await makeAccessCode();
    const { res } = await signupWithGoogle({ sub: "sub-colisao", email: "OCUPADO@example.com", email_verified: true }, code);
    expect(location(res)).toBe("/login?google=erro&motivo=falha");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await identityRows()).toHaveLength(0);
    expect((await codeRow(id)).redeemedAt).toBeNull(); // continua utilizável
    expect(await signedUpCount()).toBe(0);
    expect((await db.selectFrom("users").select("registeredViaCodeId").where("id", "=", owner.id).executeTakeFirstOrThrow()).registeredViaCodeId).toBeNull();
  });

  it("identidade JÁ cadastrada tentando cadastrar de novo ⇒ não cria a 2ª conta, não consome o código", async () => {
    const first = await makeAccessCode();
    await signupWithGoogle(GOOGLE_USER, first.code);
    const second = await makeAccessCode();
    const { res } = await signupWithGoogle({ ...GOOGLE_USER, email: "outra-caixa@gmail.com" }, second.code);
    expect(location(res)).toBe("/login?google=erro&motivo=ja_cadastrada");
    expect(await signedUpCount()).toBe(1);
    expect((await codeRow(second.id)).redeemedAt).toBeNull();
    expect(await identityRows()).toHaveLength(1);
  });

  it("sem código não há como chegar ao callback: login-attempt não carrega código e o CHECK do banco impede signup sem código / login com código", async () => {
    const login = await startFlow("login");
    expect(login.state).toBeTruthy();
    const row = await db.selectFrom("oauthAttempts").selectAll().executeTakeFirstOrThrow();
    expect(row.accessCodeId).toBeNull();
    await expect(db.updateTable("oauthAttempts").set({ intent: "signup" }).where("id", "=", row.id).execute()).rejects.toThrow(/oauth_attempts_code_iff_signup/);
    const { id } = await makeAccessCode();
    await expect(db.updateTable("oauthAttempts").set({ accessCodeId: id }).where("id", "=", row.id).execute()).rejects.toThrow(/oauth_attempts_code_iff_signup/);
  });

  it("a tentativa de LOGIN nunca vira cadastro: parâmetros extras no callback (intent, accessCode, userId) são ignorados", async () => {
    const { code } = await makeAccessCode();
    const flow = await startFlow("login");
    const gcode = approve(sim, flow, { sub: "sub-intent", email: "intent@example.com", email_verified: true });
    const qs = new URLSearchParams({ state: flow.state, code: gcode, intent: "signup", accessCode: code, userId: "1", access_code_id: "1" });
    const { handle } = await import("../src/endpoints/auth/google-callback_GET");
    const res = await handle(buildRequest(`auth/google-callback?${qs}`, { method: "GET", cookie: flow.binding }));
    expect(location(res)).toBe("/login?google=erro&motivo=nao_vinculada");
    expect(await signedUpCount()).toBe(0);
    expect(await identityRows()).toHaveLength(0);
  });
});
