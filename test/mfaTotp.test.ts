import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { db } from "../src/helpers/db";
import { base32Decode, base32Encode, buildOtpauthUri, matchTotp, normalizeTotpInput, stepAt, totpCodeAtStep, TOTP_PERIOD_SECONDS } from "../src/helpers/totp";
import { acceptedPepperVersions, currentMfaKeyId, currentPepperVersion, decryptSecret, encryptSecret, hmacSecret, IdentityKeyConfigError, isPlatformMfaRequired } from "../src/helpers/identityKeys";
import { beginTotpSetup, consumeRecoveryCode, generateRecoveryCode, getMfaMethod, issueRecoveryCodes, lockStatus, normalizeRecoveryCode, verifyTotp, LOCK_AFTER_FAILURES, type MfaMethodRow } from "../src/helpers/mfa";
import { createTestUser, enrollTestMfa, TEST_TOTP_SECRET } from "./helpers";

// RFC 6238, Apêndice B — segredo ASCII "12345678901234567890", SHA-1. Os valores de 8 dígitos truncados para 6 dígitos.
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("TOTP — RFC 6238 (SHA-1, 6 dígitos, 30 s)", () => {
  it("bate com os vetores de teste oficiais do RFC 6238", () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(totpCodeAtStep(TEST_TOTP_SECRET, Math.floor(seconds / TOTP_PERIOD_SECONDS))).toBe(expected);
    }
  });

  it("base32 (RFC 4648) ida e volta e o URI otpauth é o que Google/Microsoft Authenticator leem", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Decode("mzxw 6ytb-oi").toString()).toBe("foobar");
    const uri = buildOtpauthUri({ secret: TEST_TOTP_SECRET, accountLabel: "ana@example.com" });
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(decodeURIComponent(parsed.pathname)).toBe("/Levora:ana@example.com");
    expect(parsed.searchParams.get("secret")).toBe(base32Encode(TEST_TOTP_SECRET));
    expect(parsed.searchParams.get("issuer")).toBe("Levora");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });

  it("tolerância ±1 passo: aceita anterior, atual e seguinte; recusa ±2 e códigos malformados", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    for (const off of [-1, 0, 1]) expect(matchTotp(TEST_TOTP_SECRET, totpCodeAtStep(TEST_TOTP_SECRET, step + off), now, null)).toBe(step + off);
    for (const off of [-2, 2, 5]) expect(matchTotp(TEST_TOTP_SECRET, totpCodeAtStep(TEST_TOTP_SECRET, step + off), now, null)).toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5", "000000 "]) expect(matchTotp(TEST_TOTP_SECRET, bad, now, null) === null || /^\d{6}$/.test(normalizeTotpInput(bad))).toBe(true);
    expect(matchTotp(TEST_TOTP_SECRET, "12345", now, null)).toBeNull();
    // espaços/hífens digitados pela pessoa ("123 456") são normalizados
    const code = totpCodeAtStep(TEST_TOTP_SECRET, step);
    expect(matchTotp(TEST_TOTP_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now, null)).toBe(step);
  });

  it("anti-replay puro: o mesmo passo (ou um anterior ao último aceito) é recusado; o próximo passo é aceito", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const c0 = totpCodeAtStep(TEST_TOTP_SECRET, step);
    expect(matchTotp(TEST_TOTP_SECRET, c0, now, step)).toBeNull(); // mesmo passo
    expect(matchTotp(TEST_TOTP_SECRET, totpCodeAtStep(TEST_TOTP_SECRET, step - 1), now, step)).toBeNull(); // passo anterior ao último
    expect(matchTotp(TEST_TOTP_SECRET, totpCodeAtStep(TEST_TOTP_SECRET, step + 1), now, step)).toBe(step + 1); // próximo passo permitido
    expect(matchTotp(TEST_TOTP_SECRET, c0, now, step - 1)).toBe(step); // último foi o anterior: o atual vale
  });
});

describe("chaves de identidade — pepper e cifra versionados, sem reutilizar JWT_SECRET", () => {
  it("HMAC por contexto: o mesmo valor em contextos diferentes gera hashes diferentes; versões diferentes também", () => {
    const a = hmacSecret("recovery:v1:", "ABC", 1);
    expect(hmacSecret("recovery:v1:", "ABC", 1).equals(a)).toBe(true);
    expect(hmacSecret("bootstrap:v1:", "ABC", 1).equals(a)).toBe(false);
    expect(hmacSecret("challenge:v1:", "ABC", 1).equals(a)).toBe(false);
    process.env.IDENTITY_CODE_PEPPER_V2 = "teste-pepper-v2-ffffffffffffffffffffffffffffffff";
    try {
      expect(acceptedPepperVersions()).toEqual([1, 2]);
      expect(hmacSecret("recovery:v1:", "ABC", 2).equals(a)).toBe(false);
      expect(currentPepperVersion()).toBe(1);
    } finally {
      delete process.env.IDENTITY_CODE_PEPPER_V2;
    }
  });

  it("nenhuma chave deriva do JWT_SECRET e uma chave ausente/curta falha de forma segura", () => {
    expect(hmacSecret("recovery:v1:", "x", 1).equals(createHmac("sha256", process.env.JWT_SECRET ?? "").update("recovery:v1:x").digest())).toBe(false);
    const saved = process.env.IDENTITY_CODE_PEPPER_V1;
    process.env.IDENTITY_CODE_PEPPER_V1 = "curto";
    try {
      expect(() => hmacSecret("recovery:v1:", "x", 1)).toThrow(IdentityKeyConfigError);
    } finally {
      process.env.IDENTITY_CODE_PEPPER_V1 = saved;
    }
    const savedKey = process.env.MFA_ENCRYPTION_KEY_V1;
    process.env.MFA_ENCRYPTION_KEY_V1 = Buffer.alloc(16, 1).toString("base64");
    try {
      expect(() => encryptSecret(Buffer.from("x"), "aad")).toThrow(IdentityKeyConfigError);
    } finally {
      process.env.MFA_ENCRYPTION_KEY_V1 = savedKey;
    }
  });

  it("AES-256-GCM: formato iv(12)||tag(16)||ct; ida e volta; AAD errado e adulteração são recusados; cifra aleatória (IV novo)", () => {
    const plain = Buffer.from("segredo-totp-de-teste");
    const { ciphertext, keyId } = encryptSecret(plain, "mfa:7");
    expect(keyId).toBe(currentMfaKeyId());
    expect(ciphertext.length).toBe(12 + 16 + plain.length);
    expect(ciphertext.includes(plain)).toBe(false);
    expect(decryptSecret(ciphertext, keyId, "mfa:7").equals(plain)).toBe(true);
    expect(() => decryptSecret(ciphertext, keyId, "mfa:8")).toThrow(); // AAD de outro usuário
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSecret(tampered, keyId, "mfa:7")).toThrow();
    expect(encryptSecret(plain, "mfa:7").ciphertext.equals(ciphertext)).toBe(false);
  });

  it("rotação: um segredo cifrado com a chave V1 continua decifrando depois que a V2 vira a corrente", () => {
    const { ciphertext, keyId } = encryptSecret(Buffer.from("abc"), "mfa:1");
    process.env.MFA_ENCRYPTION_KEY_V2 = Buffer.alloc(32, 9).toString("base64");
    process.env.MFA_ENCRYPTION_KEY_CURRENT = "2";
    try {
      expect(currentMfaKeyId()).toBe(2);
      expect(decryptSecret(ciphertext, keyId, "mfa:1").toString()).toBe("abc");
      const fresh = encryptSecret(Buffer.from("abc"), "mfa:1");
      expect(fresh.keyId).toBe(2);
      expect(decryptSecret(fresh.ciphertext, 2, "mfa:1").toString()).toBe("abc");
    } finally {
      delete process.env.MFA_ENCRYPTION_KEY_V2;
      process.env.MFA_ENCRYPTION_KEY_CURRENT = "1";
    }
  });

  it("PLATFORM_MFA_REQUIRED só relaxa em staging explícito", () => {
    expect(isPlatformMfaRequired()).toBe(true);
    process.env.PLATFORM_MFA_REQUIRED = "false";
    try {
      expect(isPlatformMfaRequired()).toBe(true); // sem LEVORA_ENVIRONMENT=staging não vale
      process.env.LEVORA_ENVIRONMENT = "staging";
      expect(isPlatformMfaRequired()).toBe(false);
    } finally {
      delete process.env.PLATFORM_MFA_REQUIRED;
      delete process.env.LEVORA_ENVIRONMENT;
    }
  });
});

describe("TOTP persistido — segredo cifrado, anti-replay atômico, falhas e bloqueio progressivo", () => {
  async function method(userId: number): Promise<MfaMethodRow> {
    return (await getMfaMethod(db as never, userId, "active")) as MfaMethodRow;
  }

  it("beginTotpSetup grava o segredo CIFRADO como pending (nada ativo) e substitui um pending anterior", async () => {
    const u = await createTestUser();
    const first = await db.transaction().execute((trx) => beginTotpSetup(trx, { userId: u.id, accountLabel: u.email }));
    const second = await db.transaction().execute((trx) => beginTotpSetup(trx, { userId: u.id, accountLabel: u.email }));
    expect(first.manualKey).not.toBe(second.manualKey);
    const rows = await db.selectFrom("mfaMethods").selectAll().where("userId", "=", u.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].secretCiphertext.includes(base32Decode(second.manualKey))).toBe(false); // não é texto puro
    expect(rows[0].secretCiphertext.toString("latin1")).not.toContain(second.manualKey);
    expect(decryptSecret(rows[0].secretCiphertext, rows[0].secretKeyId, `mfa:${u.id}`).equals(base32Decode(second.manualKey))).toBe(true);
  });

  it("verifyTotp: sucesso grava last_used_step; o mesmo código de novo é rejeitado; o próximo passo vale", async () => {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    const now = new Date(1_700_000_000_000);
    const step = stepAt(now.getTime());
    const r1 = await db.transaction().execute(async (trx) => verifyTotp(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, totpCodeAtStep(TEST_TOTP_SECRET, step), now));
    expect(r1).toEqual({ ok: true, step });
    expect((await method(u.id)).lastUsedStep).toBe(step);
    const r2 = await db.transaction().execute(async (trx) => verifyTotp(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, totpCodeAtStep(TEST_TOTP_SECRET, step), now));
    expect(r2).toMatchObject({ ok: false, reason: "invalid" });
    const r3 = await db.transaction().execute(async (trx) => verifyTotp(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, totpCodeAtStep(TEST_TOTP_SECRET, step + 1), now));
    expect(r3).toEqual({ ok: true, step: step + 1 });
  });

  it("CONCORRÊNCIA: o mesmo código TOTP usado por 8 verificações simultâneas — exatamente 1 sucesso", async () => {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    const now = new Date();
    const code = totpCodeAtStep(TEST_TOTP_SECRET, stepAt(now.getTime()));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.transaction().execute(async (trx) => verifyTotp(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, code, now)))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("falhas persistem no banco (COMMIT), bloqueiam a partir de 10 em 1 h com espera crescente (teto 15 min) e um sucesso zera; falhas antigas deixam de contar", async () => {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    const now = new Date(1_700_000_000_000);
    const attempt = (code: string, at: Date) => db.transaction().execute(async (trx) => verifyTotp(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, code, at));
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) expect(await attempt("000000", now)).toMatchObject({ ok: false, reason: "invalid" });
    expect((await method(u.id)).failedAttempts).toBe(LOCK_AFTER_FAILURES - 1); // persistiu (a transação fez COMMIT)
    const locked = await attempt("000000", now);
    expect(locked).toMatchObject({ ok: false, reason: "locked", retryAfterSeconds: 30 });
    // durante o bloqueio nem o código CERTO entra (e não conta falha nova)
    const good = totpCodeAtStep(TEST_TOTP_SECRET, stepAt(now.getTime()));
    expect(await attempt(good, new Date(now.getTime() + 10_000))).toMatchObject({ ok: false, reason: "locked" });
    // passado o bloqueio: o certo entra e zera
    expect(await attempt(good, new Date(now.getTime() + 31_000))).toMatchObject({ ok: true });
    const after = await method(u.id);
    expect(after.failedAttempts).toBe(0);
    expect(after.lockedUntil).toBeNull();
    // o bloqueio nunca é permanente: 11ª falha seguida dobra a espera, mas o teto é 15 min
    const t0 = new Date(now.getTime() + 100_000_000);
    for (let i = 0; i < 25; i++) await attempt("000000", t0);
    const capped = await method(u.id);
    expect(capped.lockedUntil!.getTime() - t0.getTime()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(lockStatus(capped, new Date(t0.getTime() + 16 * 60 * 1000)).locked).toBe(false);
    // falhas fora da janela de 1 h deixam de contar
    const later = new Date(t0.getTime() + 2 * 3600 * 1000);
    expect(await attempt("000000", later)).toMatchObject({ ok: false, reason: "invalid" });
    expect((await method(u.id)).failedAttempts).toBe(1);
  });
});

describe("recovery codes — formato, hash e uso único", () => {
  it("formato Crockford 4-4-4-4 (80 bits); normalização aceita caixa, hífens, espaços e I/L/O ambíguos; formato impossível é recusado sem consultar o banco", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(code.replace(/-/g, ""));
    expect(normalizeRecoveryCode("ABCD EFGH JKMN PQRS")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeRecoveryCode("0O0O-1I1L-0000-1111")).toBe("0000111100001111");
    for (const bad of ["", "ABCD-EFGH", "ABCD-EFGH-JKMN-PQR", "ABCD-EFGH-JKMN-PQRSX", "ÜÜÜÜ-ÜÜÜÜ-ÜÜÜÜ-ÜÜÜÜ", "ABCD-EFGH-JKMN-PQRU"]) expect(normalizeRecoveryCode(bad)).toBeNull();
    expect(new Set(Array.from({ length: 200 }, generateRecoveryCode)).size).toBe(200);
  });

  it("issueRecoveryCodes: 10 códigos, só o HMAC (com pepper_version) é gravado, nunca o texto; novo lote invalida o anterior", async () => {
    const u = await createTestUser();
    const batch1 = await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.id));
    expect(batch1).toHaveLength(10);
    const rows = await db.selectFrom("mfaRecoveryCodes").selectAll().where("userId", "=", u.id).execute();
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.pepperVersion).toBe(1);
      expect(r.codeHash.length).toBe(32);
      for (const c of batch1) expect(r.codeHash.toString("hex")).not.toContain(c.replace(/-/g, "").toLowerCase());
    }
    const dump = JSON.stringify(rows);
    for (const c of batch1) expect(dump).not.toContain(c);
    const batch2 = await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.id));
    const open = await db.selectFrom("mfaRecoveryCodes").select(["batchId", "invalidatedAt"]).where("userId", "=", u.id).where("invalidatedAt", "is", null).execute();
    expect(open).toHaveLength(10);
    expect(batch2.some((c) => batch1.includes(c))).toBe(false);
  });

  it("consumeRecoveryCode: uso único; reuso, código inexistente, truncado, malformado e de OUTRO usuário falham; só o código do próprio usuário vale", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await enrollTestMfa(a.id);
    await enrollTestMfa(b.id);
    const codesA = await db.transaction().execute((trx) => issueRecoveryCodes(trx, a.id));
    const codesB = await db.transaction().execute((trx) => issueRecoveryCodes(trx, b.id));
    const use = (userId: number, code: string) =>
      db.transaction().execute(async (trx) => consumeRecoveryCode(trx, (await getMfaMethod(trx, userId, "active", { forUpdate: true }))!, code));
    expect(await use(a.id, codesA[0])).toMatchObject({ ok: true });
    expect(await use(a.id, codesA[0])).toMatchObject({ ok: false }); // reuso
    expect(await use(a.id, codesA[0].toLowerCase())).toMatchObject({ ok: false }); // reuso com outra grafia
    expect(await use(a.id, "ZZZZ-ZZZZ-ZZZZ-ZZZZ")).toMatchObject({ ok: false }); // inexistente
    expect(await use(a.id, codesA[1].slice(0, 14))).toMatchObject({ ok: false }); // truncado
    expect(await use(a.id, "lixo")).toMatchObject({ ok: false }); // malformado
    expect(await use(a.id, codesB[0])).toMatchObject({ ok: false }); // código de outro usuário
    expect(await use(b.id, codesB[0])).toMatchObject({ ok: true }); // continua valendo para o dono
    expect(await use(a.id, codesA[2])).toMatchObject({ ok: true }); // sucesso zera falhas
  });

  it("CONCORRÊNCIA: o mesmo recovery code em 8 usos simultâneos — exatamente 1 sucesso", async () => {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    const [code] = await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.id));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.transaction().execute(async (trx) => consumeRecoveryCode(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, code)))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("recovery e TOTP compartilham o contador de falhas (alternar não dobra as tentativas)", async () => {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    await db.transaction().execute((trx) => issueRecoveryCodes(trx, u.id));
    const now = new Date();
    const useRecovery = (code: string) => db.transaction().execute(async (trx) => consumeRecoveryCode(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, code, now));
    const useTotp = (code: string) => db.transaction().execute(async (trx) => verifyTotp(trx, (await getMfaMethod(trx, u.id, "active", { forUpdate: true }))!, code, now));
    for (let i = 0; i < 5; i++) {
      await useRecovery("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
      await useTotp("000000");
    }
    const m = (await getMfaMethod(db as never, u.id, "active")) as MfaMethodRow;
    expect(m.failedAttempts).toBe(10);
    expect(lockStatus(m, now).locked).toBe(true);
  });
});
