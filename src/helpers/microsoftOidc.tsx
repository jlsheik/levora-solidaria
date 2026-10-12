import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, errors as joseErrors, type JSONWebKeySet, type JWK } from "jose";
import { oauthHash, safeEqual } from "./oauthPrimitives.js";

/**
 * Microsoft OIDC (Fase 93) — Authorization Code Flow + PKCE (S256), SOMENTE identidade (scopes openid profile email; nenhum escopo do
 * Microsoft Graph). Mesmo contrato da Fase 92: o backend troca o `code` no back-channel e valida o ID token LOCALMENTE (assinatura RS256
 * pelo JWKS do Discovery, iss, aud, exp, iat, nonce, ver, tid, sub). Nenhum token da Microsoft é guardado: o `access_token` é descartado e o
 * `id_token` só vive nesta chamada. Configuração só do ambiente.
 *
 * O que é ESPECÍFICO da Microsoft (e por isso não reaproveita o Google):
 *  - authority multi-tenant (`common` aceita contas pessoais E corporativas/escolares): o `iss` NÃO é fixo, é `https://login.microsoftonline.com/{tid}/v2.0`
 *    com o `tid` DO PRÓPRIO TOKEN. Validamos a forma exata do `iss` a partir do `tid` e depois a política do authority escolhido
 *    (common | organizations | consumers | um tenant). O `tid` nunca é a identidade; o emissor guardado é o `iss` já validado.
 *  - o JWKS publica `issuer` e `cloud_instance_name` por chave; usamos isso como defesa em profundidade (chave de contas pessoais só assina `iss`
 *    pessoal; chaves de nuvens soberanas não são aceitas).
 *  - `sub` é por aplicativo; `oid` (id imutável do objeto no tenant) e `tid` vão só para metadata, nunca para a chave da identidade.
 */

/** Tenant fixo das contas Microsoft pessoais (MSA). */
export const MICROSOFT_PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const MICROSOFT_HOST = "login.microsoftonline.com";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPES = "openid profile email";
const CLOCK_TOLERANCE_SECONDS = 60;
const HTTP_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 60 * 1000;

export type MicrosoftFailure =
  | "nao_configurado"
  | "discovery_invalido"
  | "troca_codigo_falhou"
  | "token_ausente"
  | "token_malformado"
  | "assinatura_invalida"
  | "issuer_invalido"
  | "tenant_invalido"
  | "audience_invalida"
  | "azp_invalido"
  | "expirado"
  | "iat_invalido"
  | "nonce_invalido"
  | "subject_ausente"
  | "versao_invalida"
  | "chave_desconhecida"
  | "chave_issuer_divergente";

/** Erro tipado: o `motivo` é uma constante curta e segura (auditoria/logs) — nunca contém token, código ou segredo. */
export class MicrosoftOidcError extends Error {
  constructor(readonly motivo: MicrosoftFailure) {
    super(motivo);
    this.name = "MicrosoftOidcError";
  }
}

// ---- configuração (somente ambiente) -------------------------------------------------------------------------------------

export type MicrosoftTenant = "common" | "organizations" | "consumers" | string; // string = GUID de um tenant específico

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Qual público a aplicação aceita. Padrão `common` (pessoal + corporativo/escolar). Decisão de produto explícita para restringir. */
  tenant: MicrosoftTenant;
  discoveryUrl: string;
}

/** `null` ⇒ Microsoft não configurado neste ambiente (o início do fluxo responde 503). */
export function getMicrosoftConfig(): MicrosoftConfig | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  const tenant = (process.env.MICROSOFT_TENANT?.trim() || "common").toLowerCase();
  if (!(tenant === "common" || tenant === "organizations" || tenant === "consumers" || GUID.test(tenant))) return null;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) || parsed.hash) return null;
  return {
    clientId,
    clientSecret,
    redirectUri,
    tenant,
    discoveryUrl: process.env.MICROSOFT_DISCOVERY_URL?.trim() || `https://${MICROSOFT_HOST}/${tenant}/v2.0/.well-known/openid-configuration`,
  };
}

/** `iss` que a Microsoft emite para um tenant. */
export const microsoftIssuerFor = (tid: string) => `https://${MICROSOFT_HOST}/${tid}/v2.0`;

// ---- transporte (injetável SÓ em testes) --------------------------------------------------------------------------------

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const realFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
let httpFetch: FetchLike = realFetch;

/** Apenas para testes: troca o transporte HTTP e zera os caches (discovery/JWKS). */
export function __setMicrosoftTransportForTests(transport: FetchLike | null) {
  httpFetch = transport ?? realFetch;
  discoveryCache = null;
  jwksCache = null;
}

// ---- Discovery -------------------------------------------------------------------------------------------------------------

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}
let discoveryCache: { value: Discovery; at: number; key: string } | null = null;

/** SÓ testes/preview locais: aceita endpoints em localhost (provedor sintético). Nunca é ligado por ambiente ou requisição. */
let allowLocalEndpoints = false;
export const __allowMicrosoftLocalEndpointsForTests = (allow: boolean) => {
  allowLocalEndpoints = allow;
};

/** HTTPS em `login.microsoftonline.com` e caminho dentro do tenant configurado (`/{tenant}/...`). */
const isMicrosoftEndpoint = (value: unknown, tenant: string) => {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    const inTenant = u.pathname.startsWith(`/${tenant}/`);
    if (allowLocalEndpoints && u.protocol === "http:" && u.hostname === "localhost") return inTenant;
    return u.protocol === "https:" && u.hostname === MICROSOFT_HOST && !u.username && !u.password && !u.port && inTenant;
  } catch {
    return false;
  }
};

/** O emissor anunciado pelo Discovery tem de ser o do authority configurado (modelo `{tenantid}` para common/organizations). */
const expectedDiscoveryIssuer = (tenant: MicrosoftTenant) =>
  tenant === "common" || tenant === "organizations" ? `https://${MICROSOFT_HOST}/{tenantid}/v2.0` : microsoftIssuerFor(tenant === "consumers" ? MICROSOFT_PERSONAL_TENANT_ID : tenant);

async function getDiscovery(config: MicrosoftConfig, now = Date.now()): Promise<Discovery> {
  if (discoveryCache && discoveryCache.key === config.discoveryUrl && now - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.value;
  let doc: Record<string, unknown>;
  try {
    const res = await httpFetch(config.discoveryUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("status");
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new MicrosoftOidcError("discovery_invalido");
  }
  // O Discovery não define a confiança: o emissor tem de ser o esperado para o authority e TODOS os endpoints têm de ser HTTPS em
  // login.microsoftonline.com dentro do tenant configurado — um Discovery adulterado (DNS/proxy hostil) não redireciona a troca do
  // code nem o JWKS para outro host.
  const { issuer, authorization_endpoint: auth, token_endpoint: token, jwks_uri: jwks } = doc as Record<string, unknown>;
  if (issuer !== expectedDiscoveryIssuer(config.tenant) || ![auth, token, jwks].every((v) => isMicrosoftEndpoint(v, config.tenant))) {
    throw new MicrosoftOidcError("discovery_invalido");
  }
  const value = { authorizationEndpoint: auth as string, tokenEndpoint: token as string, jwksUri: jwks as string };
  discoveryCache = { value, at: now, key: config.discoveryUrl };
  return value;
}

// ---- JWKS (cache com TTL + refresh limitado quando aparece um `kid` novo = rotação) ---------------------------------------

type MicrosoftJwk = JWK & { issuer?: unknown; cloud_instance_name?: unknown };
let jwksCache: { keys: MicrosoftJwk[]; fetchedAt: number; lastRefreshAttempt: number } | null = null;

/** Só chaves da nuvem pública (o JWKS multi-nuvem também lista chaves de nuvens soberanas, que não assinam para este authority). */
const isPublicCloudKey = (k: MicrosoftJwk) => k.cloud_instance_name === undefined || k.cloud_instance_name === "microsoftonline.com";

async function fetchKeys(config: MicrosoftConfig, now: number): Promise<MicrosoftJwk[]> {
  const { jwksUri } = await getDiscovery(config, now);
  try {
    const res = await httpFetch(jwksUri, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("status");
    const jwks = (await res.json()) as JSONWebKeySet;
    if (!Array.isArray(jwks.keys)) throw new Error("formato");
    return (jwks.keys as MicrosoftJwk[]).filter((k) => k && typeof k.kid === "string" && isPublicCloudKey(k));
  } catch {
    throw new MicrosoftOidcError("chave_desconhecida");
  }
}

async function getKey(config: MicrosoftConfig, kid: string, now = Date.now()): Promise<MicrosoftJwk | undefined> {
  const known = (keys: MicrosoftJwk[]) => keys.some((k) => k.kid === kid);
  const stale = !jwksCache || now - jwksCache.fetchedAt > JWKS_TTL_MS;
  const unknownKid = Boolean(jwksCache) && !known(jwksCache!.keys) && now - jwksCache!.lastRefreshAttempt > JWKS_REFRESH_COOLDOWN_MS;
  if (stale || unknownKid) {
    try {
      const keys = await fetchKeys(config, now);
      jwksCache = { keys, fetchedAt: now, lastRefreshAttempt: now };
    } catch (error) {
      // falha ao renovar: mantém o cache anterior (se existir) e respeita o cooldown
      if (jwksCache) jwksCache.lastRefreshAttempt = now;
      else throw error;
    }
  }
  return jwksCache!.keys.find((k) => k.kid === kid);
}

// ---- URL de autorização ----------------------------------------------------------------------------------------------------

export async function buildAuthorizationUrl(config: MicrosoftConfig, params: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
  const { authorizationEndpoint } = await getDiscovery(config);
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri); // vem da configuração: nunca de Host/cabeçalho do cliente
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

// ---- troca do code + validação do ID token ------------------------------------------------------------------------------

export interface MicrosoftIdentity {
  /** `iss` já validado (https://login.microsoftonline.com/{tid}/v2.0) — o emissor guardado na identidade. */
  issuer: string;
  /** `sub` do token: identificador do usuário PARA ESTE APLICATIVO. */
  subject: string;
  email: string | null;
  /** A Microsoft não garante a posse do e-mail (classe "nOAuth"): sempre false. */
  emailVerified: false;
  name: string | null;
  /** Atributos NÃO-chave: tid, oid, ver, idp. */
  metadata: Record<string, string>;
}

/** Back-channel: troca `code` (+ `code_verifier`) pelo ID token. O resto da resposta (access_token etc.) é descartado. */
export async function exchangeCodeForIdToken(config: MicrosoftConfig, code: string, codeVerifier: string): Promise<string> {
  const { tokenEndpoint } = await getDiscovery(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
    scope: SCOPES,
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
    throw new MicrosoftOidcError("troca_codigo_falhou");
  }
  if (typeof payload.id_token !== "string" || payload.id_token.length === 0 || payload.id_token.length > 16384) throw new MicrosoftOidcError("token_ausente");
  return payload.id_token;
}

/** Política do authority escolhido sobre o `tid` do token. */
function tenantAllowed(config: MicrosoftConfig, tid: string) {
  switch (config.tenant) {
    case "common":
      return true;
    case "organizations":
      return tid !== MICROSOFT_PERSONAL_TENANT_ID;
    case "consumers":
      return tid === MICROSOFT_PERSONAL_TENANT_ID;
    default:
      return tid === config.tenant;
  }
}

const short = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null);

// Controle (C0/C1), separadores de linha/parágrafo e marcas de formatação/bidi/zero-width: nunca em nome nem e-mail.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// Versão SEM a flag g para `.test` (um regex global guarda lastIndex entre chamadas e deixaria passar o caractere seguinte de outra requisição).
const UNSAFE_CHAR = new RegExp(UNSAFE_CHARS.source);
const ADDRESS_FORBIDDEN = /[\s@<>"',;:()[\]\\]/;

/** `local@dominio.tld` simples (um só `@`, sem espaços/controle/aspas/vírgula/colchetes/HTML), minúsculo; qualquer outra coisa ⇒ null (tratado como ausente). */
function safeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 320 || UNSAFE_CHAR.test(value)) return null;
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local.length < 1 || local.length > 64 || ADDRESS_FORBIDDEN.test(local)) return null;
  if (domain.length < 3 || ADDRESS_FORBIDDEN.test(domain) || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  return value;
}

/** Nome para exibição: caracteres perigosos viram espaço, espaços colapsam; vazio ⇒ null. */
function cleanDisplayName(raw: string): string | null {
  const cleaned = raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Valida o ID token: assinatura (RS256 pelo JWKS; `kid` obrigatório), `iss` == https://login.microsoftonline.com/{tid}/v2.0 (tid do próprio
 * token, no formato GUID) e o `tid` permitido pelo authority configurado, `aud` == client_id (único), `ver` == "2.0", exp, iat (não no futuro
 * além da tolerância), nonce == o da tentativa (HMAC, tempo constante) e sub. A configuração define audience e authority; o token nunca os define.
 */
export async function verifyMicrosoftIdToken(config: MicrosoftConfig, idToken: string, expectedNonceHash: Buffer, pepperVersion: number, now = Date.now()): Promise<MicrosoftIdentity> {
  let kid: string;
  try {
    const header = decodeProtectedHeader(idToken);
    if (header.alg !== "RS256") throw new MicrosoftOidcError("assinatura_invalida"); // whitelist: nunca o `alg` que o token escolher
    if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 128) throw new MicrosoftOidcError("chave_desconhecida");
    kid = header.kid;
  } catch (error) {
    throw error instanceof MicrosoftOidcError ? error : new MicrosoftOidcError("token_malformado");
  }

  const jwk = await getKey(config, kid, now);
  if (!jwk) throw new MicrosoftOidcError("chave_desconhecida");

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, createLocalJWKSet({ keys: [jwk] }), {
      audience: config.clientId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(now),
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
    });
    claims = verified.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) throw new MicrosoftOidcError("expirado");
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      if (error.claim === "aud") throw new MicrosoftOidcError("audience_invalida");
      if (error.claim === "sub") throw new MicrosoftOidcError("subject_ausente");
      throw new MicrosoftOidcError("token_malformado");
    }
    if (error instanceof joseErrors.JWKSNoMatchingKey) throw new MicrosoftOidcError("chave_desconhecida");
    if (error instanceof joseErrors.JWSSignatureVerificationFailed) throw new MicrosoftOidcError("assinatura_invalida");
    throw new MicrosoftOidcError("token_malformado");
  }

  const iat = claims.iat;
  if (typeof iat !== "number" || iat * 1000 > now + CLOCK_TOLERANCE_SECONDS * 1000) throw new MicrosoftOidcError("iat_invalido");

  // audience: o ID token da Microsoft tem UM destinatário (este aplicativo). Lista com mais de um valor nunca é aceita.
  const aud = claims.aud;
  if (Array.isArray(aud) && aud.length !== 1) throw new MicrosoftOidcError("audience_invalida");
  if (claims.azp !== undefined && claims.azp !== config.clientId) throw new MicrosoftOidcError("azp_invalido");

  if (claims.ver !== "2.0") throw new MicrosoftOidcError("versao_invalida");

  // Emissor: o `iss` real tem de ser EXATAMENTE o emissor do `tid` do próprio token, e o tid tem de ser permitido pelo authority.
  const tid = claims.tid;
  if (typeof tid !== "string" || !GUID.test(tid)) throw new MicrosoftOidcError("tenant_invalido");
  if (claims.iss !== microsoftIssuerFor(tid)) throw new MicrosoftOidcError("issuer_invalido");
  if (!tenantAllowed(config, tid)) throw new MicrosoftOidcError("tenant_invalido");
  // Fail-closed (Fase 93.2): a chave que assinou TEM de declarar o emissor para o qual vale (modelo `{tenantid}` ou o tenant pessoal), como o JWKS da
  // Microsoft publica. Ausente, vazio ou não-string ⇒ a chave NÃO é autorizada (a falta do campo nunca vale como permissão). Com `{tenantid}`
  // substituído pelo `tid` validado, tem de igualar o `iss` EXATAMENTE: chave de contas pessoais não assina `iss` corporativo e vice-versa.
  if (typeof jwk.issuer !== "string" || jwk.issuer.trim().length === 0 || jwk.issuer.split("{tenantid}").join(tid) !== claims.iss) throw new MicrosoftOidcError("chave_issuer_divergente");

  if (typeof claims.nonce !== "string" || claims.nonce.length === 0 || claims.nonce.length > 256) throw new MicrosoftOidcError("nonce_invalido");
  if (!safeEqual(oauthHash("nonce", claims.nonce, pepperVersion), expectedNonceHash)) throw new MicrosoftOidcError("nonce_invalido");

  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) throw new MicrosoftOidcError("subject_ausente");

  // metadata (NÃO é chave): oid (imutável no tenant) e idp (provedor de identidade de convidados/federados) só quando bem formados.
  const metadata: Record<string, string> = { tid, ver: "2.0" };
  if (claims.oid !== undefined) {
    if (typeof claims.oid !== "string" || !GUID.test(claims.oid)) throw new MicrosoftOidcError("token_malformado");
    metadata.oid = claims.oid;
  }
  const idp = short(claims.idp, 255);
  if (idp) metadata.idp = idp;

  // E-mail: SOMENTE o claim `email` (nunca preferred_username/upn, que são nomes legíveis mutáveis) e só como atributo.
  // Quem administra um tenant controla estes valores: só entram se tiverem FORMA de e-mail/nome (higiene, não prova de posse).
  const email = typeof claims.email === "string" ? safeEmail(claims.email) : null;
  const name = typeof claims.name === "string" && claims.name.length <= 120 ? cleanDisplayName(claims.name) : null;
  return { issuer: claims.iss as string, subject: sub, email, emailVerified: false, name, metadata };
}
