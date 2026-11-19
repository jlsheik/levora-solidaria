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

export type PepperContext = "recovery:v1:" | "bootstrap:v1:" | "challenge:v1:" | "access-code:v1:" | "oauth-state:v1:" | "oauth-nonce:v1:" | "oauth-binding:v1:" | "password-reset:v1:";

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
 * Verifica, sem expor valores, se as chaves de identidade exigidas por contas protegidas por MFA e por códigos de acesso existem e são válidas
 * (pepper ≥ 32 bytes; chave de cifra do TOTP com 32 bytes). Usado pela prontidão (M49): sem isto, uma implantação sem chaves só falhava
 * (HTTP 500 genérico) no primeiro login de uma conta protegida.
 */
export function identityKeysConfigured(): boolean {
  try {
    pepperFor(currentVersion("IDENTITY_CODE_PEPPER"));
    mfaKeyFor(currentVersion("MFA_ENCRYPTION_KEY"));
    return true;
  } catch {
    return false;
  }
}


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

/** Hosts de banco aceitos para o relaxamento do MFA: serviço `postgres` do compose de staging + loopback (lista fechada; mesma da guarda do seed, db/seedStagingGuard.ts). */
const RELAXED_MFA_DB_HOSTS = new Set(["postgres", "localhost", "127.0.0.1", "::1", "[::1]"]);
/** Variáveis que, se declararem produção, vetam o relaxamento mesmo com o resto "certo". */
const ENV_DECLARATIONS = ["LEVORA_ENVIRONMENT", "APP_ENV", "ENVIRONMENT", "DEPLOY_ENV", "RAILWAY_ENVIRONMENT", "VERCEL_ENV"] as const;
const PRODUCTION_LIKE = /^(prod|production|producao|produção|live|prd)$/i;

/**
 * O relaxamento do MFA de plataforma exige EVIDÊNCIA POSITIVA de ambiente descartável, não só duas variáveis (que um .env ou um compose de produção poderiam trazer por engano):
 * `PLATFORM_MFA_REQUIRED=false` + `LEVORA_ENVIRONMENT=staging` + nenhuma outra variável declarando produção + banco de nome reservado (`*_staging`, `*_demo`, `*_qa`, `*_test`)
 * em host local/da lista fechada. Qualquer dúvida (URL ausente/inválida, FLOOT_DATABASE_URL divergente) ⇒ o MFA continua obrigatório.
 */
export function isRelaxedMfaEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PLATFORM_MFA_REQUIRED !== "false" || (env.LEVORA_ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") return false;
  for (const name of ENV_DECLARATIONS) {
    const value = (env[name] ?? "").trim();
    if (value && PRODUCTION_LIKE.test(value)) return false;
  }
  const primary = env.DATABASE_URL?.trim();
  const alias = env.FLOOT_DATABASE_URL?.trim();
  if (!primary || (alias && alias !== primary)) return false;
  try {
    const url = new URL(primary);
    // Parâmetros de conexão na query (estilo libpq) podem redirecionar host/banco: qualquer um deles torna a URL ambígua para esta guarda.
    for (const key of url.searchParams.keys()) if (/^(host|hostaddr|port|dbname|database|db|service|options)$/i.test(key)) return false;
    const database = decodeURIComponent(url.pathname.slice(1));
    return /^[a-z0-9][a-z0-9_]*_(staging|demo|qa|test)$/.test(database) && RELAXED_MFA_DB_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Política de plataforma: MFA obrigatório para titulares de platform_access, exceto ambiente descartável explícito (ver isRelaxedMfaEnvironment). */
export function isPlatformMfaRequired(): boolean {
  return !isRelaxedMfaEnvironment();
}
