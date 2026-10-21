/**
 * Reautenticação do MÉTODO PRIMÁRIO (Fase 92.1). Carimbo na MESMA sessão (`sessions.primary_reauth_at`), válido por poucos minutos.
 * Hoje é satisfeito pela identidade Google do PRÓPRIO usuário; Microsoft/Apple/senha/passkey poderão satisfazer o mesmo requisito
 * sem mudar quem o consome. É DISTINTO do step-up do 2º fator (`last_reauth_at`, stepUp.tsx): reautenticar a identidade nunca
 * substitui o MFA LEVORA, e o MFA nunca substitui a identidade.
 */
export const PRIMARY_REAUTH_WINDOW_SECONDS = 5 * 60;

export interface PrimaryReauthState {
  primaryReauthAt?: Date | null;
}

export function isPrimaryReauthFresh(session: PrimaryReauthState, now: Date = new Date(), windowSeconds = PRIMARY_REAUTH_WINDOW_SECONDS): boolean {
  const at = session.primaryReauthAt?.getTime() ?? 0;
  return at > 0 && now.getTime() - at < windowSeconds * 1000 && at <= now.getTime() + 1000;
}
