/**
 * Fase 93 — login e cadastro com Microsoft (OIDC), validado por testes server-side com uma Microsoft SINTÉTICA (ver microsoftHarness.ts).
 * Nada aqui prova a Microsoft real; prova a nossa validação, a máquina de estados, os tipos de conta (pessoal × corporativa/escolar × convidada),
 * a identidade (provider, issuer, sub), a ligação com código de acesso/MFA/sessão. Sem sleeps/retries.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as startHandler } from "../src/endpoints/auth/microsoft-start_POST";
import { handle as googleCallbackHandler } from "../src/endpoints/auth/google-callback_GET";
import { handle as mfaVerify } from "../src/endpoints/auth/mfa-verify_POST";
import { getMicrosoftConfig, microsoftIssuerFor, MICROSOFT_PERSONAL_TENANT_ID, __setMicrosoftTransportForTests } from "../src/helpers/microsoftOidc";
import { issueRecoveryCodes } from "../src/helpers/mfa";
import { canonicalizeAccessCode } from "../src/helpers/registrationCodes";
import { buildRequest, createPlatformAdmin, createTestUser, enrollTestMfa, makeAccessCode, testTotp } from "./helpers";
import { installGoogle } from "./googleHarness";
import {
  approve, callback, challengeCookieOf, CLIENT_ID, configureMicrosoftEnv, CORP_TID, installMicrosoft, location, makeMsKey, OTHER_CORP_TID, PERSONAL_TID, REDIRECT_URI, sessionCookieOf, startFlow,
  type MicrosoftSim, type MsClaims,
} from "./microsoftHarness";

let sim: MicrosoftSim;
beforeEach(async () => {
  sim = await installMicrosoft();
});
afterEach(() => {
  sim.uninstall();
  delete process.env.MICROSOFT_TENANT;
});

const count = async (table: "users" | "oauthAttempts") => Number((await db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
const signedUpCount = async () => Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("registeredViaCodeId", "is not", null).executeTakeFirstOrThrow()).n);
const identityRows = () => db.selectFrom("userIdentities").selectAll().orderBy("id").execute();
const codeRow = (id: number) => db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const audits = (...actions: string[]) => db.selectFrom("auditLog").selectAll().where("action", "in", actions).orderBy("id").execute();

const MS_USER = { sub: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", email: "pessoa@contoso.com", name: "Pessoa Microsoft", oid: "0a1b2c3d-1111-4222-8333-444455556666" } satisfies MsClaims;
const CORP_ISSUER = microsoftIssuerFor(CORP_TID);

async function signupWithMicrosoft(claims: MsClaims, accessCode: string) {
  const flow = await startFlow("signup", accessCode);
  const code = approve(sim, flow, claims);
  return { flow, code, res: await callback(flow, code) };
}
async function loginWithMicrosoft(claims: MsClaims) {
  const flow = await startFlow("login");
  const code = approve(sim, flow, claims);
  return { flow, code, res: await callback(flow, code) };
}
/** Usuário já vinculado a uma identidade Microsoft (estado pós-cadastro) sem passar pelo fluxo. */
async function linkedUser(opts: { sub?: string; email?: string; tid?: string; oid?: string } = {}) {
  const user = await createTestUser({ email: opts.email ?? "vinculado@example.com" });
  const tid = opts.tid ?? CORP_TID;
  await db
    .insertInto("userIdentities")
    .values({ userId: user.id, provider: "microsoft", issuer: microsoftIssuerFor(tid), subject: opts.sub ?? MS_USER.sub, emailSnapshot: opts.email ?? "vinculado@example.com", emailVerified: false, providerMetadata: { tid, ver: "2.0", ...(opts.oid ? { oid: opts.oid } : {}) } })
    .execute();
  return user;
}

describe("início do fluxo: URL de autorização, configuração e vazamento", () => {
  it("authority common, redirect URI/client id da CONFIGURAÇÃO, scopes só de identidade, PKCE S256, state/nonce de 256 bits; sem implicit, sem Graph, sem o código de acesso", async () => {
    const { code } = await makeAccessCode();
    const res = await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body: { intent: "signup", accessCode: code }, ip: "ip-a" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { json } = (await res.json()) as { json: { authorizationUrl: string } };
    const url = new URL(json.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code"); // Authorization Code (nunca implicit/token/id_token)
    expect(url.searchParams.get("response_mode")).toBe("query"); // nunca fragment
    expect(url.searchParams.get("scope")).toBe("openid profile email"); // identidade apenas: sem Graph (User.Read, Mail...), sem offline_access
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).not.toBe(url.searchParams.get("nonce"));
    expect(url.searchParams.has("tenant") || url.searchParams.has("login_hint") || url.searchParams.has("domain_hint")).toBe(false);
    expect(json.authorizationUrl).not.toContain(canonicalizeAccessCode(code)!);
    expect(json.authorizationUrl.toLowerCase()).not.toContain("lev-");
    expect(json.authorizationUrl).not.toContain("segredo-sintetico");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("levora_oauth="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/_api\/v1\/auth/);
  });

  it("o redirect URI NUNCA vem do Host/cabeçalhos do cliente", async () => {
    const req = buildRequest("auth/microsoft-start", { method: "POST", body: { intent: "login" } });
    req.headers.set("host", "evil.example");
    req.headers.set("x-forwarded-host", "evil.example");
    req.headers.set("origin", "https://evil.example");
    const res = await startHandler(req);
    const { json } = (await res.json()) as { json: { authorizationUrl: string } };
    expect(new URL(json.authorizationUrl).searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("sem configuração ⇒ 503 genérico e nada criado; redirect URI inseguro ⇒ não configurado; tenant inválido ⇒ não configurado", async () => {
    const saved = { ...process.env };
    delete process.env.MICROSOFT_CLIENT_SECRET;
    const res = await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body: { intent: "login" } }));
    expect(res.status).toBe(503);
    expect(await count("oauthAttempts")).toBe(0);
    configureMicrosoftEnv();
    process.env.MICROSOFT_REDIRECT_URI = "http://app.example.com/cb";
    expect(getMicrosoftConfig()).toBeNull();
    process.env.MICROSOFT_REDIRECT_URI = "https://app.example.com/_api/v1/auth/microsoft-callback";
    expect(getMicrosoftConfig()).toMatchObject({ redirectUri: "https://app.example.com/_api/v1/auth/microsoft-callback", tenant: "common" });
    for (const tenant of ["../evil", "contoso.onmicrosoft.com", "common/x", "https://evil.example", "NOT-A-GUID"]) {
      process.env.MICROSOFT_TENANT = tenant;
      expect(getMicrosoftConfig(), tenant).toBeNull();
    }
    for (const tenant of ["common", "organizations", "consumers", CORP_TID, CORP_TID.toUpperCase()]) {
      process.env.MICROSOFT_TENANT = tenant;
      expect(getMicrosoftConfig(), tenant).not.toBeNull();
    }
    Object.assign(process.env, saved);
  });

  it("combinação inválida ⇒ 400 e nenhuma tentativa; código inutilizável ⇒ resposta ÚNICA da Fase 91 (a mesma do Google)", async () => {
    const { code } = await makeAccessCode();
    for (const body of [{ intent: "signup" }, { intent: "login", accessCode: code }, { intent: "outro" }, {}, { intent: "login", tenant: CORP_TID }, { intent: "login", provider: "google" }]) {
      expect((await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body }))).status, JSON.stringify(body)).toBe(400);
    }
    const bodies = new Set<string>();
    for (const state of ["expired", "revoked", "redeemed"] as const) {
      const c = await makeAccessCode({ state });
      const res = await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body: { intent: "signup", accessCode: c.code } }));
      expect(res.status).toBe(400);
      bodies.add(await res.text());
    }
    bodies.add(await (await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body: { intent: "signup", accessCode: "LEV-0000-0000-0000-0000-0000" } }))).text());
    expect(bodies.size).toBe(1);
    expect(await count("oauthAttempts")).toBe(0);
  });

  it("Discovery adulterado: endpoint fora de login.microsoftonline.com, emissor de outro authority ou endpoint de OUTRO tenant ⇒ recusado (502)", async () => {
    const H = "https://login.microsoftonline.com";
    const base = {
      issuer: `${H}/{tenantid}/v2.0`,
      authorization_endpoint: `${H}/common/oauth2/v2.0/authorize`,
      token_endpoint: `${H}/common/oauth2/v2.0/token`,
      jwks_uri: `${H}/common/discovery/v2.0/keys`,
    };
    const variants: Record<string, object> = {
      "auth em host hostil": { ...base, authorization_endpoint: "https://evil.example/common/oauth2/v2.0/authorize" },
      "token em host parecido": { ...base, token_endpoint: "https://login.microsoftonline.com.evil.example/common/oauth2/v2.0/token" },
      "jwks em http": { ...base, jwks_uri: "http://login.microsoftonline.com/common/discovery/v2.0/keys" },
      "jwks de outro tenant": { ...base, jwks_uri: `${H}/${OTHER_CORP_TID}/discovery/v2.0/keys` },
      "emissor de outro authority": { ...base, issuer: `${H}/${CORP_TID}/v2.0` },
      "emissor Google": { ...base, issuer: "https://accounts.google.com" },
      "credenciais na URL": { ...base, token_endpoint: "https://user:pw@login.microsoftonline.com/common/oauth2/v2.0/token" },
    };
    for (const [name, doc] of Object.entries(variants)) {
      __setMicrosoftTransportForTests(async () => Response.json(doc));
      const res = await startHandler(buildRequest("auth/microsoft-start", { method: "POST", body: { intent: "login" } }));
      expect(res.status, name).toBe(502);
    }
  });
});

describe("TIPOS DE CONTA: pessoal, corporativa/escolar, convidada e a política do authority", () => {
  it("common aceita os DOIS públicos: conta corporativa (tid do tenant) e conta pessoal (tid fixo MSA), cada uma com o seu emissor", async () => {
    const msa = await makeMsKey("kid-msa", "msa");
    sim.published.push(msa);
    const a = await linkedUser({ sub: "sub-corp", email: "corp@example.com", tid: CORP_TID });
    const b = await linkedUser({ sub: "sub-pessoal", email: "pessoal@example.com", tid: PERSONAL_TID });
    const corp = await loginWithMicrosoft({ sub: "sub-corp", tid: CORP_TID });
    const personalFlow = await startFlow("login");
    const personal = await callback(personalFlow, approve(sim, personalFlow, { sub: "sub-pessoal", tid: PERSONAL_TID }, { signWith: msa }));
    expect([location(corp.res), location(personal)]).toEqual(["/", "/"]);
    expect(await db.selectFrom("sessions").select("userId").orderBy("userId").execute().then((r) => r.map((x) => x.userId))).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(microsoftIssuerFor(PERSONAL_TID)).toBe(`https://login.microsoftonline.com/${MICROSOFT_PERSONAL_TENANT_ID}/v2.0`);
  });

  it("conta convidada (guest): mesmo usuário em OUTRO tenant é outra identidade (issuer e sub próprios) e carrega `idp` só como metadata", async () => {
    const home = await linkedUser({ sub: "sub-home", email: "home@example.com", tid: CORP_TID });
    // o convidado entra no tenant B: iss/tid do tenant B, sub diferente (pairwise), idp = tenant de origem
    const guest = await loginWithMicrosoft({ sub: "sub-guest-no-tenant-b", tid: OTHER_CORP_TID, idp: CORP_ISSUER });
    expect(location(guest.res)).toBe("/login?microsoft=erro&motivo=nao_vinculada"); // não é a identidade do tenant de origem
    // e mesmo se o `sub` coincidir, o emissor (tenant) diferente mantém identidades separadas
    const same = await loginWithMicrosoft({ sub: "sub-home", tid: OTHER_CORP_TID });
    expect(location(same.res)).toBe("/login?microsoft=erro&motivo=nao_vinculada");
    expect(sessionCookieOf(same.res)).toBeUndefined();
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", home.id).execute()).toHaveLength(0);
    // convidado JÁ vinculado (o cadastro Microsoft está desabilitado, decisão C): o login guarda o issuer do tenant B e o idp na metadata (nunca como chave)
    await linkedUser({ sub: "sub-guest", tid: OTHER_CORP_TID, email: "convidado@example.com" });
    const guestLogin = await loginWithMicrosoft({ ...MS_USER, sub: "sub-guest", tid: OTHER_CORP_TID, idp: CORP_ISSUER });
    expect(location(guestLogin.res)).toBe("/");
    const [identity] = (await identityRows()).filter((i) => i.subject === "sub-guest");
    expect(identity.issuer).toBe(microsoftIssuerFor(OTHER_CORP_TID));
    expect(identity.providerMetadata).toMatchObject({ tid: OTHER_CORP_TID, idp: CORP_ISSUER, ver: "2.0" });
  });

  it("authority `organizations` recusa conta pessoal; `consumers` recusa corporativa; tenant GUID recusa os demais — o authority é decisão de PRODUTO na configuração", async () => {
    const msa = await makeMsKey("kid-msa", "msa");
    for (const [tenant, accepted, rejected] of [
      ["organizations", CORP_TID, PERSONAL_TID],
      ["consumers", PERSONAL_TID, CORP_TID],
      [CORP_TID, CORP_TID, OTHER_CORP_TID],
    ] as const) {
      sim.uninstall();
      sim = await installMicrosoft({ tenant });
      sim.published.push(msa);
      const keyFor = (tid: string) => (tid === PERSONAL_TID ? msa : sim.signingKey);
      await db.deleteFrom("userIdentities").execute();
      for (const [tid, ok] of [[accepted, true], [rejected, false]] as const) {
        const user = await createTestUser({ email: `u-${tenant.slice(0, 6)}-${tid.slice(0, 4)}@tenant-test.example` });
        await db.insertInto("userIdentities").values({ userId: user.id, provider: "microsoft", issuer: microsoftIssuerFor(tid), subject: `s-${tid.slice(0, 6)}` }).execute();
        const flow = await startFlow("login");
        const res = await callback(flow, approve(sim, flow, { sub: `s-${tid.slice(0, 6)}`, tid }, { signWith: keyFor(tid) }));
        expect(location(res), `${tenant} / ${tid}`).toBe(ok ? "/" : "/login?microsoft=erro&motivo=falha");
        await db.deleteFrom("userIdentities").execute();
      }
    }
  });
});

describe("LOGIN: nunca cria conta", () => {
  it("identidade inexistente ⇒ nada é criado (corporativa ou pessoal, com ou sem e-mail); resposta neutra e auditoria sem segredos", async () => {
    const msa = await makeMsKey("kid-msa", "msa");
    sim.published.push(msa);
    const before = await count("users");
    const corp = await loginWithMicrosoft({ sub: "novo-1", email: "novo@contoso.com", tid: CORP_TID });
    const flow = await startFlow("login");
    const personal = await callback(flow, approve(sim, flow, { sub: "novo-2", email: "novo@outlook.com", tid: PERSONAL_TID }, { signWith: msa }));
    const noEmail = await loginWithMicrosoft({ sub: "novo-3", email: null });
    for (const r of [corp.res, personal, noEmail.res]) {
      expect(location(r)).toBe("/login?microsoft=erro&motivo=nao_vinculada");
      expect(sessionCookieOf(r)).toBeUndefined();
    }
    expect(await count("users")).toBe(before);
    expect(await identityRows()).toHaveLength(0);
    const events = await audits("usuario.login_microsoft_falhou");
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/novo@|eyJ|novo-1/);
  });

  it("NÃO auto-vincula por e-mail: users.email igual ao e-mail da Microsoft, mas sem identidade ⇒ não entra, não vincula, não move, não sobrescreve", async () => {
    const existing = await createTestUser({ email: "pessoa@contoso.com" });
    const res = await loginWithMicrosoft({ ...MS_USER });
    expect(location(res.res)).toBe("/login?microsoft=erro&motivo=nao_vinculada");
    expect(sessionCookieOf(res.res)).toBeUndefined();
    expect(await identityRows()).toHaveLength(0);
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", existing.id).execute()).toHaveLength(0);
    // a resposta é a MESMA de um e-mail que não existe em lugar nenhum (nada revela a conta)
    const other = await loginWithMicrosoft({ ...MS_USER, sub: "outro", email: "ninguem@contoso.com" });
    expect(location(other.res)).toBe(location(res.res));
    // e o mesmo vale para preferred_username igual ao e-mail do usuário
    const upn = await loginWithMicrosoft({ sub: "upn-1", email: null, preferred_username: "pessoa@contoso.com" });
    expect(location(upn.res)).toBe(location(res.res));
  });

  it("identidade vinculada ⇒ sessão plena (primary_method=microsoft), last_used_at e metadata atualizados; e-mail da Microsoft é só snapshot NÃO verificado (users.email intacto)", async () => {
    const user = await linkedUser({ sub: MS_USER.sub, email: "vinculado@example.com", oid: MS_USER.oid });
    const { res } = await loginWithMicrosoft({ ...MS_USER, email: "mudou@contoso.com" });
    expect(location(res)).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [session] = await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute();
    expect(session.primaryMethod).toBe("microsoft");
    expect(session.mfaVerifiedAt).toBeNull();
    const [identity] = await identityRows();
    expect(identity.lastUsedAt).not.toBeNull();
    expect(identity.emailSnapshot).toBe("mudou@contoso.com");
    expect(identity.emailVerified).toBe(false);
    expect(identity.providerMetadata).toEqual({ tid: CORP_TID, ver: "2.0", oid: MS_USER.oid });
    expect((await db.selectFrom("users").select("email").where("id", "=", user.id).executeTakeFirstOrThrow()).email).toBe("vinculado@example.com");
    expect((await audits("usuario.login_microsoft")).map((a) => a.actorUserId)).toEqual([user.id]);
  });

  it("MFA LEVORA continua obrigatório: Microsoft → challenge (sem sessão) → TOTP → sessão; recovery code também. O MFA da conta Microsoft NÃO conta", async () => {
    const user = await linkedUser({ oid: MS_USER.oid });
    await enrollTestMfa(user.id);
    const { res } = await loginWithMicrosoft({ ...MS_USER });
    expect(location(res)).toBe("/login?microsoft=mfa");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute()).toHaveLength(0);
    const cookie = challengeCookieOf(res)!.split(";")[0];
    const ok = await mfaVerify(buildRequest("auth/mfa-verify", { method: "POST", cookie, body: { code: await testTotp() } }));
    expect(ok.status).toBe(200);
    const [session] = await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute();
    expect(session.primaryMethod).toBe("microsoft");
    expect(session.mfaVerifiedAt).not.toBeNull();

    const recovery = await db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const again = await loginWithMicrosoft({ ...MS_USER });
    const viaRecovery = await mfaVerify(buildRequest("auth/mfa-verify", { method: "POST", cookie: challengeCookieOf(again.res)!.split(";")[0], body: { recoveryCode: recovery[0] } }));
    expect(viaRecovery.status).toBe(200);
  });

  it("titular de platform_access sem MFA ainda ⇒ inscrição obrigatória (mfa_setup), nunca sessão direta", async () => {
    const admin = await createPlatformAdmin(); // já nasce com MFA: removemos para simular o primeiro acesso do titular
    await db.deleteFrom("mfaMethods").where("userId", "=", admin.userId).execute().catch(() => undefined); // o gatilho do banco pode impedir: o resultado é verificado abaixo
    const stillHasMfa = await db.selectFrom("mfaMethods").select("id").where("userId", "=", admin.userId).execute();
    await db.insertInto("userIdentities").values({ userId: admin.userId, provider: "microsoft", issuer: CORP_ISSUER, subject: "sub-plat" }).execute();
    const { res } = await loginWithMicrosoft({ sub: "sub-plat" });
    expect(location(res)).toBe(stillHasMfa.length ? "/login?microsoft=mfa" : "/login?microsoft=mfa_setup");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(challengeCookieOf(res)).toBeDefined();
  });

  it("MFA ativado ENTRE o início e o callback é respeitado (a decisão é tomada no callback, sob o lock do usuário)", async () => {
    const user = await linkedUser();
    const flow = await startFlow("login");
    const g = approve(sim, flow, { sub: MS_USER.sub });
    await enrollTestMfa(user.id);
    const res = await callback(flow, g);
    expect(location(res)).toBe("/login?microsoft=mfa");
    expect(sessionCookieOf(res)).toBeUndefined();
  });

  it("conta excluída/anonimizada não entra por Microsoft", async () => {
    const user = await linkedUser();
    await db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", user.id).execute();
    const { res } = await loginWithMicrosoft({ sub: MS_USER.sub });
    expect(location(res)).toBe("/login?microsoft=erro&motivo=nao_vinculada");
    expect(sessionCookieOf(res)).toBeUndefined();
  });
});

describe("CADASTRO: exige código de acesso e provisiona atomicamente", () => {
  it("CADASTRO Microsoft RECUSADO (decisão C): a Microsoft não comprova a posse do e-mail ⇒ nenhum usuário, identidade, sessão nem consumo do código; o motivo fica na auditoria", async () => {
    const { code, id } = await makeAccessCode();
    const { res } = await signupWithMicrosoft({ ...MS_USER }, code);
    expect(location(res)).toBe("/login?microsoft=erro&motivo=email_nao_verificado");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await signedUpCount()).toBe(0);
    expect(await identityRows()).toHaveLength(0);
    expect(await db.selectFrom("users").selectAll().where("email", "=", MS_USER.email).execute()).toHaveLength(0);
    expect(await db.selectFrom("sessions").selectAll().execute()).toHaveLength(0);
    const row = await codeRow(id);
    expect(row.redeemedAt).toBeNull();
    expect(row.redeemedByUserId).toBeNull();
    expect(JSON.stringify(await audits("usuario.cadastro_microsoft_falhou"))).toContain("email_nao_verificado");
    expect(await audits("usuario.cadastro_microsoft", "codigo_acesso.consumido")).toHaveLength(0);
  });

  it("o back-channel envia code_verifier (PKCE), client_secret e redirect URI da configuração; o access_token da Microsoft é descartado e NADA de token fica no banco", async () => {
    const { code } = await makeAccessCode();
    const { code: mscode } = await signupWithMicrosoft({ ...MS_USER }, code);
    const form = sim.tokenRequests.at(-1)!;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(mscode);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe("segredo-sintetico-de-teste");
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(form.get("scope")).toBe("openid profile email");
    const dump = JSON.stringify({
      identities: await identityRows(),
      users: await db.selectFrom("users").selectAll().execute(),
      sessions: await db.selectFrom("sessions").selectAll().execute(),
      attempts: await db.selectFrom("oauthAttempts").selectAll().execute(),
      audit: await db.selectFrom("auditLog").selectAll().execute(),
    });
    for (const secret of ["EwB-token-de-acesso-sintetico", "eyJ", "segredo-sintetico", mscode]) expect(dump, secret).not.toContain(secret);
  });

  it("e-mail NÃO é identidade: sub igual com e-mail diferente é a MESMA identidade; e-mail igual com sub diferente é OUTRA; preferred_username não vira e-mail", async () => {
    const user = await linkedUser({ oid: MS_USER.oid });
    const same = await loginWithMicrosoft({ ...MS_USER, email: "totalmente-outro@fabrikam.com" });
    expect(location(same.res)).toBe("/");
    expect((await db.selectFrom("sessions").select("userId").executeTakeFirstOrThrow()).userId).toBe(user.id);
    const different = await loginWithMicrosoft({ ...MS_USER, sub: "outro-sub", email: "vinculado@example.com" });
    expect(location(different.res)).toBe("/login?microsoft=erro&motivo=nao_vinculada");
    // sem claim `email` o cadastro NÃO inventa um a partir de preferred_username/upn: falha neutra, código intacto
    const { code, id } = await makeAccessCode();
    const noEmail = await signupWithMicrosoft({ sub: "sem-email", email: null, preferred_username: "alguem@contoso.com", name: "Sem Email" }, code);
    expect(location(noEmail.res)).toBe("/login?microsoft=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect(JSON.stringify(await audits("usuario.cadastro_microsoft_falhou"))).toContain("email_ausente");
  });

  it("`email_verified` do token NUNCA é aceito como prova pela Microsoft: mesmo com email_verified=true o cadastro é recusado e nada é criado", async () => {
    const { code, id } = await makeAccessCode();
    for (const claim of [true, "true", 1, null]) {
      const res = await signupWithMicrosoft({ ...MS_USER, sub: `sub-${String(claim)}`, email_verified: claim } as unknown as MsClaims, code);
      expect(location(res.res), String(claim)).toBe("/login?microsoft=erro&motivo=email_nao_verificado");
    }
    expect(await identityRows()).toHaveLength(0);
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
  });

  it("e-mail da Microsoft já pertence a um usuário LEVORA ⇒ nada é criado, o código NÃO é consumido, nada é vinculado (sem auto-link) e a resposta é neutra", async () => {
    const existing = await createTestUser({ email: "pessoa@contoso.com" });
    const { code, id } = await makeAccessCode();
    const { res } = await signupWithMicrosoft({ ...MS_USER }, code);
    expect(location(res)).toBe("/login?microsoft=erro&motivo=email_nao_verificado");
    expect(await signedUpCount()).toBe(0);
    expect(await identityRows()).toHaveLength(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", existing.id).execute()).toHaveLength(0);
  });

  it("identidade JÁ cadastrada tentando cadastrar de novo ⇒ não cria a 2ª conta, não consome o código", async () => {
    await linkedUser({ email: "dono@example.com" });
    const { code, id } = await makeAccessCode();
    const { res } = await signupWithMicrosoft({ ...MS_USER, email: "novo-email@contoso.com" }, code);
    expect(location(res)).toBe("/login?microsoft=erro&motivo=ja_cadastrada");
    expect(await signedUpCount()).toBe(0);
    expect(await identityRows()).toHaveLength(1);
    expect((await codeRow(id)).redeemedAt).toBeNull();
  });

  it("sem código não há como chegar ao callback: o banco impede signup sem código e login com código; a tentativa de LOGIN nunca vira cadastro", async () => {
    const fields = { stateHash: Buffer.from("a".repeat(32)), bindingHash: Buffer.from("b"), nonceHash: Buffer.from("n"), pepperVersion: 1, pkceVerifierCt: Buffer.from("c"), pkceKeyId: 1, provider: "microsoft", expiresAt: new Date(Date.now() + 600_000) };
    await expect(db.insertInto("oauthAttempts").values({ ...fields, intent: "signup", accessCodeId: null }).execute()).rejects.toThrow(/oauth_attempts_code_iff_signup/);
    const { id } = await makeAccessCode();
    await expect(db.insertInto("oauthAttempts").values({ ...fields, intent: "login", accessCodeId: id }).execute()).rejects.toThrow(/oauth_attempts_code_iff_signup/);
    await expect(db.insertInto("oauthAttempts").values({ ...fields, provider: "apple", intent: "login", accessCodeId: null }).execute()).rejects.toThrow(/oauth_attempts_provider_check/);

    const flow = await startFlow("login");
    const { code } = await makeAccessCode();
    const qs = new URLSearchParams({ state: flow.state, code: approve(sim, flow, { ...MS_USER }), intent: "signup", accessCode: code, provider: "google" });
    const { handle } = await import("../src/endpoints/auth/microsoft-callback_GET");
    const res = await handle(buildRequest(`auth/microsoft-callback?${qs}`, { method: "GET", cookie: flow.binding }));
    expect(location(res)).toBe("/login?microsoft=erro&motivo=nao_vinculada");
    expect(await signedUpCount()).toBe(0);
  });
});

describe("IDENTIDADE: (provider, issuer, sub) — colisões e separação entre provedores", () => {
  it("mesmo issuer+sub diferente, mesmo sub em outro issuer e oid/tid diferentes são identidades DISTINTAS; a repetição é barrada pelo banco", async () => {
    const a = await createTestUser({ email: "a@example.com" });
    const b = await createTestUser({ email: "b@example.com" });
    const c = await createTestUser({ email: "c@example.com" });
    const ins = (userId: number, issuer: string, subject: string, md: object = {}, provider = "microsoft") =>
      db.insertInto("userIdentities").values({ userId, provider, issuer, subject, providerMetadata: md }).execute();
    await ins(a.id, microsoftIssuerFor(CORP_TID), "X", { oid: "o1", tid: CORP_TID }); // issuer=A sub=X
    await ins(b.id, microsoftIssuerFor(CORP_TID), "Y", { oid: "o1", tid: CORP_TID }); // issuer=A sub=Y (mesmo oid+tid: o oid NÃO é chave)
    await ins(c.id, microsoftIssuerFor(OTHER_CORP_TID), "X", { oid: "o1", tid: OTHER_CORP_TID }); // issuer=B sub=X
    await expect(ins(b.id, microsoftIssuerFor(CORP_TID), "X")).rejects.toThrow(/user_identities_provider_issuer_subject_key/);
    await ins(c.id, "https://accounts.google.com", "X", {}, "google"); // outro provider, mesmo sub
    expect(await identityRows()).toHaveLength(4);
  });

  it("login resolve pelo trio (provider, issuer, sub): a mesma pessoa em dois tenants só entra pela identidade daquele tenant", async () => {
    const homeUser = await linkedUser({ sub: "sub-x", email: "home@example.com", tid: CORP_TID });
    const guestUser = await linkedUser({ sub: "sub-x", email: "guest@example.com", tid: OTHER_CORP_TID });
    const inHome = await loginWithMicrosoft({ sub: "sub-x", tid: CORP_TID });
    const inGuest = await loginWithMicrosoft({ sub: "sub-x", tid: OTHER_CORP_TID });
    expect([location(inHome.res), location(inGuest.res)]).toEqual(["/", "/"]);
    const sessions = await db.selectFrom("sessions").select("userId").execute();
    expect(sessions.map((s) => s.userId).sort()).toEqual([homeUser.id, guestUser.id].sort());
  });

  it("`oid` divergente para o MESMO issuer+sub é anômalo: rejeitado, nada é atualizado nem aberto", async () => {
    await linkedUser({ oid: MS_USER.oid });
    const { res } = await loginWithMicrosoft({ ...MS_USER, oid: "ffffffff-1111-4222-8333-444455556666" });
    expect(location(res)).toBe("/login?microsoft=erro&motivo=falha");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect((await identityRows())[0].providerMetadata).toMatchObject({ oid: MS_USER.oid });
    expect(JSON.stringify(await audits("usuario.microsoft_identity_rejected"))).toContain("metadata_divergente");
  });

  it("uma identidade Google com o MESMO sub não é a identidade Microsoft (o provedor faz parte da chave) e o state de um provedor não serve no callback do outro", async () => {
    const googleSim = await installGoogle();
    try {
      const user = await createTestUser({ email: "so-google@example.com" });
      await db.insertInto("userIdentities").values({ userId: user.id, provider: "google", issuer: "https://accounts.google.com", subject: MS_USER.sub }).execute();
      const { res } = await loginWithMicrosoft({ sub: MS_USER.sub });
      expect(location(res)).toBe("/login?microsoft=erro&motivo=nao_vinculada");

      // state de uma tentativa Microsoft no callback do GOOGLE: não é reconhecido (nem consumido) e nada acontece
      const flow = await startFlow("login");
      const qs = new URLSearchParams({ state: flow.state, code: "qualquer" });
      const wrong = await googleCallbackHandler(buildRequest(`auth/google-callback?${qs}`, { method: "GET", cookie: flow.binding }));
      expect(location(wrong)).toBe("/login?google=erro&motivo=falha");
      expect(googleSim.fetchCount.token).toBe(0);
      const attempt = await db.selectFrom("oauthAttempts").select(["status", "provider"]).where("provider", "=", "microsoft").orderBy("id", "desc").executeTakeFirstOrThrow();
      expect(attempt.status).toBe("started"); // o state do outro provedor não queimou a tentativa
    } finally {
      googleSim.uninstall();
    }
  });
});
