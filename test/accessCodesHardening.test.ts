/**
 * Fase 91.1 — hardening final dos códigos de acesso antes do OIDC.
 * HTTP real (Express), alfabeto/entropia pelo desenho do gerador, normalizador, exclusão de conta, sessão/JWT e resposta pública.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import superjson from "superjson";
import { buildApp } from "../server/index";
import { db } from "../src/helpers/db";
import { handle as register } from "../src/endpoints/auth/register_with_password_POST";
import { handle as check } from "../src/endpoints/auth/access-code-check_POST";
import { handle as login } from "../src/endpoints/auth/login_with_password_POST";
import { handle as deleteAccount } from "../src/endpoints/auth/account-delete_POST";
import {
  ACCESS_CODE_ALPHABET, ACCESS_CODE_LENGTH, canonicalizeAccessCode, deriveCodeStatus, formatAccessCode, generateAccessCode, accessCodeHashes,
} from "../src/helpers/registrationCodes";
import { buildRequest, createPlatformAdmin, createSessionCookie, makeAccessCode, parseJson } from "./helpers";

const post = (path: string, body: unknown, cookie?: string) => buildRequest(path, { method: "POST", body, cookie });

describe("1. cache do código secreto (HTTP real)", () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    const app = await buildApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("a resposta que entrega o código completo tem Cache-Control: no-store; o código aparece só nela (nem na URL, nem na listagem)", async () => {
    const admin = await createPlatformAdmin();
    const res = await fetch(`${baseUrl}/_api/v1/platform-access-codes-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({ json: { label: "no-store", expiresInMinutes: 60 } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("last-modified")).toBeNull(); // (o ETag fraco do Express é inócuo: no-store proíbe guardar a cópia a revalidar)
    const body = superjson.parse<{ code: string }>(await res.text());
    expect(body.code).toMatch(/^LEV(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);

    const listed = await fetch(`${baseUrl}/_api/v1/platform-access-codes`, { headers: { Cookie: admin.cookie } });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const text = await listed.text();
    expect(text).not.toContain(canonicalizeAccessCode(body.code)!);
    expect(listed.url).not.toContain(canonicalizeAccessCode(body.code)!);
    expect(res.url).not.toContain("LEV");
  });

  it("os endpoints públicos (check e cadastro) também respondem no-store, inclusive nos erros", async () => {
    for (const path of ["access-code-check", "register_with_password"]) {
      const res = await fetch(`${baseUrl}/_api/v1/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { accessCode: "xyz", email: "a@example.com", password: "senha-valida-123", displayName: "A" } }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("o cliente nunca persiste o código: sem URL/rota/storage/histórico e sem retenção no cache do React Query (varredura estática)", () => {
    const panel = readFileSync("src/components/AccessCodesPanel.tsx", "utf8");
    const form = readFileSync("src/components/PasswordRegisterForm.tsx", "utf8");
    for (const src of [panel, form]) {
      expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|history\.(push|replace)State|useNavigate|navigate\(|useSearchParams|location\.(search|hash|href)/);
    }
    expect(panel).not.toMatch(/useQuery\([^)]*create/); // o código nunca passa por uma query cacheável
    expect(panel).toMatch(/createMutation = useMutation\(\{\s*gcTime: 0/); // resultado da mutação descartado, não retido
    const client = readFileSync("src/endpoints/platform-access-codes-create_POST.schema.ts", "utf8");
    expect(client).toContain('apiRequest<OutputType>("POST"'); // POST: nunca cacheado por navegador/intermediários
  });
});

describe("2/3/4. alfabeto, entropia e normalização", () => {
  it("o gerador sorteia diretamente de um alfabeto canônico: 32 símbolos distintos, sem I/L/O/U, e o normalizador é a IDENTIDADE sobre ele", () => {
    expect(ACCESS_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(ACCESS_CODE_ALPHABET).size).toBe(32);
    for (const ambiguous of "ILOU") expect(ACCESS_CODE_ALPHABET).not.toContain(ambiguous);
    // nenhum símbolo gerável é reescrito pela canonicalização ⇒ zero perda de entropia por convergência
    for (const c of ACCESS_CODE_ALPHABET) {
      const code = formatAccessCode(c.repeat(ACCESS_CODE_LENGTH));
      expect(canonicalizeAccessCode(code)).toBe(c.repeat(ACCESS_CODE_LENGTH));
    }
    for (let i = 0; i < 300; i++) {
      const code = generateAccessCode();
      const canonical = code.replace(/^LEV-/, "").replace(/-/g, "");
      expect(canonical).toHaveLength(20);
      expect([...canonical].every((c) => ACCESS_CODE_ALPHABET.includes(c))).toBe(true);
      expect(canonicalizeAccessCode(code)).toBe(canonical);
    }
  });

  it("entropia (pelo desenho): 20 símbolos × log2(32) = 100 bits; 256 % 32 = 0 ⇒ byte % 32 é uniforme (sem viés de módulo)", () => {
    expect(ACCESS_CODE_ALPHABET.length ** ACCESS_CODE_LENGTH).toBe(2 ** 100);
    expect(Math.log2(ACCESS_CODE_ALPHABET.length) * ACCESS_CODE_LENGTH).toBe(100);
    expect(256 % ACCESS_CODE_ALPHABET.length).toBe(0);
    const source = readFileSync("src/helpers/registrationCodes.tsx", "utf8");
    expect(source).toMatch(/randomBytes\(ACCESS_CODE_LENGTH\)/); // 1 byte de CSPRNG por símbolo, sem contador/data/id
    expect(accessCodeHashes(canonicalizeAccessCode(generateAccessCode())!)[0]).toHaveLength(32); // HMAC-SHA-256 = 32 bytes
  });

  it("I, L e 1 ⇒ mesma representação; O e 0 ⇒ mesma representação (regra INTENCIONAL do Crockford; nenhum deles é gerável)", () => {
    const base = "ABCDEFGHJKMNPQRSTVWX"; // 20 símbolos canônicos
    const one = canonicalizeAccessCode(base.slice(0, 5) + "1" + base.slice(6));
    expect(one).not.toBeNull();
    const swap = (ch: string) => canonicalizeAccessCode(base.slice(0, 5) + ch + base.slice(6));
    expect(swap("I")).toBe(one);
    expect(swap("L")).toBe(one);
    expect(swap("i")).toBe(one);
    expect(swap("l")).toBe(one);
    const zero = swap("0");
    expect(swap("O")).toBe(zero);
    expect(swap("o")).toBe(zero);
    expect(zero).not.toBe(one); // 0 e 1 continuam distintos
  });

  it("minúsculas/maiúsculas, espaços, hífens e colagem com lixo de borda são aceitos; caracteres inválidos e Unicode ⇒ null", () => {
    const code = generateAccessCode();
    const canonical = canonicalizeAccessCode(code)!;
    const variants = [
      code, code.toLowerCase(), canonical, canonical.toLowerCase(), code.replace(/-/g, " "), `  ${code}\n`, `\t${code}\r\n`, code.replace(/-/g, "--"),
      canonical.replace(/(.{4})/g, "$1 ").trim(), `lev ${canonical.toLowerCase().replace(/(.{5})/g, "$1 ")}`,
    ];
    for (const v of variants) expect(canonicalizeAccessCode(v), JSON.stringify(v)).toBe(canonical);
    const invalid = [
      "", " ", "LEV", "LEV-", canonical.slice(1), `${canonical}A`, `LEV-${canonical}A`, "U".repeat(20), canonical.slice(0, 19) + "U", canonical.slice(0, 19) + "!",
      canonical.slice(0, 19) + "_", canonical.slice(0, 10) + "–" + canonical.slice(11), // travessão (não é hífen)
      canonical.slice(0, 19) + "ı", canonical.slice(0, 19) + "ſ", canonical.slice(0, 19) + "Ｋ", canonical.slice(0, 19) + "\u0000", `${canonical}​`,
      "ＬＥＶ" + canonical,
    ];
    for (const v of invalid) expect(canonicalizeAccessCode(v), JSON.stringify(v)).toBeNull();
  });

  it("dois códigos canônicos DIFERENTES nunca viram o mesmo valor: o mapa é injetivo sobre o alfabeto, em todas as posições", () => {
    const base = generateAccessCode();
    const canonical = canonicalizeAccessCode(base)!;
    const seen = new Set<string>();
    for (let pos = 0; pos < ACCESS_CODE_LENGTH; pos++) {
      for (const sym of ACCESS_CODE_ALPHABET) {
        const mutated = canonical.slice(0, pos) + sym + canonical.slice(pos + 1);
        const out = canonicalizeAccessCode(mutated)!;
        expect(out).toBe(mutated); // identidade
        seen.add(out);
      }
    }
    // 20 posições × 32 símbolos, com o original contado uma vez por posição: 20*31 + 1 valores distintos
    expect(seen.size).toBe(ACCESS_CODE_LENGTH * (ACCESS_CODE_ALPHABET.length - 1) + 1);
  });
});

describe("5. exclusão de conta nunca libera o código", () => {
  it("código consumido → conta excluída/anonimizada ⇒ continua REDIMIDO, não valida, não cadastra, e o usuário não pode ser apagado do banco", async () => {
    const { code, id } = await makeAccessCode();
    const email = "vai-excluir@example.com";
    expect((await register(post("auth/register_with_password", { email, password: "senha-valida-123", displayName: "Vai Excluir", accessCode: code }))).status).toBe(200);
    const user = await db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirstOrThrow();
    expect(user.registeredViaCodeId).toBe(id);

    const cookie = await createSessionCookie(user.id);
    const del = await deleteAccount(post("auth/account-delete", { password: "senha-valida-123" }, cookie));
    expect(del.status).toBe(200);
    const anonymized = await db.selectFrom("users").selectAll().where("id", "=", user.id).executeTakeFirstOrThrow();
    expect(anonymized.anonymizedAt).not.toBeNull();
    expect(anonymized.email).not.toBe(email);

    const row = await db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.redeemedAt).not.toBeNull();
    expect(row.redeemedByUserId).toBe(user.id);
    expect(deriveCodeStatus(row)).toBe("redeemed");
    expect(anonymized.registeredViaCodeId).toBe(id); // o vínculo (e a UNIQUE) sobrevivem à anonimização

    expect((await check(post("auth/access-code-check", { accessCode: code }))).status).toBe(400);
    expect((await register(post("auth/register_with_password", { email: "reuso@example.com", password: "senha-valida-123", displayName: "Reuso", accessCode: code }))).status).toBe(400);
    expect(await db.selectFrom("users").select("id").where("email", "=", "reuso@example.com").execute()).toHaveLength(0);
    // nem mesmo um DELETE direto consegue apagar o consumidor (FK do código): não existe caminho que "devolva" o código
    await expect(db.deleteFrom("users").where("id", "=", user.id).execute()).rejects.toThrow();
    // e o próprio código não pode ser reativado limpando o resgate (par redeemed_at/redeemed_by é CHECK; o UNIQUE do usuário permanece)
    await expect(db.updateTable("registrationAccessCodes").set({ redeemedAt: null }).where("id", "=", id).execute()).rejects.toThrow();
  });
});

describe("6. o código não vira sessão, JWT, claim, credencial nem método de login", () => {
  it("login após o cadastro: JWT só com {id, createdAt, lastAccessed}; corpo do login sem código; sessão e credencial sem referência ao código", async () => {
    const { code, id } = await makeAccessCode();
    const email = "sessao@example.com";
    expect((await register(post("auth/register_with_password", { email, password: "senha-valida-123", displayName: "Sessão", accessCode: code }))).status).toBe(200);
    const user = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirstOrThrow();

    const res = await login(post("auth/login_with_password", { email, password: "senha-valida-123" }));
    expect(res.status).toBe(200);
    const token = res.headers.get("Set-Cookie")!.split(";")[0].split("=").slice(1).join("=");
    const claims = decodeJwt(token);
    expect(Object.keys(claims).filter((k) => !["iat", "exp", "nbf"].includes(k)).sort()).toEqual(["createdAt", "id", "lastAccessed"]);
    const body = await res.text();
    expect(body).not.toContain(canonicalizeAccessCode(code)!);
    expect(body).not.toMatch(/registeredViaCode|accessCode|registered_via_code|codigo_acesso/i);

    // nada no schema de sessão/credencial guarda ou referencia o código
    const columns = await db
      .selectFrom("information_schema.columns" as never)
      .select(["table_name", "column_name"] as never[])
      .where("table_schema" as never, "=", "public" as never)
      .where("table_name" as never, "in", ["sessions", "user_passwords", "mfa_methods", "auth_challenges"] as never)
      .execute();
    expect(JSON.stringify(columns)).not.toMatch(/code_id|access_code|registration/);

    // o código não é credencial: nem como senha, nem como "senha" de outro e-mail
    expect((await login(post("auth/login_with_password", { email, password: code }))).status).toBe(401);
    expect((await login(post("auth/login_with_password", { email, password: canonicalizeAccessCode(code)! }))).status).toBe(401);
    const payload = readFileSync("src/helpers/authResponses.tsx", "utf8");
    expect(payload).not.toMatch(/registeredViaCode|accessCode/);
    expect(readFileSync("src/helpers/User.tsx", "utf8")).not.toMatch(/registeredViaCode|accessCode/);
  });
});

describe("7. access-code-check — resposta pública mínima e uniforme", () => {
  it("válido: exatamente {valid:true}; inválidos: corpo idêntico; nenhum dado administrativo (criador, consumidor, hash, datas, organização, descrição)", async () => {
    const creatorLabel = "SEGREDO-ADMIN-LABEL";
    const active = await makeAccessCode({ label: creatorLabel });
    const redeemed = await makeAccessCode({ state: "redeemed", label: creatorLabel });
    const expired = await makeAccessCode({ state: "expired", label: creatorLabel });
    const revoked = await makeAccessCode({ state: "revoked", label: creatorLabel });

    const ok = await check(post("auth/access-code-check", { accessCode: active.code }));
    expect(ok.status).toBe(200);
    expect(await parseJson(ok.clone())).toEqual({ valid: true });
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("set-cookie")).toBeNull();

    const bodies = new Set<string>();
    for (const c of [redeemed, expired, revoked, { code: "LEV-0000-0000-0000-0000-0000" }, { code: "lixo" }]) {
      const res = await check(post("auth/access-code-check", { accessCode: c.code }));
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    const only = [...bodies][0];
    for (const forbidden of [creatorLabel, "Criador", "criador-de-codigos", "@example.com", "hash", "expires", "createdAt", "organiza", "redeemed", "revoked", "20"]) {
      expect(only.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(Object.keys(await parseJson<Record<string, unknown>>(new Response(only)))).toEqual(["message", "code"]);
  });

  it("o rate limit (20 por 15 min por IP) é checado ANTES de qualquer consulta ao banco e responde 429 com Retry-After", async () => {
    const source = readFileSync("src/endpoints/auth/access-code-check_POST.ts", "utf8");
    expect(source.indexOf("checkRateLimit")).toBeGreaterThan(-1);
    expect(source.indexOf("checkRateLimit")).toBeLessThan(source.indexOf("checkAccessCode("));
    const ip = "ip-91-1-rate";
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) last = await check(buildRequest("auth/access-code-check", { method: "POST", ip, body: { accessCode: "xyz" } }));
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).not.toBeNull();
  });
});
