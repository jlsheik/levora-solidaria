/**
 * F1 — recuperação de senha por e-mail. Chama o `handle()` dos endpoints reais contra PostgreSQL real, com um transporte de e-mail SINTÉTICO
 * (nenhuma rede, nenhum e-mail real) e contas sintéticas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sql } from "kysely";

const mail = vi.hoisted(() => ({
  mode: "ok" as "ok" | "fail" | "notconfigured",
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  gate: null as null | Promise<void>,
}));

vi.mock("../src/helpers/emailAdapter", async (original) => {
  const actual = await original<typeof import("../src/helpers/emailAdapter")>();
  return {
    ...actual,
    emailAdapter: {
      get isConfigured() {
        return mail.mode !== "notconfigured";
      },
      async send(input: { to: string; subject: string; text: string }) {
        if (mail.gate) await mail.gate;
        if (mail.mode === "fail") return { sent: false, reason: "provider_error", error: "falha-sintetica" };
        mail.sent.push(input);
        return { sent: true, messageId: `sintetico-${mail.sent.length}`, synthetic: true };
      },
    },
  };
});

import { db } from "../src/helpers/db";
import { handle as postRequest, GENERIC_MESSAGE } from "../src/endpoints/auth/password-reset-request_POST";
import { handle as postValidate } from "../src/endpoints/auth/password-reset-validate_POST";
import { handle as postConfirm } from "../src/endpoints/auth/password-reset-confirm_POST";
import { buildResetUrl, flushPasswordResetWork, processResetRequest, resetTtlMinutes, RESET_MAX_ATTEMPTS, hashResetToken } from "../src/helpers/passwordReset";
import { issueRecoveryCodes } from "../src/helpers/mfa";
import { currentPepperVersion } from "../src/helpers/identityKeys";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { createPlatformAdmin, createPlatformOwner, createSessionCookie, createTestUser, enrollTestMfa, buildRequest, parseJson, testTotp, TEST_TOTP_SECRET } from "./helpers";
import { cookieFrom, CHALLENGE, login, PASSWORD, resetReplay } from "./mfaHarness";

const NEW_PASSWORD = "uma-senha-nova-segura-456";
const APP = "https://app.levora-teste.example";

type Json = Record<string, unknown>;
const requestReset = (email: string, ip?: string) => postRequest(buildRequest("auth/password-reset-request", { method: "POST", body: { email }, ip }));
const validate = (token: string, ip?: string) => postValidate(buildRequest("auth/password-reset-validate", { method: "POST", body: { token }, ip }));
const confirm = (body: Json, ip?: string) => postConfirm(buildRequest("auth/password-reset-confirm", { method: "POST", body, ip }));
const tokenFromMail = (index = mail.sent.length - 1): string => {
  const m = /#token=([A-Za-z0-9_-]{43})/.exec(mail.sent[index]?.text ?? "");
  if (!m) throw new Error("nenhum link de redefinição no e-mail sintético");
  return m[1];
};
/** Pede a redefinição e espera o trabalho em segundo plano; devolve o token do último e-mail sintético. */
async function issueFor(email: string): Promise<string> {
  const before = mail.sent.length;
  expect((await requestReset(email)).status).toBe(202);
  await flushPasswordResetWork();
  expect(mail.sent.length).toBe(before + 1);
  return tokenFromMail();
}
const backdate = (userId: number, seconds: number) =>
  sql`UPDATE password_reset_tokens SET created_at = created_at - make_interval(secs => ${seconds}), expires_at = expires_at - make_interval(secs => ${seconds}) WHERE user_id = ${userId}`.execute(db);

beforeEach(() => {
  mail.mode = "ok";
  mail.sent.length = 0;
  mail.gate = null;
  vi.stubEnv("APP_PUBLIC_URL", APP);
  vi.stubEnv("PASSWORD_RESET_TTL_MINUTES", "");
});
afterEach(async () => {
  // Trabalho agendado por um pedido (depois da resposta) precisa terminar antes do TRUNCATE do próximo teste (senão disputa locks com ele).
  await flushPasswordResetWork();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("pedido: resposta genérica e sem enumeração", () => {
  it("responde de forma idêntica (status, cabeçalhos e corpo) para conta existente, inexistente, de plataforma e anonimizada", async () => {
    const real = await createTestUser();
    const admin = await createPlatformAdmin();
    const anonymized = await createTestUser();
    await db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", anonymized.id).execute();
    const noPassword = await createTestUser();
    await db.deleteFrom("userPasswords").where("userId", "=", noPassword.id).execute();

    const emails = [real.email, "ninguem-existe@example.com", admin.email, anonymized.email, noPassword.email];
    const responses = [];
    for (const e of emails) responses.push(await requestReset(e));
    await flushPasswordResetWork();
    const shapes = await Promise.all(responses.map(async (r) => ({ status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: await r.text() })));
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0].status).toBe(202);
    expect(shapes[0].body).toContain("Se existir uma conta");
    // só a conta elegível recebeu e-mail e token
    expect(mail.sent.map((m) => m.to)).toEqual([real.email]);
    expect(await db.selectFrom("passwordResetTokens").select("userId").execute()).toEqual([{ userId: real.id }]);
  });

  it("a resposta NÃO espera o envio: e-mail lento não muda o tempo percebido (trabalho depois da resposta)", async () => {
    const u = await createTestUser();
    let release!: () => void;
    mail.gate = new Promise<void>((r) => (release = r));
    const started = Date.now();
    const res = await requestReset(u.email);
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mail.sent.length).toBe(0); // o envio ainda está pendente
    release();
    await flushPasswordResetWork();
    expect(mail.sent.length).toBe(1);
  });

  it("e-mail mal formado é validado sem consultar contas; aceita maiúsculas e espaços", async () => {
    expect((await requestReset("isto-nao-e-email")).status).toBe(400);
    const u = await createTestUser({ email: "Pessoa.Teste@Example.com" });
    expect((await requestReset("  pessoa.teste@EXAMPLE.com ")).status).toBe(202);
    await flushPasswordResetWork();
    expect(mail.sent.map((m) => m.to)).toEqual([u.email]);
  });
});

describe("fluxo completo e propriedades do token", () => {
  it("pedido → e-mail com link no FRAGMENTO → validar → redefinir → login com a senha nova (a antiga deixa de valer)", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    const link = /https?:\/\/\S+/.exec(mail.sent[0].text)![0];
    expect(link).toBe(`${APP}/redefinir-senha#token=${token}`);
    expect(link).not.toMatch(/\?/);
    expect(mail.sent[0].subject).toMatch(/Redefinição de senha/);

    const v = await parseJson<Json>(await validate(token));
    expect(v).toEqual({ state: "valido", mfaRequired: false });

    const done = await confirm({ token, newPassword: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect(done.headers.get("set-cookie")).toBeNull(); // não cria sessão: volta ao login
    expect((await login(u.email, PASSWORD)).status).toBeGreaterThanOrEqual(400);
    expect((await login(u.email, NEW_PASSWORD)).status).toBe(200);
    await flushPasswordResetWork();
    expect(mail.sent.length).toBe(2); // aviso de senha alterada ao titular
    expect(mail.sent[1].subject).toMatch(/foi alterada/);
    expect(mail.sent[1].text).not.toContain(token);
  });

  it("só o HMAC do token fica no banco (nunca o token); 256 bits; pepper versionado; expiração padrão de 30 min", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db.selectFrom("passwordResetTokens").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].tokenHash.equals(hashResetToken(token, currentPepperVersion()))).toBe(true);
    expect(rows[0].pepperVersion).toBe(currentPepperVersion());
    const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(ttl).toBe(30 * 60 * 1000);
    expect(rows[0].usedAt).toBeNull();
  });

  it("dois pedidos produzem tokens diferentes e imprevisíveis", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const ta = await issueFor(a.email);
    const tb = await issueFor(b.email);
    expect(ta).not.toBe(tb);
  });

  it("uso único: reutilizar o link depois do sucesso falha e não altera nada; validar passa a dizer 'utilizado'", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    expect((await confirm({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    const replay = await confirm({ token, newPassword: "outra-senha-qualquer-789" });
    expect(replay.status).toBe(400);
    expect((await parseJson<Json>(replay)).code).toBe("link_utilizado");
    expect((await parseJson<Json>(await validate(token))).state).toBe("utilizado");
    expect((await login(u.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(u.email, "outra-senha-qualquer-789")).status).toBeGreaterThanOrEqual(400);
  });

  it("token expirado: validar = 'expirado'; confirmar = 400 link_expirado e a senha continua a antiga", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    await backdate(u.id, 31 * 60);
    expect((await parseJson<Json>(await validate(token))).state).toBe("expirado");
    const res = await confirm({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect((await parseJson<Json>(res)).code).toBe("link_expirado");
    expect((await login(u.email, PASSWORD)).status).toBe(200);
  });

  it("token inexistente, truncado ou de formato impossível: 'invalido' / link_invalido (sem consultar o banco por formato impossível)", async () => {
    await createTestUser();
    for (const bad of ["x", "a".repeat(43), "A".repeat(42), "../../etc/passwd", " ".repeat(5) + "z", "a".repeat(120)]) {
      expect((await parseJson<Json>(await validate(bad))).state).toBe("invalido");
      const res = await confirm({ token: bad, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect((await parseJson<Json>(res)).code).toBe("link_invalido");
    }
  });

  it("novo pedido substitui o anterior: o link antigo deixa de valer; no máximo um token ativo por usuário", async () => {
    const u = await createTestUser();
    const first = await issueFor(u.email);
    await backdate(u.id, 120); // passa o cooldown (continua válido)
    const second = await issueFor(u.email);
    expect(second).not.toBe(first);
    expect((await parseJson<Json>(await validate(first))).state).toBe("invalido");
    expect((await parseJson<Json>(await validate(second))).state).toBe("valido");
    const active = await db.selectFrom("passwordResetTokens").select("id").where("userId", "=", u.id).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute();
    expect(active).toHaveLength(1);
    expect((await confirm({ token: first, newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await confirm({ token: second, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("reenvio controlado: um segundo pedido dentro do cooldown (60 s) não gera outro e-mail nem outro token", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    expect((await requestReset(u.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(mail.sent).toHaveLength(1);
    expect((await parseJson<Json>(await validate(token))).state).toBe("valido");
  });

  it("concorrência: duas confirmações simultâneas com o mesmo token — exatamente uma vence", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    const results = await Promise.all([confirm({ token, newPassword: "senha-concorrente-um-111" }), confirm({ token, newPassword: "senha-concorrente-dois-222" })]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    const loser = results.find((r) => r.status === 400)!;
    expect((await parseJson<Json>(loser)).code).toBe("link_utilizado");
    const used = await db.selectFrom("passwordResetTokens").select("usedAt").where("userId", "=", u.id).execute();
    expect(used.filter((r) => r.usedAt).length).toBe(1);
  });

  it("política de senha existente: curta e acima de 72 bytes são recusadas sem consumir o token; senha igual à atual é recusada (422) e o link continua válido", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    expect((await confirm({ token, newPassword: "curta" })).status).toBe(400);
    expect((await confirm({ token, newPassword: "ç".repeat(40) })).status).toBe(400); // 80 bytes
    const same = await confirm({ token, newPassword: PASSWORD });
    expect(same.status).toBe(422);
    expect((await parseJson<Json>(same)).code).toBe("senha_igual");
    expect((await parseJson<Json>(await validate(token))).state).toBe("valido");
    expect((await confirm({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("corpo com campos extras é rejeitado (schema estrito): o cliente não consegue injetar userId, e-mail ou papel", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    expect((await confirm({ token, newPassword: NEW_PASSWORD, userId: 1, email: "x@y.z" })).status).toBe(400);
    expect((await requestReset(u.email).then(async () => postRequest(buildRequest("auth/password-reset-request", { method: "POST", body: { email: u.email, role: "admin" } })))).status).toBe(400);
  });
});

describe("sessões, desafios e auditoria", () => {
  it("revoga TODAS as sessões do usuário e cancela desafios de login pendentes; não toca sessões de outros usuários", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const c1 = await createSessionCookie(u.id);
    await createSessionCookie(u.id);
    const otherCookie = await createSessionCookie(other.id);
    await db.insertInto("authChallenges").values({ secretHash: Buffer.from("a".repeat(32)), pepperVersion: 1, purpose: "mfa_login", status: "pending", userId: u.id, expiresAt: new Date(Date.now() + 60000) }).execute();
    const token = await issueFor(u.email);
    expect((await confirm({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(0);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", other.id).execute()).toHaveLength(1);
    const { handle: getSession } = await import("../src/endpoints/auth/session_GET");
    expect((await getSession(buildRequest("auth/session", { cookie: c1 }))).status).toBe(401);
    expect((await getSession(buildRequest("auth/session", { cookie: otherCookie }))).status).toBe(200);
    expect((await db.selectFrom("authChallenges").select("status").where("userId", "=", u.id).executeTakeFirstOrThrow()).status).toBe("cancelled");
  });

  it("audita solicitação e redefinição sem expor token, hash, senha ou e-mail; a cadeia de auditoria continua íntegra", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    await confirm({ token, newPassword: NEW_PASSWORD });
    const rows = await db.selectFrom("auditLog").selectAll().where("action", "like", "usuario.senha_redefin%").orderBy("id", "asc").execute();
    expect(rows.map((r) => r.action)).toEqual(["usuario.senha_redefinicao_solicitada", "usuario.senha_redefinida"]);
    const dump = JSON.stringify(rows);
    for (const secret of [token, NEW_PASSWORD, PASSWORD, u.email]) expect(dump).not.toContain(secret);
    expect(rows[1].metadata).toMatchObject({ sessoesRevogadas: 0, mfaExigido: false });
    const chain = await verifyAuditLogChain();
    expect(chain.integra).toBe(true);
  });
});

describe("MFA preservado", () => {
  async function mfaUser() {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    const codes = await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.id));
    return { u, codes };
  }
  const openCodes = async (userId: number) => (await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", userId).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute()).length;

  it("conta com MFA: o link NÃO basta — sem código = 422 mfa_obrigatorio, token e senha intactos; a validação do link informa mfaRequired", async () => {
    const { u } = await mfaUser();
    const token = await issueFor(u.email);
    expect(await parseJson<Json>(await validate(token))).toEqual({ state: "valido", mfaRequired: true });
    const res = await confirm({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(422);
    expect((await parseJson<Json>(res)).code).toBe("mfa_obrigatorio");
    expect((await login(u.email, NEW_PASSWORD)).status).toBeGreaterThanOrEqual(400);
    expect((await parseJson<Json>(await validate(token))).state).toBe("valido");
  });

  it("TOTP correto conclui; o MFA continua ativo, os códigos de recuperação NÃO são regenerados nem consumidos, e o login seguinte ainda pede o segundo fator", async () => {
    const { u } = await mfaUser();
    const before = await openCodes(u.id);
    const token = await issueFor(u.email);
    await resetReplay(u.id);
    const done = await confirm({ token, newPassword: NEW_PASSWORD, totpCode: await testTotp() });
    expect(done.status).toBe(200);
    const method = await db.selectFrom("mfaMethods").select(["status", "secretKeyId"]).where("userId", "=", u.id).executeTakeFirstOrThrow();
    expect(method.status).toBe("active");
    expect(await openCodes(u.id)).toBe(before);
    expect(await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", u.id).execute()).toHaveLength(before);
    const next = await login(u.email, NEW_PASSWORD);
    expect(next.status).toBe(200);
    expect(cookieFrom(next, CHALLENGE)).toBeTruthy(); // MFA continua sendo exigido no login
    expect((await parseJson<Json>(next)).mfaRequired).toBe(true);
  });

  it("código de recuperação autoriza a redefinição, é consumido (uso único) e os demais permanecem; reutilizá-lo não funciona", async () => {
    const { u, codes } = await mfaUser();
    const before = await openCodes(u.id);
    const token = await issueFor(u.email);
    const done = await confirm({ token, newPassword: NEW_PASSWORD, recoveryCode: codes[0] });
    expect(done.status).toBe(200);
    expect(await openCodes(u.id)).toBe(before - 1);
    await backdate(u.id, 120);
    const token2 = await issueFor(u.email);
    const reuse = await confirm({ token: token2, newPassword: "senha-depois-do-reuso-987", recoveryCode: codes[0] });
    expect(reuse.status).toBe(401);
    expect((await parseJson<Json>(reuse)).code).toBe("mfa_invalido");
    expect((await confirm({ token: token2, newPassword: "senha-depois-do-reuso-987", recoveryCode: codes[1] })).status).toBe(200);
  });

  it("segundo fator errado: 401, conta tentativa; ao esgotar o token ele é invalidado (mesmo o código certo depois não funciona)", async () => {
    const { u } = await mfaUser();
    const token = await issueFor(u.email);
    for (let i = 1; i <= RESET_MAX_ATTEMPTS; i += 1) {
      const res = await confirm({ token, newPassword: NEW_PASSWORD, totpCode: "000000" });
      expect(res.status).toBe(401);
      const body = await parseJson<Json>(res);
      expect(body.code).toBe(i === RESET_MAX_ATTEMPTS ? "link_invalido" : "mfa_invalido");
    }
    const row = await db.selectFrom("passwordResetTokens").select(["attempts", "invalidatedAt"]).where("userId", "=", u.id).executeTakeFirstOrThrow();
    expect(row.attempts).toBe(RESET_MAX_ATTEMPTS);
    expect(row.invalidatedAt).not.toBeNull();
    await resetReplay(u.id);
    const late = await confirm({ token, newPassword: NEW_PASSWORD, totpCode: await testTotp() });
    expect(late.status).toBe(400);
    expect((await login(u.email, NEW_PASSWORD)).status).toBeGreaterThanOrEqual(400);
    const audited = await db.selectFrom("auditLog").select("metadata").where("action", "=", "usuario.senha_redefinicao_falhou").execute();
    expect(audited.length).toBe(RESET_MAX_ATTEMPTS);
    expect(JSON.stringify(audited)).not.toContain("000000");
  });

  it("senha igual à atual com MFA: 422 e NADA é consumido (o mesmo TOTP e o mesmo código de recuperação continuam valendo); o TOTP depois de CONCLUIR é de uso único (anti-replay)", async () => {
    const { u, codes } = await mfaUser();
    const before = await openCodes(u.id);
    const token = await issueFor(u.email);
    await resetReplay(u.id);
    const code = await testTotp();
    const same = await confirm({ token, newPassword: PASSWORD, totpCode: code });
    expect(same.status).toBe(422);
    expect((await parseJson<Json>(same)).code).toBe("senha_igual");
    expect((await confirm({ token, newPassword: PASSWORD, recoveryCode: codes[0] })).status).toBe(422);
    expect(await openCodes(u.id)).toBe(before); // o código de recuperação não foi gasto
    expect((await db.selectFrom("passwordResetTokens").select("attempts").where("userId", "=", u.id).executeTakeFirstOrThrow()).attempts).toBe(0);
    expect((await confirm({ token, newPassword: NEW_PASSWORD, totpCode: code })).status).toBe(200); // o mesmo TOTP ainda valia
    await backdate(u.id, 120);
    const token2 = await issueFor(u.email);
    const replay = await confirm({ token: token2, newPassword: "senha-depois-do-replay-987", totpCode: code });
    expect(replay.status).toBe(401); // agora sim: o passo do TOTP foi consumido pela redefinição concluída
  });

  it("não é possível informar TOTP e código de recuperação ao mesmo tempo", async () => {
    const { u, codes } = await mfaUser();
    const token = await issueFor(u.email);
    expect((await confirm({ token, newPassword: NEW_PASSWORD, totpCode: "123456", recoveryCode: codes[0] })).status).toBe(400);
  });

  it("a sessão TEM de ser nova para quem tinha MFA: nada de sessão criada pela redefinição", async () => {
    const { u } = await mfaUser();
    const token = await issueFor(u.email);
    await resetReplay(u.id);
    await confirm({ token, newPassword: NEW_PASSWORD, totpCode: await testTotp() });
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).toHaveLength(0);
    expect(TEST_TOTP_SECRET.length).toBeGreaterThan(0);
  });
});

describe("contas privilegiadas e elegibilidade", () => {
  it("titular de acesso de plataforma não usa este caminho: nenhum token, nenhum e-mail; um token já emitido deixa de valer se a conta ganha acesso de plataforma", async () => {
    const admin = await createPlatformAdmin();
    expect((await requestReset(admin.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(mail.sent).toHaveLength(0);
    expect(await db.selectFrom("passwordResetTokens").select("id").execute()).toHaveLength(0);

    const u = await createTestUser();
    const token = await issueFor(u.email);
    await db.insertInto("platformAccess").values({ userId: u.id, level: "admin", status: "active", grantOrigin: "test" }).execute();
    expect((await parseJson<Json>(await validate(token))).state).toBe("invalido");
    const res = await confirm({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect((await login(u.email, PASSWORD)).status).toBe(200); // senha antiga intacta
  });

  it("o Platform Owner também é inelegível (nenhum token, nenhum e-mail): ele usa platform:owner-recovery", async () => {
    const owner = await createPlatformOwner();
    expect((await requestReset(owner.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(mail.sent).toHaveLength(0);
    expect(await db.selectFrom("passwordResetTokens").select("id").execute()).toHaveLength(0);
  });

  it("conta anonimizada depois do pedido: o link deixa de valer", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    await db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", u.id).execute();
    expect((await parseJson<Json>(await validate(token))).state).toBe("invalido");
    expect((await confirm({ token, newPassword: NEW_PASSWORD })).status).toBe(400);
  });

  it("a redefinição só atinge o dono do token (nenhuma elevação de privilégio: papel, organização e acesso de plataforma não mudam)", async () => {
    const u = await createTestUser();
    const before = await db.selectFrom("users").select(["role", "email"]).where("id", "=", u.id).executeTakeFirstOrThrow();
    const token = await issueFor(u.email);
    await confirm({ token, newPassword: NEW_PASSWORD });
    const after = await db.selectFrom("users").select(["role", "email"]).where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    expect(await db.selectFrom("platformAccess").select("userId").where("userId", "=", u.id).execute()).toHaveLength(0);
  });
});

describe("limites, falhas de e-mail e de banco", () => {
  it("limite por IP: o 11º pedido do mesmo IP em 15 min recebe 429 (independe de a conta existir)", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < 10; i += 1) expect((await requestReset(`pessoa${i}@example.com`, ip)).status).toBe(202);
    const limited = await requestReset("pessoa-extra@example.com", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("limite por e-mail: depois de 3 pedidos na hora a resposta continua 202 (idêntica) mas nada novo é enviado", async () => {
    const u = await createTestUser();
    for (let i = 0; i < 3; i += 1) {
      await issueFor(u.email);
      await backdate(u.id, 120);
    }
    const res = await requestReset(u.email);
    expect(res.status).toBe(202);
    expect(await parseJson<Json>(res)).toEqual({ message: GENERIC_MESSAGE });
    await flushPasswordResetWork();
    expect(mail.sent).toHaveLength(3);
  });

  it("limite por IP também em validar e confirmar (429 com Retry-After)", async () => {
    const ip = "203.0.113.8";
    for (let i = 0; i < 20; i += 1) await confirm({ token: "x", newPassword: NEW_PASSWORD }, ip);
    const res = await confirm({ token: "x", newPassword: NEW_PASSWORD }, ip);
    expect(res.status).toBe(429);
    const vip = "203.0.113.9";
    for (let i = 0; i < 60; i += 1) await validate("x", vip);
    expect((await validate("x", vip)).status).toBe(429);
  });

  it("transporte indisponível: o token é invalidado (nada fica ativo), a resposta pública continua genérica e o log traz só um código seguro", async () => {
    const u = await createTestUser();
    mail.mode = "fail";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await requestReset(u.email);
    expect(res.status).toBe(202);
    await flushPasswordResetWork();
    const row = await db.selectFrom("passwordResetTokens").select(["usedAt", "invalidatedAt"]).where("userId", "=", u.id).executeTakeFirstOrThrow();
    expect(row.invalidatedAt).not.toBeNull();
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ENVIO_FALHOU");
    expect(logged).not.toContain(u.email);
    expect(logged).not.toContain("falha-sintetica");
  });

  it("transporte NÃO configurado: não cria token, não finge envio e identifica a causa por código seguro (smtp_nao_configurado)", async () => {
    const u = await createTestUser();
    mail.mode = "notconfigured";
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await requestReset(u.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(await db.selectFrom("passwordResetTokens").select("id").execute()).toHaveLength(0);
    expect(logs.mock.calls.map((c) => String(c[0])).join("\n")).toContain("smtp_nao_configurado");
    expect(await processResetRequest(u.email, { emailAdapter: { isConfigured: false, send: async () => ({ sent: false, reason: "not_configured" }) } })).toBe("smtp_nao_configurado");
  });

  it("falha de banco durante o pedido: a resposta pública continua 202 genérica e nada vaza (resultado 'erro' só no log)", async () => {
    const u = await createTestUser();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db, "transaction").mockImplementation(() => {
      throw Object.assign(new Error("connection refused postgres://usuario:segredo@127.0.0.1/db"), { code: "ECONNREFUSED" });
    });
    const res = await requestReset(u.email);
    expect(res.status).toBe(202);
    await flushPasswordResetWork();
    vi.restoreAllMocks();
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toMatch(/segredo|postgres:\/\/|127\.0\.0\.1/);
    expect(mail.sent).toHaveLength(0);
  });

  it("falha de banco na confirmação: erro genérico, sem detalhe interno", async () => {
    const u = await createTestUser();
    const token = await issueFor(u.email);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(db, "transaction").mockImplementation(() => {
      throw new Error("falha interna com segredo postgres://u:p@h/db");
    });
    const res = await confirm({ token, newPassword: NEW_PASSWORD });
    spy.mockRestore();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).not.toMatch(/segredo|postgres:\/\//);
    expect((await parseJson<Json>(await validate(token))).state).toBe("valido");
  });

  it("logs de todo o fluxo não contêm token, senha, e-mail nem hash", async () => {
    const out: string[] = [];
    const capture = (...args: unknown[]) => void out.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    const u = await createTestUser();
    const token = await issueFor(u.email);
    await confirm({ token, newPassword: NEW_PASSWORD });
    await confirm({ token, newPassword: NEW_PASSWORD });
    await validate("invalido-qualquer");
    await flushPasswordResetWork();
    const text = out.join("\n");
    for (const secret of [token, NEW_PASSWORD, PASSWORD, u.email, hashResetToken(token, currentPepperVersion()).toString("hex")]) expect(text).not.toContain(secret);
  });
});

describe("URL do link: validação de origem", () => {
  const t = "a".repeat(43);
  it("usa APP_PUBLIC_URL (nunca Host/Origin da requisição) e coloca o token no fragmento", async () => {
    expect(buildResetUrl(t, { NODE_ENV: "production", APP_PUBLIC_URL: "https://app.exemplo.org.br/" })).toEqual({ ok: true, url: `https://app.exemplo.org.br/redefinir-senha#token=${t}` });
    const u = await createTestUser();
    const req = new Request("http://localhost/_api/auth/password-reset-request", { method: "POST", headers: { Host: "evil.example", Origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-client-ip-verified": "t-1" }, body: JSON.stringify({ json: { email: u.email } }) });
    expect((await postRequest(req)).status).toBe(202);
    await flushPasswordResetWork();
    expect(mail.sent[0].text).toContain(APP);
    expect(mail.sent[0].text).not.toContain("evil.example");
  });

  it("recusa URLs inseguras ou fora do padrão", () => {
    const bad = (env: Record<string, string | undefined>) => buildResetUrl(t, env as NodeJS.ProcessEnv);
    expect(bad({ NODE_ENV: "production" })).toEqual({ ok: false, code: "APP_URL_AUSENTE" });
    for (const url of ["http://app.exemplo.org.br", "javascript:alert(1)", "ftp://app.exemplo.org.br", "https://user:pass@app.exemplo.org.br", "https://app.exemplo.org.br/caminho", "https://app.exemplo.org.br/?a=1", "https://app.exemplo.org.br/#x", "nao-e-url", "//evil.example"]) {
      expect(bad({ NODE_ENV: "production", APP_PUBLIC_URL: url })).toEqual({ ok: false, code: "APP_URL_INVALIDA" });
    }
    expect(bad({ NODE_ENV: "production", APP_PUBLIC_URL: "https://localhost" })).toEqual({ ok: false, code: "APP_URL_INVALIDA" });
    expect(bad({ NODE_ENV: "development", APP_PUBLIC_URL: "http://localhost:5173" })).toMatchObject({ ok: true });
    expect(bad({ NODE_ENV: "development", APP_PUBLIC_URL: "http://app.exemplo.org.br" })).toEqual({ ok: false, code: "APP_URL_INVALIDA" });
  });

  it("URL inválida em produção: não cria token e registra o código seguro", async () => {
    const u = await createTestUser();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcome = await processResetRequest(u.email, { env: { NODE_ENV: "production", APP_PUBLIC_URL: "http://inseguro.example" } as NodeJS.ProcessEnv, emailAdapter: { isConfigured: true, send: async () => ({ sent: true, messageId: "x" }) } });
    expect(outcome).toBe("url_invalida");
    expect(await db.selectFrom("passwordResetTokens").select("id").execute()).toHaveLength(0);
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain("APP_URL_INVALIDA");
  });
});

describe("configuração, retenção e restrições do banco", () => {
  it("TTL configurável com limites (10–120 min); valor inválido volta ao padrão seguro de 30", () => {
    const env = (v: string) => ({ PASSWORD_RESET_TTL_MINUTES: v }) as NodeJS.ProcessEnv;
    expect(resetTtlMinutes(env(""))).toBe(30);
    expect(resetTtlMinutes(env("45"))).toBe(45);
    for (const bad of ["5", "9", "121", "0", "-3", "abc", "1.5", "99999"]) expect(resetTtlMinutes(env(bad))).toBe(30);
  });

  it("retenção curta: tokens usados/invalidados/expirados há mais de 7 dias são removidos no pedido seguinte; ativos e recentes ficam", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const oldUsed = await issueFor(u.email);
    await confirm({ token: oldUsed, newPassword: NEW_PASSWORD });
    await sql`UPDATE password_reset_tokens SET created_at = now() - interval '9 days', expires_at = now() - interval '9 days' + interval '30 minutes' WHERE user_id = ${u.id}`.execute(db);
    await issueFor(other.email); // token recente e ativo de outro usuário
    await issueFor(u.email); // dispara a limpeza
    const rows = await db.selectFrom("passwordResetTokens").select(["userId", "usedAt"]).execute();
    expect(rows.filter((r) => r.userId === u.id)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === u.id)[0].usedAt).toBeNull();
    expect(rows.filter((r) => r.userId === other.id)).toHaveLength(1);
  });

  it("o banco impede dois tokens ativos do mesmo usuário, expiração anterior à criação e estado usado+invalidado", async () => {
    const u = await createTestUser();
    const base = { userId: u.id, pepperVersion: 1, expiresAt: new Date(Date.now() + 600000) };
    await db.insertInto("passwordResetTokens").values({ ...base, tokenHash: Buffer.from("h1") }).execute();
    await expect(db.insertInto("passwordResetTokens").values({ ...base, tokenHash: Buffer.from("h2") }).execute()).rejects.toMatchObject({ code: "23505" });
    await expect(db.insertInto("passwordResetTokens").values({ ...base, userId: (await createTestUser()).id, tokenHash: Buffer.from("h3"), expiresAt: new Date(Date.now() - 600000) }).execute()).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.insertInto("passwordResetTokens").values({ ...base, userId: (await createTestUser()).id, tokenHash: Buffer.from("h4"), usedAt: new Date(), invalidatedAt: new Date() }).execute()
    ).rejects.toMatchObject({ code: "23514" });
    await expect(db.insertInto("passwordResetTokens").values({ ...base, userId: (await createTestUser()).id, tokenHash: Buffer.from("h1") }).execute()).rejects.toMatchObject({ code: "23505" });
  });

  it("excluir o usuário remove seus tokens (FK em cascata)", async () => {
    const u = await createTestUser(); // sem auditoria (audit_log é append-only e referencia o usuário): token inserido direto
    await db.insertInto("passwordResetTokens").values({ userId: u.id, tokenHash: Buffer.from("h-cascata"), pepperVersion: 1, expiresAt: new Date(Date.now() + 600000) }).execute();
    await sql`DELETE FROM users WHERE id = ${u.id}`.execute(db);
    expect(await db.selectFrom("passwordResetTokens").select("id").execute()).toHaveLength(0);
  });
});
