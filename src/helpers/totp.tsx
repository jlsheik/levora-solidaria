import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238 sobre HOTP RFC 4226): HMAC-SHA-1, 6 dígitos, período de 30 s — o perfil que Google Authenticator e Microsoft
 * Authenticator (e outros apps TOTP) interpretam do mesmo `otpauth://`. Implementação com `node:crypto`; sem dependência.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** Tolerância de relógio: aceita o passo atual, o anterior e o seguinte (±30 s). */
export const TOTP_WINDOW_STEPS = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo de 160 bits (recomendação do RFC 4226). */
export const generateTotpSecret = (): Buffer => randomBytes(20);

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);

export function totpCodeAtStep(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Normaliza o que a pessoa digitou ("123 456" → "123456"). Não é uma validação de segurança. */
export const normalizeTotpInput = (input: string): string => input.replace(/[\s-]/g, "");

/**
 * Procura o passo que gerou `code` dentro da janela ±1 e ESTRITAMENTE MAIOR que `lastUsedStep` (anti-replay: o mesmo
 * passo nunca vale duas vezes, e um passo anterior ao último aceito também não). Comparação em tempo constante e sem
 * curto-circuito entre os passos. Devolve o passo aceito ou null.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  const normalized = normalizeTotpInput(code);
  if (!/^\d{6}$/.test(normalized)) return null;
  const current = stepAt(nowMs);
  let accepted: number | null = null;
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step++) {
    const expected = Buffer.from(totpCodeAtStep(secret, step));
    const given = Buffer.from(normalized);
    const equal = expected.length === given.length && timingSafeEqual(expected, given);
    if (equal && (lastUsedStep === null || step > lastUsedStep) && accepted === null) accepted = step;
  }
  return accepted;
}

/** `otpauth://` para QR / entrada manual. O rótulo identifica a conta no app autenticador (nunca contém segredo além de `secret`). */
export function buildOtpauthUri(params: { secret: Buffer; accountLabel: string; issuer?: string }): string {
  const issuer = params.issuer ?? "Levora";
  // O ':' que separa emissor e conta fica LITERAL (formato Key Uri do Google Authenticator); cada parte é codificada.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.accountLabel)}`;
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
