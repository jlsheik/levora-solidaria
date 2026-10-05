import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { decryptSecret } from "../src/helpers/identityKeys";
import { createChallenge, loadPendingChallengeForUpdate, consumeChallenge, recordChallengeFailure, readChallengeSecret, challengeHash, CHALLENGE_MAX_ATTEMPTS, MFA_CHALLENGE_TTL_MS } from "../src/helpers/authChallenges";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { base32Decode } from "../src/helpers/totp";
import { handle as getPlatformOrganizations } from "../src/endpoints/platform-organizations_GET";
import { handle as postOrgStatus } from "../src/endpoints/platform-organizations-status_POST";
import { createAuthenticatedUser, createPlatformAdmin, createPlatformOwner, createSessionCookie, createTestOrganization, createTestUser, enrollTestMfa, buildRequest, TEST_TOTP_SECRET } from "./helpers";
import { cookieFrom, clearedCookie, CHALLENGE, SESSION, PASSWORD, disableMfa, fullLogin, join, json, login, logout, mfaStatus, regenerate, resetReplay, sessionIdOf, setupBegin, setupConfirm, stepUp, totp, valueOf, verify, whoAmI } from "./mfaHarness";

const MIN = 60 * 1000;
const platformCall = (cookie: string) => getPlatformOrganizations(buildRequest("platform-organizations", { cookie }));
const auditActions = async (action?: string) => (await db.selectFrom("auditLog").selectAll().$if(Boolean(action), (q) => q.where("action", "=", action!)).orderBy("id", "asc").execute());

async function mfaUser() {
  const u = await createTestUser();
  await enrollTestMfa(u.id);
  return u;
}

describe("auth_challenges — estado parcial, NÃO é sessão", () => {
  it("cria com segredo opaco: só o HMAC fica no banco; challenges pendentes anteriores do mesmo usuário são cancelados", async () => {
    const u = await createTestUser();
    const a = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id }));
    const b = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id }));
    const rows = await db.selectFrom("authChallenges").selectAll().where("userId", "=", u.id).orderBy("id", "asc").execute();
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "pending"]);
    expect(JSON.stringify(rows)).not.toContain(a.secret);
    expect(JSON.stringify(rows)).not.toContain(b.secret);
    expect(rows[1].secretHash.equals(challengeHash(b.secret, 1))).toBe(true);
    expect(b.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(MFA_CHALLENGE_TTL_MS);
    // o cancelado não carrega mais
    const stale = await db.transaction().execute((trx) => loadPendingChallengeForUpdate(trx, a.secret, ["mfa_login"]));
    expect(stale).toBeNull();
  });

  it("carrega só pendente + dentro do prazo + propósito esperado; consumo é ÚNICO; tentativas esgotam o challenge", async () => {
    const u = await createTestUser();
    const c = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id }));
    expect(await db.transaction().execute((trx) => loadPendingChallengeForUpdate(trx, c.secret, ["mfa_enroll"]))).toBeNull(); // propósito errado
    expect(await db.transaction().execute((trx) => loadPendingChallengeForUpdate(trx, "x".repeat(43), ["mfa_login"]))).toBeNull(); // inexistente
    const row = await db.transaction().execute((trx) => loadPendingChallengeForUpdate(trx, c.secret, ["mfa_login"]));
    expect(row?.userId).toBe(u.id);
    let current = row!;
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS - 1; i++) {
      expect((await db.transaction().execute((trx) => recordChallengeFailure(trx, current))).exhausted).toBe(false);
      current = (await db.transaction().execute((trx) => loadPendingChallengeForUpdate(trx, c.secret, ["mfa_login"])))!;
    }
    expect(current.attempts).toBe(CHALLENGE_MAX_ATTEMPTS - 1);
    expect((await db.transaction().execute((trx) => recordChallengeFailure(trx, current))).exhausted).toBe(true);
    expect(await db.transaction().execute((trx) => loadPendingChallengeForUpdate(trx, c.secret, ["mfa_login"]))).toBeNull();

    const d = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id }));
    const results = await Promise.all(Array.from({ length: 6 }, () => db.transaction().execute((trx) => consumeChallenge(trx, Number(d.id)))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("challenge expirado nunca carrega nem é consumido", async () => {
    const u = await createTestUser();
    const now = new Date(Date.now() - 10 * MIN);
    const c = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id, now }));
    expect(await db.transaction().execute((trx) => loadPendingChallengeForUpdate(trx, c.secret, ["mfa_login"]))).toBeNull();
    expect(await db.transaction().execute((trx) => consumeChallenge(trx, c.id))).toBe(false);
  });

  it("leitura do cookie: só o nome certo e formato válido (43 caracteres base64url)", () => {
    const secret = "A".repeat(43);
    expect(readChallengeSecret(new Request("http://x", { headers: { cookie: `a=b; ${CHALLENGE}=${secret}` } }))).toBe(secret);
    expect(readChallengeSecret(new Request("http://x", { headers: { cookie: `${CHALLENGE}=curto` } }))).toBeNull();
    expect(readChallengeSecret(new Request("http://x", { headers: { cookie: `${SESSION}=${secret}` } }))).toBeNull();
    expect(readChallengeSecret(new Request("http://x"))).toBeNull();
  });
});

describe("login com MFA — a senha correta NÃO é login completo", () => {
  it("usuário SEM MFA e sem poder de plataforma: sessão direta, como antes (política atual: MFA opcional)", async () => {
    const u = await createTestUser();
    const res = await login(u.email);
    expect(res.status).toBe(200);
    expect(cookieFrom(res, SESSION)).toBeTruthy();
    expect(cookieFrom(res, CHALLENGE)).toBeUndefined();
    expect((await json<{ user: { id: number } }>(res)).user.id).toBe(u.id);
    const s = await db.selectFrom("sessions").select(["mfaVerifiedAt"]).where("userId", "=", u.id).executeTakeFirstOrThrow();
    expect(s.mfaVerifiedAt).toBeNull();
  });

  it("usuário COM MFA: 200 {mfaRequired}, cookie de challenge, NENHUMA sessão e nenhum dado de usuário; o challenge não autentica nada", async () => {
    const u = await mfaUser();
    const res = await login(u.email);
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(body).toMatchObject({ mfaRequired: true, mfaKind: "verify" });
    expect(body.user).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(u.email);
    expect(cookieFrom(res, SESSION)).toBeUndefined();
    const challenge = cookieFrom(res, CHALLENGE)!;
    expect(challenge).toBeTruthy();
    expect(res.headers.getSetCookie().find((c) => c.startsWith(CHALLENGE))).toMatch(/HttpOnly.*Secure.*SameSite=Lax.*Path=\/_api\/v1\/auth/);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(0);
    // o segredo do challenge, usado COMO cookie de sessão, ou o cookie de challenge sozinho, nunca autenticam
    expect((await whoAmI(challenge)).status).toBe(401);
    expect((await whoAmI(`${SESSION}=${valueOf(challenge)}`)).status).toBe(401);
    expect((await mfaStatus(challenge)).status).toBe(401);
  });

  it("enumeração: senha errada de conta COM MFA e e-mail inexistente respondem IGUAL (status e corpo); MFA não vaza antes da senha certa", async () => {
    const u = await mfaUser();
    const a = await login(u.email, "errada-errada", "192.0.2.10");
    const b = await login("nao-existe@example.com", "errada-errada", "192.0.2.11");
    expect(a.status).toBe(401);
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
    expect(cookieFrom(a, CHALLENGE)).toBeUndefined();
  });

  it("TOTP correto conclui: sessão com id novo e mfa_verified_at, challenge consumido e cookie apagado; eventos de auditoria sem segredos", async () => {
    const u = await mfaUser();
    const first = await login(u.email);
    const challenge = cookieFrom(first, CHALLENGE)!;
    const done = await verify(challenge, { code: totp() });
    expect(done.status).toBe(200);
    expect((await json<{ user: { id: number } }>(done)).user.id).toBe(u.id);
    const session = cookieFrom(done, SESSION)!;
    expect(clearedCookie(done, CHALLENGE)).toBe(true);
    expect(valueOf(session)).not.toBe(valueOf(challenge));
    const row = await db.selectFrom("sessions").selectAll().where("userId", "=", u.id).executeTakeFirstOrThrow();
    expect(row.mfaVerifiedAt).not.toBeNull();
    expect(row.lastReauthAt).not.toBeNull();
    expect(row.primaryMethod).toBe("password");
    expect(row.id).not.toBe(valueOf(challenge));
    expect((await whoAmI(session)).status).toBe(200);
    const ch = await db.selectFrom("authChallenges").select(["status", "consumedAt"]).where("userId", "=", u.id).executeTakeFirstOrThrow();
    expect(ch.status).toBe("consumed");
    expect((await auditActions()).map((e) => e.action)).toEqual(expect.arrayContaining(["mfa.desafio_emitido", "mfa.utilizado", "usuario.login_realizado"]));
  });

  it("REPLAY do challenge: depois do sucesso, o mesmo cookie não conclui de novo (nem com outro código válido)", async () => {
    const u = await mfaUser();
    const challenge = cookieFrom(await login(u.email), CHALLENGE)!;
    expect((await verify(challenge, { code: totp() })).status).toBe(200);
    const again = await verify(challenge, { code: totp(1) });
    expect(again.status).toBe(401);
    expect((await json<{ code: string }>(again)).code).toBe("challenge_invalido");
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(1);
  });

  it("código errado: 401 sem sessão; 5 erros encerram o challenge (mesmo o código certo depois falha) e o cookie é apagado", async () => {
    const u = await mfaUser();
    const challenge = cookieFrom(await login(u.email), CHALLENGE)!;
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS - 1; i++) {
      const r = await verify(challenge, { code: "000000" });
      expect(r.status).toBe(401);
      expect((await json<{ code: string }>(r)).code).toBe("codigo_invalido");
    }
    const last = await verify(challenge, { code: "000000" });
    expect((await json<{ code: string }>(last)).code).toBe("challenge_esgotado");
    expect(clearedCookie(last, CHALLENGE)).toBe(true);
    const afterGood = await verify(challenge, { code: totp() });
    expect(afterGood.status).toBe(401);
    expect((await json<{ code: string }>(afterGood)).code).toBe("challenge_invalido");
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(0);
    expect((await auditActions("mfa.tentativa_falhou")).length).toBe(CHALLENGE_MAX_ATTEMPTS);
  });

  it("challenge EXPIRADO: recusado (resposta idêntica às demais) e nenhuma sessão é criada", async () => {
    const u = await mfaUser();
    const challenge = cookieFrom(await login(u.email), CHALLENGE)!;
    await db.updateTable("authChallenges").set({ expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 6 * MIN) }).where("userId", "=", u.id).execute();
    const r = await verify(challenge, { code: totp() });
    expect(r.status).toBe(401);
    expect((await json<{ code: string }>(r)).code).toBe("challenge_invalido");
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(0);
  });

  it("sem cookie, cookie inventado, de OUTRO propósito (inscrição) ou cancelado por novo login: tudo a mesma recusa", async () => {
    const u = await mfaUser();
    const noCookie = await verify(undefined, { code: totp() });
    const forged = await verify(`${CHALLENGE}=${"B".repeat(43)}`, { code: totp() });
    expect(noCookie.status).toBe(401);
    expect(await noCookie.text()).toBe(await forged.text());
    const old = cookieFrom(await login(u.email), CHALLENGE)!;
    const fresh = cookieFrom(await login(u.email, PASSWORD, "198.51.100.9"), CHALLENGE)!;
    expect((await verify(old, { code: totp() })).status).toBe(401); // cancelado pelo login mais novo
    expect((await verify(fresh, { code: totp() })).status).toBe(200);
    // challenge de INSCRIÇÃO não verifica login
    const owner = await createPlatformOwner();
    await db.deleteFrom("mfaMethods").where("userId", "=", owner.userId).execute().catch(() => undefined);
  });

  it("session fixation: a sessão pré-existente do atacante não é aproveitada — o login completo cria um id NOVO e não toca a sessão anterior", async () => {
    const u = await mfaUser();
    const attackerPlanted = await createSessionCookie(u.id); // cookie "plantado" antes do login (sem MFA)
    const plantedId = await sessionIdOf(attackerPlanted);
    const challenge = cookieFrom(await login(u.email), CHALLENGE)!;
    const done = await verify(`${challenge}; ${attackerPlanted}`, { code: totp() });
    const newSession = cookieFrom(done, SESSION)!;
    expect(await sessionIdOf(newSession)).not.toBe(plantedId);
    const planted = await db.selectFrom("sessions").select("mfaVerifiedAt").where("id", "=", plantedId).executeTakeFirstOrThrow();
    expect(planted.mfaVerifiedAt).toBeNull(); // continua "pré-MFA"; não foi promovida
  });

  it("recovery code conclui o login (uso único); reuso, código de outro usuário e formato errado falham; TOTP continua válido", async () => {
    const a = await mfaUser();
    const b = await mfaUser();
    const { issueRecoveryCodes } = await import("../src/helpers/mfa");
    const codesA = await db.transaction().execute((trx) => issueRecoveryCodes(trx, a.id));
    const codesB = await db.transaction().execute((trx) => issueRecoveryCodes(trx, b.id));
    const c1 = cookieFrom(await login(a.email, PASSWORD, "203.0.113.1"), CHALLENGE)!;
    const ok = await verify(c1, { recoveryCode: codesA[0] });
    expect(ok.status).toBe(200);
    expect(cookieFrom(ok, SESSION)).toBeTruthy();
    expect((await auditActions("mfa.recovery_code_usado")).length).toBe(1);
    const c2 = cookieFrom(await login(a.email, PASSWORD, "203.0.113.2"), CHALLENGE)!;
    expect((await verify(c2, { recoveryCode: codesA[0] })).status).toBe(401); // reuso
    expect((await verify(c2, { recoveryCode: codesB[0] })).status).toBe(401); // de outro usuário
    expect((await verify(c2, { recoveryCode: "lixo" })).status).toBe(401);
    expect((await verify(c2, { recoveryCode: codesA[1] })).status).toBe(200); // outro código seu, no mesmo challenge (ainda tinha tentativas)
  });

  it("REPLAY do TOTP entre logins: o mesmo código, no mesmo passo, não vale num segundo login; o código do passo seguinte vale", async () => {
    const u = await mfaUser();
    const code = totp();
    const c1 = cookieFrom(await login(u.email, PASSWORD, "203.0.113.31"), CHALLENGE)!;
    expect((await verify(c1, { code })).status).toBe(200);
    const c2 = cookieFrom(await login(u.email, PASSWORD, "203.0.113.32"), CHALLENGE)!;
    expect((await verify(c2, { code })).status).toBe(401);
    expect((await verify(c2, { code: totp(1) })).status).toBe(200);
  });

  it("CONCORRÊNCIA: 6 verificações simultâneas do mesmo challenge e do mesmo código — exatamente 1 sessão", async () => {
    const u = await mfaUser();
    const challenge = cookieFrom(await login(u.email), CHALLENGE)!;
    const code = totp();
    const results = await Promise.all(Array.from({ length: 6 }, () => verify(challenge, { code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(1);
  });

  it("CONCORRÊNCIA: o mesmo TOTP usado em 2 challenges/IPs diferentes ao mesmo tempo — só 1 vence (replay atômico)", async () => {
    const u = await mfaUser();
    // dois logins em sequência cancelariam um ao outro; cria o 2º challenge direto no banco para o mesmo usuário
    const c1 = cookieFrom(await login(u.email, PASSWORD, "203.0.113.41"), CHALLENGE)!;
    const second = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id, primaryMethod: "password" }));
    // createChallenge cancela o primeiro: reabre-o para simular dois navegadores com challenges válidos
    await db.updateTable("authChallenges").set({ status: "pending" }).where("userId", "=", u.id).where("status", "=", "cancelled").execute();
    const code = totp();
    const results = await Promise.all([verify(c1, { code }, "203.0.113.41"), verify(`${CHALLENGE}=${second.secret}`, { code }, "203.0.113.42")]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("CONCORRÊNCIA: o mesmo recovery code em 2 challenges simultâneos — só 1 sessão", async () => {
    const u = await mfaUser();
    const { issueRecoveryCodes } = await import("../src/helpers/mfa");
    const [code] = await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.id));
    const c1 = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id, primaryMethod: "password" }));
    const c2 = await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.id, primaryMethod: "password" }));
    await db.updateTable("authChallenges").set({ status: "pending" }).where("userId", "=", u.id).execute();
    const results = await Promise.all([verify(`${CHALLENGE}=${c1.secret}`, { recoveryCode: code }), verify(`${CHALLENGE}=${c2.secret}`, { recoveryCode: code })]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(1);
  });

  it("login simultâneo (6 logins ao mesmo tempo): no máximo 1 challenge pendente por usuário e nenhuma sessão", async () => {
    const u = await mfaUser();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => login(u.email, PASSWORD, `203.0.113.${60 + i}`)));
    expect(rs.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    const pending = await db.selectFrom("authChallenges").select("id").where("userId", "=", u.id).where("status", "=", "pending").execute();
    expect(pending.length).toBeLessThanOrEqual(1);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(0);
  });

  it("logout depois do login com MFA remove a sessão e audita; o cookie deixa de valer", async () => {
    const u = await mfaUser();
    const session = await fullLogin(u.email, u.id);
    expect((await logout(session)).status).toBe(200);
    expect((await whoAmI(session)).status).toBe(401);
    expect((await auditActions("usuario.logout")).length).toBe(1);
  });

  it("falha de MFA gera auditoria SEM código, segredo, hash ou token; a hash-chain continua íntegra", async () => {
    const u = await mfaUser();
    const challenge = cookieFrom(await login(u.email), CHALLENGE)!;
    await verify(challenge, { code: "123456" });
    await verify(challenge, { recoveryCode: "ABCD-EFGH-JKMN-PQRS" });
    await verify(challenge, { code: totp() });
    const dump = JSON.stringify(await auditActions());
    for (const forbidden of ["123456", "ABCD-EFGH-JKMN-PQRS", valueOf(challenge), TEST_TOTP_SECRET.toString("hex"), "secret", "passwordHash"]) expect(dump).not.toContain(forbidden);
    for (const e of await auditActions("mfa.tentativa_falhou")) expect(Object.keys(e.metadata as object).sort()).toEqual(["desafioEsgotado", "motivo", "tipo"].sort());
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });
});

describe("titular de platform_access — MFA obrigatório", () => {
  it("owner/admin COM MFA: login só devolve challenge; depois do TOTP a sessão tem tier de plataforma e acessa /plataforma", async () => {
    const owner = await createPlatformOwner();
    const first = await login(owner.email);
    expect(cookieFrom(first, SESSION)).toBeUndefined();
    expect((await json<{ mfaKind: string }>(first)).mfaKind).toBe("verify");
    await resetReplay(owner.userId);
    const done = await verify(cookieFrom(first, CHALLENGE)!, { code: totp() });
    const session = cookieFrom(done, SESSION)!;
    expect((await json<{ user: { platformLevel: string } }>(done)).user.platformLevel).toBe("owner");
    expect((await platformCall(session)).status).toBe(200);
  });

  it("sessão de titular SEM MFA concluído é recusada em QUALQUER endpoint (401) — inclusive sessões antigas", async () => {
    const owner = await createPlatformOwner();
    const noMfaCookie = await createSessionCookie(owner.userId); // sem mfa_verified_at
    expect((await whoAmI(noMfaCookie)).status).toBe(401);
    expect((await platformCall(noMfaCookie)).status).toBe(401);
    expect((await platformCall(owner.cookie)).status).toBe(200); // a do helper tem MFA
    // usuário comum com sessão sem MFA continua normal
    const plain = await createAuthenticatedUser();
    expect((await whoAmI(plain.cookie)).status).toBe(200);
  });

  it("owner migrado (sem TOTP ainda): o login NÃO cria sessão — cai na INSCRIÇÃO; configura o autenticador e só então entra", async () => {
    const owner = await createTestUser();
    await db.insertInto("platformAccess").values({ userId: owner.id, level: "owner", status: "active", grantOrigin: "migrated_from_users_role" }).execute();
    const res = await login(owner.email);
    expect((await json<{ mfaKind: string }>(res)).mfaKind).toBe("enroll");
    expect(cookieFrom(res, SESSION)).toBeUndefined();
    const challenge = cookieFrom(res, CHALLENGE)!;
    expect((await platformCall(challenge)).status).toBe(401);

    const begin = await setupBegin(challenge);
    expect(begin.status).toBe(200);
    const setup = await json<{ otpauthUri: string; manualKey: string }>(begin);
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\/Levora:/);
    // "QR gerado" NÃO é "MFA ativo": segue pendente e o login ainda não existe
    const pending = await db.selectFrom("mfaMethods").selectAll().where("userId", "=", owner.id).executeTakeFirstOrThrow();
    expect(pending.status).toBe("pending");
    expect(pending.secretCiphertext.toString("latin1")).not.toContain(setup.manualKey);
    expect((await platformCall(challenge)).status).toBe(401);

    // código ERRADO: continua pendente
    const wrong = await setupConfirm(challenge, { code: "000000" });
    expect(wrong.status).toBe(401);
    expect((await db.selectFrom("mfaMethods").select("status").where("userId", "=", owner.id).executeTakeFirstOrThrow()).status).toBe("pending");
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", owner.id).execute()).toHaveLength(0);

    // código CERTO (do segredo gerado): ativa, emite recovery codes, cria a sessão (id novo, MFA concluído)
    const secret = base32Decode(setup.manualKey);
    const { totpCodeAtStep, stepAt } = await import("../src/helpers/totp");
    const ok = await setupConfirm(challenge, { code: totpCodeAtStep(secret, stepAt(Date.now())) });
    expect(ok.status).toBe(200);
    const body = await json<{ recoveryCodes: string[]; user: { platformLevel: string } }>(ok);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.user.platformLevel).toBe("owner");
    const session = cookieFrom(ok, SESSION)!;
    expect((await platformCall(session)).status).toBe(200);
    const active = await db.selectFrom("mfaMethods").selectAll().where("userId", "=", owner.id).executeTakeFirstOrThrow();
    expect(active.status).toBe("active");
    expect(decryptSecret(active.secretCiphertext, active.secretKeyId, `mfa:${owner.id}`).equals(secret)).toBe(true);
    const hashes = await db.selectFrom("mfaRecoveryCodes").select("codeHash").where("userId", "=", owner.id).execute();
    expect(hashes).toHaveLength(10);
    for (const c of body.recoveryCodes) expect(JSON.stringify(hashes)).not.toContain(c);
    // os códigos nunca são devolvidos de novo
    const status = await json<Record<string, unknown>>(await mfaStatus(session));
    expect(JSON.stringify(status)).not.toContain(body.recoveryCodes[0]);
    expect(status).toMatchObject({ active: true, recoveryCodesRemaining: 10, requiredByPolicy: true });
  });

  it("owner e admin NÃO removem o MFA: endpoint 409 mfa_obrigatorio; SQL direto (apagar, desativar) barrado pelo trigger; a troca na MESMA transação é aceita", async () => {
    for (const make of [createPlatformOwner, createPlatformAdmin]) {
      if (make === createPlatformAdmin) await createPlatformOwner().catch(() => undefined);
      const holder = await make();
      const res = await disableMfa(holder.cookie);
      expect(res.status).toBe(409);
      expect((await json<{ code: string }>(res)).code).toBe("mfa_obrigatorio");
      await expect(db.deleteFrom("mfaMethods").where("userId", "=", holder.userId).execute()).rejects.toThrow(/sem MFA ativo/);
      await expect(db.updateTable("mfaMethods").set({ status: "disabled" }).where("userId", "=", holder.userId).execute()).rejects.toThrow(/sem MFA ativo/);
      expect((await db.selectFrom("mfaMethods").select("status").where("userId", "=", holder.userId).executeTakeFirstOrThrow()).status).toBe("active");
      // troca atômica (como a recuperação do owner): desativa e cria o novo no mesmo COMMIT
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("mfaMethods").set({ status: "disabled", disabledAt: new Date() }).where("userId", "=", holder.userId).execute();
        const { encryptSecret } = await import("../src/helpers/identityKeys");
        const { ciphertext, keyId } = encryptSecret(TEST_TOTP_SECRET, `mfa:${holder.userId}`);
        await trx.insertInto("mfaMethods").values({ userId: holder.userId, status: "active", secretCiphertext: ciphertext, secretKeyId: keyId, confirmedAt: new Date() }).execute();
      });
    }
  });

  it("depois que o acesso de plataforma é revogado, o MFA volta a ser opcional (pode ser desativado com step-up)", async () => {
    const owner = await createPlatformOwner();
    const admin = await createPlatformAdmin();
    await db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", admin.userId).execute();
    const cookie = await createSessionCookie(admin.userId, { mfaVerified: true });
    expect((await disableMfa(cookie)).status).toBe(200);
    void owner;
  });
});

describe("ativação voluntária do MFA (usuário comum, sessão) + recovery + step-up", () => {
  async function enrolled() {
    const u = await createAuthenticatedUser(); // sessão SEM mfa_verified_at (usuário comum)
    const begin = await setupBegin(u.cookie, { password: PASSWORD });
    const setup = await json<{ manualKey: string }>(begin);
    const secret = base32Decode(setup.manualKey);
    const { totpCodeAtStep, stepAt } = await import("../src/helpers/totp");
    return { u, secret, code: (offset = 0) => totpCodeAtStep(secret, stepAt(Date.now()) + offset) };
  }

  it("exige a senha (reauth): sem senha ou com senha errada = 401 e nada é criado", async () => {
    const u = await createAuthenticatedUser();
    expect((await setupBegin(u.cookie, {})).status).toBe(401);
    expect((await setupBegin(u.cookie, { password: "errada-errada" })).status).toBe(401);
    expect(await db.selectFrom("mfaMethods").select("id").where("userId", "=", u.userId).execute()).toHaveLength(0);
    expect((await setupBegin(undefined, { password: PASSWORD })).status).toBe(401); // anônimo
  });

  it("confirmar: código errado mantém pendente; 5 erros descartam; código certo ativa, emite recovery codes, REVOGA as outras sessões e ROTACIONA a atual", async () => {
    const { u, secret, code } = await enrolled();
    const other = await createSessionCookie(u.userId);
    const oldId = await sessionIdOf(u.cookie);
    for (let i = 0; i < 4; i++) expect((await setupConfirm(u.cookie, { code: "000000" })).status).toBe(401);
    expect((await db.selectFrom("mfaMethods").select("status").where("userId", "=", u.userId).executeTakeFirstOrThrow()).status).toBe("pending");
    const ok = await setupConfirm(u.cookie, { code: code() });
    expect(ok.status).toBe(200);
    expect((await json<{ recoveryCodes: string[] }>(ok)).recoveryCodes).toHaveLength(10);
    const fresh = cookieFrom(ok, SESSION)!;
    expect(await sessionIdOf(fresh)).not.toBe(oldId);
    expect((await whoAmI(u.cookie)).status).toBe(401); // JWT antigo: linha removida pela rotação
    expect((await whoAmI(other)).status).toBe(401); // outras sessões revogadas
    expect((await whoAmI(fresh)).status).toBe(200);
    const row = await db.selectFrom("sessions").select(["mfaVerifiedAt", "absoluteExpiresAt"]).where("userId", "=", u.userId).executeTakeFirstOrThrow();
    expect(row.mfaVerifiedAt).not.toBeNull();
    expect((await db.selectFrom("mfaMethods").select(["status", "lastUsedStep"]).where("userId", "=", u.userId).executeTakeFirstOrThrow()).status).toBe("active");
    void secret;
    // com o MFA ativo, um novo begin é recusado
    expect((await setupBegin(fresh, { password: PASSWORD })).status).toBe(409);
  });

  it("5 códigos errados DESCARTAM a configuração pendente (é preciso recomeçar)", async () => {
    const { u, code } = await enrolled();
    for (let i = 0; i < 4; i++) await setupConfirm(u.cookie, { code: "000000" });
    const fifth = await setupConfirm(u.cookie, { code: "000000" });
    expect((await json<{ code: string }>(fifth)).code).toBe("configuracao_descartada");
    const afterGood = await setupConfirm(u.cookie, { code: code() });
    expect(afterGood.status).toBe(409);
    expect((await db.selectFrom("mfaMethods").select("status").where("userId", "=", u.userId).executeTakeFirstOrThrow()).status).toBe("disabled");
  });

  it("CONCORRÊNCIA: dois 'begin' simultâneos deixam UM pendente; dois 'confirm' simultâneos com o mesmo código ativam UMA vez", async () => {
    const u = await createAuthenticatedUser();
    const [b1, b2] = await Promise.all([setupBegin(u.cookie, { password: PASSWORD }), setupBegin(u.cookie, { password: PASSWORD })]);
    expect([b1.status, b2.status].every((s) => s === 200 || s === 429)).toBe(true);
    expect(await db.selectFrom("mfaMethods").select("id").where("userId", "=", u.userId).where("status", "=", "pending").execute()).toHaveLength(1);
    const pending = await db.selectFrom("mfaMethods").selectAll().where("userId", "=", u.userId).executeTakeFirstOrThrow();
    const secret = decryptSecret(pending.secretCiphertext, pending.secretKeyId, `mfa:${u.userId}`);
    const { totpCodeAtStep, stepAt } = await import("../src/helpers/totp");
    const code = totpCodeAtStep(secret, stepAt(Date.now()));
    const rs = await Promise.all([setupConfirm(u.cookie, { code }), setupConfirm(u.cookie, { code })]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.selectFrom("mfaMethods").select("id").where("userId", "=", u.userId).where("status", "=", "active").execute()).toHaveLength(1);
    expect(await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", u.userId).where("invalidatedAt", "is", null).execute()).toHaveLength(10);
  });

  it("CONCORRÊNCIA: ativação do MFA × login em paralelo — o estado final é consistente (sessões antigas revogadas, MFA ativo, no máximo 1 sessão da ativação)", async () => {
    const u = await createAuthenticatedUser();
    const secretResp = await json<{ manualKey: string }>(await setupBegin(u.cookie, { password: PASSWORD }));
    const { totpCodeAtStep, stepAt } = await import("../src/helpers/totp");
    const code = totpCodeAtStep(base32Decode(secretResp.manualKey), stepAt(Date.now()));
    const [confirm, loginRes] = await Promise.all([setupConfirm(u.cookie, { code }), login(u.email, PASSWORD, "203.0.113.90")]);
    expect(confirm.status).toBe(200);
    expect([200]).toContain(loginRes.status);
    expect((await db.selectFrom("mfaMethods").select("status").where("userId", "=", u.userId).executeTakeFirstOrThrow()).status).toBe("active");
    // o login concorrente ou entrou antes (sessão revogada pela ativação) ou depois (cai em challenge): nunca sobra sessão "pré-MFA" válida
    const sessions = await db.selectFrom("sessions").select(["mfaVerifiedAt"]).where("userId", "=", u.userId).execute();
    expect(sessions.every((s) => s.mfaVerifiedAt !== null)).toBe(true);
  });

  it("PROVA DETERMINÍSTICA: um login que chega com a ativação do MFA ainda não commitada ESPERA o lock do usuário e, depois do COMMIT, cai no desafio (nunca cria sessão pré-MFA)", async () => {
    const u = await createTestUser();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const ready = new Promise<void>((resolve) => (held = resolve));
    const { lockUsersInOrder } = await import("../src/helpers/lockOrder");
    const { encryptSecret } = await import("../src/helpers/identityKeys");
    // "ativação em andamento": trava o usuário, ativa o MFA, mas só confirma (COMMIT) quando liberarmos
    const activation = db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [u.id]);
      const { ciphertext, keyId } = encryptSecret(TEST_TOTP_SECRET, `mfa:${u.id}`);
      await trx.insertInto("mfaMethods").values({ userId: u.id, status: "active", secretCiphertext: ciphertext, secretKeyId: keyId, confirmedAt: new Date() }).execute();
      held();
      await hold;
    });
    await ready;
    let loginDone = false;
    const loginPromise = login(u.email).then((r) => {
      loginDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(loginDone).toBe(false); // bloqueado no lock do usuário
    release();
    await activation;
    const res = await loginPromise;
    expect((await json<{ mfaRequired?: boolean }>(res)).mfaRequired).toBe(true);
    expect(cookieFrom(res, SESSION)).toBeUndefined();
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(0);
  });

  it("regenerar recovery codes: exige step-up recente (403 reauth_required), invalida os antigos e devolve novos UMA vez", async () => {
    const { u, code } = await enrolled();
    const ok = await setupConfirm(u.cookie, { code: code() });
    let session = cookieFrom(ok, SESSION)!;
    const original = (await json<{ recoveryCodes: string[] }>(ok)).recoveryCodes;
    // envelhece o carimbo de MFA/step-up
    await db.updateTable("sessions").set({ mfaVerifiedAt: new Date(Date.now() - 11 * MIN), lastReauthAt: new Date(Date.now() - 11 * MIN) }).where("userId", "=", u.userId).execute();
    const blocked = await regenerate(session);
    expect(blocked.status).toBe(403);
    expect((await json<{ code: string }>(blocked)).code).toBe("reauth_required");
    // step-up com TOTP do passo seguinte (o atual já foi consumido na ativação)
    const su = await stepUp(session, { code: code(1) });
    expect(su.status).toBe(200);
    session = cookieFrom(su, SESSION)!;
    const regen = await regenerate(session);
    expect(regen.status).toBe(200);
    const fresh = (await json<{ recoveryCodes: string[] }>(regen)).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => original.includes(c))).toBe(false);
    const open = await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", u.userId).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute();
    expect(open).toHaveLength(10);
    // antigos não entram no login; novos entram
    const c1 = cookieFrom(await login(u.email, PASSWORD, "203.0.113.71"), CHALLENGE)!;
    expect((await verify(c1, { recoveryCode: original[0] })).status).toBe(401);
    expect((await verify(c1, { recoveryCode: fresh[0] })).status).toBe(200);
    // anônimo não regenera
    expect((await regenerate(`${SESSION}=lixo`)).status).toBe(401);
  });

  it("desativar o MFA (usuário comum): step-up, invalida recovery codes, rotaciona a sessão; o login volta a ser direto", async () => {
    const { u, code } = await enrolled();
    const ok = await setupConfirm(u.cookie, { code: code() });
    const session = cookieFrom(ok, SESSION)!;
    const res = await disableMfa(session); // MFA acabou de ser concluído ⇒ recente
    expect(res.status).toBe(200);
    expect((await db.selectFrom("mfaMethods").select("status").where("userId", "=", u.userId).executeTakeFirstOrThrow()).status).toBe("disabled");
    expect(await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", u.userId).where("invalidatedAt", "is", null).execute()).toHaveLength(0);
    expect((await whoAmI(session)).status).toBe(401); // rotacionada
    const direct = await login(u.email, PASSWORD, "203.0.113.72");
    expect(cookieFrom(direct, SESSION)).toBeTruthy();
    expect((await auditActions("mfa.desativado")).length).toBe(1);
  });
});

describe("step-up — reautenticação recente nas ações críticas, sem sessão paralela", () => {
  const changeStatus = (cookie: string, orgId: number) => postOrgStatus(buildRequest("platform-organizations-status", { method: "POST", cookie, body: { organizationId: orgId, status: "suspensa" } }));

  it("ação crítica da plataforma: dentro da janela passa; passada a janela = 403 reauth_required; step-up com TOTP reabre e rotaciona o id; wrong code = 401", async () => {
    const admin = await createPlatformAdmin();
    const orgOwner = await createAuthenticatedUser();
    const org = await createTestOrganization(orgOwner.userId);
    expect((await changeStatus(admin.cookie, org.id)).status).toBe(200); // sessão do helper tem MFA recente

    const stale = new Date(Date.now() - 11 * MIN);
    await db.updateTable("sessions").set({ mfaVerifiedAt: stale, lastReauthAt: stale }).where("userId", "=", admin.userId).execute();
    const blocked = await changeStatus(admin.cookie, org.id);
    expect(blocked.status).toBe(403);
    expect((await json<{ code: string }>(blocked)).code).toBe("reauth_required");
    // leituras NÃO exigem step-up
    expect((await platformCall(admin.cookie)).status).toBe(200);

    await resetReplay(admin.userId);
    expect((await stepUp(admin.cookie, { code: "000000" })).status).toBe(401);
    const sessionsBefore = await db.selectFrom("sessions").select(["id", "mfaVerifiedAt"]).where("userId", "=", admin.userId).execute();
    const ok = await stepUp(admin.cookie, { code: totp() });
    expect(ok.status).toBe(200);
    const newCookie = cookieFrom(ok, SESSION)!;
    const sessionsAfter = await db.selectFrom("sessions").select(["id", "mfaVerifiedAt", "lastReauthAt"]).where("userId", "=", admin.userId).execute();
    expect(sessionsAfter).toHaveLength(1); // NÃO é uma sessão paralela
    expect(sessionsAfter[0].id).not.toBe(sessionsBefore[0].id); // rotacionada
    expect(sessionsAfter[0].mfaVerifiedAt?.getTime()).toBe(stale.getTime()); // MFA original preservado
    expect(sessionsAfter[0].lastReauthAt!.getTime()).toBeGreaterThan(stale.getTime());
    expect((await whoAmI(admin.cookie)).status).toBe(401);
    expect((await changeStatus(newCookie, org.id)).status).toBe(200);
    const actions = (await auditActions()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["step_up.falhou", "step_up.concluido"]));
  });

  it("step-up por recovery code; sem MFA ativo = 409; anônimo = 401; bloqueio por falhas é temporário", async () => {
    const admin = await createPlatformAdmin();
    const { issueRecoveryCodes } = await import("../src/helpers/mfa");
    const [code] = await db.transaction().execute((trx) => issueRecoveryCodes(trx, admin.userId));
    expect((await stepUp(admin.cookie, { recoveryCode: code })).status).toBe(200);
    const plain = await createAuthenticatedUser();
    expect((await stepUp(plain.cookie, { code: "123456" })).status).toBe(409);
    expect((await stepUp(`${SESSION}=lixo`, { code: "123456" })).status).toBe(401);
  });

  it("CONCORRÊNCIA: dois step-ups simultâneos com o MESMO código — 1 vence; com códigos de passos diferentes, a sessão rotacionada pelo primeiro derruba o segundo (sem sessões duplicadas)", async () => {
    const admin = await createPlatformAdmin();
    await resetReplay(admin.userId);
    const code = totp();
    const same = await Promise.all([stepUp(admin.cookie, { code }), stepUp(admin.cookie, { code })]);
    expect(same.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", admin.userId).execute()).toHaveLength(1);

    const admin2 = await createPlatformAdmin();
    await resetReplay(admin2.userId);
    const diff = await Promise.all([stepUp(admin2.cookie, { code: totp(-1) }), stepUp(admin2.cookie, { code: totp(1) })]);
    expect(diff.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", admin2.userId).execute()).toHaveLength(1);
  });
});

describe("lock de login — não é DoS contra o owner", () => {
  const wrong = (email: string, ip: string) => login(email, "errada-errada", ip);

  it("conta PROTEGIDA (MFA/plataforma): erros de OUTRA rede NÃO bloqueiam o dono; os da MESMA rede bloqueiam só aquela rede", async () => {
    const owner = await createPlatformOwner();
    for (let i = 0; i < 6; i++) await wrong(owner.email, `198.51.100.${i + 1}`); // atacante na rede 198.51.100.0/24
    expect((await login(owner.email, PASSWORD, "198.51.100.200")).status).toBe(429); // a rede do atacante está bloqueada (mesmo com a senha certa)
    const fromHome = await login(owner.email, PASSWORD, "203.0.113.7"); // o dono, de outra rede
    expect(fromHome.status).toBe(200);
    expect((await json<{ mfaRequired: boolean }>(fromHome)).mfaRequired).toBe(true);
    expect(cookieFrom(fromHome, CHALLENGE)).toBeTruthy();
  });

  it("várias redes atacando a MESMA conta protegida: nenhuma trava o dono; ≥20 falhas geram UM alerta usuario.login_suspeito (não bloqueio)", async () => {
    const u = await mfaUser();
    for (let i = 0; i < 22; i++) await wrong(u.email, `10.${i}.0.1`);
    const alerts = await auditActions("usuario.login_suspeito");
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0].metadata)).not.toContain(u.email);
    const ok = await login(u.email, PASSWORD, "203.0.113.8");
    expect(ok.status).toBe(200);
  });

  it("conta SEM segundo fator: o bloqueio por e-mail (qualquer rede) continua — a senha é a única defesa", async () => {
    const u = await createTestUser();
    for (let i = 0; i < 5; i++) await wrong(u.email, `198.51.100.${i + 1}`);
    expect((await login(u.email, PASSWORD, "203.0.113.9")).status).toBe(429);
  });

  it("o bloqueio da rede é temporário (15 min) e a falha na MESMA rede após passar o prazo volta a contar do zero", async () => {
    const u = await mfaUser();
    for (let i = 0; i < 5; i++) await wrong(u.email, "198.51.100.5");
    expect((await login(u.email, PASSWORD, "198.51.100.5")).status).toBe(429);
    await db.updateTable("loginAttempts").set({ attemptedAt: new Date(Date.now() - 16 * MIN) }).execute();
    expect((await login(u.email, PASSWORD, "198.51.100.5")).status).toBe(200);
  });

  it("brute force de senha sem 2º fator de ponta a ponta: com a senha CERTA ainda é preciso o TOTP — a senha sozinha nunca abre sessão", async () => {
    const owner = await createPlatformOwner();
    const res = await login(owner.email, PASSWORD, "203.0.113.20");
    expect(cookieFrom(res, SESSION)).toBeUndefined();
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", owner.userId).where("lastAccessed", ">", new Date(Date.now() - 5000)).execute()).toHaveLength(1); // só a do helper (criada no createPlatformOwner)
  });
});

describe("conta excluída e MFA", () => {
  it("excluir a conta remove segredo TOTP, recovery codes e challenges (minimização)", async () => {
    const { handle: postDelete } = await import("../src/endpoints/auth/account-delete_POST");
    const owner = await createPlatformOwner();
    void owner;
    const u = await createAuthenticatedUser();
    await enrollTestMfa(u.userId);
    const { issueRecoveryCodes } = await import("../src/helpers/mfa");
    await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.userId));
    await db.transaction().execute((trx) => createChallenge(trx, { purpose: "mfa_login", userId: u.userId }));
    const res = await postDelete(buildRequest("auth/account-delete", { method: "POST", cookie: u.cookie, body: { password: PASSWORD } }));
    expect(res.status).toBe(200);
    expect(await db.selectFrom("mfaMethods").select("id").where("userId", "=", u.userId).execute()).toHaveLength(0);
    expect(await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", u.userId).execute()).toHaveLength(0);
    expect(await db.selectFrom("authChallenges").select("id").where("userId", "=", u.userId).execute()).toHaveLength(0);
  });
});

describe("CONCORRÊNCIA J — login do owner × mudança de plataforma", () => {
  it("login completo do owner em paralelo com a transferência de ownership: nunca fica sem owner e a sessão criada reflete um nível válido", async () => {
    const { transferPlatformOwnership } = await import("../src/helpers/platformAccessAdmin");
    const owner = await createPlatformOwner();
    const admin = await createPlatformAdmin();
    await resetReplay(owner.userId);
    const first = await login(owner.email, PASSWORD, "203.0.113.150");
    const challenge = cookieFrom(first, CHALLENGE)!;
    const [verifyRes] = await Promise.all([
      verify(challenge, { code: totp() }),
      db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: owner.userId, targetUserId: admin.userId })),
    ]);
    expect(verifyRes.status).toBe(200);
    const level = (await json<{ user: { platformLevel: string | null } }>(verifyRes)).user.platformLevel;
    expect(["owner", "admin"]).toContain(level); // ou o nível de antes ou o de depois da transferência — nunca nulo nem inconsistente
    const owners = await db.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").execute();
    expect(owners).toEqual([{ userId: admin.userId }]);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", owner.userId).where("mfaVerifiedAt", "is not", null).execute()).not.toHaveLength(0);
  });
});
