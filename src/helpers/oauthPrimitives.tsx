import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hmacSecret } from "./identityKeys.js";

/**
 * Primitivas OAuth/OIDC que Google (Fase 92) e Microsoft (Fase 93) realmente COMPARTILHAM: segredos de 256 bits, PKCE S256, hashes
 * HMAC (com pepper versionado) de state/nonce/vínculo e comparação em tempo constante. Nada específico de provedor mora aqui.
 */

const b64url = (buf: Buffer) => buf.toString("base64url");
export const newOauthSecret = () => b64url(randomBytes(32)); // 256 bits → 43 caracteres
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier, "ascii").digest());
export const newPkceVerifier = () => b64url(randomBytes(32)); // 43 caracteres (RFC 7636: 43–128)

export const oauthHash = (kind: "state" | "nonce" | "binding", value: string, version: number) =>
  hmacSecret(kind === "state" ? "oauth-state:v1:" : kind === "nonce" ? "oauth-nonce:v1:" : "oauth-binding:v1:", value, version);

export const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
