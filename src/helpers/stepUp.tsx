import { ReauthRequiredError } from "./errorResponse.js";

/**
 * Step-up (Fase 90; §25.14): reautenticação RECENTE para ações críticas. Não cria sessão paralela — é um carimbo na MESMA
 * sessão (`sessions.last_reauth_at`, ou `mfa_verified_at` logo após o login com MFA), que expira sozinho.
 * Janela padrão: 10 min (a especificação prevê 2 min para a futura transferência de ownership).
 */
export const STEP_UP_DEFAULT_WINDOW_SECONDS = 10 * 60;

export interface StepUpSessionState {
  mfaVerifiedAt?: Date | null;
  lastReauthAt?: Date | null;
}

export function isRecentlyAuthenticated(session: StepUpSessionState, maxAgeSeconds = STEP_UP_DEFAULT_WINDOW_SECONDS, now: Date = new Date()): boolean {
  const latest = Math.max(session.mfaVerifiedAt?.getTime() ?? 0, session.lastReauthAt?.getTime() ?? 0);
  return latest > 0 && now.getTime() - latest < maxAgeSeconds * 1000;
}

/** Lança 403 `reauth_required` quando a sessão não se autenticou (MFA/step-up) dentro da janela. */
export function requireRecentAuth(session: StepUpSessionState, maxAgeSeconds = STEP_UP_DEFAULT_WINDOW_SECONDS, now: Date = new Date()): void {
  if (!isRecentlyAuthenticated(session, maxAgeSeconds, now)) throw new ReauthRequiredError();
}
