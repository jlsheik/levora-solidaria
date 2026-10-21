/**
 * Harness SINTÉTICO da Microsoft para testes server-side (Fase 93). NÃO é a Microsoft: gera pares RSA na hora, serve Discovery/JWKS/token
 * endpoint por um transporte injetado em `microsoftOidc` e assina ID tokens de teste no FORMATO documentado (iss por tenant, ver 2.0, tid, oid).
 * Serve para provar a NOSSA validação e a máquina de estados — nunca para afirmar que a Microsoft real funciona.
 */
import { SignJWT } from "jose";
import { randomBytes, createHash } from "node:crypto";
import { __setMicrosoftTransportForTests, MICROSOFT_PERSONAL_TENANT_ID } from "../src/helpers/microsoftOidc";
import { handle as startHandler } from "../src/endpoints/auth/microsoft-start_POST";
import { handle as callbackHandler } from "../src/endpoints/auth/microsoft-callback_GET";
import { buildRequest, createSessionCookie, makeAccessCode } from "./helpers";
import { db } from "../src/helpers/db";
import { microsoftIssuerFor } from "../src/helpers/microsoftOidc";
import { IP, makeKey, type CallbackOptions, type Flow, type SigningKey } from "./googleHarness";

export { IP, location, sessionCookieOf, challengeCookieOf, sessionPair } from "./googleHarness";

export const CLIENT_ID = "6f1f3a52-0d3c-4b9a-9d1e-0a1b2c3d4e5f"; // GUID sintético de teste (não é um aplicativo real)
export const REDIRECT_URI = "http://localhost:5173/_api/v1/auth/microsoft-callback";
export const CORP_TID = "72f988bf-86f1-41af-91ab-2d7cd011db47"; // tenant corporativo SINTÉTICO de teste
export const OTHER_CORP_TID = "5a3b9c1e-7d2f-4e8a-b6c4-1f0e9d8c7b6a";
export const PERSONAL_TID = MICROSOFT_PERSONAL_TENANT_ID;
const HOST = "https://login.microsoftonline.com";

/** GUID determinístico a partir de (tid, sub): o mesmo usuário tem sempre o mesmo `oid`. */
function stableOid(tid: string, sub: string) {
  const h = createHash("sha256").update(`${tid}:${sub}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function configureMicrosoftEnv(tenant?: string) {
  process.env.MICROSOFT_CLIENT_ID = CLIENT_ID;
  process.env.MICROSOFT_CLIENT_SECRET = "segredo-sintetico-de-teste";
  process.env.MICROSOFT_REDIRECT_URI = REDIRECT_URI;
  if (tenant) process.env.MICROSOFT_TENANT = tenant;
  else delete process.env.MICROSOFT_TENANT;
}

/** Chave publicada no JWKS no formato da Microsoft: `issuer` (modelo `{tenantid}` ou o tenant pessoal) e `cloud_instance_name`. */
export interface MsKey extends SigningKey {
  issuerTag?: string;
  cloud?: string;
}

export async function makeMsKey(kid: string, kind: "aad" | "msa" | "untagged" = "aad", cloud = "microsoftonline.com"): Promise<MsKey> {
  const base = await makeKey(kid);
  if (kind === "untagged") return base;
  const issuerTag = kind === "msa" ? `${HOST}/${PERSONAL_TID}/v2.0` : `${HOST}/{tenantid}/v2.0`;
  return { ...base, issuerTag, cloud, jwk: { ...base.jwk, issuer: issuerTag, cloud_instance_name: cloud } };
}

/** Chave com o campo `issuer` do JWKS controlado pelo teste (ausente = undefined; também valores malformados). */
export async function makeMsKeyWithIssuer(kid: string, issuer: unknown): Promise<MsKey> {
  const base = await makeKey(kid);
  const jwk: Record<string, unknown> = { ...base.jwk, cloud_instance_name: "microsoftonline.com" };
  if (issuer !== undefined) jwk.issuer = issuer;
  return { ...base, jwk: jwk as MsKey["jwk"] };
}

export interface MsClaims {
  sub?: string | null;
  email?: string | null;
  name?: string | null;
  preferred_username?: string | null;
  nonce?: string | null;
  iss?: string | null;
  aud?: string | string[] | null;
  azp?: string | null;
  tid?: string | null;
  oid?: string | null;
  ver?: string | null;
  idp?: string | null;
  exp?: number;
  iat?: number;
  nbf?: number;
}

export interface MicrosoftSim {
  published: MsKey[];
  signingKey: MsKey;
  tokenRequests: URLSearchParams[];
  fetchCount: { discovery: number; jwks: number; token: number };
  /** simula falha TEMPORÁRIA do endpoint de chaves */
  failJwks: boolean;
  sign(claims: MsClaims, key?: MsKey): Promise<string>;
  rotate(newKey: MsKey): void;
  grants: Map<string, (form: URLSearchParams) => Promise<{ id_token?: string; status?: number }>>;
  uninstall(): void;
}

/** Tokens de TESTE no formato da Microsoft v2.0: `tid` e `iss` coerentes por padrão; cada teste adultera só o que quer provar. */
export async function installMicrosoft(opts: { tenant?: string; key?: MsKey } = {}): Promise<MicrosoftSim> {
  configureMicrosoftEnv(opts.tenant);
  const key = opts.key ?? (await makeMsKey("ms-kid-1", "aad"));
  const sim: MicrosoftSim = {
    published: [key],
    signingKey: key,
    tokenRequests: [],
    fetchCount: { discovery: 0, jwks: 0, token: 0 },
    failJwks: false,
    grants: new Map(),
    async sign(claims, signWith = sim.signingKey) {
      const now = Math.floor(Date.now() / 1000);
      const tid = claims.tid === undefined ? CORP_TID : claims.tid;
      const payload: Record<string, unknown> = {
        iss: tid ? `${HOST}/${tid}/v2.0` : `${HOST}/${CORP_TID}/v2.0`,
        aud: CLIENT_ID,
        iat: now,
        nbf: now,
        exp: now + 3600,
        ver: "2.0",
        oid: stableOid(tid ?? CORP_TID, claims.sub ?? "sem-sub"), // o oid é estável por usuário (como na Microsoft), nunca aleatório por token
        ...claims,
        tid,
      };
      for (const k of Object.keys(payload)) if (payload[k] === null || payload[k] === undefined) delete payload[k];
      return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: signWith.kid, typ: "JWT" }).sign(signWith.privateKey);
    },
    rotate(newKey) {
      sim.published = [newKey];
      sim.signingKey = newKey;
    },
    uninstall() {
      __setMicrosoftTransportForTests(null);
    },
  };
  __setMicrosoftTransportForTests(async (url, init) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/([^/]+)\/(.*)$/);
    const tenant = m?.[1] ?? "";
    const rest = m?.[2] ?? "";
    if (u.origin !== HOST || !m) return new Response("not found", { status: 404 });
    if (rest === "v2.0/.well-known/openid-configuration") {
      sim.fetchCount.discovery++;
      const issuer = tenant === "common" || tenant === "organizations" ? `${HOST}/{tenantid}/v2.0` : `${HOST}/${tenant === "consumers" ? PERSONAL_TID : tenant}/v2.0`;
      return Response.json({
        issuer,
        authorization_endpoint: `${HOST}/${tenant}/oauth2/v2.0/authorize`,
        token_endpoint: `${HOST}/${tenant}/oauth2/v2.0/token`,
        jwks_uri: `${HOST}/${tenant}/discovery/v2.0/keys`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (rest === "discovery/v2.0/keys") {
      sim.fetchCount.jwks++;
      if (sim.failJwks) return new Response("unavailable", { status: 503 });
      return Response.json({ keys: sim.published.map((k) => k.jwk) });
    }
    if (rest === "oauth2/v2.0/token") {
      sim.fetchCount.token++;
      const form = new URLSearchParams(String(init?.body));
      sim.tokenRequests.push(form);
      const grant = sim.grants.get(form.get("code") ?? "");
      sim.grants.delete(form.get("code") ?? ""); // o code é de USO ÚNICO
      if (!grant) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      const out = await grant(form);
      if (out.status && out.status !== 200) return new Response(JSON.stringify({ error: "x" }), { status: out.status });
      // a Microsoft devolve também access_token (e refresh_token se offline_access); o servidor deve DESCARTÁ-LOS
      return Response.json({ token_type: "Bearer", scope: "openid profile email", expires_in: 3599, access_token: "EwB-token-de-acesso-sintetico", id_token: out.id_token });
    }
    return new Response("not found", { status: 404 });
  });
  return sim;
}

// ---- o "navegador" -------------------------------------------------------------------------------------------------------------

export async function startFlow(intent: "login" | "signup" | "reauth", accessCode?: string, ip: string = IP(), sessionCookie?: string): Promise<Flow> {
  const res = await startHandler(buildRequest("auth/microsoft-start", { method: "POST", ip, cookie: sessionCookie, body: { intent, ...(accessCode ? { accessCode } : {}) } }));
  if (res.status !== 200) throw new Error(`start falhou: ${res.status}`);
  const { json } = (await res.json()) as { json: { authorizationUrl: string } };
  const url = new URL(json.authorizationUrl);
  const binding = res.headers.getSetCookie().find((c) => c.startsWith("levora_oauth="))!.split(";")[0];
  return { state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, codeChallenge: url.searchParams.get("code_challenge")!, binding, authorizationUrl: url };
}

/** O usuário "autoriza" na Microsoft: passa a existir um `code` que devolve um ID token com o nonce DESTA tentativa. */
export function approve(sim: MicrosoftSim, flow: Flow, claims: MsClaims, opts: { tamper?: (claims: MsClaims) => MsClaims; signWith?: MsKey; checkPkce?: boolean } = {}): string {
  const code = `mscode-${randomBytes(12).toString("hex")}`;
  sim.grants.set(code, async (form) => {
    if (opts.checkPkce !== false) {
      const expected = createHash("sha256").update(form.get("code_verifier") ?? "", "ascii").digest("base64url");
      if (expected !== flow.codeChallenge) return { status: 400 }; // PKCE: a Microsoft recusaria um verifier que não casa
    }
    if (form.get("redirect_uri") !== REDIRECT_URI || form.get("client_id") !== CLIENT_ID || form.get("grant_type") !== "authorization_code") return { status: 400 };
    const base: MsClaims = { nonce: flow.nonce, ...claims };
    return { id_token: await sim.sign(opts.tamper ? opts.tamper(base) : base, opts.signWith) };
  });
  return code;
}

export async function callback(flow: Flow, code: string | undefined, opts: CallbackOptions = {}) {
  const qs = new URLSearchParams();
  qs.set("state", opts.state ?? flow.state);
  if (opts.error) qs.set("error", opts.error);
  const c = opts.code ?? code;
  if (c) qs.set("code", c);
  return callbackHandler(buildRequest(`auth/microsoft-callback?${qs}`, { method: "GET", ip: opts.ip ?? IP(), cookie: opts.cookie === null ? undefined : (opts.cookie ?? flow.binding) }));
}

/** Reautenticação: usuário JÁ logado confirma a identidade na Microsoft. O cookie de sessão e o de vínculo seguem juntos. */
export async function reauthWithMicrosoft(sim: MicrosoftSim, sessionCookie: string, claims: MsClaims, opts: { ip?: string } = {}) {
  const flow = await startFlow("reauth", undefined, opts.ip, sessionCookie);
  const code = approve(sim, flow, claims);
  const res = await callback(flow, code, { cookie: `${sessionCookie}; ${flow.binding}` });
  const pair = res.headers.getSetCookie().find((c) => c.startsWith("floot_built_app_session="))?.split(";")[0];
  return { flow, code, res, cookie: pair };
}

/**
 * Estado PÓS-CADASTRO de uma conta Microsoft-only (usuário sem senha, código de acesso resgatado, identidade vinculada, sessão aberta com a Microsoft), criado direto no
 * banco. O NOVO cadastro Microsoft está desabilitado por política (decisão C: a Microsoft não comprova a posse do e-mail), então os testes de ciclo de vida, reautenticação
 * e exclusão partem deste estado em vez do fluxo de cadastro. O que o cadastro recusa é provado em microsoftAuth.test.ts.
 */
export async function seedMicrosoftOnlyAccount(claims: MsClaims, opts: { tid?: string } = {}): Promise<{ userId: number; cookie: string }> {
  const { id: codeId } = await makeAccessCode();
  const tid = opts.tid ?? claims.tid ?? CORP_TID;
  const sub = claims.sub ?? "sem-sub";
  const email = (claims.email ?? `${sub}@contoso.com`).toLowerCase();
  const user = await db.insertInto("users").values({ email, displayName: claims.name ?? email, role: "user", registeredViaCodeId: codeId }).returning("id").executeTakeFirstOrThrow();
  await db.updateTable("registrationAccessCodes").set({ redeemedAt: new Date(), redeemedByUserId: user.id }).where("id", "=", codeId).execute();
  await db
    .insertInto("userIdentities")
    .values({ userId: user.id, provider: "microsoft", issuer: microsoftIssuerFor(tid), subject: sub, emailSnapshot: email, emailVerified: false, providerMetadata: { tid, ver: "2.0", oid: stableOid(tid, sub) } })
    .execute();
  const cookie = await createSessionCookie(user.id);
  await db.updateTable("sessions").set({ primaryMethod: "microsoft" }).where("userId", "=", user.id).execute();
  return { userId: user.id, cookie };
}
