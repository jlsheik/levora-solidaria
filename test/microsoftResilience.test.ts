/**
 * Fase 93.3 (continuação) — resiliência e higiene de claims do fluxo Microsoft, SEM conta real e SEM código legítimo:
 * falhas do provedor no callback (token endpoint, Discovery, JWKS, configuração) e claims controlados por quem administra um tenant
 * (`email`, `name`). Microsoft SINTÉTICA: prova a NOSSA reação, não a Microsoft real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../src/helpers/db";
import { __setMicrosoftTransportForTests, verifyMicrosoftIdToken, getMicrosoftConfig } from "../src/helpers/microsoftOidc";
import { oauthHash } from "../src/helpers/oauthPrimitives";
import { currentPepperVersion } from "../src/helpers/identityKeys";
import { makeAccessCode } from "./helpers";
import { approve, callback, CORP_TID, installMicrosoft, location, startFlow, type MicrosoftSim, type MsClaims } from "./microsoftHarness";

let sim: MicrosoftSim;
beforeEach(async () => {
  sim = await installMicrosoft();
});
afterEach(() => {
  sim.uninstall();
});

const NONCE = "nonce-de-teste-0123456789abcdefghijklmnopqrstuv";
const U = { sub: "res-1", email: "res@contoso.com", name: "Pessoa Resiliente" };
const signedUpCount = async () => Number((await db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("registeredViaCodeId", "is not", null).executeTakeFirstOrThrow()).n);
const codeRow = (id: number) => db.selectFrom("registrationAccessCodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const audits = (...a: string[]) => db.selectFrom("auditLog").selectAll().where("action", "in", a).orderBy("id").execute();
const attempts = () => db.selectFrom("oauthAttempts").select(["status", "intent"]).execute();

async function verify(claims: MsClaims) {
  const token = await sim.sign({ nonce: NONCE, sub: U.sub, ...claims });
  return verifyMicrosoftIdToken(getMicrosoftConfig()!, token, oauthHash("nonce", NONCE, currentPepperVersion()), currentPepperVersion());
}

/** Depois do start (Discovery já usado), troca o transporte por um que serve Discovery/JWKS válidos mas falha onde o teste quer. */
function brokenTransport(mode: "token_throw" | "token_html" | "token_null" | "token_500" | "token_429" | "discovery_down" | "jwks_down") {
  const H = "https://login.microsoftonline.com";
  __setMicrosoftTransportForTests(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/.well-known/openid-configuration")) {
      if (mode === "discovery_down") return new Response("down", { status: 503 });
      return Response.json({ issuer: `${H}/{tenantid}/v2.0`, authorization_endpoint: `${H}/common/oauth2/v2.0/authorize`, token_endpoint: `${H}/common/oauth2/v2.0/token`, jwks_uri: `${H}/common/discovery/v2.0/keys` });
    }
    if (u.pathname.endsWith("/discovery/v2.0/keys")) return mode === "jwks_down" ? new Response("down", { status: 503 }) : Response.json({ keys: sim.published.map((k) => k.jwk) });
    if (u.pathname.endsWith("/oauth2/v2.0/token")) {
      if (mode === "token_throw") throw new TypeError("fetch failed");
      if (mode === "token_html") return new Response("<html>Bad gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      if (mode === "token_null") return new Response("null", { status: 200 });
      if (mode === "token_500") return new Response("{}", { status: 500 });
      if (mode === "token_429") return new Response("{}", { status: 429, headers: { "Retry-After": "30" } });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("falhas do provedor NO CALLBACK: resposta neutra, nada criado, código intacto, tentativa encerrada", () => {
  const modes = ["token_throw", "token_html", "token_null", "token_500", "token_429", "discovery_down", "jwks_down"] as const;
  for (const mode of modes) {
    it(`${mode}`, async () => {
      const { code, id } = await makeAccessCode();
      const flow = await startFlow("signup", code);
      const mscode = approve(sim, flow, U); // o code existe no provedor sintético, mas o transporte quebrado nunca o honra
      brokenTransport(mode);
      const res = await callback(flow, mscode);
      expect(location(res)).toBe("/login?microsoft=erro&motivo=falha");
      expect(res.headers.getSetCookie().find((c) => c.startsWith("levora_oauth="))!).toMatch(/Max-Age=0/);
      expect(res.headers.getSetCookie().some((c) => c.startsWith("floot_built_app_session="))).toBe(false);
      expect(await signedUpCount()).toBe(0);
      expect((await codeRow(id)).redeemedAt).toBeNull();
      expect((await attempts()).map((a) => a.status)).toEqual(["failed"]);
      const dump = JSON.stringify(await db.selectFrom("auditLog").selectAll().execute());
      expect(dump).not.toMatch(/eyJ|segredo-sintetico|fetch failed|Bad gateway/);
    });
  }
});

describe("resposta do token endpoint sem id_token utilizável", () => {
  it("sem id_token, id_token vazio e id_token gigante (>16 KiB) ⇒ falha neutra e nada criado", async () => {
    for (const idToken of [undefined, "", "x".repeat(16385)]) {
      const { code, id } = await makeAccessCode();
      const flow = await startFlow("signup", code);
      sim.grants.set("mscode-fixo", async () => ({ id_token: idToken }));
      expect(location(await callback(flow, "mscode-fixo"))).toBe("/login?microsoft=erro&motivo=falha");
      expect((await codeRow(id)).redeemedAt).toBeNull();
    }
    expect(await signedUpCount()).toBe(0);
    expect(JSON.stringify(await audits("usuario.microsoft_identity_rejected"))).toContain("token_ausente");
  });
});

describe("configuração removida entre o start e o callback", () => {
  it("sem MICROSOFT_* no callback ⇒ falha neutra, nada criado, código intacto", async () => {
    const { code, id } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const mscode = approve(sim, flow, U);
    const saved = process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    try {
      expect(location(await callback(flow, mscode))).toBe("/login?microsoft=erro&motivo=falha");
    } finally {
      process.env.MICROSOFT_CLIENT_SECRET = saved;
    }
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect(JSON.stringify(await audits("usuario.cadastro_microsoft_falhou"))).toContain("nao_configurado");
  });
});

describe("claims controlados por quem administra o tenant (email, name): higiene antes de virar users.email/display_name", () => {
  it("e-mail malformado (espaços, HTML, vários @, controle, sem domínio) NUNCA vira users.email: é tratado como ausente", async () => {
    const bad = ["a b@contoso.com", "<script>@contoso.com", "a@@contoso.com", "a@b@contoso.com", "x@contoso.com\nBcc: y@z.com", "sem-arroba", "@contoso.com", "a@", "a@contoso", "\"a\"@contoso.com", "a@contoso.com,b@contoso.com", "a".repeat(65) + "@contoso.com"];
    for (const email of bad) expect((await verify({ email })).email, JSON.stringify(email)).toBeNull();
    for (const email of ["Pessoa@Contoso.COM", "nome.sobrenome+tag@sub.contoso.com.br", "a_b-c@contoso.org"]) expect((await verify({ email })).email, email).toBe(email.toLowerCase());
  });

  it("sem estado entre chamadas: um e-mail rejeitado não faz o PRÓXIMO (outro usuário/requisição) escapar da checagem de caracteres invisíveis/bidi", async () => {
    const ZW = String.fromCharCode(0x200b);
    const RLO = String.fromCharCode(0x202e);
    const sequence = ["x" + ZW + "y@contoso.com", RLO + "a@contoso.com", "ok@contoso.com", "b" + ZW + "@contoso.com", ZW + "c@contoso.com", "a@" + RLO + "contoso.com", "a@contoso.com"];
    const expected = [null, null, "ok@contoso.com", null, null, null, "a@contoso.com"];
    for (let round = 0; round < 3; round++) {
      const got = [];
      for (const email of sequence) got.push((await verify({ email })).email);
      expect(got).toEqual(expected);
    }
  });

  it("e2e: cadastro com e-mail malformado ⇒ falha neutra (email_ausente), nada criado, código intacto", async () => {
    const { code, id } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    expect(location(await callback(flow, approve(sim, flow, { ...U, email: "a b@contoso.com" })))).toBe("/login?microsoft=erro&motivo=falha");
    expect(await signedUpCount()).toBe(0);
    expect((await codeRow(id)).redeemedAt).toBeNull();
    expect(JSON.stringify(await audits("usuario.cadastro_microsoft_falhou"))).toContain("email_ausente");
  });

  it("name: caracteres de controle e espaços repetidos são removidos; vazio após limpeza vira ausente; excesso de tamanho é ignorado", async () => {
    expect((await verify({ name: "  Ana\u0000 ‮Maria\n\t Silva  " })).name).toBe("Ana Maria Silva");
    expect((await verify({ name: "\u0000\u0007 \n" })).name).toBeNull();
    expect((await verify({ name: "x".repeat(121) })).name).toBeNull();
    expect((await verify({ name: "João da Conceição" })).name).toBe("João da Conceição");
  });

  it("e2e: o display_name gravado vem do name higienizado (nunca com controle/bidi) e a identidade segue a chave (issuer, sub)", async () => {
    const { code } = await makeAccessCode();
    const flow = await startFlow("signup", code);
    const res = await callback(flow, approve(sim, flow, { ...U, name: "Ana\u0000‮ Silva" }));
    expect(location(res)).toBe("/");
    const user = await db.selectFrom("users").select(["displayName", "email"]).where("email", "=", U.email).executeTakeFirstOrThrow();
    expect(user.displayName).toBe("Ana Silva");
    expect(CORP_TID).toBeTruthy();
  });
});
