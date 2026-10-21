import {
  buildAuthorizationUrl as googleAuthorizationUrl, exchangeCodeForIdToken as googleExchange, getGoogleConfig, GoogleOidcError, verifyGoogleIdToken, type GoogleConfig,
} from "./googleOidc.js";
import {
  buildAuthorizationUrl as microsoftAuthorizationUrl, exchangeCodeForIdToken as microsoftExchange, getMicrosoftConfig, MicrosoftOidcError, verifyMicrosoftIdToken, type MicrosoftConfig,
} from "./microsoftOidc.js";
import type { OauthAuditAction, OauthProvider } from "./oauthFlow.js";

/**
 * Pequena camada entre o fluxo OAuth COMPARTILHADO (start/callback: tentativa, state, vínculo, login que nunca cria conta, cadastro com
 * código, reauth, MFA, sessão) e o que é de fato ESPECÍFICO de cada provedor (configuração, URL, troca do code, validação do ID token e
 * metadados). Não é um framework: são dois adaptadores (Google, Microsoft); a Apple será uma fase própria.
 */

export interface NormalizedIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** Atributos NÃO-chave do provedor (Microsoft: tid/oid/ver/idp). Nunca participam da busca da identidade. */
  metadata: Record<string, string>;
}

export interface OauthProviderAdapter<C = unknown> {
  provider: OauthProvider;
  /** Nome do parâmetro de retorno em /login (`?google=...` | `?microsoft=...`). */
  param: "google" | "microsoft";
  startBucket: string;
  callbackBucket: string;
  startRateMessage: string;
  notConfigured: { message: string; code: string };
  unavailable: { message: string; code: string };
  logName: string;
  actions: { login: OauthAuditAction; loginFailed: OauthAuditAction; signup: OauthAuditAction; signupFailed: OauthAuditAction; reauth: OauthAuditAction; reauthFailed: OauthAuditAction; rejected: OauthAuditAction };
  getConfig(): C | null;
  buildAuthorizationUrl(config: C, params: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  /** Troca o code (back-channel, PKCE) e valida o ID token LOCALMENTE. Lança erro do provedor com `motivo` seguro. */
  exchangeAndVerify(config: C, code: string, verifier: string, nonceHash: Buffer, pepperVersion: number): Promise<NormalizedIdentity>;
  /** `motivo` seguro se o erro for do provedor (validação do token); `null` caso contrário. */
  motivoOf(error: unknown): string | null;
  /** Metadados guardados que contradizem os do token (identidade anômala ⇒ rejeitada). */
  metadataConflict?(stored: Record<string, unknown>, fresh: Record<string, string>): boolean;
}

export const googleAdapter: OauthProviderAdapter<GoogleConfig> = {
  provider: "google",
  param: "google",
  startBucket: "google-start",
  callbackBucket: "google-callback",
  startRateMessage: "Muitas tentativas de entrar com o Google. Aguarde antes de tentar de novo.",
  notConfigured: { message: "Entrar com o Google não está disponível neste ambiente.", code: "google_nao_configurado" },
  unavailable: { message: "Não foi possível iniciar o login com o Google. Tente novamente.", code: "google_indisponivel" },
  logName: "Google",
  actions: {
    login: "usuario.login_google", loginFailed: "usuario.login_google_falhou", signup: "usuario.cadastro_google", signupFailed: "usuario.cadastro_google_falhou",
    reauth: "usuario.reauth_google", reauthFailed: "usuario.reauth_google_falhou", rejected: "usuario.google_identity_rejected",
  },
  getConfig: getGoogleConfig,
  buildAuthorizationUrl: googleAuthorizationUrl,
  async exchangeAndVerify(config, code, verifier, nonceHash, pepperVersion) {
    const identity = await verifyGoogleIdToken(config, await googleExchange(config, code, verifier), nonceHash, pepperVersion);
    return { ...identity, metadata: {} };
  },
  motivoOf: (error) => (error instanceof GoogleOidcError ? error.motivo : null),
};

export const microsoftAdapter: OauthProviderAdapter<MicrosoftConfig> = {
  provider: "microsoft",
  param: "microsoft",
  startBucket: "microsoft-start",
  callbackBucket: "microsoft-callback",
  startRateMessage: "Muitas tentativas de entrar com a Microsoft. Aguarde antes de tentar de novo.",
  notConfigured: { message: "Entrar com a Microsoft não está disponível neste ambiente.", code: "microsoft_nao_configurado" },
  unavailable: { message: "Não foi possível iniciar o login com a Microsoft. Tente novamente.", code: "microsoft_indisponivel" },
  logName: "Microsoft",
  actions: {
    login: "usuario.login_microsoft", loginFailed: "usuario.login_microsoft_falhou", signup: "usuario.cadastro_microsoft", signupFailed: "usuario.cadastro_microsoft_falhou",
    reauth: "usuario.reauth_microsoft", reauthFailed: "usuario.reauth_microsoft_falhou", rejected: "usuario.microsoft_identity_rejected",
  },
  getConfig: getMicrosoftConfig,
  buildAuthorizationUrl: microsoftAuthorizationUrl,
  async exchangeAndVerify(config, code, verifier, nonceHash, pepperVersion) {
    return verifyMicrosoftIdToken(config, await microsoftExchange(config, code, verifier), nonceHash, pepperVersion);
  },
  motivoOf: (error) => (error instanceof MicrosoftOidcError ? error.motivo : null),
  // `oid` é imutável por objeto: o MESMO (issuer, sub) com `oid` diferente do já gravado é anômalo ⇒ rejeita (nunca "atualiza" em silêncio).
  metadataConflict: (stored, fresh) => typeof stored.oid === "string" && typeof fresh.oid === "string" && stored.oid !== fresh.oid,
};
