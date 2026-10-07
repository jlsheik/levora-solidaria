/**
 * Fase 93 — segurança do Microsoft OIDC: validação do ID token (issuer por tenant, audience, ver, tid, assinatura/JWKS), state/nonce/PKCE/replay,
 * IDOR, concorrência (A–J), rate limit, auditoria e varreduras estáticas. Microsoft SINTÉTICA (microsoftHarness.ts): prova a NOSSA validação,
 * não a Microsoft real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { db } from "../src/helpers/db";
import { handle as startHandler } from "../src/endpoints/auth/microsoft-start_POST";
import { handle as callbackHandler } from "../src/endpoints/auth/microsoft-callback_GET";
import { verifyMicrosoftIdToken, getMicrosoftConfig, microsoftIssuerFor, MicrosoftOidcError, type MicrosoftFailure } from "../src/helpers/microsoftOidc";
import { oauthHash } from "../src/helpers/oauthPrimitives";
import { currentPepperVersion } from "../src/helpers/identityKeys";
import { buildRequest, createTestUser, makeAccessCode, enrollTestMfa } from "./helpers";
import {
  approve, callback, CLIENT_ID, CORP_TID, installMicrosoft, location, makeMsKey, OTHER_CORP_TID, PERSONAL_TID, sessionCookieOf, startFlow, type MicrosoftSim, type MsClaims, type MsKey,
} from "./microsoftHarness";

let sim: MicrosoftSim;
beforeEach(async () => {
  sim = await installMicrosoft();
});
afterEach(() => {
  vi.useRealTimers();
  sim.uninstall();
});

const NONCE = "nonce-de-teste-0123456789abcdefghijklmnopqrstuv";
const config = () => getMicrosoftConfig()!;
const nonceHash = () => oauthHash("nonce", NONCE, currentPepperVersion());
const signedUpCount = async () => Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("registeredViaCodeId", "is not", null).executeTakeFirstOrThrow()).n);
const identityRows = () => db.selectFrom("userIdentities").selectAll().orderBy("id").execute();
const codeRow = (id: number) => db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const audits = (...actions: string[]) => db.selectFrom("auditLog").selectAll().where("action", "in", actions).orderBy("id").execute();
const U = { sub: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", email: "pessoa@contoso.com", name: "Pessoa", oid: "0a1b2c3d-1111-4222-8333-444455556666" };
const NOW_S = () => Math.floor(Date.now() / 1000);

async function verify(claims: MsClaims, opts: { key?: MsKey; now?: number } = {}) {
  const token = await sim.sign({ nonce: NONCE, sub: U.sub, email: U.email, ...claims }, opts.key);
  return verifyMicrosoftIdToken(config(), token, nonceHash(), currentPepperVersion(), opts.now);
}
async function expectFailure(promise: Promise<unknown>, motivo: MicrosoftFailure) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(MicrosoftOidcError);
  expect((error as MicrosoftOidcError).motivo).toBe(motivo);
}
async function signup(claims: MsClaims, accessCode: string) {
  const flow = await startFlow("signup", accessCode);
  const code = approve(sim, flow, claims);
  return { flow, code, res: await callback(flow, code) };
}
const linkIdentity = (userId: number, subject: string, tid = CORP_TID, md: object = {}) =>
  db.insertInto("userIdentities").values({ userId, provider: "microsoft", issuer: microsoftIssuerFor(tid), subject, providerMetadata: { tid, ver: "2.0", ...md } }).execute();

describe("validação do ID token (server-side, local)", () => {
  it("token válido: a identidade é (issuer do tid, sub); oid/tid/ver/idp vão para a metadata; e-mail só do claim `email` e nunca verificado", async () => {
    const a = await verify({ oid: U.oid, idp: "https://sts.windows.net/x/" });
    expect(a).toMatchObject({ issuer: microsoftIssuerFor(CORP_TID), subject: U.sub, email: U.email, emailVerified: false });
    expect(a.metadata).toEqual({ tid: CORP_TID, ver: "2.0", oid: U.oid, idp: "https://sts.windows.net/x/" });
    // preferred_username/upn NÃO viram e-mail
    const b = await verify({ email: null, preferred_username: "outro@contoso.com" });
    expect(b.email).toBeNull();
    // `email_verified` do token é ignorado
    const c = await verify({ email_verified: true } as MsClaims);
    expect(c.emailVerified).toBe(false);
  });

  it("assinatura: chave diferente (mesmo kid), payload adulterado, alg none, HS256 e RS384 ⇒ rejeitados (whitelist RS256)", async () => {
    const attacker = await makeMsKey("ms-kid-1", "aad"); // mesmo kid, outra chave
    await expectFailure(verify({}, { key: attacker }), "assinatura_invalida");
    const good = await sim.sign({ nonce: NONCE, sub: U.sub });
    const [h, p, s] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "outro-sub" })).toString("base64url");
    await expectFailure(verifyMicrosoftIdToken(config(), `${h}.${forged}.${s}`, nonceHash(), currentPepperVersion()), "assinatura_invalida");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
    await expectFailure(verifyMicrosoftIdToken(config(), none, nonceHash(), currentPepperVersion()), "assinatura_invalida");
    const hs = `${Buffer.from(JSON.stringify({ alg: "HS256", kid: "ms-kid-1" })).toString("base64url")}.${p}.${s}`;
    await expectFailure(verifyMicrosoftIdToken(config(), hs, nonceHash(), currentPepperVersion()), "assinatura_invalida");
    const rs384 = `${Buffer.from(JSON.stringify({ alg: "RS384", kid: "ms-kid-1" })).toString("base64url")}.${p}.${s}`;
    await expectFailure(verifyMicrosoftIdToken(config(), rs384, nonceHash(), currentPepperVersion()), "assinatura_invalida");
    await expectFailure(verifyMicrosoftIdToken(config(), "lixo", nonceHash(), currentPepperVersion()), "token_malformado");
  });

  it("kid ausente ou inexistente ⇒ rejeitado (chave fora do JWKS confiável); um JWKS alternativo do atacante não é consultado", async () => {
    const noKid = await new SignJWT({ sub: U.sub }).setProtectedHeader({ alg: "RS256" }).sign(sim.signingKey.privateKey);
    await expectFailure(verifyMicrosoftIdToken(config(), noKid, nonceHash(), currentPepperVersion()), "chave_desconhecida");
    const rogue = await makeMsKey("kid-do-atacante", "aad");
    await expectFailure(verify({}, { key: rogue }), "chave_desconhecida");
    // `jku`/`x5u`/`jwk` no cabeçalho são ignorados: só o JWKS do Discovery vale
    const withJku = await new SignJWT({ sub: U.sub, nonce: NONCE }).setProtectedHeader({ alg: "RS256", kid: "ms-kid-1", jku: "https://evil.example/keys" } as never).sign(rogue.privateKey);
    await expectFailure(verifyMicrosoftIdToken(config(), withJku, nonceHash(), currentPepperVersion()), "assinatura_invalida");
  });

  it("ISSUER: tem de ser EXATAMENTE https://login.microsoftonline.com/{tid}/v2.0 com o tid do próprio token; qualquer outro `iss` é rejeitado mesmo com assinatura válida", async () => {
    const bad = [
      "https://evil.example",
      `https://login.microsoftonline.com.evil.example/${CORP_TID}/v2.0`,
      `http://login.microsoftonline.com/${CORP_TID}/v2.0`,
      `https://login.microsoftonline.com/${OTHER_CORP_TID}/v2.0`, // tenant diferente do `tid`
      `https://login.microsoftonline.com/${CORP_TID}/v2.0/`,
      `https://login.microsoftonline.com/${CORP_TID}`, // v1
      `https://sts.windows.net/${CORP_TID}/`,
      "https://login.microsoftonline.com/common/v2.0",
      "https://login.microsoftonline.com/{tenantid}/v2.0",
      "https://accounts.google.com",
      CORP_TID,
    ];
    for (const iss of bad) await expectFailure(verify({ iss }), "issuer_invalido");
    await expectFailure(verify({ iss: null }), "token_malformado"); // iss ausente
    expect((await verify({ iss: microsoftIssuerFor(CORP_TID) })).issuer).toBe(microsoftIssuerFor(CORP_TID));
  });

  it("TID: ausente, vazio, fora do formato GUID ou com tentativa de injeção ⇒ rejeitado; tid de outro tenant exige iss do MESMO tenant", async () => {
    await expectFailure(verify({ tid: null }), "tenant_invalido");
    for (const tid of ["", "common", "contoso.onmicrosoft.com", `${CORP_TID}/../x`, CORP_TID.toUpperCase(), `${CORP_TID} `]) {
      await expectFailure(verify({ tid, iss: `https://login.microsoftonline.com/${tid}/v2.0` }), "tenant_invalido");
    }
    // tid de outro tenant com `iss` do tenant padrão do harness (incoerente) ⇒ issuer_invalido
    const token = await sim.sign({ nonce: NONCE, sub: U.sub, tid: OTHER_CORP_TID, iss: microsoftIssuerFor(CORP_TID) });
    await expectFailure(verifyMicrosoftIdToken(config(), token, nonceHash(), currentPepperVersion()), "issuer_invalido");
    expect((await verify({ tid: OTHER_CORP_TID })).issuer).toBe(microsoftIssuerFor(OTHER_CORP_TID));
  });

  it("VER: só 2.0 (tokens v1/sem ver ⇒ formato inesperado, rejeitado)", async () => {
    await expectFailure(verify({ ver: "1.0" }), "versao_invalida");
    await expectFailure(verify({ ver: null }), "versao_invalida");
    await expectFailure(verify({ ver: "2" }), "versao_invalida");
  });

  it("AUDIENCE: correta; errada; múltipla (qualquer lista com ≠1 valor); azp inconsistente", async () => {
    expect((await verify({ aud: CLIENT_ID })).subject).toBe(U.sub);
    expect((await verify({ aud: [CLIENT_ID] })).subject).toBe(U.sub);
    await expectFailure(verify({ aud: "00000003-0000-0000-c000-000000000000" }), "audience_invalida"); // token destinado ao Graph
    await expectFailure(verify({ aud: "outro-aplicativo" }), "audience_invalida");
    await expectFailure(verify({ aud: [CLIENT_ID, "outro-app"] }), "audience_invalida");
    await expectFailure(verify({ aud: [CLIENT_ID, "outro-app"], azp: CLIENT_ID }), "audience_invalida");
    await expectFailure(verify({ aud: [] }), "audience_invalida");
    await expectFailure(verify({ aud: null }), "audience_invalida");
    await expectFailure(verify({ azp: "outro-app" }), "azp_invalido");
    expect((await verify({ azp: CLIENT_ID })).subject).toBe(U.sub);
  });

  it("exp e iat: expirado, no limite da tolerância, iat no futuro, nbf no futuro ⇒ rejeitados", async () => {
    const now = NOW_S();
    await expectFailure(verify({ exp: now - 600, iat: now - 1200, nbf: now - 1200 }), "expirado");
    await expectFailure(verify({ exp: now - 90, nbf: now - 3000 }), "expirado");
    expect((await verify({ exp: now - 30, nbf: now - 3000 })).subject).toBe(U.sub);
    await expectFailure(verify({ iat: now + 3600, exp: now + 7200 }), "iat_invalido");
    expect((await verify({ iat: now + 30 })).subject).toBe(U.sub);
    await expectFailure(verify({ nbf: now + 3600, exp: now + 7200 }), "token_malformado");
  });

  it("nonce errado, ausente ou de outra tentativa ⇒ rejeitado; sub ausente/vazio/enorme ⇒ rejeitado; oid malformado ⇒ rejeitado", async () => {
    await expectFailure(verify({ nonce: "nonce-errado" }), "nonce_invalido");
    await expectFailure(verify({ nonce: null }), "nonce_invalido");
    await expectFailure(verify({ nonce: "" }), "nonce_invalido");
    await expectFailure(verify({ sub: null }), "subject_ausente");
    await expectFailure(verify({ sub: "" }), "subject_ausente");
    await expectFailure(verify({ sub: "x".repeat(256) }), "subject_ausente");
    await expectFailure(verify({ oid: "não-é-guid" }), "token_malformado");
    expect((await verify({ oid: null })).metadata.oid).toBeUndefined(); // oid ausente não impede a identidade (a chave é issuer+sub)
  });

  it("JWKS: chave marcada pela Microsoft com o emissor — chave de contas pessoais não assina `iss` corporativo; chaves de nuvens soberanas são ignoradas; chave sem marcação vale", async () => {
    const msa = await makeMsKey("kid-msa", "msa");
    const gov = await makeMsKey("kid-gov", "aad", "microsoftonline.us");
    const plain = await makeMsKey("kid-plain", "untagged");
    sim.published.push(msa, gov, plain);
    expect((await verify({ tid: PERSONAL_TID }, { key: msa })).issuer).toBe(microsoftIssuerFor(PERSONAL_TID));
    await expectFailure(verify({ tid: CORP_TID }, { key: msa }), "chave_issuer_divergente");
    expect((await verify({ tid: CORP_TID }, { key: sim.signingKey })).issuer).toBe(microsoftIssuerFor(CORP_TID));
    await expectFailure(verify({}, { key: gov }), "chave_desconhecida");
    expect((await verify({}, { key: plain })).subject).toBe(U.sub);
  });

  it("JWKS: cache (1 fetch), kids desconhecidos em rajada NÃO martelam a Microsoft, rotação dispara UM refresh depois do cooldown, chave antiga deixa de valer", async () => {
    expect((await verify({})).subject).toBe(U.sub);
    await verify({});
    expect(sim.fetchCount).toMatchObject({ discovery: 1, jwks: 1 });
    const rogue = await makeMsKey("kid-desconhecido", "aad");
    for (let i = 0; i < 10; i++) await expectFailure(verify({}, { key: rogue }), "chave_desconhecida");
    expect(sim.fetchCount.jwks).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    const next = await makeMsKey("ms-kid-2", "aad");
    sim.rotate(next);
    expect((await verify({}, { key: next, now: Date.now() })).subject).toBe(U.sub);
    expect(sim.fetchCount.jwks).toBe(2);
    await expectFailure(verify({}, { key: await makeMsKey("ms-kid-1", "aad"), now: Date.now() }), "chave_desconhecida");
  });

  it("JWKS: falha TEMPORÁRIA do endpoint — o cache anterior continua valendo, nada é aceito sem chave, e a recuperação acontece depois do cooldown (sem retry no mesmo pedido)", async () => {
    // 1ª validação sem cache e com o endpoint fora ⇒ falha fechada
    sim.failJwks = true;
    await expectFailure(verify({}), "chave_desconhecida");
    sim.failJwks = false;
    expect((await verify({})).subject).toBe(U.sub); // sem cache a nova tentativa é imediata
    expect(sim.fetchCount.jwks).toBe(2);

    // com cache: uma chave nova + endpoint fora ⇒ a chave nova NÃO é aceita, a antiga continua válida (cache)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    const next = await makeMsKey("ms-kid-3", "aad");
    sim.published.push(next);
    sim.failJwks = true;
    await expectFailure(verify({}, { key: next, now: Date.now() }), "chave_desconhecida");
    expect((await verify({}, { now: Date.now() })).subject).toBe(U.sub);
    // endpoint volta, mas ainda dentro do cooldown: sem novo fetch
    sim.failJwks = false;
    const fetches = sim.fetchCount.jwks;
    await expectFailure(verify({}, { key: next, now: Date.now() }), "chave_desconhecida");
    expect(sim.fetchCount.jwks).toBe(fetches);
    // passado o cooldown ⇒ recupera
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect((await verify({}, { key: next, now: Date.now() })).subject).toBe(U.sub);
  });

  it("e2e: token inválido no callback ⇒ nada é criado, código intacto, motivo só na auditoria (sem token)", async () => {
    const { code, id } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const res = await callback(flow, approve(sim, flow, U, { tamper: (c) => ({ ...c, aud: "outro-app" }) }));
    expect(location(res)).toBe("/login?microsoft=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
    const [event] = await audits("usuario.microsoft_identity_rejected");
    expect(JSON.stringify(event.metadata)).toContain("audience_invalida");
    expect(JSON.stringify(event)).not.toContain("eyJ");
  });
});

describe("state, nonce, PKCE, vínculo e replay", () => {
  it("state ausente, malformado, inexistente ou de OUTRO propósito ⇒ falha neutra, nada criado, nenhuma troca com a Microsoft", async () => {
    const { code } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const g = approve(sim, flow, U);
    for (const state of ["", "curto", "x".repeat(43), "!".repeat(43), "A".repeat(100)]) {
      expect(location(await callback(flow, g, { state }))).toBe("/login?microsoft=erro&motivo=falha");
    }
    expect(await signedUpCount()).toBe(0);
    expect(sim.fetchCount.token).toBe(0);
  });

  it("state expirado ⇒ rejeitado (TTL curto)", async () => {
    const { code, id } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    await db.updateTable("oauthAttempts").set({ expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 60_000) }).execute();
    const res = await callback(flow, approve(sim, flow, U));
    expect(location(res)).toBe("/login?microsoft=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
  });

  it("REPLAY do callback completo: a 2ª chamada (mesmo state/code) não cria nada, não rotaciona nem cria 2ª sessão", async () => {
    const { code } = await makeAccessCode();
    const { flow, code: mscode, res } = await signup(U, code);
    expect(location(res)).toBe("/");
    const sessionsBefore = await db.selectFrom("sessions").selectAll().execute();
    const replay = await callback(flow, mscode);
    expect(location(replay)).toBe("/login?microsoft=erro&motivo=falha");
    expect(sessionCookieOf(replay)).toBeUndefined();
    expect(await db.selectFrom("sessions").selectAll().execute()).toHaveLength(sessionsBefore.length);
    expect(await signedUpCount()).toBe(1);
  });

  it("o code é de uso único: reutilizá-lo em outra tentativa falha na troca (invalid_grant) e nada é criado", async () => {
    const a = await makeAccessCode();
    const b = await makeAccessCode();
    const flowA = await startFlow("signup", a.code);
    const mscode = approve(sim, flowA, U);
    expect(location(await callback(flowA, mscode))).toBe("/");
    const flowB = await startFlow("signup", b.code);
    approve(sim, flowB, { ...U, sub: "outro" });
    expect(location(await callback(flowB, mscode))).toBe("/login?microsoft=erro&motivo=falha");
    expect(await signedUpCount()).toBe(1);
    expect((await codeRow(b.id)).redeemedAt).toBeNull();
  });

  it("vínculo de navegador: sem cookie ou com o cookie de OUTRA tentativa ⇒ rejeitado (state de B não funciona no navegador de A)", async () => {
    const a = await makeAccessCode();
    const b = await makeAccessCode();
    const flowA = await startFlow("signup", a.code);
    const flowB = await startFlow("signup", b.code);
    expect(location(await callback(flowB, approve(sim, flowB, { ...U, sub: "sub-b", email: "b@contoso.com" }), { cookie: null }))).toBe("/login?microsoft=erro&motivo=falha");
    const flowB2 = await startFlow("signup", b.code);
    expect(location(await callback(flowB2, approve(sim, flowB2, { ...U, sub: "sub-b", email: "b@contoso.com" }), { cookie: flowA.binding }))).toBe("/login?microsoft=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
  });

  it("PKCE: o verifier enviado é o da tentativa (o code emitido para o challenge de A não serve para B); verifier cifrado em repouso; nada em URL/storage", async () => {
    const a = await makeAccessCode();
    const b = await makeAccessCode();
    const flowA = await startFlow("signup", a.code);
    const flowB = await startFlow("signup", b.code);
    const gA = approve(sim, flowA, U);
    expect(location(await callback(flowB, gA))).toBe("/login?microsoft=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    for (const r of await db.selectFrom("oauthAttempts").select(["pkceVerifierCt"]).execute()) expect(r.pkceVerifierCt.length).toBeGreaterThan(43);
    expect(flowA.authorizationUrl.toString()).not.toMatch(/code_verifier/);
  });

  it("erro do provedor (access_denied) ⇒ 'cancelado'; a mensagem da Microsoft nunca é repassada", async () => {
    const { code } = await makeAccessCode();
    expect(location(await callback(await startFlow("signup", code), undefined, { error: "access_denied" }))).toBe("/login?microsoft=erro&motivo=cancelado");
    const res2 = await callback(await startFlow("signup", (await makeAccessCode()).code), undefined, { error: "<script>alert(1)</script>" });
    expect(location(res2)).toBe("/login?microsoft=erro&motivo=falha");
    expect(location(res2)).not.toContain("script");
    expect(await signedUpCount()).toBe(0);
  });

  it("o cookie de vínculo é sempre apagado no callback e nenhuma resposta carrega token/code/ID token", async () => {
    const { code } = await makeAccessCode();
    const { res, flow, code: mscode } = await signup(U, code);
    expect(res.headers.getSetCookie().find((c) => c.startsWith("levora_oauth="))!).toMatch(/Max-Age=0/);
    const everything = location(res) + res.headers.getSetCookie().filter((c) => !c.startsWith("floot_built_app_session=")).join(";") + (await res.text());
    for (const secret of [mscode, flow.state, flow.nonce, "eyJ", "EwB"]) expect(everything).not.toContain(secret);
  });
});

describe("IDOR / ownership — nada enviado pelo navegador escolhe a identidade final", () => {
  it("identidade já vinculada a OUTRO usuário nunca é movida, sobrescrita nem usada para um 2º usuário", async () => {
    const owner = await createTestUser({ email: "dono@example.com" });
    await linkIdentity(owner.id, "sub-do-dono");
    const { code, id } = await makeAccessCode();
    const { res } = await signup({ sub: "sub-do-dono", email: "intruso@contoso.com" }, code);
    expect(location(res)).toBe("/login?microsoft=erro&motivo=ja_cadastrada");
    const rows = await identityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.id, subject: "sub-do-dono" });
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect(await signedUpCount()).toBe(0);
  });

  it("o callback ignora user_id/userId/provider/intent/accessCode/tid/oid/sub/iss/email na query: só valem a linha da tentativa e o token validado", async () => {
    const victim = await createTestUser({ email: "vitima@example.com" });
    await linkIdentity(victim.id, "sub-vitima", CORP_TID, { oid: U.oid });
    const flow = await startFlow("login");
    const g = approve(sim, flow, { sub: "sub-atacante", email: "vitima@example.com", oid: U.oid });
    const qs = new URLSearchParams({
      state: flow.state, code: g, user_id: String(victim.id), userId: String(victim.id), provider: "google", intent: "signup", accessCode: "LEV-0000-0000-0000-0000-0000",
      tid: CORP_TID, oid: U.oid, sub: "sub-vitima", iss: microsoftIssuerFor(CORP_TID), email: "vitima@example.com",
    });
    const res = await callbackHandler(buildRequest(`auth/microsoft-callback?${qs}`, { method: "GET", cookie: flow.binding }));
    expect(location(res)).toBe("/login?microsoft=erro&motivo=nao_vinculada");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", victim.id).execute()).toHaveLength(0);
  });

  it("um ID token de OUTRO usuário (sub da vítima) só entra se o token FOR da vítima: nonce de outra tentativa ⇒ rejeitado (replay de token)", async () => {
    const victim = await createTestUser({ email: "vitima@example.com" });
    await linkIdentity(victim.id, "sub-vitima");
    // token legítimo capturado de uma tentativa X, reapresentado numa tentativa Y: o nonce não casa
    const flowX = await startFlow("login");
    const stolen = await sim.sign({ nonce: flowX.nonce, sub: "sub-vitima", email: "vitima@example.com" });
    const flowY = await startFlow("login");
    const code = `mscode-roubado`;
    sim.grants.set(code, async () => ({ id_token: stolen }));
    const res = await callback(flowY, code);
    expect(location(res)).toBe("/login?microsoft=erro&motivo=falha");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(JSON.stringify(await audits("usuario.microsoft_identity_rejected"))).toContain("nonce_invalido");
  });

  it("o id do código na tentativa não é alterável pelo cliente; um código revogado depois do start não cadastra", async () => {
    const mine = await makeAccessCode();
    const other = await makeAccessCode();
    const flow = await startFlow("signup", mine.code);
    expect((await db.selectFrom("oauthAttempts").select("accessCodeId").executeTakeFirstOrThrow()).accessCodeId).toBe(mine.id);
    const qs = new URLSearchParams({ state: flow.state, code: approve(sim, flow, U), accessCodeId: String(other.id), accessCode: other.code });
    const res = await callbackHandler(buildRequest(`auth/microsoft-callback?${qs}`, { method: "GET", cookie: flow.binding }));
    expect(location(res)).toBe("/");
    expect((await codeRow(mine.id)).redeemedAt).not.toBeNull();
    expect((await codeRow(other.id)).redeemedAt).toBeNull();
  });

  it("tentativa de signup de OUTRO navegador/usuário: state+cookie de A com o code de B não cadastram ninguém", async () => {
    const a = await makeAccessCode();
    const b = await makeAccessCode();
    const flowA = await startFlow("signup", a.code);
    const flowB = await startFlow("signup", b.code);
    const codeB = approve(sim, flowB, { ...U, sub: "sub-b", email: "b@contoso.com" });
    expect(location(await callback(flowA, codeB))).toBe("/login?microsoft=erro&motivo=falha"); // PKCE de A ≠ challenge de B
    expect(await signedUpCount()).toBe(0);
  });
});

describe("CONCORRÊNCIA (A–J) — sem sleeps, sem retries", () => {
  it("A: dois callbacks para a MESMA tentativa (state único) ⇒ exatamente um prossegue", async () => {
    const { code } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const [r1, r2] = await Promise.all([callback(flow, approve(sim, flow, U)), callback(flow, approve(sim, flow, U))]);
    expect([location(r1), location(r2)].sort()).toEqual(["/", "/login?microsoft=erro&motivo=falha"]);
    expect(await signedUpCount()).toBe(1);
    expect(await identityRows()).toHaveLength(1);
    expect(await db.selectFrom("sessions").selectAll().execute()).toHaveLength(1);
  });

  it("B: dois cadastros com o MESMO código e a MESMA identidade ⇒ 1 usuário, 1 identidade, código consumido 1 vez", async () => {
    const { code, id } = await makeAccessCode();
    const f1 = await startFlow("signup", code);
    const f2 = await startFlow("signup", code);
    const results = await Promise.all([callback(f1, approve(sim, f1, U)), callback(f2, approve(sim, f2, U))]);
    expect(results.filter((r) => location(r) === "/")).toHaveLength(1);
    expect(await signedUpCount()).toBe(1);
    expect(await identityRows()).toHaveLength(1);
    expect((await codeRow(id)).redeemedAt).not.toBeNull();
    expect(await audits("codigo_acesso.consumido")).toHaveLength(1);
  });

  it("C: a MESMA identidade Microsoft tentando criar duas contas com DOIS códigos ⇒ 1 conta; o código perdedor NÃO é queimado", async () => {
    const c1 = await makeAccessCode();
    const c2 = await makeAccessCode();
    const f1 = await startFlow("signup", c1.code);
    const f2 = await startFlow("signup", c2.code);
    const results = await Promise.all([callback(f1, approve(sim, f1, U)), callback(f2, approve(sim, f2, { ...U, email: "outro-email@contoso.com" }))]);
    expect(results.filter((r) => location(r) === "/")).toHaveLength(1);
    expect(await signedUpCount()).toBe(1);
    expect(await identityRows()).toHaveLength(1);
    expect([await codeRow(c1.id), await codeRow(c2.id)].filter((c) => c.redeemedAt !== null)).toHaveLength(1);
  });

  it("D: identidades Microsoft DIFERENTES com o MESMO código ⇒ exatamente 1 conta", async () => {
    const { code, id } = await makeAccessCode();
    const f1 = await startFlow("signup", code);
    const f2 = await startFlow("signup", code);
    const results = await Promise.all([
      callback(f1, approve(sim, f1, { sub: "d1", email: "d1@contoso.com" })),
      callback(f2, approve(sim, f2, { sub: "d2", email: "d2@contoso.com", tid: OTHER_CORP_TID })),
    ]);
    expect(results.filter((r) => location(r) === "/")).toHaveLength(1);
    expect(results.filter((r) => location(r) === "/login?microsoft=erro&motivo=codigo_indisponivel")).toHaveLength(1);
    expect(await signedUpCount()).toBe(1);
    expect(await identityRows()).toHaveLength(1);
    expect((await codeRow(id)).redeemedByUserId).not.toBeNull();
  });

  it("E: código revogado antes do callback ⇒ nada criado; revogação SIMULTÂNEA ao callback ⇒ ou conta+código consumido, ou nada (nunca ambos)", async () => {
    const pre = await makeAccessCode();
    const f0 = await startFlow("signup", pre.code);
    await db.updateTable("registrationAccessCodes").set({ revokedAt: new Date(), revokedByUserId: pre.creatorId }).where("id", "=", pre.id).execute();
    expect(location(await callback(f0, approve(sim, f0, U)))).toBe("/login?microsoft=erro&motivo=codigo_indisponivel");
    expect(await signedUpCount()).toBe(0);
    for (let round = 0; round < 4; round++) {
      const c = await makeAccessCode();
      const flow = await startFlow("signup", c.code);
      const g = approve(sim, flow, { sub: `g${round}`, email: `g${round}@contoso.com` });
      const [res] = await Promise.all([
        callback(flow, g),
        db.updateTable("registrationAccessCodes").set({ revokedAt: new Date(), revokedByUserId: c.creatorId }).where("id", "=", c.id).where("redeemedAt", "is", null).execute(),
      ]);
      const row = await codeRow(c.id);
      expect(row.redeemedAt !== null && row.revokedAt !== null).toBe(false);
      const created = await db.selectFrom("users").select("id").where("email", "=", `g${round}@contoso.com`).executeTakeFirst();
      if (location(res) === "/") {
        expect(created).toBeDefined();
        expect(row.redeemedByUserId).toBe(created!.id);
      } else {
        expect(created).toBeUndefined();
        expect(row.redeemedAt).toBeNull();
      }
    }
  });

  it("F: código expirado antes do callback (e expirando DURANTE) ⇒ nada criado, código não queimado", async () => {
    const c = await makeAccessCode({ validityMs: 6 * 60 * 1000 });
    const flow = await startFlow("signup", c.code);
    await db.updateTable("registrationAccessCodes").set({ createdAt: new Date(Date.now() - 3 * 3600_000), expiresAt: new Date(Date.now() - 1000) }).where("id", "=", c.id).execute();
    expect(location(await callback(flow, approve(sim, flow, U)))).toBe("/login?microsoft=erro&motivo=codigo_indisponivel");
    expect(await signedUpCount()).toBe(0);
    expect(await identityRows()).toHaveLength(0);

    const d = await makeAccessCode({ validityMs: 6 * 60 * 1000 });
    const flow2 = await startFlow("signup", d.code);
    const g = approve(sim, flow2, { sub: "exp-durante", email: "exp@contoso.com" });
    const [res] = await Promise.all([
      callback(flow2, g),
      db.updateTable("registrationAccessCodes").set({ createdAt: new Date(Date.now() - 3 * 3600_000), expiresAt: new Date(Date.now() - 1000) }).where("id", "=", d.id).execute(),
    ]);
    const row = await codeRow(d.id);
    const created = await db.selectFrom("users").select("id").where("email", "=", "exp@contoso.com").executeTakeFirst();
    if (location(res) === "/") expect(row.redeemedByUserId).toBe(created!.id);
    else {
      expect(created).toBeUndefined();
      expect(row.redeemedAt).toBeNull();
    }
  });

  it("G: MFA ativado ao mesmo tempo que o login Microsoft ⇒ nunca uma sessão plena para quem já tem MFA ativo ao final", async () => {
    for (let round = 0; round < 4; round++) {
      const user = await createTestUser({ email: `j${round}@example.com` });
      await linkIdentity(user.id, `j${round}`);
      const flow = await startFlow("login");
      const [res] = await Promise.all([callback(flow, approve(sim, flow, { sub: `j${round}` })), enrollTestMfa(user.id)]);
      const sessions = await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute();
      if (location(res) === "/") expect(sessions).toHaveLength(1);
      else {
        expect(location(res)).toBe("/login?microsoft=mfa");
        expect(sessions).toHaveLength(0);
      }
    }
  });

  it("J: identidade já vinculada + callback replay / dois logins simultâneos ⇒ cada tentativa gera no máximo 1 sessão", async () => {
    const user = await createTestUser({ email: "vinc@example.com" });
    await linkIdentity(user.id, "sub-b");
    const f1 = await startFlow("login");
    const f2 = await startFlow("login");
    const [a, b] = await Promise.all([callback(f1, approve(sim, f1, { sub: "sub-b" })), callback(f2, approve(sim, f2, { sub: "sub-b" }))]);
    expect([location(a), location(b)]).toEqual(["/", "/"]);
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute()).toHaveLength(2);
    const f3 = await startFlow("login");
    const [c, d] = await Promise.all([callback(f3, approve(sim, f3, { sub: "sub-b" })), callback(f3, approve(sim, f3, { sub: "sub-b" }))]);
    expect([location(c), location(d)].sort()).toEqual(["/", "/login?microsoft=erro&motivo=falha"]);
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute()).toHaveLength(3);
  });
});

describe("rate limit, enumeração e auditoria", () => {
  it("microsoft-start: 20 por 15 min por IP; microsoft-callback: 30 por 15 min por IP; os baldes são independentes por provedor", async () => {
    const ip = "ip-limite-start-ms";
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) last = await startHandler(buildRequest("auth/microsoft-start", { method: "POST", ip, body: { intent: "login" } }));
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).not.toBeNull();
    // outro IP não é afetado
    expect((await startHandler(buildRequest("auth/microsoft-start", { method: "POST", ip: "ip-outro-ms", body: { intent: "login" } }))).status).toBe(200);
    const flow = await startFlow("login");
    let result: Response | undefined;
    for (let i = 0; i < 31; i++) result = await callback(flow, "x", { ip: "ip-limite-cb-ms", state: "a".repeat(43) });
    expect(location(result!)).toBe("/login?microsoft=erro&motivo=limite");
    // esgotar a Microsoft para um IP não esgota o Google para o mesmo IP (balde próprio)
    const { handle: googleStart } = await import("../src/endpoints/auth/google-start_POST");
    expect((await googleStart(buildRequest("auth/google-start", { method: "POST", ip, body: { intent: "login" } }))).status).not.toBe(429);
  });

  it("eventos de auditoria existem e NUNCA contêm code, tokens, nonce, verifier, state, segredos, senha ou e-mail", async () => {
    const { code } = await makeAccessCode();
    const ok = await signup(U, code);
    const failed = await signup({ ...U, sub: "x", email: "x@contoso.com" }, (await makeAccessCode()).code);
    const rejected = await (async () => {
      const flow = await startFlow("login");
      return callback(flow, approve(sim, flow, U, { tamper: (c) => ({ ...c, nonce: "errado" }) }));
    })();
    expect(location(ok.res)).toBe("/");
    expect(location(failed.res)).toBeTruthy();
    expect(location(rejected)).toBe("/login?microsoft=erro&motivo=falha");
    const events = await audits("usuario.cadastro_microsoft", "usuario.login_microsoft_falhou", "usuario.cadastro_microsoft_falhou", "usuario.microsoft_identity_rejected");
    expect(events.length).toBeGreaterThanOrEqual(2);
    const dump = JSON.stringify(await db.selectFrom("auditLog").selectAll().execute());
    for (const secret of ["eyJ", "EwB", ok.flow.state, ok.flow.nonce, ok.code, "segredo-sintetico", "pessoa@contoso.com", "code_verifier", U.oid]) expect(dump, secret).not.toContain(secret);
  });
});

describe("varredura estática", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (name === "node_modules" || name === "static") return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  const source = [...walk("src"), ...walk("server")].map((f) => [f.replace(/\\/g, "/"), readFileSync(f, "utf8")] as const);
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("sem userinfo/Graph, sem implicit flow, sem escopos além de identidade, sem tabela/colunas de tokens", () => {
    const oidc = code("src/helpers/microsoftOidc.tsx");
    expect(oidc).not.toMatch(/graph\.microsoft\.com|userinfo|tokeninfo/i);
    expect(oidc).not.toMatch(/response_type["'], ["']token|id_token token|response_mode["'], ["']fragment/);
    expect(oidc).not.toMatch(/offline_access|User\.Read|Mail\.|Files\.|Calendars?\.|Contacts\.|\.default/);
    expect(oidc).toMatch(/SCOPES = "openid profile email"/);
    expect(readFileSync("db/schema.sql", "utf8")).not.toMatch(/microsoft_tokens|refresh_token|access_token/i);
    expect(source.filter(([, text]) => /refresh_token|offline_access/.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))).map(([f]) => f)).toEqual([]);
  });

  it("e-mail/UPN/preferred_username nunca são lidos como identidade: o CÓDIGO só lê o claim `email`", () => {
    for (const f of ["src/helpers/microsoftOidc.tsx", "src/helpers/oauthCallback.tsx", "src/helpers/oauthProviders.tsx"]) {
      expect(code(f), f).not.toMatch(/preferred_username|unique_name|\bupn\b/);
    }
    expect(code("src/helpers/microsoftOidc.tsx")).toMatch(/claims\.email\b/);
    // a chave da busca de identidade é (provider, issuer, subject) — e nenhuma busca usa e-mail
    const cb = code("src/helpers/oauthCallback.tsx");
    const lookup = cb.slice(cb.indexOf('.selectFrom("userIdentities as i")'), cb.indexOf("executeTakeFirst()", cb.indexOf('.selectFrom("userIdentities as i")')));
    expect(lookup).toMatch(/provider.*adapter\.provider/s);
    expect(lookup).toMatch(/issuer.*identity\.issuer/s);
    expect(lookup).toMatch(/subject.*identity\.subject/s);
    expect(lookup).not.toMatch(/\bemail\b|identity\.metadata|\boid\b|\btid\b/);
  });

  it("nenhum segredo/ID de aplicativo no código-fonte (só variáveis de ambiente) e nada é impresso além do NOME do erro", () => {
    const oidc = code("src/helpers/microsoftOidc.tsx");
    expect(oidc).toMatch(/process\.env\.MICROSOFT_CLIENT_SECRET/);
    expect(oidc).not.toMatch(/console\.(log|error|warn)/);
    expect(oidc).not.toMatch(/[A-Za-z0-9~_.-]{3}8Q~[A-Za-z0-9~_.-]{20,}/); // formato de client secret da Microsoft
    const logs = code("src/helpers/oauthCallback.tsx").split("\n").filter((l) => l.includes("console."));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => !/\.message|\.stack|,\s*error\s*\)/.test(l))).toBe(true);
  });

  it("redirecionamentos RELATIVOS e redirect URI só da configuração (nunca Host/Origin/Referer/query)", () => {
    for (const f of ["src/helpers/oauthCallback.tsx", "src/helpers/oauthStart.tsx", "src/helpers/microsoftOidc.tsx", "src/endpoints/auth/microsoft-callback_GET.ts", "src/endpoints/auth/microsoft-start_POST.ts"]) {
      const text = code(f);
      expect(text, f).not.toMatch(/headers\.get\(["'](host|x-forwarded-host|origin|referer)/i);
      expect(text, f).not.toMatch(/Location: ["'`]https?:/);
      expect(text, f).not.toMatch(/searchParams\.get\(["'](redirect_uri|accessCode|access_code|intent|user_?id|provider|tid|oid|sub)["']/);
    }
    const oidc = code("src/helpers/microsoftOidc.tsx");
    expect((oidc.match(/redirect_uri/g) ?? []).length).toBeGreaterThan(0);
    expect(oidc).not.toMatch(/redirect_uri["'], (?!config\.redirectUri)/);
  });

  it("os endpoints Microsoft são finos (sem lógica própria) e não existe endpoint 'account-delete da Microsoft'", () => {
    for (const f of ["src/endpoints/auth/microsoft-callback_GET.ts", "src/endpoints/auth/microsoft-start_POST.ts"]) {
      expect(readFileSync(f, "utf8").split("\n").length, f).toBeLessThan(15);
    }
    expect(readdirSync("src/endpoints/auth").filter((f) => /microsoft.*(delete|reauth)|delete.*microsoft/i.test(f))).toEqual([]);
    expect(readFileSync("src/endpoints/auth/account-delete_POST.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/microsoft/i);
  });
});
