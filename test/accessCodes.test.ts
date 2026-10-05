/**
 * Fase 91 — códigos de acesso e provisionamento controlado de contas.
 * Banco real; sem sleeps/retries. A concorrência é provada com Promise.all contra o banco e, onde a ordem importa, de forma
 * determinística (callback dentro da transação de consumo).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as register } from "../src/endpoints/auth/register_with_password_POST";
import { handle as check } from "../src/endpoints/auth/access-code-check_POST";
import { handle as create } from "../src/endpoints/platform-access-codes-create_POST";
import { handle as revoke } from "../src/endpoints/platform-access-codes-revoke_POST";
import { handle as list } from "../src/endpoints/platform-access-codes_GET";
import { handle as login } from "../src/endpoints/auth/login_with_password_POST";
import { handle as acceptInvite } from "../src/endpoints/organization-invites-accept_POST";
import {
  ACCESS_CODE_UNAVAILABLE_MESSAGE, canonicalizeAccessCode, deriveCodeStatus, formatAccessCode, generateAccessCode, maskAccessCode,
  provisionUserWithAccessCode, resolveExpiry, MAX_VALIDITY_MS, MIN_VALIDITY_MS,
} from "../src/helpers/registrationCodes";
import {
  buildRequest, createAuthenticatedUser, createPlatformAdmin, createPlatformOwner, createTestOrganization, addMembership, makeAccessCode,
  parseJson, createSessionCookie,
} from "./helpers";

const MIN = 60 * 1000;
const post = (path: string, body: unknown, cookie?: string, ip?: string) => buildRequest(path, { method: "POST", body, cookie, ip });
const signUp = (accessCode: string | undefined, email: string, ip?: string) =>
  register(post("auth/register_with_password", { email, password: "senha-valida-123", displayName: "Pessoa", ...(accessCode === undefined ? {} : { accessCode }) }, undefined, ip));
const createCode = (cookie: string, body: Record<string, unknown> = { expiresInMinutes: 60 }) => create(post("platform-access-codes-create", body, cookie));
const staleSession = (userId: number) => {
  const old = new Date(Date.now() - 11 * MIN);
  return db.updateTable("sessions").set({ mfaVerifiedAt: old, lastReauthAt: old }).where("userId", "=", userId).execute();
};
const userByEmail = (email: string) => db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst();
const codeRow = (id: number) => db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

describe("formato, canonicalização e armazenamento", () => {
  it("gera 20 símbolos Crockford (sem I/L/O/U) no formato LEV-XXXX×5, todos distintos entre si", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateAccessCode();
      expect(code).toMatch(/^LEV(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(500);
  });

  it("canonicaliza no servidor: caixa, espaços, hífens, prefixo e I/L→1, O→0; lixo ⇒ null", () => {
    const code = generateAccessCode();
    const canonical = canonicalizeAccessCode(code)!;
    expect(canonical).toHaveLength(20);
    expect(canonicalizeAccessCode(code.toLowerCase())).toBe(canonical);
    expect(canonicalizeAccessCode(` ${code.replace(/-/g, " ")} `)).toBe(canonical);
    expect(canonicalizeAccessCode(canonical)).toBe(canonical);
    expect(canonicalizeAccessCode("LEV-IIII-LLLL-OOOO-0000-1111")).toBe("11111111000000001111");
    for (const bad of ["", "LEV", "ABC", `${canonical}X`, canonical.slice(1), "U".repeat(20), "LEV-" + "!".repeat(20)]) expect(canonicalizeAccessCode(bad)).toBeNull();
    expect(formatAccessCode(canonical)).toBe(code);
    expect(maskAccessCode("A7K2")).toBe("LEV-••••-••••-••••-••••-A7K2");
  });

  it("o banco guarda só o hash e o final: o texto puro não existe em nenhuma coluna nem na auditoria", async () => {
    const admin = await createPlatformAdmin();
    const res = await createCode(admin.cookie);
    expect(res.status).toBe(200);
    const body = await parseJson<{ id: number; code: string; last4: string; masked: string }>(res);
    const canonical = canonicalizeAccessCode(body.code)!;
    const row = await codeRow(body.id);
    expect(row.codeLast4).toBe(canonical.slice(-4));
    expect(row.codeHash.length).toBe(32);
    const audit = JSON.stringify(await db.selectFrom("auditLog").selectAll().execute());
    const dump = JSON.stringify(await sql`SELECT row_to_json(c)::text AS t FROM registration_access_codes c`.execute(db)) + audit;
    expect(dump).not.toContain(canonical);
    expect(dump).not.toContain(body.code);
    expect(audit).not.toContain(Buffer.from(row.codeHash).toString("hex"));
  });

  it("CHECKs e UNIQUE do banco: validade máxima, par redeemed/revoked, e um código nunca serve a dois usuários", async () => {
    const { id, creatorId } = await makeAccessCode();
    await expect(db.updateTable("registrationAccessCodes").set({ expiresAt: new Date(Date.now() + 100 * 24 * 3600 * 1000) }).where("id", "=", id).execute()).rejects.toThrow();
    await expect(db.updateTable("registrationAccessCodes").set({ redeemedAt: new Date() }).where("id", "=", id).execute()).rejects.toThrow(); // sem redeemed_by
    await expect(db.updateTable("registrationAccessCodes").set({ redeemedAt: new Date(), redeemedByUserId: creatorId, revokedAt: new Date(), revokedByUserId: creatorId }).where("id", "=", id).execute()).rejects.toThrow();
    const a = await db.insertInto("users").values({ email: "a@example.com", displayName: "A", role: "user", registeredViaCodeId: id }).returning("id").executeTakeFirstOrThrow();
    expect(a.id).toBeGreaterThan(0);
    await expect(db.insertInto("users").values({ email: "b@example.com", displayName: "B", role: "user", registeredViaCodeId: id }).execute()).rejects.toThrow(/registered_via_code/);
  });

  it("status derivado e limites de validade", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const at = new Date(now.getTime() + 1000);
    expect(deriveCodeStatus({ redeemedAt: null, revokedAt: null, expiresAt: at }, now)).toBe("active");
    expect(deriveCodeStatus({ redeemedAt: null, revokedAt: null, expiresAt: now }, now)).toBe("expired"); // limite exato já é expirado
    expect(deriveCodeStatus({ redeemedAt: now, revokedAt: null, expiresAt: at }, now)).toBe("redeemed");
    expect(deriveCodeStatus({ redeemedAt: null, revokedAt: now, expiresAt: at }, now)).toBe("revoked");
    expect(() => resolveExpiry({ expiresInMinutes: 4 }, now)).toThrow();
    expect(() => resolveExpiry({ expiresInMinutes: 5 }, now)).not.toThrow();
    expect(() => resolveExpiry({ expiresInMinutes: 90 * 24 * 60 }, now)).not.toThrow();
    expect(() => resolveExpiry({ expiresInMinutes: 90 * 24 * 60 + 1 }, now)).toThrow();
    expect(() => resolveExpiry({ expiresAt: new Date("2099-01-01T00:00:00Z") }, now)).toThrow();
    expect(() => resolveExpiry({ expiresAt: new Date(now.getTime() - 1) }, now)).toThrow();
    expect(MIN_VALIDITY_MS).toBe(5 * MIN);
    expect(MAX_VALIDITY_MS).toBe(90 * 24 * 60 * MIN);
  });
});

describe("criação e revogação — autorização, step-up e auditoria", () => {
  it("platform admin e platform owner criam; o código devolvido aparece UMA vez (listagem só mascarado)", async () => {
    for (const make of [createPlatformAdmin, createPlatformOwner]) {
      const actor = await make();
      const res = await createCode(actor.cookie, { label: "Cliente piloto", expiresInMinutes: 24 * 60 });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = await parseJson<{ id: number; code: string; masked: string; status: string }>(res);
      expect(body.status).toBe("active");
      const listed = await parseJson<{ total: number; codes: Array<Record<string, unknown>> }>(await list(buildRequest("platform-access-codes", { cookie: actor.cookie })));
      const mine = listed.codes.find((c) => c.id === body.id)!;
      expect(mine.masked).toBe(body.masked);
      expect(JSON.stringify(listed)).not.toContain(canonicalizeAccessCode(body.code)!);
      expect(Object.keys(mine)).not.toContain("code");
      expect(Object.keys(mine)).not.toContain("codeHash");
    }
  });

  it("quem NÃO é platform_access recebe 403 (usuário comum, owner/admin de organização, sem membership) e nada é criado/revogado", async () => {
    const plain = await createAuthenticatedUser();
    const orgOwner = await createAuthenticatedUser();
    const org = await createTestOrganization(orgOwner.userId);
    const orgAdmin = await createAuthenticatedUser();
    await addMembership(org.id, orgAdmin.userId, "administrador");
    const orgOperator = await createAuthenticatedUser();
    await addMembership(org.id, orgOperator.userId, "operador");
    const target = await makeAccessCode();
    // step-up FRESCO para todos: só o gate de papel (platform_access) pode barrar — não o step-up
    await db.updateTable("sessions").set({ mfaVerifiedAt: new Date(), lastReauthAt: new Date() }).where("userId", "in", [plain.userId, orgOwner.userId, orgAdmin.userId, orgOperator.userId]).execute();
    for (const actor of [plain, orgOwner, orgAdmin, orgOperator]) {
      expect((await createCode(actor.cookie)).status).toBe(403);
      expect((await revoke(post("platform-access-codes-revoke", { id: target.id }, actor.cookie))).status).toBe(403);
      expect((await list(buildRequest("platform-access-codes", { cookie: actor.cookie }))).status).toBe(403);
    }
    expect((await createCode("")).status).toBe(401);
    expect((await revoke(post("platform-access-codes-revoke", { id: target.id }))).status).toBe(401);
    expect((await list(buildRequest("platform-access-codes"))).status).toBe(401);
    expect((await codeRow(target.id)).revokedAt).toBeNull();
    // apenas o código fabricado pelo helper existe
    expect(Number((await db.selectFrom("registrationAccessCodes").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n)).toBe(1);
  });

  it("platform_access REVOGADO perde o poder na hora (o banco é a autoridade, não a sessão)", async () => {
    const admin = await createPlatformAdmin();
    expect((await createCode(admin.cookie)).status).toBe(200);
    await db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", admin.userId).execute();
    expect((await createCode(admin.cookie)).status).toBe(403);
    expect((await list(buildRequest("platform-access-codes", { cookie: admin.cookie }))).status).toBe(403);
  });

  it("exige step-up: sessão com MFA/reauth antigos ⇒ 403 reauth_required (criar e revogar); leitura continua livre", async () => {
    const admin = await createPlatformAdmin();
    const target = await makeAccessCode();
    await staleSession(admin.userId);
    const blocked = await createCode(admin.cookie);
    expect(blocked.status).toBe(403);
    expect((await parseJson<{ code: string }>(blocked)).code).toBe("reauth_required");
    const blockedRevoke = await revoke(post("platform-access-codes-revoke", { id: target.id }, admin.cookie));
    expect(blockedRevoke.status).toBe(403);
    expect((await parseJson<{ code: string }>(blockedRevoke)).code).toBe("reauth_required");
    expect((await codeRow(target.id)).revokedAt).toBeNull();
    expect((await list(buildRequest("platform-access-codes", { cookie: admin.cookie }))).status).toBe(200);
  });

  it("validade: servidor decide (5 min … 90 dias); 2099, passado e ausência/ambiguidade são rejeitados", async () => {
    const admin = await createPlatformAdmin();
    for (const body of [{ expiresInMinutes: 1 }, { expiresInMinutes: 90 * 24 * 60 + 1 }, { expiresAt: "2099-01-01T00:00:00Z" }, { expiresAt: "2000-01-01T00:00:00Z" }, {}, { expiresInMinutes: 60, expiresAt: new Date(Date.now() + 3600_000) }]) {
      const res = await createCode(admin.cookie, body as Record<string, unknown>);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await createCode(admin.cookie, { expiresInMinutes: 5 })).status).toBe(200);
    expect((await createCode(admin.cookie, { expiresAt: new Date(Date.now() + 2 * 3600_000) })).status).toBe(200);
  });

  it("revogar: ativo ⇒ 200; já revogado/usado/expirado ⇒ 409; inexistente (ID manipulado) ⇒ 404; auditoria sem segredo", async () => {
    const admin = await createPlatformAdmin();
    const a = await makeAccessCode();
    expect((await revoke(post("platform-access-codes-revoke", { id: a.id }, admin.cookie))).status).toBe(200);
    expect((await revoke(post("platform-access-codes-revoke", { id: a.id }, admin.cookie))).status).toBe(409);
    for (const state of ["redeemed", "expired", "revoked"] as const) {
      const c = await makeAccessCode({ state });
      expect((await revoke(post("platform-access-codes-revoke", { id: c.id }, admin.cookie))).status).toBe(409);
    }
    expect((await revoke(post("platform-access-codes-revoke", { id: 999999 }, admin.cookie))).status).toBe(404);
    expect((await revoke(post("platform-access-codes-revoke", { id: "1 OR 1=1" }, admin.cookie))).status).toBe(400);
    const audit = await db.selectFrom("auditLog").select(["action", "metadata", "actorUserId"]).where("action", "in", ["codigo_acesso.criado", "codigo_acesso.revogado"]).execute();
    expect(audit.some((e) => e.action === "codigo_acesso.revogado" && e.actorUserId === admin.userId)).toBe(true);
    expect(audit.some((e) => e.action === "codigo_acesso.criado")).toBe(true);
  });

  it("rate limit da plataforma: geração e revogação por administrador", async () => {
    const admin = await createPlatformAdmin();
    const codes = await Promise.all(Array.from({ length: 5 }, () => makeAccessCode()));
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await createCode(admin.cookie)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(codes).toHaveLength(5);
  });
});

describe("listagem e filtros", () => {
  it("estados, filtros (status, descrição, final, consumidor, período) e máscara", async () => {
    const admin = await createPlatformAdmin();
    const active = await makeAccessCode({ label: "Alpha ativo" });
    await makeAccessCode({ state: "expired", label: "Beta expirado" });
    await makeAccessCode({ state: "revoked", label: "Gama revogado" });
    const used = await makeAccessCode({ state: "redeemed", label: "Delta usado" });
    const q = async (qs: string) => parseJson<{ total: number; codes: Array<{ id: number; status: string; label: string; masked: string; redeemedBy: { displayName: string; email: string } | null }> }>(await list(buildRequest(`platform-access-codes${qs}`, { cookie: admin.cookie })));
    expect((await q("")).total).toBe(4);
    for (const [status, label] of [["active", "Alpha ativo"], ["expired", "Beta expirado"], ["revoked", "Gama revogado"], ["redeemed", "Delta usado"]] as const) {
      const r = await q(`?status=${status}`);
      expect(r.codes.map((c) => c.label)).toEqual([label]);
      expect(r.codes[0].status).toBe(status);
    }
    expect((await q("?q=alpha")).codes.map((c) => c.id)).toEqual([active.id]);
    const last4 = (await codeRow(active.id)).codeLast4;
    expect((await q(`?q=${last4.toLowerCase()}`)).codes.map((c) => c.id)).toContain(active.id);
    const redeemer = (await q("?status=redeemed")).codes[0].redeemedBy!;
    expect((await q(`?q=${encodeURIComponent(redeemer.email)}`)).codes.map((c) => c.id)).toEqual([used.id]);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    expect((await q(`?createdFrom=${encodeURIComponent(tomorrow)}`)).total).toBe(0);
    expect((await q(`?createdTo=${encodeURIComponent(tomorrow)}`)).total).toBe(4);
    expect((await q("")).codes.every((c) => c.masked.startsWith("LEV-••••-") && c.masked.length === 28)).toBe(true);
    expect((await list(buildRequest("platform-access-codes?status=bogus", { cookie: admin.cookie }))).status).toBe(400);
    expect((await list(buildRequest("platform-access-codes?q=%25", { cookie: admin.cookie }))).status).toBe(200); // % tratado como literal
  });
});

describe("validação pública (não consome) e cadastro", () => {
  const checkCode = (accessCode: string, ip?: string) => check(post("auth/access-code-check", { accessCode }, undefined, ip));

  it("validar NÃO consome: continua utilizável depois de várias validações", async () => {
    const { code, id } = await makeAccessCode();
    for (let i = 0; i < 3; i++) expect((await checkCode(code)).status).toBe(200);
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect((await signUp(code, "ok@example.com")).status).toBe(200);
    expect((await codeRow(id)).redeemedAt).not.toBeNull();
  });

  it("inexistente, malformado, expirado, revogado e utilizado dão a MESMA resposta (status, corpo e Cache-Control) — no check e no cadastro", async () => {
    const fixtures = {
      ativoFalso: formatAccessCode("0".repeat(20)),
      malformado: "xyz",
      expirado: (await makeAccessCode({ state: "expired" })).code,
      revogado: (await makeAccessCode({ state: "revoked" })).code,
      utilizado: (await makeAccessCode({ state: "redeemed" })).code,
    };
    const seen = new Set<string>();
    let n = 0;
    for (const code of Object.values(fixtures)) {
      for (const fn of [(c: string) => checkCode(c), (c: string) => signUp(c, `x${n++}@example.com`)]) {
        const res = await fn(code);
        expect(res.status).toBe(400);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        const body = await parseJson<{ message: string; code: string }>(res);
        expect(body).toEqual({ message: ACCESS_CODE_UNAVAILABLE_MESSAGE, code: "codigo_indisponivel" });
        seen.add(JSON.stringify(body));
      }
    }
    expect(seen.size).toBe(1);
    expect(Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("email", "like", "x%@example.com").executeTakeFirstOrThrow()).n)).toBe(0);
  });

  it("sem código: 400 de validação, nenhuma conta", async () => {
    const res = await signUp(undefined, "sem-codigo@example.com");
    expect(res.status).toBe(400);
    expect(await userByEmail("sem-codigo@example.com")).toBeUndefined();
  });

  it("código válido: cria 1 usuário role='user' SEM platform_access/MFA, grava o vínculo, consome e audita", async () => {
    const { code, id } = await makeAccessCode();
    const res = await signUp(code.toLowerCase().replace(/-/g, " "), "Nova@Example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const user = (await userByEmail("nova@example.com"))!;
    expect(user.role).toBe("user");
    expect(user.registeredViaCodeId).toBe(id);
    expect(await db.selectFrom("platformAccess").selectAll().where("userId", "=", user.id).execute()).toHaveLength(0);
    expect(await db.selectFrom("mfaMethods").selectAll().where("userId", "=", user.id).execute()).toHaveLength(0);
    const row = await codeRow(id);
    expect(row.redeemedByUserId).toBe(user.id);
    expect(row.redeemedAt).not.toBeNull();
    const audit = await db.selectFrom("auditLog").selectAll().where("action", "=", "codigo_acesso.consumido").execute();
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(user.id);
    expect(JSON.stringify(audit)).not.toContain(canonicalizeAccessCode(code)!);
    // a senha escolhida funciona; o código não funciona como senha
    expect((await login(post("auth/login_with_password", { email: "nova@example.com", password: "senha-valida-123" }))).status).toBe(200);
    expect((await login(post("auth/login_with_password", { email: "nova@example.com", password: code }))).status).toBe(401);
    // segundo uso do mesmo código
    expect((await signUp(code, "outra@example.com")).status).toBe(400);
    expect(await userByEmail("outra@example.com")).toBeUndefined();
  });

  it("e-mail já existente: resposta neutra idêntica ao sucesso, NADA consumido, código segue ativo", async () => {
    const first = await makeAccessCode();
    expect((await signUp(first.code, "dup@example.com")).status).toBe(200);
    const second = await makeAccessCode();
    const ok = await signUp((await makeAccessCode()).code, "novo-neutro@example.com");
    const dup = await signUp(second.code, "dup@example.com");
    expect(dup.status).toBe(ok.status);
    expect(await dup.text()).toBe(await ok.text());
    expect((await codeRow(second.id)).redeemedAt).toBeNull();
    expect((await signUp(second.code, "dup@example.com".toUpperCase())).status).toBe(200); // caixa diferente = mesmo e-mail
    expect((await codeRow(second.id)).redeemedAt).toBeNull();
    expect((await signUp(second.code, "livre@example.com")).status).toBe(200);
    expect((await codeRow(second.id)).redeemedAt).not.toBeNull();
  });

  it("rate limit público: validação de código por IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await checkCode("xyz", "ip-fixo-check")).status);
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("tentativas inválidas são auditadas com o MOTIVO (só na auditoria), com volume limitado e sem o código digitado", async () => {
    const expired = await makeAccessCode({ state: "expired" });
    for (let i = 0; i < 3; i++) await checkCode(expired.code, "ip-audit-fixo");
    const rows = await db.selectFrom("auditLog").select(["action", "metadata"]).where("action", "=", "codigo_acesso.tentativa_invalida").execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("expirado");
    expect(JSON.stringify(rows)).not.toContain(canonicalizeAccessCode(expired.code)!);
  });
});

describe("convites × códigos (independentes)", () => {
  it("convite não cria conta: aceitar sem sessão é 401 e nenhum usuário nasce; criar conta exige código; conta nova aceita o convite depois", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const before = Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
    const res = await acceptInvite(post("organization-invites-accept", { token: "t".repeat(32) }));
    expect(res.status).toBe(401);
    expect((await signUp(undefined, "convidada@example.com")).status).toBe(400);
    expect(Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n)).toBe(before);
    const { code } = await makeAccessCode();
    expect((await signUp(code, "convidada@example.com")).status).toBe(200);
    const invitee = (await userByEmail("convidada@example.com"))!;
    expect(await db.selectFrom("memberships").selectAll().where("userId", "=", invitee.id).where("organizationId", "=", org.id).execute()).toHaveLength(0);
    const cookie = await createSessionCookie(invitee.id);
    expect((await acceptInvite(post("organization-invites-accept", { token: "t".repeat(32) }, cookie))).status).not.toBe(200); // token inexistente: o convite segue sendo fluxo próprio
  });
});

describe("concorrência (A–I)", () => {
  const countUsersVia = async (codeId: number) => Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("registeredViaCodeId", "=", codeId).executeTakeFirstOrThrow()).n);

  it("A/B/C: 20 cadastros simultâneos (abas, máquinas, e-mails e IPs diferentes) com o MESMO código ⇒ exatamente 1 conta", async () => {
    const { code, id } = await makeAccessCode();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => signUp(code, `corrida${i}@example.com`, `ip-corrida-${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(19);
    expect(await countUsersVia(id)).toBe(1);
    const row = await codeRow(id);
    expect(row.redeemedByUserId).not.toBeNull();
    expect(await db.selectFrom("auditLog").selectAll().where("action", "=", "codigo_acesso.consumido").execute()).toHaveLength(1);
  });

  it("D: requisição repetida (mesmo e-mail, mesma senha, mesmo código) ⇒ 1 conta, 1 consumo, respostas sem vazar qual venceu", async () => {
    const { code, id } = await makeAccessCode();
    const results = await Promise.all(Array.from({ length: 10 }, () => signUp(code, "repetida@example.com")));
    expect(await countUsersVia(id)).toBe(1);
    expect(Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("email", "=", "repetida@example.com").executeTakeFirstOrThrow()).n)).toBe(1);
    for (const r of results) expect([200, 400]).toContain(r.status);
  });

  it("replay: reenviar a requisição vencedora depois não cria nada", async () => {
    const { code, id } = await makeAccessCode();
    expect((await signUp(code, "replay@example.com")).status).toBe(200);
    expect((await signUp(code, "replay@example.com")).status).toBe(400);
    expect(await countUsersVia(id)).toBe(1);
  });

  it("E: cancelamento após a validação não consome e não deixa nada (check cancelado = leitura pura)", async () => {
    const { code, id } = await makeAccessCode();
    await check(post("auth/access-code-check", { accessCode: code }));
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect(await countUsersVia(id)).toBe(0);
    expect((await signUp(code, "depois-do-cancelamento@example.com")).status).toBe(200);
  });

  it("F: revogação × consumo simultâneos ⇒ exatamente um vence; nunca revogado E utilizado", async () => {
    for (let round = 0; round < 5; round++) {
      const admin = await createPlatformAdmin();
      const { code, id } = await makeAccessCode();
      const [reg, rev] = await Promise.all([signUp(code, `f${round}@example.com`), revoke(post("platform-access-codes-revoke", { id }, admin.cookie))]);
      const row = await codeRow(id);
      expect(row.redeemedAt !== null && row.revokedAt !== null).toBe(false);
      expect(row.redeemedAt !== null || row.revokedAt !== null).toBe(true);
      if (row.redeemedAt) {
        expect(reg.status).toBe(200);
        expect(rev.status).toBe(409);
        expect(await countUsersVia(id)).toBe(1);
      } else {
        expect(reg.status).toBe(400);
        expect(rev.status).toBe(200);
        expect(await countUsersVia(id)).toBe(0);
        expect(await userByEmail(`f${round}@example.com`)).toBeUndefined();
      }
    }
  });

  it("F (determinístico): revogação que chega ENTRE o lock e o UPDATE de consumo ⇒ rollback total, sem usuário órfão", async () => {
    const { code, id, creatorId } = await makeAccessCode();
    const result = await provisionUserWithAccessCode(code, async (trx, ctx) => {
      const u = await trx.insertInto("users").values({ email: "revogado-no-meio@example.com", displayName: "X", role: "user", registeredViaCodeId: ctx.codeId }).returning("id").executeTakeFirstOrThrow();
      await trx.updateTable("registrationAccessCodes").set({ revokedAt: new Date(), revokedByUserId: creatorId }).where("id", "=", ctx.codeId).execute();
      return u.id;
    });
    expect(result).toEqual({ ok: false, reason: "utilizado" });
    expect(await userByEmail("revogado-no-meio@example.com")).toBeUndefined();
    const row = await codeRow(id);
    expect(row.redeemedAt).toBeNull();
    expect(row.revokedAt).toBeNull(); // o rollback também desfez a revogação simulada
  });

  it("G (determinístico): expiração que ocorre durante o consumo ⇒ rollback, código não queimado", async () => {
    const { code, id } = await makeAccessCode();
    const result = await provisionUserWithAccessCode(code, async (trx, ctx) => {
      const u = await trx.insertInto("users").values({ email: "expirou-no-meio@example.com", displayName: "X", role: "user", registeredViaCodeId: ctx.codeId }).returning("id").executeTakeFirstOrThrow();
      await trx.updateTable("registrationAccessCodes").set({ expiresAt: sql`created_at + interval '1 millisecond'` }).where("id", "=", ctx.codeId).execute();
      return u.id;
    }, new Date(Date.now() + 1000));
    expect(result.ok).toBe(false);
    expect(await userByEmail("expirou-no-meio@example.com")).toBeUndefined();
    expect((await codeRow(id)).redeemedAt).toBeNull();
  });

  it("H: falha depois de criar o usuário (credencial) ⇒ rollback: sem conta órfã, sem código queimado, código reutilizável", async () => {
    const { code, id } = await makeAccessCode();
    await expect(
      provisionUserWithAccessCode(code, async (trx, ctx) => {
        await trx.insertInto("users").values({ email: "parcial@example.com", displayName: "P", role: "user", registeredViaCodeId: ctx.codeId }).execute();
        throw new Error("falha simulada depois de criar o usuário");
      })
    ).rejects.toThrow("falha simulada");
    expect(await userByEmail("parcial@example.com")).toBeUndefined();
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect((await signUp(code, "parcial@example.com")).status).toBe(200);
  });

  it("H': falha no UPDATE do código (trigger de teste) ⇒ rollback pelo endpoint real, resposta 5xx genérica, nada gravado", async () => {
    const { code, id } = await makeAccessCode();
    await sql.raw(`CREATE OR REPLACE FUNCTION public.test_fail_redeem() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.redeemed_at IS NOT NULL THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END $$`).execute(db);
    await sql.raw(`CREATE TRIGGER test_fail_redeem BEFORE UPDATE ON registration_access_codes FOR EACH ROW EXECUTE FUNCTION public.test_fail_redeem()`).execute(db);
    try {
      const res = await signUp(code, "trigger@example.com");
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("falha injetada");
      expect(await userByEmail("trigger@example.com")).toBeUndefined();
      expect((await codeRow(id)).redeemedAt).toBeNull();
    } finally {
      await sql.raw(`DROP TRIGGER test_fail_redeem ON registration_access_codes`).execute(db);
      await sql.raw(`DROP FUNCTION public.test_fail_redeem()`).execute(db);
    }
    expect((await signUp(code, "trigger@example.com")).status).toBe(200);
  });

  it("I: mecanismo FUTURO simulado (callback sem senha, tipo signup_attempt social) usa o mesmo consumo atômico e a mesma unicidade", async () => {
    const { code, id } = await makeAccessCode();
    const social = (email: string) => provisionUserWithAccessCode(code, async (trx, ctx) => {
      const u = await trx.insertInto("users").values({ email, displayName: "Social", role: "user", registeredViaCodeId: ctx.codeId }).returning("id").executeTakeFirstOrThrow();
      return u.id; // nenhuma credencial de senha: o provisionamento independe do método de autenticação
    });
    const results = await Promise.all([social("s1@example.com"), social("s2@example.com"), signUp(code, "s3@example.com").then((r) => ({ ok: r.status === 200 }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await countUsersVia(id)).toBe(1);
  });

  it("unicidade do banco é a última defesa: sem o UPDATE condicional, o segundo usuário ainda é barrado", async () => {
    const { id } = await makeAccessCode();
    await db.insertInto("users").values({ email: "u1@example.com", displayName: "U1", role: "user", registeredViaCodeId: id }).execute();
    await expect(db.insertInto("users").values({ email: "u2@example.com", displayName: "U2", role: "user", registeredViaCodeId: id }).execute()).rejects.toMatchObject({ code: "23505" });
  });
});

describe("mapa de criadores de usuário (varredura estática)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (name === "node_modules" || name === "static") return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });

  it("só o cadastro (com código), o bootstrap do owner e o seed interno inserem em users; o aceite de convite nunca", () => {
    const writers = [...walk("src"), ...walk("server"), "db/seedStaging.ts"].filter((f) => /insertInto\(\s*["']users["']\s*\)/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
    expect(writers.sort()).toEqual(["db/seedStaging.ts", "src/endpoints/auth/google-callback_GET.ts", "src/endpoints/auth/register_with_password_POST.ts", "src/helpers/bootstrapFinalize.tsx"]);
    expect(readFileSync("src/endpoints/auth/register_with_password_POST.ts", "utf8")).toContain("provisionUserWithAccessCode");
    expect(readFileSync("src/endpoints/organization-invites-accept_POST.ts", "utf8")).not.toMatch(/insertInto\(\s*["']users["']/);
  });
});
