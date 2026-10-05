import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, errors as joseErrors, type JSONWebKeySet } from "jose";
import { hmacSecret } from "./identityKeys.js";

/**
 * Google OIDC (Fase 92) — Authorization Code Flow + PKCE (S256), SOMENTE identidade (scopes openid email profile).
 * O backend é a autoridade: troca o `code` no back-channel e valida o ID token LOCALMENTE (assinatura RS256 pelo JWKS do Discovery,
 * iss, aud, azp, exp, iat, nonce, sub). Nunca usa `tokeninfo`. Nenhum token do Google é guardado: o `access_token` devolvido pela
 * troca é descartado e `id_token` só vive nesta chamada. Nada aqui é lido do cliente: configuração vem do ambiente.
 */

export const GOOGLE_ISSUER = "https://accounts.google.com";
/** O Google emite `iss` com e sem esquema; ambos são o MESMO emissor, e a identidade guarda a forma canônica. */
const ACCEPTED_ISSUERS = [GOOGLE_ISSUER, "accounts.google.com"];
export const GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
const SCOPES = "openid email profile";
const CLOCK_TOLERANCE_SECONDS = 60;
const HTTP_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 60 * 1000;

export type GoogleFailure =
  | "nao_configurado"
  | "discovery_invalido"
  | "troca_codigo_falhou"
  | "token_ausente"
  | "token_malformado"
  | "assinatura_invalida"
  | "issuer_invalido"
  | "audience_invalida"
  | "azp_invalido"
  | "expirado"
  | "iat_invalido"
  | "nonce_invalido"
  | "subject_ausente"
  | "chave_desconhecida";

/** Erro tipado: o `motivo` é uma constante curta e segura (auditoria/logs) — nunca contém token, código ou segredo. */
export class GoogleOidcError extends Error {
  constructor(readonly motivo: GoogleFailure) {
    super(motivo);
    this.name = "GoogleOidcError";
  }
}

// ---- configuração (somente ambiente) -------------------------------------------------------------------------------------

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  discoveryUrl: string;
}

/** `null` ⇒ Google não configurado neste ambiente (o início do fluxo responde 503; os testes unitários não dependem disto). */
export function getGoogleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) || parsed.hash) return null;
  return { clientId, clientSecret, redirectUri, discoveryUrl: process.env.GOOGLE_DISCOVERY_URL?.trim() || GOOGLE_DISCOVERY_URL };
}

// ---- transporte (injetável SÓ em testes) --------------------------------------------------------------------------------

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let httpFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });

/** Apenas para testes: troca o transporte HTTP e zera os caches (discovery/JWKS). */
export function __setGoogleTransportForTests(transport: FetchLike | null) {
  httpFetch = transport ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" }));
  discoveryCache = null;
  jwksCache = null;
}

// ---- Discovery -------------------------------------------------------------------------------------------------------------

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}
let discoveryCache: { value: Discovery; at: number } | null = null;

/** SÓ testes/preview locais: aceita endpoints em localhost (provedor sintético). Nunca é ligado por ambiente ou requisição. */
let allowLocalEndpoints = false;
export const __allowLocalEndpointsForTests = (allow: boolean) => {
  allowLocalEndpoints = allow;
};

const isGoogleHost = (value: string) => {
  try {
    const u = new URL(value);
    if (allowLocalEndpoints && u.protocol === "http:" && u.hostname === "localhost") return true;
    return u.protocol === "https:" && (u.hostname === "google.com" || u.hostname.endsWith(".google.com") || u.hostname.endsWith(".googleapis.com"));
  } catch {
    return false;
  }
};

async function getDiscovery(config: GoogleConfig, now = Date.now()): Promise<Discovery> {
  if (discoveryCache && now - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.value;
  let doc: Record<string, unknown>;
  try {
    const res = await httpFetch(config.discoveryUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("status");
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new GoogleOidcError("discovery_invalido");
  }
  // O emissor do Discovery tem de ser o esperado e todos os endpoints têm de ser HTTPS em domínios do Google: um Discovery
  // adulterado (ou DNS/proxy hostil) não consegue redirecionar a troca do code nem o JWKS para outro host.
  const { issuer, authorization_endpoint: auth, token_endpoint: token, jwks_uri: jwks } = doc as Record<string, string>;
  if (!ACCEPTED_ISSUERS.includes(String(issuer)) || ![auth, token, jwks].every((v) => typeof v === "string" && isGoogleHost(v))) {
    throw new GoogleOidcError("discovery_invalido");
  }
  const value = { authorizationEndpoint: auth, tokenEndpoint: token, jwksUri: jwks };
  discoveryCache = { value, at: now };
  return value;
}

// ---- JWKS (cache com TTL + refresh limitado quando aparece um `kid` novo = rotação) ---------------------------------------

let jwksCache: { jwks: JSONWebKeySet; fetchedAt: number; lastRefreshAttempt: number } | null = null;

async function fetchJwks(config: GoogleConfig, now: number): Promise<JSONWebKeySet> {
  const { jwksUri } = await getDiscovery(config, now);
  try {
    const res = await httpFetch(jwksUri, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("status");
    const jwks = (await res.json()) as JSONWebKeySet;
    if (!Array.isArray(jwks.keys)) throw new Error("formato");
    return jwks;
  } catch {
    throw new GoogleOidcError("chave_desconhecida");
  }
}

async function getKeySet(config: GoogleConfig, kid: string | undefined, now = Date.now()) {
  const known = (jwks: JSONWebKeySet) => Boolean(kid) && jwks.keys.some((k) => k.kid === kid);
  const stale = !jwksCache || now - jwksCache.fetchedAt > JWKS_TTL_MS;
  const unknownKid = Boolean(jwksCache) && !known(jwksCache!.jwks) && now - jwksCache!.lastRefreshAttempt > JWKS_REFRESH_COOLDOWN_MS;
  if (stale || unknownKid) {
    try {
      const jwks = await fetchJwks(config, now);
      jwksCache = { jwks, fetchedAt: now, lastRefreshAttempt: now };
    } catch (error) {
      // falha ao renovar: mantém o cache anterior (se existir e não for velho demais) e respeita o cooldown
      if (jwksCache) jwksCache.lastRefreshAttempt = now;
      else throw error;
    }
  }
  return createLocalJWKSet(jwksCache!.jwks);
}

// ---- state / nonce / PKCE ----------------------------------------------------------------------------------------------------

const b64url = (buf: Buffer) => buf.toString("base64url");
export const newOauthSecret = () => b64url(randomBytes(32)); // 256 bits → 43 caracteres
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier, "ascii").digest());
export const newPkceVerifier = () => b64url(randomBytes(32)); // 43 caracteres (RFC 7636: 43–128)

export const oauthHash = (kind: "state" | "nonce" | "binding", value: string, version: number) =>
  hmacSecret(kind === "state" ? "oauth-state:v1:" : kind === "nonce" ? "oauth-nonce:v1:" : "oauth-binding:v1:", value, version);

export async function buildAuthorizationUrl(config: GoogleConfig, params: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
  const { authorizationEndpoint } = await getDiscovery(config);
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri); // vem da configuração: nunca de Host/cabeçalho do cliente
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

// ---- troca do code + validação do ID token ------------------------------------------------------------------------------

export interface GoogleIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** Back-channel: troca `code` (+ `code_verifier`) pelo ID token. O resto da resposta (access_token etc.) é descartado. */
export async function exchangeCodeForIdToken(config: GoogleConfig, code: string, codeVerifier: string): Promise<string> {
  const { tokenEndpoint } = await getDiscovery(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });
  let payload: { id_token?: unknown };
  try {
    const res = await httpFetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!res.ok) throw new Error("status");
    payload = (await res.json()) as { id_token?: unknown };
  } catch {
    throw new GoogleOidcError("troca_codigo_falhou");
  }
  if (typeof payload.id_token !== "string" || payload.id_token.length === 0 || payload.id_token.length > 8192) throw new GoogleOidcError("token_ausente");
  return payload.id_token;
}

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Valida o ID token: assinatura (RS256 pelo JWKS), iss ∈ {emissor do Google}, aud == client_id, exp, iat (não no futuro além da
 * tolerância), azp (== client_id quando presente; obrigatório se `aud` tiver mais de um valor), nonce == o da tentativa
 * (comparação em tempo constante dos HMACs) e sub. A configuração define emissor e audience; o token nunca os define.
 */
export async function verifyGoogleIdToken(config: GoogleConfig, idToken: string, expectedNonceHash: Buffer, pepperVersion: number, now = Date.now()): Promise<GoogleIdentity> {
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(idToken);
    if (header.alg !== "RS256") throw new GoogleOidcError("assinatura_invalida");
    kid = header.kid;
  } catch (error) {
    throw error instanceof GoogleOidcError ? error : new GoogleOidcError("token_malformado");
  }

  const keySet = await getKeySet(config, kid, now);
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, keySet, {
      issuer: ACCEPTED_ISSUERS,
      audience: config.clientId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(now),
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
    });
    claims = verified.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) throw new GoogleOidcError("expirado");
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      if (error.claim === "iss") throw new GoogleOidcError("issuer_invalido");
      if (error.claim === "aud") throw new GoogleOidcError("audience_invalida");
      if (error.claim === "sub") throw new GoogleOidcError("subject_ausente");
      throw new GoogleOidcError("token_malformado");
    }
    if (error instanceof joseErrors.JWKSNoMatchingKey) throw new GoogleOidcError("chave_desconhecida");
    if (error instanceof joseErrors.JWSSignatureVerificationFailed) throw new GoogleOidcError("assinatura_invalida");
    throw new GoogleOidcError("token_malformado");
  }

  const iat = claims.iat;
  if (typeof iat !== "number" || iat * 1000 > now + CLOCK_TOLERANCE_SECONDS * 1000) throw new GoogleOidcError("iat_invalido");

  const aud = claims.aud;
  const azp = claims.azp;
  if (Array.isArray(aud) && aud.length > 1 && azp !== config.clientId) throw new GoogleOidcError("azp_invalido");
  if (azp !== undefined && azp !== config.clientId) throw new GoogleOidcError("azp_invalido");

  if (typeof claims.nonce !== "string" || claims.nonce.length === 0 || claims.nonce.length > 256) throw new GoogleOidcError("nonce_invalido");
  if (!safeEqual(oauthHash("nonce", claims.nonce, pepperVersion), expectedNonceHash)) throw new GoogleOidcError("nonce_invalido");

  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) throw new GoogleOidcError("subject_ausente");

  const email = typeof claims.email === "string" && claims.email.length > 0 && claims.email.length <= 320 ? claims.email.trim().toLowerCase() : null;
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 120) : null;
  // Identidade = (provider, issuer, subject). O emissor guardado é o CANÔNICO configurado, nunca uma string escolhida pelo token.
  return { issuer: GOOGLE_ISSUER, subject: sub, email, emailVerified, name };
}
