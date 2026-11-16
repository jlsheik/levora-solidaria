/**
 * F2 — confiabilidade do envio posterior à resposta HTTP, teto por conta no BANCO (vale entre reinícios/instâncias), atomicidade sob falha parcial e confiança no proxy.
 * Transporte de e-mail SINTÉTICO (nenhuma rede); contas sintéticas; PostgreSQL real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sql } from "kysely";

const ctl = vi.hoisted(() => ({
  send: "ok" as "ok" | "throw" | "fail",
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  sendCalls: 0,
  gate: null as null | Promise<void>,
  failAuditAction: null as null | string,
}));

vi.mock("../src/helpers/emailAdapter", async (original) => {
  const actual = await original<typeof import("../src/helpers/emailAdapter")>();
  return {
    ...actual,
    emailAdapter: {
      isConfigured: true,
      async send(input: { to: string; subject: string; text: string }) {
        ctl.sendCalls += 1;
        if (ctl.gate) await ctl.gate;
        if (ctl.send === "throw") throw new Error("excecao-sintetica do transporte com segredo smtp://u:p@host");
        if (ctl.send === "fail") return { sent: false, reason: "provider_error", error: "falha-sintetica" };
        ctl.sent.push(input);
        return { sent: true, messageId: `sintetico-${ctl.sent.length}`, synthetic: true };
      },
    },
  };
});

vi.mock("../src/helpers/auditLog", async (original) => {
  const actual = await original<typeof import("../src/helpers/auditLog")>();
  return {
    ...actual,
    recordAuditLogEntry: (async (entry: { action: string }, ...rest: unknown[]) => {
      if (ctl.failAuditAction && entry.action === ctl.failAuditAction) throw Object.assign(new Error("falha-de-auditoria-sintetica"), { code: "AUDIT_INJECTED" });
      return (actual.recordAuditLogEntry as (...a: unknown[]) => unknown)(entry, ...rest);
    }) as typeof actual.recordAuditLogEntry,
  };
});

import { db } from "../src/helpers/db";
import { handle as postRequest } from "../src/endpoints/auth/password-reset-request_POST";
import { handle as postConfirm } from "../src/endpoints/auth/password-reset-confirm_POST";
import { flushPasswordResetWork, processResetRequest, RESET_MAX_PER_HOUR, hashResetToken, generateResetToken, scheduleResetWork } from "../src/helpers/passwordReset";
import { checkProxyTrust } from "../src/helpers/proxyTrust";
import { limiterKeyForIp } from "../src/helpers/limiterKey";
import { currentPepperVersion } from "../src/helpers/identityKeys";
import { issueRecoveryCodes } from "../src/helpers/mfa";
import { resetAllRateLimitsForTests } from "../src/helpers/rateLimit";
import { createSessionCookie, createTestUser, enrollTestMfa, buildRequest, parseJson } from "./helpers";
import { login, PASSWORD } from "./mfaHarness";

const APP = "https://app.levora-teste.example";
const NEW_PASSWORD = "uma-senha-nova-segura-456";
type Json = Record<string, unknown>;
const requestReset = (email: string, ip?: string) => postRequest(buildRequest("auth/password-reset-request", { method: "POST", body: { email }, ip }));
const confirm = (body: Json) => postConfirm(buildRequest("auth/password-reset-confirm", { method: "POST", body }));
const tokenFromMail = (index = ctl.sent.length - 1): string => /#token=([A-Za-z0-9_-]{43})/.exec(ctl.sent[index].text)![1];
const backdate = (userId: number, seconds: number) =>
  sql`UPDATE password_reset_tokens SET created_at = created_at - make_interval(secs => ${seconds}), expires_at = expires_at - make_interval(secs => ${seconds}) WHERE user_id = ${userId}`.execute(db);
const tokenCount = async (userId: number) => (await db.selectFrom("passwordResetTokens").select("id").where("userId", "=", userId).execute()).length;
const activeCount = async (userId: number) => (await db.selectFrom("passwordResetTokens").select("id").where("userId", "=", userId).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute()).length;

beforeEach(() => {
  ctl.send = "ok";
  ctl.sent.length = 0;
  ctl.sendCalls = 0;
  ctl.gate = null;
  ctl.failAuditAction = null;
  vi.stubEnv("APP_PUBLIC_URL", APP);
});
afterEach(async () => {
  ctl.gate = null;
  await flushPasswordResetWork();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("envio posterior à resposta HTTP: confiabilidade e diagnóstico", () => {
  it("encerramento da conexão: o cliente não lê (nem espera) a resposta e o trabalho termina mesmo assim", async () => {
    const u = await createTestUser();
    const res = await requestReset(u.email); // o corpo da resposta nunca é lido: equivale a um cliente que fechou a conexão
    expect(res.status).toBe(202);
    await flushPasswordResetWork();
    expect(ctl.sent.map((m) => m.to)).toEqual([u.email]);
  });

  it("pedidos SIMULTÂNEOS para a mesma conta (vários IPs): exatamente um e-mail e um token ativo (lock do usuário + cooldown no banco)", async () => {
    const u = await createTestUser();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => requestReset(u.email, `198.51.100.${i + 1}`)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    await flushPasswordResetWork();
    expect(ctl.sent).toHaveLength(1);
    expect(await activeCount(u.id)).toBe(1);
    expect(await tokenCount(u.id)).toBe(1);
  });

  it("transporte que LANÇA exceção (não só devolve falha): o token é invalidado (nada fica válido sem mensagem), o log traz só código seguro e não há retry", async () => {
    const u = await createTestUser();
    ctl.send = "throw";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await requestReset(u.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(ctl.sendCalls).toBe(1); // sem retry automático
    expect(await activeCount(u.id)).toBe(0);
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ENVIO_FALHOU");
    expect(logged).not.toMatch(/segredo|smtp:\/\/|excecao-sintetica/);
    expect(logged).not.toContain(u.email);
  });

  it("transporte que devolve falha: idem (token invalidado); e depois do cooldown a pessoa consegue pedir de novo e receber", async () => {
    const u = await createTestUser();
    ctl.send = "fail";
    expect((await requestReset(u.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(await activeCount(u.id)).toBe(0);
    ctl.send = "ok";
    expect((await requestReset(u.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(ctl.sent).toHaveLength(1);
    expect(await activeCount(u.id)).toBe(1);
  });

  it("reinício/queda ENTRE a gravação do token e o envio: o token fica ativo sem e-mail; dentro do cooldown não há novo e-mail, passado o cooldown um novo pedido SUBSTITUI o token e envia (recuperação por reenvio, sem fila persistente)", async () => {
    const u = await createTestUser();
    const orphan = generateResetToken();
    await db.insertInto("passwordResetTokens").values({ userId: u.id, tokenHash: hashResetToken(orphan, currentPepperVersion()), pepperVersion: currentPepperVersion(), expiresAt: new Date(Date.now() + 30 * 60_000) }).execute();
    expect((await requestReset(u.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(ctl.sent).toHaveLength(0); // cooldown: comportamento documentado
    await backdate(u.id, 61);
    resetAllRateLimitsForTests(); // processo novo: contadores em memória zerados
    expect((await requestReset(u.email)).status).toBe(202);
    await flushPasswordResetWork();
    expect(ctl.sent).toHaveLength(1);
    expect(await activeCount(u.id)).toBe(1);
    expect((await confirm({ token: orphan, newPassword: NEW_PASSWORD })).status).toBe(400); // o token órfão foi substituído
    expect((await confirm({ token: tokenFromMail(), newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("encerramento gracioso: flush aguarda o envio em andamento (não devolve antes de ele terminar)", async () => {
    const u = await createTestUser();
    let release!: () => void;
    ctl.gate = new Promise<void>((r) => (release = r));
    expect((await requestReset(u.email)).status).toBe(202);
    let flushed = false;
    const flushing = flushPasswordResetWork().then(() => (flushed = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(ctl.sent).toHaveLength(1);
  });

  it("exceção em trabalho agendado nunca fica silenciosa nem derruba o processo: vira log com código seguro", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db, "transaction").mockImplementation(() => {
      throw Object.assign(new Error("banco indisponivel postgres://u:senha@h/db"), { code: "ECONNRESET" });
    });
    scheduleResetWork(processResetRequest("qualquer@example.com"));
    await flushPasswordResetWork();
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ECONNRESET");
    expect(logged).not.toMatch(/senha|postgres:\/\/|qualquer@example/);
  });

  it("diagnóstico operacional: cada desfecho tem um código no log (enviado, inelegível, cooldown, limite horário) sem e-mail, token nem corpo da mensagem", async () => {
    const out: string[] = [];
    const capture = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const u = await createTestUser();
    expect(await processResetRequest(u.email)).toBe("enviado");
    expect(await processResetRequest(u.email)).toBe("cooldown");
    expect(await processResetRequest("ninguem@example.com")).toBe("inelegivel");
    const text = out.join("\n");
    expect(text).toMatch(/"event":"password_reset_request"/);
    for (const code of ["cooldown", "inelegivel"]) expect(text).toContain(code);
    expect(text).not.toContain(u.email);
    expect(text).not.toContain("ninguem@example.com");
    expect(text).not.toMatch(/#token=|Redefinição de senha/);
    expect(text).not.toContain(tokenFromMail());
  });
});

describe("teto por conta no BANCO (compensa o limite em memória)", () => {
  it(`no máximo ${RESET_MAX_PER_HOUR} tokens por conta por hora; a resposta pública continua genérica e o teto SOBREVIVE a reinício (contadores em memória zerados)`, async () => {
    const u = await createTestUser();
    for (let i = 0; i < RESET_MAX_PER_HOUR; i += 1) {
      resetAllRateLimitsForTests(); // simula processo novo / outra instância: a memória não conhece os pedidos anteriores
      expect(await processResetRequest(u.email)).toBe("enviado");
      await backdate(u.id, 120); // passa o cooldown, continua dentro da hora
    }
    resetAllRateLimitsForTests();
    const res = await requestReset(u.email);
    expect(res.status).toBe(202);
    expect(await parseJson<Json>(res)).toMatchObject({ message: expect.stringContaining("Se existir uma conta") });
    expect(await processResetRequest(u.email)).toBe("limite_horario");
    await flushPasswordResetWork();
    expect(ctl.sent).toHaveLength(RESET_MAX_PER_HOUR);
    // depois de uma hora o teto deixa de valer
    await backdate(u.id, 3600);
    expect(await processResetRequest(u.email)).toBe("enviado");
  });

  it("o teto é por conta: outra conta não é afetada", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    for (let i = 0; i < RESET_MAX_PER_HOUR; i += 1) {
      expect(await processResetRequest(a.email)).toBe("enviado");
      await backdate(a.id, 120);
    }
    expect(await processResetRequest(a.email)).toBe("limite_horario");
    expect(await processResetRequest(b.email)).toBe("enviado");
  });
});

describe("atomicidade: falha parcial não altera a senha", () => {
  it("falha na auditoria no meio da confirmação: nada é aplicado (senha, token, sessões e código de recuperação intactos) e o link continua válido", async () => {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    const codes = await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.id));
    const cookie = await createSessionCookie(u.id);
    expect(await processResetRequest(u.email)).toBe("enviado");
    const token = tokenFromMail();
    const openBefore = (await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", u.id).where("usedAt", "is", null).execute()).length;

    ctl.failAuditAction = "usuario.senha_redefinida";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await confirm({ token, newPassword: NEW_PASSWORD, recoveryCode: codes[0] });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await failed.text()).not.toMatch(/falha-de-auditoria|AUDIT_INJECTED/);
    ctl.failAuditAction = null;

    expect((await login(u.email, PASSWORD)).status).toBe(200); // senha antiga continua valendo
    expect((await login(u.email, NEW_PASSWORD)).status).toBeGreaterThanOrEqual(400);
    const row = await db.selectFrom("passwordResetTokens").select(["usedAt", "invalidatedAt"]).where("userId", "=", u.id).executeTakeFirstOrThrow();
    expect(row.usedAt).toBeNull();
    expect(row.invalidatedAt).toBeNull();
    expect((await db.selectFrom("sessions").select("id").where("userId", "=", u.id).execute()).length).toBeGreaterThanOrEqual(1);
    expect((await db.selectFrom("mfaRecoveryCodes").select("id").where("userId", "=", u.id).where("usedAt", "is", null).execute()).length).toBe(openBefore);
    void cookie;
    // e, sem a falha, o MESMO link e o MESMO código de recuperação concluem
    expect((await confirm({ token, newPassword: NEW_PASSWORD, recoveryCode: codes[0] })).status).toBe(200);
  });
});

describe("confiança no proxy (limites por IP)", () => {
  it("produção sem TRUST_PROXY é sinalizada; com valor ou fora de produção não", () => {
    expect(checkProxyTrust({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("ausente_em_producao");
    expect(checkProxyTrust({ NODE_ENV: "production", TRUST_PROXY: " " } as NodeJS.ProcessEnv)).toBe("ausente_em_producao");
    expect(checkProxyTrust({ NODE_ENV: "production", TRUST_PROXY: "1" } as NodeJS.ProcessEnv)).toBe("ok");
    expect(checkProxyTrust({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("ok");
  });
});

describe("limite por IP: identificador e abuso distribuído", () => {
  it("IPv4: endereço exato (vizinhos no mesmo /24 NÃO dividem o contador); IPv6: prefixo /64; IPv4 mapeado vira IPv4; valores desconhecidos passam como estão", () => {
    expect(limiterKeyForIp("203.0.113.7")).toBe("203.0.113.7");
    expect(limiterKeyForIp("203.0.113.8")).not.toBe(limiterKeyForIp("203.0.113.7"));
    expect(limiterKeyForIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(limiterKeyForIp("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(limiterKeyForIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limiterKeyForIp("::1")).toBe("0:0:0:0::/64");
    expect(limiterKeyForIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(limiterKeyForIp("desconhecido")).toBe("desconhecido");
    expect(limiterKeyForIp("lixo:::::")).toBe("lixo:::::");
  });

  it("girar endereços dentro do mesmo /64 IPv6 não escapa do limite (o 11º pedido recebe 429); /64 diferentes têm contadores independentes", async () => {
    for (let i = 0; i < 10; i += 1) expect((await requestReset(`p${i}@example.com`, `2001:db8:aaaa:bbbb::${(i + 1).toString(16)}`)).status).toBe(202);
    expect((await requestReset("p10@example.com", "2001:db8:aaaa:bbbb:1:2:3:4")).status).toBe(429);
    expect((await requestReset("outra@example.com", "2001:db8:aaaa:cccc::1")).status).toBe(202);
    await flushPasswordResetWork();
  });

  it("e-mails distintos NÃO criam contadores em memória (o teto por conta é do banco): 200 pedidos de e-mails inexistentes de IPs distintos respondem todos 202", async () => {
    for (let i = 0; i < 200; i += 1) expect((await requestReset(`fantasma-${i}@example.com`, `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`)).status).toBe(202);
    await flushPasswordResetWork();
    expect(ctl.sent).toHaveLength(0);
  });
});
