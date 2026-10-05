/**
 * Harness SINTÉTICO do Google para testes server-side (Fase 92). NÃO é o Google: gera um par de chaves RSA na hora, serve
 * Discovery/JWKS/token endpoint por um transporte injetado em `googleOidc` e assina ID tokens de teste. Serve para provar a NOSSA
 * validação (assinatura, iss, aud, exp, iat, nonce, sub), o PKCE e a máquina de estados — nunca para afirmar que o Google real funciona.
 */
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { randomBytes, createHash } from "node:crypto";
import { __setGoogleTransportForTests, GOOGLE_DISCOVERY_URL } from "../src/helpers/googleOidc";
import { handle as startHandler } from "../src/endpoints/auth/google-start_POST";
import { handle as callbackHandler } from "../src/endpoints/auth/google-callback_GET";
import { buildRequest } from "./helpers";

export const CLIENT_ID = "levora-test-client.apps.googleusercontent.com";
export const REDIRECT_URI = "http://localhost:5173/_api/v1/auth/google-callback";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";

export function configureGoogleEnv() {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "segredo-sintetico-de-teste";
  process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

export async function makeKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { kid, privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export interface TokenClaims {
  sub?: string | null;
  email?: string | null;
  email_verified?: boolean | string;
  name?: string;
  nonce?: string | null;
  iss?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
}

export interface GoogleSim {
  /** chaves publicadas no JWKS */
  published: SigningKey[];
  signingKey: SigningKey;
  /** pedidos recebidos no token endpoint (para provar o que o servidor envia ao Google) */
  tokenRequests: URLSearchParams[];
  fetchCount: { discovery: number; jwks: number; token: number };
  sign(claims: TokenClaims, key?: SigningKey): Promise<string>;
  /** Substitui as chaves publicadas (rotação do JWKS). */
  rotate(newKey: SigningKey): void;
  /** `code` do Google → resposta do token endpoint. */
  grants: Map<string, (form: URLSearchParams) => Promise<{ id_token?: string; status?: number }>>;
  uninstall(): void;
}

export async function installGoogle(): Promise<GoogleSim> {
  configureGoogleEnv();
  const key = await makeKey("kid-1");
  const sim: GoogleSim = {
    published: [key],
    signingKey: key,
    tokenRequests: [],
    fetchCount: { discovery: 0, jwks: 0, token: 0 },
    grants: new Map(),
    async sign(claims, signWith = sim.signingKey) {
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: "https://accounts.google.com",
        aud: CLIENT_ID,
        iat: now,
        exp: now + 600,
        ...claims,
      };
      for (const k of Object.keys(payload)) if (payload[k] === null || payload[k] === undefined) delete payload[k];
      return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: signWith.kid }).sign(signWith.privateKey);
    },
    rotate(newKey) {
      sim.published = [newKey];
      sim.signingKey = newKey;
    },
    uninstall() {
      __setGoogleTransportForTests(null);
    },
  };
  __setGoogleTransportForTests(async (url, init) => {
    if (url === GOOGLE_DISCOVERY_URL) {
      sim.fetchCount.discovery++;
      return Response.json({ issuer: "https://accounts.google.com", authorization_endpoint: AUTH_URI, token_endpoint: TOKEN_URI, jwks_uri: JWKS_URI });
    }
    if (url === JWKS_URI) {
      sim.fetchCount.jwks++;
      return Response.json({ keys: sim.published.map((k) => k.jwk) });
    }
    if (url === TOKEN_URI) {
      sim.fetchCount.token++;
      const form = new URLSearchParams(String(init?.body));
      sim.tokenRequests.push(form);
      const grant = sim.grants.get(form.get("code") ?? "");
      sim.grants.delete(form.get("code") ?? ""); // o code do Google é de USO ÚNICO
      if (!grant) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      const out = await grant(form);
      if (out.status && out.status !== 200) return new Response(JSON.stringify({ error: "x" }), { status: out.status });
      // o Google devolve também access_token; o servidor deve DESCARTÁ-LO
      return Response.json({ access_token: "ya29.token-de-acesso-sintetico", token_type: "Bearer", expires_in: 3599, id_token: out.id_token });
    }
    return new Response("not found", { status: 404 });
  });
  return sim;
}

// ---- o "navegador" -------------------------------------------------------------------------------------------------------------

export interface Flow {
  state: string;
  nonce: string;
  codeChallenge: string;
  /** cookie de vínculo, no formato "nome=valor" */
  binding: string;
  authorizationUrl: URL;
}

export const IP = () => `test-ip-${Math.random().toString(36).slice(2)}`;

export async function startFlow(intent: "login" | "signup", accessCode?: string, ip: string = IP()): Promise<Flow> {
  const res = await startHandler(buildRequest("auth/google-start", { method: "POST", ip, body: { intent, ...(accessCode ? { accessCode } : {}) } }));
  if (res.status !== 200) throw new Error(`start falhou: ${res.status}`);
  const { json } = (await res.json()) as { json: { authorizationUrl: string } };
  const url = new URL(json.authorizationUrl);
  const binding = res.headers.getSetCookie().find((c) => c.startsWith("levora_oauth="))!.split(";")[0];
  return { state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, codeChallenge: url.searchParams.get("code_challenge")!, binding, authorizationUrl: url };
}

/** O usuário "autoriza" no Google: o Google passa a aceitar um `code` que devolve um ID token com o nonce DESTA tentativa. */
export function approve(sim: GoogleSim, flow: Flow, claims: TokenClaims, opts: { tamper?: (claims: TokenClaims) => TokenClaims; signWith?: SigningKey; checkPkce?: boolean } = {}): string {
  const code = `gcode-${randomBytes(12).toString("hex")}`;
  sim.grants.set(code, async (form) => {
    if (opts.checkPkce !== false) {
      const expected = createHash("sha256").update(form.get("code_verifier") ?? "", "ascii").digest("base64url");
      if (expected !== flow.codeChallenge) return { status: 400 }; // PKCE: o Google recusaria um verifier que não casa
    }
    if (form.get("redirect_uri") !== REDIRECT_URI || form.get("client_id") !== CLIENT_ID || form.get("grant_type") !== "authorization_code") return { status: 400 };
    const base: TokenClaims = { nonce: flow.nonce, ...claims };
    return { id_token: await sim.sign(opts.tamper ? opts.tamper(base) : base, opts.signWith) };
  });
  return code;
}

export interface CallbackOptions {
  state?: string;
  code?: string;
  error?: string;
  cookie?: string | null;
  ip?: string;
}

export async function callback(flow: Flow, code: string | undefined, opts: CallbackOptions = {}) {
  const qs = new URLSearchParams();
  qs.set("state", opts.state ?? flow.state);
  if (opts.error) qs.set("error", opts.error);
  const c = opts.code ?? code;
  if (c) qs.set("code", c);
  return callbackHandler(buildRequest(`auth/google-callback?${qs}`, { method: "GET", ip: opts.ip ?? IP(), cookie: opts.cookie === null ? undefined : (opts.cookie ?? flow.binding) }));
}

export const location = (res: Response) => res.headers.get("location") ?? "";
export const sessionCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("floot_built_app_session="));
export const challengeCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("levora_challenge="));
