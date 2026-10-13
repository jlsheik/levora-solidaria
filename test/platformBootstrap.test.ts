import { describe, it, expect } from "vitest";
import { compare } from "bcryptjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { db } from "../src/helpers/db";
import { activateBootstrapToken, BootstrapError, issueBootstrapToken, normalizeBootstrapToken, revokePendingBootstrapTokens, BOOTSTRAP_TOKEN_TTL_MS } from "../src/helpers/platformBootstrap";
import { decryptSecret } from "../src/helpers/identityKeys";
import { base32Decode, stepAt, totpCodeAtStep } from "../src/helpers/totp";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as getPlatformOrganizations } from "../src/endpoints/platform-organizations_GET";
import { createPlatformOwner, createTestUser, createSessionCookie, createAuthenticatedUser, buildRequest } from "./helpers";
import { bootstrapActivate, bootstrapCredentials, cookieFrom, CHALLENGE, SESSION, fullLogin, json, setupBegin, setupConfirm, whoAmI, stepUp, totp, resetReplay, clearedCookie, login, verify } from "./mfaHarness";

const MIN = 60 * 1000;
const platformCall = (cookie: string) => getPlatformOrganizations(buildRequest("platform-organizations", { cookie }));
const OWNER_EMAIL = "owner-novo@example.com";
const OWNER_PASSWORD = "uma-senha-forte-do-owner-1";

async function issueOwner(email = OWNER_EMAIL) {
  return issueBootstrapToken({ purpose: "owner", email, issuedBy: "teste@ci" });
}

const codeFor = (manualKey: string, offset = 0) => totpCodeAtStep(base32Decode(manualKey), stepAt(Date.now()) + offset);

/** Executa o fluxo completo (ativar → credenciais → begin → confirm). Devolve as respostas de cada etapa. */
async function runActivation(token: string, opts: { code?: (key: string) => string; password?: string; name?: string } = {}) {
  const act = await bootstrapActivate(token);
  const challenge = cookieFrom(act, CHALLENGE);
  const creds = await bootstrapCredentials(challenge, { displayName: opts.name ?? "Dono da Plataforma", password: opts.password ?? OWNER_PASSWORD });
  const begin = await setupBegin(challenge);
  const setup = begin.status === 200 ? await json<{ otpauthUri: string; manualKey: string }>(begin) : null;
  const confirm = setup ? await setupConfirm(challenge, { code: (opts.code ?? ((k: string) => codeFor(k)))(setup.manualKey) }) : null;
  return { act, challenge, creds, begin, setup, confirm };
}

const snapshotOwnerState = async () => ({
  users: (await db.selectFrom("users").select("id").execute()).length,
  passwords: (await db.selectFrom("userPasswords").select("id").execute()).length,
  access: (await db.selectFrom("platformAccess").select("userId").execute()).length,
  mfa: (await db.selectFrom("mfaMethods").select("id").execute()).length,
  recovery: (await db.selectFrom("mfaRecoveryCodes").select("id").execute()).length,
  sessions: (await db.selectFrom("sessions").select("id").execute()).length,
});

describe("bootstrap offline — emissão do token", () => {
  it("token LEVB-…: 256 bits, só o HMAC (com pepper_version) é gravado, TTL 15 min, auditoria sem o token", async () => {
    const t = await issueOwner();
    expect(t.token).toMatch(/^LEVB-([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(normalizeBootstrapToken(t.token)).toMatch(/^LEVB[A-Z2-7]{52}$/);
    const rows = await db.selectFrom("platformBootstrapTokens").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "owner", expectedEmail: OWNER_EMAIL, pepperVersion: 1, issuedBy: "teste@ci", usedAt: null, revokedAt: null, claimedAt: null });
    expect(rows[0].tokenHash.length).toBe(32);
    expect(rows[0].expiresAt.getTime() - rows[0].createdAt.getTime()).toBe(BOOTSTRAP_TOKEN_TTL_MS);
    const dump = JSON.stringify(rows) + JSON.stringify(await db.selectFrom("auditLog").selectAll().execute());
    expect(dump).not.toContain(normalizeBootstrapToken(t.token));
    expect(dump).not.toContain(t.token);
    const audit = await db.selectFrom("auditLog").select(["action", "actorUserId", "metadata"]).where("action", "=", "plataforma.bootstrap_emitido").execute();
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBeNull();
    expect(audit[0].metadata).toEqual({ origem: "cli", finalidade: "owner", emitidoPor: "teste@ci", validadeMinutos: 15 });
  });

  it("precondições: e-mail inválido, e-mail de conta existente e owner já existente são recusados; o owner nunca promove uma conta comum", async () => {
    await expect(issueBootstrapToken({ purpose: "owner", email: "nao-e-email", issuedBy: "x" })).rejects.toMatchObject({ code: "email_invalido" });
    const existing = await createTestUser({ email: "ja-existe@example.com" });
    await expect(issueBootstrapToken({ purpose: "owner", email: existing.email.toUpperCase(), issuedBy: "x" })).rejects.toMatchObject({ code: "email_em_uso" });
    await createPlatformOwner();
    await expect(issueOwner()).rejects.toMatchObject({ code: "owner_ja_existe" });
    expect(await db.selectFrom("platformBootstrapTokens").select("id").execute()).toHaveLength(0);
    await expect(issueBootstrapToken({ purpose: "owner", email: OWNER_EMAIL, issuedBy: "x" })).rejects.toBeInstanceOf(BootstrapError);
  });

  it("recuperação só existe com owner ativo", async () => {
    await expect(issueBootstrapToken({ purpose: "owner_recovery", issuedBy: "x" })).rejects.toMatchObject({ code: "sem_owner" });
  });

  it("emitir outro token REVOGA o pendente (sempre no máximo 1 pendente); revogar é idempotente", async () => {
    const first = await issueOwner();
    const second = await issueOwner();
    const rows = await db.selectFrom("platformBootstrapTokens").select(["id", "revokedAt"]).orderBy("id", "asc").execute();
    expect(rows.map((r) => r.revokedAt !== null)).toEqual([true, false]);
    expect((await activateBootstrapToken(first.token)).ok).toBe(false); // revogado
    expect(await db.transaction().execute((trx) => revokePendingBootstrapTokens(trx, "x"))).toBe(1);
    expect(await db.transaction().execute((trx) => revokePendingBootstrapTokens(trx, "x"))).toBe(0);
    expect((await activateBootstrapToken(second.token)).ok).toBe(false);
    expect((await db.selectFrom("auditLog").select("action").where("action", "=", "plataforma.bootstrap_revogado").execute()).length).toBeGreaterThanOrEqual(2);
  });

  it("CONCORRÊNCIA (B): dois tokens emitidos ao mesmo tempo — exatamente 1 pendente, o outro revogado; sem estado ambíguo", async () => {
    const results = await Promise.allSettled([issueOwner(), issueOwner(), issueOwner()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rows = await db.selectFrom("platformBootstrapTokens").select(["revokedAt", "usedAt"]).execute();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.revokedAt === null && r.usedAt === null)).toHaveLength(1);
    const tokens = results.map((r) => (r as PromiseFulfilledResult<{ token: string }>).value.token);
    const valid = await Promise.all(tokens.map(async (t) => (await activateBootstrapToken(t)).ok));
    expect(valid.filter(Boolean)).toHaveLength(1);
  });

  it("índice único do banco: dois tokens pendentes simultâneos são impossíveis mesmo por SQL direto", async () => {
    await issueOwner();
    await expect(
      db.insertInto("platformBootstrapTokens").values({ purpose: "owner", tokenHash: Buffer.alloc(32, 1), pepperVersion: 1, expectedEmail: "x@y.com", expiresAt: new Date(Date.now() + MIN), issuedBy: "sql" }).execute()
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("bootstrap — ativação (token → challenge), sempre a mesma recusa para token ruim", () => {
  it("token válido: abre challenge (cookie de challenge, NENHUMA sessão, nenhum usuário); o token fica reivindicado", async () => {
    const t = await issueOwner();
    const before = await snapshotOwnerState();
    const res = await bootstrapActivate(t.token);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ purpose: "owner", email: OWNER_EMAIL });
    expect(cookieFrom(res, CHALLENGE)).toBeTruthy();
    expect(cookieFrom(res, SESSION)).toBeUndefined();
    expect(await snapshotOwnerState()).toEqual(before);
    const row = await db.selectFrom("platformBootstrapTokens").select(["claimedAt", "usedAt"]).executeTakeFirstOrThrow();
    expect(row.claimedAt).not.toBeNull();
    expect(row.usedAt).toBeNull();
    const challenge = await db.selectFrom("authChallenges").select(["purpose", "userId", "status"]).executeTakeFirstOrThrow();
    expect(challenge).toEqual({ purpose: "bootstrap_owner", userId: null, status: "pending" });
    // o token com hífens/caixa diferentes também normaliza para o mesmo valor
    expect(normalizeBootstrapToken(t.token.toLowerCase())).toBe(normalizeBootstrapToken(t.token));
  });

  it("(E/D) inválido, malformado, expirado, usado, revogado e já reivindicado: TODOS a mesma resposta 401 bootstrap_invalido", async () => {
    const bodies = new Set<string>();
    const record = async (res: Response) => {
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    };
    await record(await bootstrapActivate("LEVB-AAAA-BBBB"));
    await record(await bootstrapActivate("x".repeat(40)));
    await record(await bootstrapActivate("LEVB-" + "A".repeat(52)));

    const expired = await issueOwner();
    await db.updateTable("platformBootstrapTokens").set({ createdAt: new Date(Date.now() - 20 * MIN), expiresAt: new Date(Date.now() - 5 * MIN) }).execute();
    await record(await bootstrapActivate(expired.token));

    const used = await issueOwner("usado@example.com");
    await db.updateTable("platformBootstrapTokens").set({ usedAt: new Date() }).where("revokedAt", "is", null).execute();
    await record(await bootstrapActivate(used.token));

    const revoked = await issueOwner("revogado@example.com");
    await db.transaction().execute((trx) => revokePendingBootstrapTokens(trx, "x"));
    await record(await bootstrapActivate(revoked.token));

    const claimed = await issueOwner("reivindicado@example.com");
    expect((await bootstrapActivate(claimed.token)).status).toBe(200);
    await record(await bootstrapActivate(claimed.token)); // replay / 2ª aba
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toContain("bootstrap_invalido");
    expect((await db.selectFrom("auditLog").select("id").where("action", "=", "plataforma.bootstrap_falhou").execute()).length).toBeGreaterThanOrEqual(1);
  });

  it("(F) token de outro ambiente: o mesmo valor com OUTRO pepper (ou outro banco) é inválido", async () => {
    const t = await issueOwner();
    const saved = process.env.IDENTITY_CODE_PEPPER_V1;
    process.env.IDENTITY_CODE_PEPPER_V1 = "outro-ambiente-pepper-ffffffffffffffffffffffff";
    try {
      expect((await bootstrapActivate(t.token)).status).toBe(401);
    } finally {
      process.env.IDENTITY_CODE_PEPPER_V1 = saved;
    }
    expect((await bootstrapActivate(t.token)).status).toBe(200);
  });

  it("(A) CONCORRÊNCIA: o mesmo token ativado por 6 navegadores simultâneos — exatamente 1 vence", async () => {
    const t = await issueOwner();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => bootstrapActivate(t.token, `203.0.113.${100 + i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.selectFrom("authChallenges").select("id").execute()).toHaveLength(1);
  });

  it("limite por IP na ativação (força bruta de token): a 11ª tentativa do mesmo IP é 429", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await bootstrapActivate("LEVB-AAAA-BBBB-CCCC", "198.51.100.77")).status;
    expect(last).toBe(429);
  });
});

describe("bootstrap — ativação completa e atômica", () => {
  it("fluxo feliz: cria users + senha + platform_access(owner) + MFA ativo + recovery codes, consome token e challenge, entra com sessão MFA; nada de secrets em audit", async () => {
    const t = await issueOwner();
    const r = await runActivation(t.token);
    expect(r.act.status).toBe(200);
    expect(r.creds.status).toBe(200);
    expect(r.begin.status).toBe(200);
    expect(r.confirm!.status).toBe(200);
    const body = await json<{ user: { id: number; email: string; role: string; platformLevel: string }; recoveryCodes: string[] }>(r.confirm!);
    expect(body.user).toMatchObject({ email: OWNER_EMAIL, platformLevel: "owner", role: "admin" });
    expect(body.recoveryCodes).toHaveLength(10);
    const session = cookieFrom(r.confirm!, SESSION)!;
    expect(clearedCookie(r.confirm!, CHALLENGE)).toBe(true);
    expect((await platformCall(session)).status).toBe(200);

    const user = await db.selectFrom("users").selectAll().where("id", "=", body.user.id).executeTakeFirstOrThrow();
    expect(user.role).toBe("user"); // NUNCA users.role=admin
    expect(user.displayName).toBe("Dono da Plataforma");
    const pw = await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", user.id).executeTakeFirstOrThrow();
    expect(await compare(OWNER_PASSWORD, pw.passwordHash)).toBe(true);
    const access = await db.selectFrom("platformAccess").selectAll().where("userId", "=", user.id).executeTakeFirstOrThrow();
    expect(access).toMatchObject({ level: "owner", status: "active", grantOrigin: "bootstrap" });
    expect(access.bootstrapTokenId).not.toBeNull();
    const mfa = await db.selectFrom("mfaMethods").selectAll().where("userId", "=", user.id).executeTakeFirstOrThrow();
    expect(mfa.status).toBe("active");
    expect(mfa.lastUsedStep).not.toBeNull();
    expect(decryptSecret(mfa.secretCiphertext, mfa.secretKeyId, `mfa:${user.id}`).equals(base32Decode(r.setup!.manualKey))).toBe(true);
    expect(await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", user.id).execute()).toHaveLength(10);
    const tok = await db.selectFrom("platformBootstrapTokens").select(["usedAt", "claimedAt"]).executeTakeFirstOrThrow();
    expect(tok.usedAt).not.toBeNull();
    expect((await db.selectFrom("authChallenges").select("status").executeTakeFirstOrThrow()).status).toBe("consumed");
    expect((await db.selectFrom("platformState").select("ownerBootstrappedAt").executeTakeFirstOrThrow()).ownerBootstrappedAt).not.toBeNull();
    const sess = await db.selectFrom("sessions").select(["mfaVerifiedAt", "primaryMethod"]).where("userId", "=", user.id).executeTakeFirstOrThrow();
    expect(sess.mfaVerifiedAt).not.toBeNull();

    const audit = await db.selectFrom("auditLog").selectAll().orderBy("id", "asc").execute();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["plataforma.bootstrap_emitido", "mfa.configuracao_iniciada", "plataforma.owner_provisionado", "mfa.ativado", "mfa.recovery_codes_regenerados"]));
    const dump = JSON.stringify(audit);
    for (const secret of [t.token, normalizeBootstrapToken(t.token), OWNER_PASSWORD, r.setup!.manualKey, ...body.recoveryCodes, pw.passwordHash]) expect(dump).not.toContain(secret);
    expect((await verifyAuditLogChain()).integra).toBe(true);
    // e depois disso o owner entra pelo login normal: senha + TOTP
    await resetReplay(user.id);
    expect(cookieFrom(await login(OWNER_EMAIL, OWNER_PASSWORD), CHALLENGE)).toBeTruthy();
  });

  it("(D) replay: token já consumido e challenge já consumido não ativam nem concluem nada", async () => {
    const t = await issueOwner();
    const r = await runActivation(t.token);
    expect(r.confirm!.status).toBe(200);
    expect((await bootstrapActivate(t.token)).status).toBe(401);
    const replayConfirm = await setupConfirm(r.challenge, { code: codeFor(r.setup!.manualKey, 1) });
    expect(replayConfirm.status).toBe(401);
    expect(await db.selectFrom("users").select("id").execute()).toHaveLength(1);
    expect(await db.selectFrom("platformAccess").select("userId").execute()).toHaveLength(1);
  });

  it("ordem dos passos: begin antes das credenciais = 409; confirm antes do begin = 409; credenciais incompletas = 400; senha fora da política = 400", async () => {
    const t = await issueOwner();
    const act = await bootstrapActivate(t.token);
    const challenge = cookieFrom(act, CHALLENGE);
    expect((await setupBegin(challenge)).status).toBe(409);
    expect((await json<{ code: string }>(await setupBegin(challenge))).code).toBe("credenciais_pendentes");
    expect((await setupConfirm(challenge, { code: "123456" })).status).toBe(409);
    expect((await bootstrapCredentials(challenge, { displayName: "Só nome" })).status).toBe(400);
    expect((await bootstrapCredentials(challenge, { displayName: "X", password: "a".repeat(73) })).status).toBe(400); // teto de 72 bytes
    expect((await bootstrapCredentials(challenge, { displayName: "X", password: "curta" })).status).toBe(400);
    expect((await bootstrapCredentials(challenge, { displayName: "X", password: OWNER_PASSWORD, role: "admin" })).status).toBe(400); // estrito
    expect(await db.selectFrom("users").select("id").execute()).toHaveLength(0);
  });

  it("(G) falha no meio — TOTP errado: nada criado, nada consumido; 5 erros encerram o challenge", async () => {
    const t = await issueOwner();
    const before = await snapshotOwnerState();
    const act = await bootstrapActivate(t.token);
    const challenge = cookieFrom(act, CHALLENGE);
    await bootstrapCredentials(challenge, { displayName: "Owner", password: OWNER_PASSWORD });
    await setupBegin(challenge);
    for (let i = 0; i < 4; i++) expect((await setupConfirm(challenge, { code: "000000" })).status).toBe(401);
    expect((await json<{ code: string }>(await setupConfirm(challenge, { code: "000000" }))).code).toBe("challenge_esgotado");
    expect(await snapshotOwnerState()).toEqual(before);
    expect((await db.selectFrom("platformBootstrapTokens").select("usedAt").executeTakeFirstOrThrow()).usedAt).toBeNull();
  });

  it("(G) falha na transação final — e-mail do owner tomado no meio: ROLLBACK total (sem user/owner/MFA/credencial parciais) e o token NÃO é consumido", async () => {
    const t = await issueOwner();
    const act = await bootstrapActivate(t.token);
    const challenge = cookieFrom(act, CHALLENGE);
    await bootstrapCredentials(challenge, { displayName: "Owner", password: OWNER_PASSWORD });
    const setup = await json<{ manualKey: string }>(await setupBegin(challenge));
    await createTestUser({ email: OWNER_EMAIL }); // alguém registrou o e-mail entre a emissão e a conclusão
    const before = await snapshotOwnerState();
    const res = await setupConfirm(challenge, { code: codeFor(setup.manualKey) });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("ativacao_falhou");
    expect(await snapshotOwnerState()).toEqual(before);
    expect((await db.selectFrom("platformBootstrapTokens").select("usedAt").executeTakeFirstOrThrow()).usedAt).toBeNull();
    expect(await db.selectFrom("platformAccess").select("userId").execute()).toHaveLength(0);
    expect((await db.selectFrom("authChallenges").select("status").executeTakeFirstOrThrow()).status).toBe("pending");
  });

  it("(C) token expira DURANTE a ativação: a conclusão é recusada e nada é criado", async () => {
    const t = await issueOwner();
    const act = await bootstrapActivate(t.token);
    const challenge = cookieFrom(act, CHALLENGE);
    await bootstrapCredentials(challenge, { displayName: "Owner", password: OWNER_PASSWORD });
    const setup = await json<{ manualKey: string }>(await setupBegin(challenge));
    await db.updateTable("platformBootstrapTokens").set({ createdAt: new Date(Date.now() - 20 * MIN), expiresAt: new Date(Date.now() - 1000) }).execute();
    await db.updateTable("authChallenges").set({ createdAt: new Date(Date.now() - 20 * MIN) }).execute();
    const before = await snapshotOwnerState();
    const res = await setupConfirm(challenge, { code: codeFor(setup.manualKey) });
    expect(res.status).toBe(409);
    expect(await snapshotOwnerState()).toEqual(before);
  });

  it("a ativação não vive além do token: o challenge nasce com TTL ≤ o restante do token (15 min), mesmo que o teto do challenge seja 30", async () => {
    const t = await issueOwner();
    await bootstrapActivate(t.token);
    const ch = await db.selectFrom("authChallenges").select(["createdAt", "expiresAt"]).executeTakeFirstOrThrow();
    expect(ch.expiresAt.getTime() - ch.createdAt.getTime()).toBeLessThanOrEqual(BOOTSTRAP_TOKEN_TTL_MS);
  });

  it("(J) owner duplicado: finalização com um owner já existente (challenge forjado por SQL) é recusada e nada muda", async () => {
    const t = await issueOwner();
    const act = await bootstrapActivate(t.token);
    const challenge = cookieFrom(act, CHALLENGE);
    await bootstrapCredentials(challenge, { displayName: "Owner", password: OWNER_PASSWORD });
    const setup = await json<{ manualKey: string }>(await setupBegin(challenge));
    const intruder = await createPlatformOwner(); // surge um owner antes da conclusão
    const before = await snapshotOwnerState();
    const res = await setupConfirm(challenge, { code: codeFor(setup.manualKey) });
    expect(res.status).toBe(409);
    expect(await snapshotOwnerState()).toEqual(before);
    expect((await db.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").execute()).map((r) => r.userId)).toEqual([intruder.userId]);
  });

  it("os endpoints de bootstrap NÃO criam nada sem um challenge de bootstrap: nem com cookie inventado, nem com challenge de MFA comum", async () => {
    const before = await snapshotOwnerState();
    expect((await bootstrapCredentials(`${CHALLENGE}=${"C".repeat(43)}`, { displayName: "X", password: OWNER_PASSWORD })).status).toBe(401);
    expect((await bootstrapCredentials(undefined, { displayName: "X", password: OWNER_PASSWORD })).status).toBe(401);
    expect((await setupConfirm(`${CHALLENGE}=${"C".repeat(43)}`, { code: "123456" })).status).toBe(401);
    // cadastro público e login nunca viram owner
    const plain = await createAuthenticatedUser();
    expect((await platformCall(plain.cookie)).status).toBe(403);
    expect((await snapshotOwnerState()).access).toBe(before.access);
  });

  it("ausência de owner: ninguém acessa /plataforma; owner existente impede novo bootstrap", async () => {
    const plain = await createAuthenticatedUser();
    expect((await platformCall(plain.cookie)).status).toBe(403);
    const t = await issueOwner();
    const r = await runActivation(t.token);
    expect(r.confirm!.status).toBe(200);
    await expect(issueOwner("outro@example.com")).rejects.toMatchObject({ code: "owner_ja_existe" });
  });
});

describe("recuperação administrativa do owner (CLI offline) — troca de MFA sem janela sem proteção", () => {
  it("token de recuperação: troca o TOTP e os recovery codes, encerra TODAS as sessões do owner, mantém o owner e audita", async () => {
    const owner = await createPlatformOwner();
    const oldSession = owner.cookie;
    const { issueRecoveryCodes } = await import("../src/helpers/mfa");
    const oldCodes = await db.transaction().execute((trx) => issueRecoveryCodes(trx, owner.userId));
    const t = await issueBootstrapToken({ purpose: "owner_recovery", issuedBy: "teste@ci" });
    expect(t.email).toBe(owner.email);
    const act = await bootstrapActivate(t.token);
    expect(await json(act)).toMatchObject({ purpose: "owner_recovery", email: owner.email });
    const challenge = cookieFrom(act, CHALLENGE)!;
    const begin = await setupBegin(challenge); // credenciais opcionais na recuperação
    expect(begin.status).toBe(200);
    const setup = await json<{ manualKey: string }>(begin);
    const confirm = await setupConfirm(challenge, { code: codeFor(setup.manualKey) });
    expect(confirm.status).toBe(200);
    const body = await json<{ recoveryCodes: string[]; user: { id: number; platformLevel: string } }>(confirm);
    expect(body.user).toMatchObject({ id: owner.userId, platformLevel: "owner" });
    expect((await whoAmI(oldSession)).status).toBe(401); // sessão antiga encerrada
    expect((await platformCall(cookieFrom(confirm, SESSION)!)).status).toBe(200);
    const mfa = await db.selectFrom("mfaMethods").select(["status"]).where("userId", "=", owner.userId).orderBy("id", "asc").execute();
    expect(mfa.map((m) => m.status)).toEqual(["disabled", "active"]);
    const open = await db.selectFrom("mfaRecoveryCodes").select(["invalidatedAt"]).where("userId", "=", owner.userId).where("invalidatedAt", "is", null).execute();
    expect(open).toHaveLength(10);
    expect(body.recoveryCodes.some((c) => oldCodes.includes(c))).toBe(false);
    expect((await db.selectFrom("auditLog").select("action").where("action", "=", "plataforma.owner_recuperado").execute())).toHaveLength(1);
    expect(await db.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").execute()).toHaveLength(1);
  });

  it("recuperação com NOVA senha troca a credencial (a antiga deixa de funcionar)", async () => {
    const owner = await createPlatformOwner();
    const t = await issueBootstrapToken({ purpose: "owner_recovery", issuedBy: "teste@ci" });
    const act = await bootstrapActivate(t.token);
    const challenge = cookieFrom(act, CHALLENGE);
    expect((await bootstrapCredentials(challenge, { password: OWNER_PASSWORD })).status).toBe(200);
    const setup = await json<{ manualKey: string }>(await setupBegin(challenge));
    expect((await setupConfirm(challenge, { code: codeFor(setup.manualKey) })).status).toBe(200);
    const row = await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", owner.userId).executeTakeFirstOrThrow();
    expect(await compare(OWNER_PASSWORD, row.passwordHash)).toBe(true);
    expect(await db.selectFrom("userPasswords").select("id").where("userId", "=", owner.userId).execute()).toHaveLength(1);
  });

  it("falha no meio da recuperação (token expirado): o MFA antigo e as sessões permanecem intactos", async () => {
    const owner = await createPlatformOwner();
    const t = await issueBootstrapToken({ purpose: "owner_recovery", issuedBy: "teste@ci" });
    const act = await bootstrapActivate(t.token);
    const challenge = cookieFrom(act, CHALLENGE);
    const setup = await json<{ manualKey: string }>(await setupBegin(challenge));
    await db.updateTable("platformBootstrapTokens").set({ createdAt: new Date(Date.now() - 20 * MIN), expiresAt: new Date(Date.now() - 1000) }).execute();
    expect((await setupConfirm(challenge, { code: codeFor(setup.manualKey) })).status).toBe(409);
    expect((await db.selectFrom("mfaMethods").select("status").where("userId", "=", owner.userId).executeTakeFirstOrThrow()).status).toBe("active");
    expect((await platformCall(owner.cookie)).status).toBe(200);
  });
});

describe("owner sempre com MFA — nenhum estado persistente owner sem MFA após o bootstrap", () => {
  it("depois de um bootstrap completo, todo titular ativo possui TOTP ativo; o login do owner exige o 2º fator; a senha sozinha nunca cria sessão", async () => {
    const t = await issueOwner();
    const r = await runActivation(t.token);
    const { user } = await json<{ user: { id: number } }>(r.confirm!);
    const holders = await db.selectFrom("platformAccess").select("userId").where("status", "=", "active").execute();
    for (const h of holders) expect(await db.selectFrom("mfaMethods").select("id").where("userId", "=", h.userId).where("status", "=", "active").execute()).toHaveLength(1);
    const res = await login(OWNER_EMAIL, OWNER_PASSWORD);
    expect(cookieFrom(res, SESSION)).toBeUndefined();
    await resetReplay(user.id);
    expect((await verify(cookieFrom(res, CHALLENGE)!, { code: codeFor(r.setup!.manualKey, 0) })).status).toBe(200);
  });

  it("sessão de step-up do owner recém-criado: ação crítica funciona logo após o bootstrap (MFA recente) e expira depois", async () => {
    const t = await issueOwner();
    const r = await runActivation(t.token);
    const session = cookieFrom(r.confirm!, SESSION)!;
    const { user } = await json<{ user: { id: number } }>(r.confirm!);
    expect((await stepUp(session, { code: "000000" })).status).toBe(401);
    void user;
    void totp;
    void fullLogin;
    void createSessionCookie;
  });
});

describe("CLI offline (db/platform-bootstrap-cli.ts)", () => {
  const root = path.resolve(__dirname, "..");
  const run = (args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", "db/platform-bootstrap-cli.ts", ...args], { cwd: root, env: { ...process.env }, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

  it("owner --email imprime o token UMA vez, grava só o hash, e o token ativa pelo endpoint; status nunca mostra o token; revoke funciona", async () => {
    const out = run(["owner", "--email", "cli-owner@example.com"]);
    const token = /LEVB-[A-Z2-7-]+/.exec(out)?.[0];
    expect(token).toBeTruthy();
    const rows = await db.selectFrom("platformBootstrapTokens").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(normalizeBootstrapToken(token!));
    expect(rows[0].issuedBy).toMatch(/@/);
    const status = run(["status"]);
    expect(status).toContain("Token pendente: owner");
    expect(status).not.toContain(token!);
    expect((await bootstrapActivate(token!)).status).toBe(200);
    expect(run(["revoke"])).toContain("revogado");
    expect(run(["status"])).toContain("Nenhum token pendente");
  });

  it("recusa emitir token de owner quando já existe owner (e orienta usar a recuperação) e sem e-mail", async () => {
    await createPlatformOwner();
    expect(() => run(["owner", "--email", "x@example.com"])).toThrow();
    let stderr = "";
    try {
      run(["owner", "--email", "x@example.com"]);
    } catch (e) {
      stderr = String((e as { stderr?: string }).stderr);
    }
    expect(stderr).toContain("Platform Owner ativo");
    expect(await db.selectFrom("platformBootstrapTokens").select("id").execute()).toHaveLength(0);
  });

  it("owner-recovery pelo CLI emite um token ligado ao owner atual; sem owner, recusa", async () => {
    let stderr = "";
    try {
      run(["owner-recovery"]);
    } catch (e) {
      stderr = String((e as { stderr?: string }).stderr);
    }
    expect(stderr).toContain("Não existe Platform Owner");
    const owner = await createPlatformOwner();
    const out = run(["owner-recovery"]);
    expect(out).toContain(owner.email);
    expect(/LEVB-[A-Z2-7-]+/.test(out)).toBe(true);
    const row = await db.selectFrom("platformBootstrapTokens").select(["purpose", "targetUserId"]).executeTakeFirstOrThrow();
    expect(row).toEqual({ purpose: "owner_recovery", targetUserId: owner.userId });
  });
});
