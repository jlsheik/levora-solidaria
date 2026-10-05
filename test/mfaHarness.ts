/**
 * Utilitários dos testes de MFA/bootstrap (Fase 90): chamam `handle()` dos endpoints reais com cookies de sessão/challenge.
 */
import { db } from "../src/helpers/db";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as postMfaVerify } from "../src/endpoints/auth/mfa-verify_POST";
import { handle as postSetupBegin } from "../src/endpoints/auth/mfa-setup-begin_POST";
import { handle as postSetupConfirm } from "../src/endpoints/auth/mfa-setup-confirm_POST";
import { handle as getMfaStatus } from "../src/endpoints/auth/mfa-status_GET";
import { handle as postRegenerate } from "../src/endpoints/auth/mfa-recovery-regenerate_POST";
import { handle as postDisable } from "../src/endpoints/auth/mfa-disable_POST";
import { handle as postStepUp } from "../src/endpoints/auth/step-up_POST";
import { handle as postBootstrapActivate } from "../src/endpoints/auth/bootstrap-activate_POST";
import { handle as postBootstrapCredentials } from "../src/endpoints/auth/bootstrap-credentials_POST";
import { handle as getSession } from "../src/endpoints/auth/session_GET";
import { handle as postLogout } from "../src/endpoints/auth/logout_POST";
import { getServerSessionOrThrow } from "../src/helpers/getSetServerSession";
import { buildRequest, parseJson, TEST_TOTP_SECRET } from "./helpers";
import { stepAt, totpCodeAtStep } from "../src/helpers/totp";

export const PASSWORD = "senha-de-teste-123";
export const SESSION = "floot_built_app_session";
export const CHALLENGE = "levora_challenge";

/** "nome=valor" do cookie `name` entre os Set-Cookie da resposta (ou undefined). */
export function cookieFrom(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(name + "="));
}
export const clearedCookie = (res: Response, name: string) => res.headers.getSetCookie().some((c) => c.startsWith(name + "=;") && /Max-Age=0/.test(c));
export const join = (...cookies: Array<string | undefined>) => cookies.filter(Boolean).join("; ");
export const valueOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

export const login = (email: string, password = PASSWORD, ip?: string) =>
  postLogin(buildRequest("auth/login_with_password", { method: "POST", body: { email, password }, ip }));
export const verify = (cookie: string | undefined, body: unknown, ip?: string) => postMfaVerify(buildRequest("auth/mfa-verify", { method: "POST", cookie, body, ip }));
export const setupBegin = (cookie: string | undefined, body: unknown = {}, ip?: string) => postSetupBegin(buildRequest("auth/mfa-setup-begin", { method: "POST", cookie, body, ip }));
export const setupConfirm = (cookie: string | undefined, body: unknown, ip?: string) => postSetupConfirm(buildRequest("auth/mfa-setup-confirm", { method: "POST", cookie, body, ip }));
export const mfaStatus = (cookie: string) => getMfaStatus(buildRequest("auth/mfa-status", { cookie }));
export const regenerate = (cookie: string) => postRegenerate(buildRequest("auth/mfa-recovery-regenerate", { method: "POST", cookie, body: {} }));
export const disableMfa = (cookie: string) => postDisable(buildRequest("auth/mfa-disable", { method: "POST", cookie, body: {} }));
export const stepUp = (cookie: string, body: unknown) => postStepUp(buildRequest("auth/step-up", { method: "POST", cookie, body }));
export const bootstrapActivate = (token: string, ip?: string) => postBootstrapActivate(buildRequest("auth/bootstrap-activate", { method: "POST", body: { token }, ip }));
export const bootstrapCredentials = (cookie: string | undefined, body: unknown) => postBootstrapCredentials(buildRequest("auth/bootstrap-credentials", { method: "POST", cookie, body }));
export const whoAmI = (cookie: string) => getSession(buildRequest("auth/session", { cookie }));
export const logout = (cookie: string) => postLogout(buildRequest("auth/logout", { method: "POST", cookie }));
export const json = <T>(res: Response) => parseJson<T>(res);

export const sessionIdOf = async (cookie: string) => (await getServerSessionOrThrow(new Request("http://localhost/x", { headers: { cookie } }))).id;

/** Código TOTP do usuário de teste (segredo fixo) para `stepAt(nowMs)+offset`. */
export const totp = (offset = 0, nowMs = Date.now()) => totpCodeAtStep(TEST_TOTP_SECRET, stepAt(nowMs) + offset);

/** Apaga o anti-replay do usuário (para testes que NÃO estão testando replay e precisam logar várias vezes na mesma janela). */
export const resetReplay = (userId: number) => db.updateTable("mfaMethods").set({ lastUsedStep: null, failedAttempts: 0, lockedUntil: null, lastFailedAt: null }).where("userId", "=", userId).execute();

/** Login completo com senha + TOTP; devolve o cookie de sessão. */
export async function fullLogin(email: string, userId: number, ip?: string): Promise<string> {
  await resetReplay(userId);
  const first = await login(email, PASSWORD, ip);
  const challenge = cookieFrom(first, CHALLENGE);
  if (!challenge) throw new Error("fullLogin: o login não devolveu challenge (conta sem MFA?)");
  const done = await verify(challenge, { code: totp() }, ip);
  const session = cookieFrom(done, SESSION);
  if (!session) throw new Error(`fullLogin: verificação falhou (${done.status})`);
  return session;
}
