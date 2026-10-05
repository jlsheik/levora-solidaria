import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Chaves da camada de identidade (Fase 90; docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §25.5).
 * Finalidades SEPARADAS, nenhuma derivada de outra e nenhuma é o `JWT_SECRET`:
 *
 *   IDENTITY_CODE_PEPPER_V<n>  (+ IDENTITY_CODE_PEPPER_CURRENT)  → HMAC-SHA-256 de segredos bearer de alta entropia
 *                                (recovery codes, tokens de bootstrap, segredo opaco de auth_challenges). Separação de
 *                                contextos por *domain separation* no HMAC ("recovery:v1:", "bootstrap:v1:", ...).
 *   MFA_ENCRYPTION_KEY_V<n>    (+ MFA_ENCRYPTION_KEY_CURRENT)    → AES-256-GCM do segredo TOTP em repouso (32 bytes, base64).
 *
 * Versionamento: cada registro guarda a versão (`pepper_version` / `secret_key_id`). Novos registros usam a versão CURRENT; a
 * validação aceita todas as versões configuradas — a rotação não invalida tudo de uma vez. Ausência de chave obrigatória ⇒
 * erro de configuração (falha segura: nunca se gera hash/cifra com chave fraca ou padrão).
 */

export class IdentityKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityKeyConfigError";
  }
}

function versionsFor(prefix: string): number[] {
  const versions: number[] = [];
  for (const name of Object.keys(process.env)) {
    const match = new RegExp(`^${prefix}_V(\\d+)$`).exec(name);
    if (match && process.env[name]) versions.push(Number(match[1]));
  }
  return versions.sort((a, b) => a - b);
}

function currentVersion(prefix: string): number {
  const configured = process.env[`${prefix}_CURRENT`];
  const available = versionsFor(prefix);
  if (available.length === 0) throw new IdentityKeyConfigError(`${prefix}_V<n> não configurada`);
  const current = configured ? Number(configured) : available[available.length - 1];
  if (!Number.isInteger(current) || !available.includes(current)) {
    throw new IdentityKeyConfigError(`${prefix}_CURRENT aponta para uma versão não configurada`);
  }
  return current;
}

// ---- pepper (HMAC) -------------------------------------------------------------------------------------------------

export type PepperContext = "recovery:v1:" | "bootstrap:v1:" | "challenge:v1:";

function pepperFor(version: number): Buffer {
  const raw = process.env[`IDENTITY_CODE_PEPPER_V${version}`];
  if (!raw) throw new IdentityKeyConfigError(`IDENTITY_CODE_PEPPER_V${version} não configurada`);
  if (Buffer.byteLength(raw, "utf8") < 32) throw new IdentityKeyConfigError("IDENTITY_CODE_PEPPER precisa ter pelo menos 32 bytes");
  return Buffer.from(raw, "utf8");
}

export const currentPepperVersion = () => currentVersion("IDENTITY_CODE_PEPPER");
export const acceptedPepperVersions = () => versionsFor("IDENTITY_CODE_PEPPER");

/** HMAC-SHA-256(pepper_v, contexto + valor normalizado). */
export function hmacSecret(context: PepperContext, value: string, version: number): Buffer {
  return createHmac("sha256", pepperFor(version)).update(context + value, "utf8").digest();
}

// ---- cifra do segredo TOTP (AES-256-GCM) ---------------------------------------------------------------------------

function mfaKeyFor(keyId: number): Buffer {
  const raw = process.env[`MFA_ENCRYPTION_KEY_V${keyId}`];
  if (!raw) throw new IdentityKeyConfigError(`MFA_ENCRYPTION_KEY_V${keyId} não configurada`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new IdentityKeyConfigError("MFA_ENCRYPTION_KEY precisa ter exatamente 32 bytes (base64)");
  return key;
}

export const currentMfaKeyId = () => currentVersion("MFA_ENCRYPTION_KEY");

/**
 * Formato armazenado (coluna BYTEA): `iv(12) || tag(16) || ciphertext`. `keyId` vai em coluna própria (`secret_key_id`).
 * AAD (dados autenticados, não secretos) liga o texto cifrado ao registro: o ciphertext de um usuário não decifra em
 * outro nem em outro propósito.
 */
export function encryptSecret(plaintext: Buffer, aad: string): { ciphertext: Buffer; keyId: number } {
  const keyId = currentMfaKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mfaKeyFor(keyId), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]), keyId };
}

export function decryptSecret(stored: Buffer, keyId: number, aad: string): Buffer {
  if (stored.length < 12 + 16 + 1) throw new Error("segredo cifrado malformado");
  const iv = stored.subarray(0, 12);
  const tag = stored.subarray(12, 28);
  const data = stored.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", mfaKeyFor(keyId), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Política de plataforma: MFA obrigatório para titulares de platform_access, exceto staging sintético explícito. */
export function isPlatformMfaRequired(): boolean {
  return !(process.env.PLATFORM_MFA_REQUIRED === "false" && process.env.LEVORA_ENVIRONMENT === "staging");
}
