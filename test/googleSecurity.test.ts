/**
 * Fase 92 — segurança do Google OIDC: validação do ID token, state/nonce/PKCE/replay, IDOR, concorrência (A–J), rate limit,
 * exclusão de conta e varreduras estáticas. Google SINTÉTICO (googleHarness.ts): prova a NOSSA validação, não o Google real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/helpers/db";
import { handle as startHandler } from "../src/endpoints/auth/google-start_POST";
import { handle as callbackHandler } from "../src/endpoints/auth/google-callback_GET";
import { handle as deleteAccount } from "../src/endpoints/auth/account-delete_POST";
import { generatePasswordHash } from "../src/helpers/generatePasswordHash";
import { verifyGoogleIdToken, getGoogleConfig, oauthHash, GoogleOidcError, GOOGLE_ISSUER, type GoogleFailure } from "../src/helpers/googleOidc";
import { currentPepperVersion } from "../src/helpers/identityKeys";
import { buildRequest, createTestUser, createSessionCookie, makeAccessCode, enrollTestMfa } from "./helpers";
import { approve, callback, CLIENT_ID, installGoogle, location, makeKey, sessionCookieOf, startFlow, type GoogleSim, type TokenClaims } from "./googleHarness";

let sim: GoogleSim;
beforeEach(async () => {
  sim = await installGoogle();
});
afterEach(() => {
  vi.useRealTimers();
  sim.uninstall();
});

const NONCE = "nonce-de-teste-0123456789abcdefghijklmnopqrstuv";
const config = () => getGoogleConfig()!;
const nonceHash = () => oauthHash("nonce", NONCE, currentPepperVersion());
const signedUpCount = async () => Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("registeredViaCodeId", "is not", null).executeTakeFirstOrThrow()).n);
const identityRows = () => db.selectFrom("userIdentities").selectAll().orderBy("id").execute();
const codeRow = (id: number) => db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const audits = (...actions: string[]) => db.selectFrom("auditLog").selectAll().where("action", "in", actions).orderBy("id").execute();
const U = { sub: "1100000000000000000001", email: "pessoa@gmail.com", email_verified: true, name: "Pessoa" };

async function verify(claims: TokenClaims, opts: { key?: Awaited<ReturnType<typeof makeKey>>; now?: number } = {}) {
  const token = await sim.sign({ nonce: NONCE, sub: U.sub, email: U.email, ...claims }, opts.key);
  return verifyGoogleIdToken(config(), token, nonceHash(), currentPepperVersion(), opts.now);
}
async function expectFailure(promise: Promise<unknown>, motivo: GoogleFailure) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(GoogleOidcError);
  expect((error as GoogleOidcError).motivo).toBe(motivo);
}
async function signup(claims: TokenClaims, accessCode: string) {
  const flow = await startFlow("signup", accessCode);
  const code = approve(sim, flow, claims);
  return { flow, code, res: await callback(flow, code) };
}

describe("validação do ID token (server-side, local)", () => {
  it("token válido: devolve a identidade com o emissor CANÔNICO; aceita iss com e sem esquema; sub é a chave", async () => {
    const a = await verify({});
    expect(a).toMatchObject({ issuer: GOOGLE_ISSUER, subject: U.sub, email: "pessoa@gmail.com" });
    const b = await verify({ iss: "accounts.google.com" });
    expect(b.issuer).toBe(GOOGLE_ISSUER); // o emissor guardado é o configurado, não a string do token
  });

  it("assinatura: chave diferente (mesmo kid), payload adulterado, alg none e HS256 ⇒ rejeitados", async () => {
    const attacker = await makeKey("kid-1"); // mesmo kid, outra chave
    await expectFailure(verify({}, { key: attacker }), "assinatura_invalida");
    const good = await sim.sign({ nonce: NONCE, sub: U.sub });
    const [h, p, s] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "outro-sub" })).toString("base64url");
    await expectFailure(verifyGoogleIdToken(config(), `${h}.${forged}.${s}`, nonceHash(), currentPepperVersion()), "assinatura_invalida");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
    await expectFailure(verifyGoogleIdToken(config(), none, nonceHash(), currentPepperVersion()), "assinatura_invalida");
    const hs = `${Buffer.from(JSON.stringify({ alg: "HS256", kid: "kid-1" })).toString("base64url")}.${p}.${s}`;
    await expectFailure(verifyGoogleIdToken(config(), hs, nonceHash(), currentPepperVersion()), "assinatura_invalida");
    await expectFailure(verifyGoogleIdToken(config(), "lixo", nonceHash(), currentPepperVersion()), "token_malformado");
  });

  it("issuer inválido (inclusive um 'parecido') ⇒ rejeitado; a CONFIGURAÇÃO decide o emissor, não o token", async () => {
    for (const iss of ["https://evil.example", "https://accounts.google.com.evil.example", "https://login.microsoftonline.com/x/v2.0", "http://accounts.google.com"]) {
      await expectFailure(verify({ iss }), "issuer_invalido");
    }
  });

  it("audience: correta, errada, múltipla (com/sem azp correto) e azp inconsistente", async () => {
    expect((await verify({ aud: CLIENT_ID })).subject).toBe(U.sub);
    await expectFailure(verify({ aud: "outro-app.apps.googleusercontent.com" }), "audience_invalida");
    await expectFailure(verify({ aud: [CLIENT_ID, "outro-app"] }), "azp_invalido"); // múltipla sem azp
    expect((await verify({ aud: [CLIENT_ID, "outro-app"], azp: CLIENT_ID })).subject).toBe(U.sub);
    await expectFailure(verify({ aud: [CLIENT_ID, "outro-app"], azp: "outro-app" }), "azp_invalido");
    await expectFailure(verify({ azp: "outro-app" }), "azp_invalido");
    expect((await verify({ azp: CLIENT_ID })).subject).toBe(U.sub);
  });

  it("exp e iat: expirado, no limite da tolerância, iat no futuro ⇒ rejeitados", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectFailure(verify({ exp: now - 600, iat: now - 1200 }), "expirado");
    await expectFailure(verify({ exp: now - 90 }), "expirado"); // fora da tolerância de 60 s
    expect((await verify({ exp: now - 30 })).subject).toBe(U.sub); // dentro da tolerância
    await expectFailure(verify({ iat: now + 3600, exp: now + 7200 }), "iat_invalido");
    expect((await verify({ iat: now + 30 })).subject).toBe(U.sub);
  });

  it("nonce errado, ausente ou reutilizado de outra tentativa ⇒ rejeitado; sub ausente/vazio ⇒ rejeitado", async () => {
    await expectFailure(verify({ nonce: "nonce-errado" }), "nonce_invalido");
    await expectFailure(verify({ nonce: null }), "nonce_invalido");
    await expectFailure(verify({ nonce: "" }), "nonce_invalido");
    await expectFailure(verify({ sub: null }), "subject_ausente");
    await expectFailure(verify({ sub: "" }), "subject_ausente");
  });

  it("JWKS rotacionado: kid novo dispara UM refresh (depois do cooldown); kids desconhecidos em rajada NÃO martelam o Google", async () => {
    expect((await verify({})).subject).toBe(U.sub);
    expect(sim.fetchCount.jwks).toBe(1); // cache: a 2ª validação não vai ao Google
    await verify({});
    expect(sim.fetchCount.jwks).toBe(1);

    const rogue = await makeKey("kid-desconhecido");
    for (let i = 0; i < 10; i++) await expectFailure(verify({}, { key: rogue }), "chave_desconhecida");
    expect(sim.fetchCount.jwks).toBe(1); // dentro do cooldown: sem novo fetch

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    const next = await makeKey("kid-2");
    sim.rotate(next);
    expect((await verify({}, { key: next, now: Date.now() })).subject).toBe(U.sub);
    expect(sim.fetchCount.jwks).toBe(2);
    // a chave antiga deixou de ser publicada: token assinado por ela não passa mais
    await expectFailure(verify({}, { key: await makeKey("kid-1"), now: Date.now() }), "chave_desconhecida");
  });

  it("e2e: token inválido no callback ⇒ nada é criado, código intacto, motivo só na auditoria (sem token)", async () => {
    const { code, id } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const res = await callback(flow, approve(sim, flow, U, { tamper: (c) => ({ ...c, aud: "outro-app" }) }));
    expect(location(res)).toBe("/login?google=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
    const [event] = await audits("usuario.google_identity_rejected");
    expect(JSON.stringify(event.metadata)).toContain("audience_invalida");
    expect(JSON.stringify(event)).not.toContain("eyJ");
  });
});

describe("state, nonce, PKCE, vínculo e replay", () => {
  it("state ausente, malformado, inexistente e de OUTRO propósito (segredo de challenge/bootstrap) ⇒ falha neutra e nada criado", async () => {
    const { code } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const g = approve(sim, flow, U);
    const bad = ["", "curto", "x".repeat(43), "!".repeat(43), "A".repeat(100)];
    for (const state of bad) {
      const res = await callback(flow, g, { state });
      expect(location(res)).toBe("/login?google=erro&motivo=falha");
    }
    const challengeSecret = "A".repeat(43); // formato de segredo de challenge: não é um state conhecido
    expect(location(await callback(flow, g, { state: challengeSecret }))).toBe("/login?google=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect(sim.fetchCount.token).toBe(0); // nenhuma troca com o Google foi sequer tentada
  });

  it("state expirado ⇒ rejeitado (TTL curto)", async () => {
    const { code, id } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    await db.updateTable("oauthAttempts").set({ expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 60_000) }).execute();
    const res = await callback(flow, approve(sim, flow, U));
    expect(location(res)).toBe("/login?google=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
  });

  it("REPLAY do callback completo: a 2ª chamada (mesmo state/code) não cria nada, não rotaciona nem cria 2ª sessão", async () => {
    const { code } = await makeAccessCode();
    const { flow, code: gcode, res } = await signup(U, code);
    expect(location(res)).toBe("/");
    const sessionsBefore = await db.selectFrom("sessions").selectAll().execute();
    const replay = await callback(flow, gcode);
    expect(location(replay)).toBe("/login?google=erro&motivo=falha");
    expect(sessionCookieOf(replay)).toBeUndefined();
    expect(await db.selectFrom("sessions").selectAll().execute()).toHaveLength(sessionsBefore.length);
    expect(await signedUpCount()).toBe(1);
  });

  it("o code do Google é de uso único: reutilizá-lo em outra tentativa falha na troca (invalid_grant) e nada é criado", async () => {
    const a = await makeAccessCode();
    const b = await makeAccessCode();
    const flowA = await startFlow("signup", a.code);
    const gcode = approve(sim, flowA, U);
    expect(location(await callback(flowA, gcode))).toBe("/");
    const flowB = await startFlow("signup", b.code);
    approve(sim, flowB, { ...U, sub: "outro" });
    const res = await callback(flowB, gcode); // code do Google já consumido
    expect(location(res)).toBe("/login?google=erro&motivo=falha");
    expect(await signedUpCount()).toBe(1);
    expect((await codeRow(b.id)).redeemedAt).toBeNull();
  });

  it("vínculo de navegador: sem cookie, cookie de OUTRA tentativa ou adulterado ⇒ rejeitado (state de B não funciona no navegador de A)", async () => {
    const a = await makeAccessCode();
    const b = await makeAccessCode();
    const flowA = await startFlow("signup", a.code);
    const flowB = await startFlow("signup", b.code);
    const gB = approve(sim, flowB, { ...U, sub: "sub-b", email: "b@gmail.com" });
    expect(location(await callback(flowB, gB, { cookie: null }))).toBe("/login?google=erro&motivo=falha");
    const gB2 = approve(sim, flowB, { ...U, sub: "sub-b", email: "b@gmail.com" });
    // a tentativa de B foi consumida acima (state é de uso único), então o ataque real é: state de B + cookie de A
    const flowB2 = await startFlow("signup", b.code);
    const gB3 = approve(sim, flowB2, { ...U, sub: "sub-b", email: "b@gmail.com" });
    expect(location(await callback(flowB2, gB3, { cookie: flowA.binding }))).toBe("/login?google=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect(gB2).toBeTruthy();
  });

  it("PKCE: o verifier enviado ao Google é o da tentativa; trocar o state de tentativa faz o Google (code_challenge) recusar; verifier cifrado em repouso", async () => {
    const a = await makeAccessCode();
    const b = await makeAccessCode();
    const flowA = await startFlow("signup", a.code);
    const flowB = await startFlow("signup", b.code);
    const gA = approve(sim, flowA, U); // code emitido para o challenge de A
    const res = await callback(flowB, gA); // atacante usa o code de A com o state/cookie de B ⇒ verifier de B ≠ challenge de A
    expect(location(res)).toBe("/login?google=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    const rows = await db.selectFrom("oauthAttempts").select(["pkceVerifierCt"]).execute();
    for (const r of rows) expect(r.pkceVerifierCt.length).toBeGreaterThan(43); // iv + tag + ciphertext (não é o verifier em claro)
  });

  it("erro do provedor (access_denied) ⇒ 'cancelado', sem criar nada; a mensagem do Google nunca é repassada", async () => {
    const { code } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const res = await callback(flow, undefined, { error: "access_denied" });
    expect(location(res)).toBe("/login?google=erro&motivo=cancelado");
    const res2 = await callback(await startFlow("signup", (await makeAccessCode()).code), undefined, { error: "<script>alert(1)</script>" });
    expect(location(res2)).toBe("/login?google=erro&motivo=falha");
    expect(location(res2)).not.toContain("script");
    expect(await signedUpCount()).toBe(0);
  });

  it("o cookie de vínculo é sempre apagado no callback e nenhuma resposta carrega token/code/ID token", async () => {
    const { code } = await makeAccessCode();
    const { res, flow, code: gcode } = await signup(U, code);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith("levora_oauth="))!;
    expect(cleared).toMatch(/Max-Age=0/);
    const everything = location(res) + res.headers.getSetCookie().filter((c) => !c.startsWith("floot_built_app_session=")).join(";") + (await res.text());
    for (const secret of [gcode, flow.state, flow.nonce, "eyJ", "ya29"]) expect(everything).not.toContain(secret);
  });
});

describe("IDOR / ownership", () => {
  it("identidade já vinculada a OUTRO usuário nunca é movida, sobrescrita nem usada para um 2º usuário", async () => {
    const owner = await createTestUser({ email: "dono@example.com" });
    await db.insertInto("userIdentities").values({ userId: owner.id, provider: "google", issuer: GOOGLE_ISSUER, subject: "sub-do-dono", emailSnapshot: "dono@example.com", emailVerified: true }).execute();
    const { code, id } = await makeAccessCode();
    const { res } = await signup({ sub: "sub-do-dono", email: "intruso@gmail.com", email_verified: true }, code);
    expect(location(res)).toBe("/login?google=erro&motivo=ja_cadastrada");
    const rows = await identityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.id, subject: "sub-do-dono", emailSnapshot: "dono@example.com" });
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect(await signedUpCount()).toBe(0);
  });

  it("a mesma identidade externa só pertence a UM usuário no banco (UNIQUE provider+issuer+subject); chaves distintas não colidem", async () => {
    const a = await createTestUser({ email: "a@example.com" });
    const b = await createTestUser({ email: "b@example.com" });
    const ins = (userId: number, issuer: string, subject: string, provider = "google") => db.insertInto("userIdentities").values({ userId, provider, issuer, subject }).execute();
    await ins(a.id, "https://accounts.google.com", "A");
    await ins(b.id, "https://accounts.google.com", "B"); // outro subject
    await ins(b.id, "https://outro-emissor.example", "A"); // outro issuer, mesmo subject
    await ins(b.id, "https://accounts.google.com", "A", "microsoft"); // outro provider (restrição de CHECK permite; sem fluxo implementado)
    await expect(ins(b.id, "https://accounts.google.com", "A")).rejects.toThrow(/user_identities_provider_issuer_subject_key/);
    expect((await identityRows()).length).toBe(4);
  });

  it("nada depende do cliente: o callback ignora user_id/intent/código enviados e só usa a linha da tentativa", async () => {
    const victim = await createTestUser({ email: "vitima@example.com" });
    await db.insertInto("userIdentities").values({ userId: victim.id, provider: "google", issuer: GOOGLE_ISSUER, subject: "sub-vitima", emailVerified: true }).execute();
    const flow = await startFlow("login");
    const g = approve(sim, flow, { sub: "sub-atacante", email: "vitima@example.com", email_verified: true });
    const qs = new URLSearchParams({ state: flow.state, code: g, user_id: String(victim.id), userId: String(victim.id) });
    const res = await callbackHandler(buildRequest(`auth/google-callback?${qs}`, { method: "GET", cookie: flow.binding }));
    expect(location(res)).toBe("/login?google=erro&motivo=nao_vinculada");
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", victim.id).execute()).toHaveLength(0);
  });

  it("o id do código na tentativa não é alterável pelo cliente; um código revogado depois do start não cadastra", async () => {
    const mine = await makeAccessCode();
    const other = await makeAccessCode();
    const flow = await startFlow("signup", mine.code);
    const attempt = await db.selectFrom("oauthAttempts").select("accessCodeId").executeTakeFirstOrThrow();
    expect(attempt.accessCodeId).toBe(mine.id);
    const qs = new URLSearchParams({ state: flow.state, code: approve(sim, flow, U), accessCodeId: String(other.id), accessCode: other.code });
    const res = await callbackHandler(buildRequest(`auth/google-callback?${qs}`, { method: "GET", cookie: flow.binding }));
    expect(location(res)).toBe("/");
    expect((await codeRow(mine.id)).redeemedAt).not.toBeNull();
    expect((await codeRow(other.id)).redeemedAt).toBeNull();
  });
});

describe("CONCORRÊNCIA (A–J) — sem sleeps, sem retries", () => {
  it("A: dois callbacks para a MESMA tentativa (state único) ⇒ exatamente um prossegue", async () => {
    const { code } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const g1 = approve(sim, flow, U);
    const g2 = approve(sim, flow, U);
    const [r1, r2] = await Promise.all([callback(flow, g1), callback(flow, g2)]);
    expect([location(r1), location(r2)].sort()).toEqual(["/", "/login?google=erro&motivo=falha"]);
    expect(await signedUpCount()).toBe(1);
    expect(await identityRows()).toHaveLength(1);
    expect(await db.selectFrom("sessions").selectAll().execute()).toHaveLength(1);
  });

  it("B/F: dois logins Google simultâneos da mesma identidade (e callback duplicado da mesma tentativa) ⇒ cada tentativa gera no máximo 1 sessão", async () => {
    const user = await createTestUser({ email: "vinc@example.com" });
    await db.insertInto("userIdentities").values({ userId: user.id, provider: "google", issuer: GOOGLE_ISSUER, subject: "sub-b", emailVerified: true }).execute();
    const f1 = await startFlow("login");
    const f2 = await startFlow("login");
    const [a, b] = await Promise.all([callback(f1, approve(sim, f1, { sub: "sub-b", email: "x@gmail.com" })), callback(f2, approve(sim, f2, { sub: "sub-b", email: "x@gmail.com" }))]);
    expect([location(a), location(b)]).toEqual(["/", "/"]);
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute()).toHaveLength(2);
    expect(await identityRows()).toHaveLength(1);
    // F: o mesmo state duas vezes
    const f3 = await startFlow("login");
    const [c, d] = await Promise.all([callback(f3, approve(sim, f3, { sub: "sub-b" })), callback(f3, approve(sim, f3, { sub: "sub-b" }))]);
    expect([location(c), location(d)].sort()).toEqual(["/", "/login?google=erro&motivo=falha"]);
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute()).toHaveLength(3);
  });

  it("C: dois cadastros com o MESMO código e a MESMA identidade Google ⇒ 1 usuário, 1 identidade, código consumido 1 vez", async () => {
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

  it("D: dois cadastros com o MESMO código e identidades Google DIFERENTES ⇒ exatamente 1 conta", async () => {
    const { code, id } = await makeAccessCode();
    const f1 = await startFlow("signup", code);
    const f2 = await startFlow("signup", code);
    const results = await Promise.all([
      callback(f1, approve(sim, f1, { sub: "d1", email: "d1@gmail.com" })),
      callback(f2, approve(sim, f2, { sub: "d2", email: "d2@gmail.com" })),
    ]);
    expect(results.filter((r) => location(r) === "/")).toHaveLength(1);
    expect(results.filter((r) => location(r) === "/login?google=erro&motivo=codigo_indisponivel")).toHaveLength(1);
    expect(await signedUpCount()).toBe(1);
    expect(await identityRows()).toHaveLength(1);
    expect((await codeRow(id)).redeemedByUserId).not.toBeNull();
  });

  it("E/I: a MESMA issuer+sub tentando criar duas contas com DOIS códigos ⇒ 1 conta; o código perdedor NÃO é queimado", async () => {
    const c1 = await makeAccessCode();
    const c2 = await makeAccessCode();
    const f1 = await startFlow("signup", c1.code);
    const f2 = await startFlow("signup", c2.code);
    const results = await Promise.all([callback(f1, approve(sim, f1, U)), callback(f2, approve(sim, f2, { ...U, email: "outro-email@gmail.com" }))]);
    expect(results.filter((r) => location(r) === "/")).toHaveLength(1);
    expect(await signedUpCount()).toBe(1);
    expect(await identityRows()).toHaveLength(1);
    const redeemed = [await codeRow(c1.id), await codeRow(c2.id)].filter((c) => c.redeemedAt !== null);
    expect(redeemed).toHaveLength(1); // o outro código segue utilizável
    // I (sequencial): tentar de novo com um código novo ⇒ ja_cadastrada, código novo intacto
    const c3 = await makeAccessCode();
    const again = await signup({ ...U, email: "terceiro@gmail.com" }, c3.code);
    expect(location(again.res)).toBe("/login?google=erro&motivo=ja_cadastrada");
    expect((await codeRow(c3.id)).redeemedAt).toBeNull();
  });

  it("G: código revogado antes do callback ⇒ nada criado; revogação SIMULTÂNEA ao callback ⇒ ou conta+código consumido, ou nada (nunca ambos)", async () => {
    const pre = await makeAccessCode();
    const f0 = await startFlow("signup", pre.code);
    await db.updateTable("registrationAccessCodes").set({ revokedAt: new Date(), revokedByUserId: pre.creatorId }).where("id", "=", pre.id).execute();
    expect(location(await callback(f0, approve(sim, f0, U)))).toBe("/login?google=erro&motivo=codigo_indisponivel");
    expect(await signedUpCount()).toBe(0);

    for (let round = 0; round < 4; round++) {
      const c = await makeAccessCode();
      const flow = await startFlow("signup", c.code);
      const g = approve(sim, flow, { sub: `g${round}`, email: `g${round}@gmail.com` });
      const [res] = await Promise.all([
        callback(flow, g),
        db.updateTable("registrationAccessCodes").set({ revokedAt: new Date(), revokedByUserId: c.creatorId }).where("id", "=", c.id).where("redeemedAt", "is", null).execute(),
      ]);
      const row = await codeRow(c.id);
      expect(row.redeemedAt !== null && row.revokedAt !== null).toBe(false);
      const created = await db.selectFrom("users").select("id").where("email", "=", `g${round}@gmail.com`).executeTakeFirst();
      if (location(res) === "/") {
        expect(created).toBeDefined();
        expect(row.redeemedByUserId).toBe(created!.id);
      } else {
        expect(created).toBeUndefined();
        expect(row.redeemedAt).toBeNull();
      }
    }
  });

  it("H: código expirado antes do callback ⇒ nada criado, código não queimado", async () => {
    const c = await makeAccessCode({ validityMs: 6 * 60 * 1000 });
    const flow = await startFlow("signup", c.code);
    await db.updateTable("registrationAccessCodes").set({ createdAt: new Date(Date.now() - 3 * 3600_000), expiresAt: new Date(Date.now() - 1000) }).where("id", "=", c.id).execute();
    expect(location(await callback(flow, approve(sim, flow, U)))).toBe("/login?google=erro&motivo=codigo_indisponivel");
    expect(await signedUpCount()).toBe(0);
    expect(await identityRows()).toHaveLength(0);
  });

  it("J: MFA ativado ao mesmo tempo que o login Google ⇒ nunca uma sessão plena para quem já tem MFA ativo ao final", async () => {
    for (let round = 0; round < 4; round++) {
      const user = await createTestUser({ email: `j${round}@example.com` });
      await db.insertInto("userIdentities").values({ userId: user.id, provider: "google", issuer: GOOGLE_ISSUER, subject: `j${round}`, emailVerified: true }).execute();
      const flow = await startFlow("login");
      const g = approve(sim, flow, { sub: `j${round}` });
      const [res] = await Promise.all([callback(flow, g), enrollTestMfa(user.id)]);
      const sessions = await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute();
      // ou o login ocorreu ANTES da ativação (sessão sem MFA, aceitável: o ativador revoga outras sessões) ou depois (challenge)
      if (location(res) === "/") expect(sessions).toHaveLength(1);
      else {
        expect(location(res)).toBe("/login?google=mfa");
        expect(sessions).toHaveLength(0);
      }
    }
  });
});

describe("rate limit, enumeração e auditoria", () => {
  it("início do fluxo: 20 por 15 min por IP; callback: 30 por 15 min por IP", async () => {
    const ip = "ip-limite-start";
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) last = await startHandler(buildRequest("auth/google-start", { method: "POST", ip, body: { intent: "login" } }));
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).not.toBeNull();
    const flow = await startFlow("login");
    let result: Response | undefined;
    for (let i = 0; i < 31; i++) result = await callback(flow, "x", { ip: "ip-limite-cb", state: "a".repeat(43) });
    expect(location(result!)).toBe("/login?google=erro&motivo=limite");
  });

  it("eventos de auditoria existem e NUNCA contêm code, tokens, nonce, verifier, state, segredos, senha ou e-mail", async () => {
    const { code } = await makeAccessCode();
    const ok = await signup(U, code);
    const failed = await signup({ ...U, sub: "x", email: "x@gmail.com" }, (await makeAccessCode()).code);
    const rejected = await (async () => {
      const flow = await startFlow("login");
      return callback(flow, approve(sim, flow, U, { tamper: (c) => ({ ...c, nonce: "errado" }) }));
    })();
    expect(location(ok.res)).toBe("/");
    expect(location(failed.res)).toBeTruthy();
    expect(location(rejected)).toBe("/login?google=erro&motivo=falha");
    const events = await audits("usuario.cadastro_google", "usuario.login_google_falhou", "usuario.cadastro_google_falhou", "usuario.google_identity_rejected");
    expect(events.length).toBeGreaterThanOrEqual(2);
    const dump = JSON.stringify(await db.selectFrom("auditLog").selectAll().execute());
    for (const secret of ["eyJ", "ya29", ok.flow.state, ok.flow.nonce, ok.code, "segredo-sintetico", "pessoa@gmail.com", "code_verifier"]) expect(dump, secret).not.toContain(secret);
  });
});

describe("exclusão de conta", () => {
  it("anonimizar remove a identidade Google (credencial), mantém o código REDIMIDO e a mesma identidade não volta a entrar", async () => {
    const { code, id } = await makeAccessCode();
    const { res } = await signup(U, code);
    expect(location(res)).toBe("/");
    const user = await db.selectFrom("users").selectAll().where("email", "=", U.email).executeTakeFirstOrThrow();
    // cenário de exclusão: a conta recebe uma senha (a exclusão exige senha; Google-only não tem exclusão self-service nesta fase)
    await db.insertInto("userPasswords").values({ userId: user.id, passwordHash: await generatePasswordHash("senha-valida-123") }).execute();
    const cookie = await createSessionCookie(user.id);
    const del = await deleteAccount(buildRequest("auth/account-delete", { method: "POST", cookie, body: { password: "senha-valida-123" } }));
    expect(del.status).toBe(200);
    expect(await identityRows()).toHaveLength(0);
    expect(await db.selectFrom("sessions").selectAll().where("userId", "=", user.id).execute()).toHaveLength(0);
    const row = await codeRow(id);
    expect(row.redeemedAt).not.toBeNull();
    expect((await db.selectFrom("users").select("registeredViaCodeId").where("id", "=", user.id).executeTakeFirstOrThrow()).registeredViaCodeId).toBe(id);
    const again = await (async () => {
      const flow = await startFlow("login");
      return callback(flow, approve(sim, flow, U));
    })();
    expect(location(again)).toBe("/login?google=erro&motivo=nao_vinculada");
    // e o código antigo não serve de novo
    const reuse = await startHandler(buildRequest("auth/google-start", { method: "POST", body: { intent: "signup", accessCode: code } }));
    expect(reuse.status).toBe(400);
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

  it("sem tokeninfo, sem implicit flow, sem Microsoft/Apple, sem tabela/colunas de tokens do Google", () => {
    const oidc = readFileSync("src/helpers/googleOidc.tsx", "utf8");
    expect(oidc).not.toMatch(/googleapis\.com\/(oauth2\/v\d\/)?tokeninfo/i); // nenhuma URL de tokeninfo
    expect(oidc).not.toMatch(/response_type["'], ["']token|id_token token/);
    const providers = source.filter(([f, text]) => !f.includes("schema.tsx") && /login\.microsoftonline|appleid\.apple|microsoft_callback|apple_callback/.test(text));
    expect(providers.map(([f]) => f)).toEqual([]);
    expect(readdirSync("src/endpoints/auth").filter((f) => /microsoft|apple/i.test(f))).toEqual([]);
    expect(readFileSync("db/schema.sql", "utf8")).not.toMatch(/google_tokens|refresh_token|access_token/i);
  });

  it("o único lugar que cria users por Google é o callback (dentro do provisionamento por código); o callback de login não tem INSERT em users", () => {
    const writers = source.filter(([, text]) => /insertInto\(\s*["']users["']\s*\)/.test(text)).map(([f]) => f).sort();
    expect(writers).toEqual(["src/endpoints/auth/google-callback_GET.ts", "src/endpoints/auth/register_with_password_POST.ts", "src/helpers/bootstrapFinalize.tsx"]);
    const cb = readFileSync("src/endpoints/auth/google-callback_GET.ts", "utf8");
    const loginPart = cb.slice(cb.indexOf('attempt.intent === "login"'), cb.indexOf("CADASTRO"));
    expect(loginPart).not.toMatch(/insertInto/);
    expect(cb).toMatch(/provisionUserWithAccessCode\(\s*\{ codeId: attempt\.accessCodeId \}/); // o código vem da TENTATIVA, nunca da requisição
    expect(cb).not.toMatch(/searchParams\.get\(["'](accessCode|access_code|intent|user_?id)/);
  });

  it("o callback usa redirecionamentos RELATIVOS e nunca Host/X-Forwarded-Host", () => {
    const cb = readFileSync("src/endpoints/auth/google-callback_GET.ts", "utf8");
    expect(cb).not.toMatch(/headers\.get\(["'](host|x-forwarded-host|origin|referer)/i);
    expect(cb).not.toMatch(/Location: ["'`]https?:/);
    expect(readFileSync("src/helpers/googleOidc.tsx", "utf8")).not.toMatch(/headers\.get\(["'](host|x-forwarded-host)/i);
  });
});

describe("contrato do frontend (estático)", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("login: 'Entrar com Google' com intent=login; cadastro: 'Continuar com Google' SÓ no ramo em que o código já foi validado", () => {
    expect(read("src/components/PasswordLoginForm.tsx")).toMatch(/<GoogleButton intent="login">/);
    const form = read("src/components/PasswordRegisterForm.tsx");
    expect(form).toMatch(/<GoogleButton intent="signup" accessCode=\{accessCode\}>/);
    const gated = form.slice(form.indexOf("{!codeValid ? ("));
    expect(gated.indexOf("<GoogleButton")).toBeGreaterThan(gated.indexOf(") : ("));
    expect(form).toMatch(/postAccessCodeCheck/); // o passo 1 valida (sem consumir) antes de oferecer qualquer método
  });

  it("o código de acesso só viaja no CORPO do POST: nada de URL/query/rota/storage/histórico no botão, no formulário e no cliente do start", () => {
    for (const src of [read("src/components/GoogleButton.tsx"), read("src/components/PasswordRegisterForm.tsx"), read("src/endpoints/auth/google-start_POST.schema.ts")]) {
      expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|history\.(push|replace)State|useSearchParams|location\.(search|hash)|URLSearchParams/);
    }
    expect(read("src/endpoints/auth/google-start_POST.schema.ts")).toContain('authRequest<OutputType>("POST", "google-start"');
    const login = read("src/pages/login.tsx");
    expect(login).toMatch(/replace: true/); // o retorno do callback (só um código curto) é removido da barra de endereço
    expect(login).not.toMatch(/accessCode|localStorage|sessionStorage/);
  });
});
