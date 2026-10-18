-- Fase 92.1 — reautenticação por identidade (ciclo de vida de contas sociais). Ver docs/IDENTIDADE_FASE92_GOOGLE_AUDITORIA.md §16.
--
--   1. sessions.primary_reauth_at   carimbo da ÚLTIMA reautenticação do método PRIMÁRIO (hoje: identidade Google do próprio usuário).
--                                   É DISTINTO de last_reauth_at (step-up do 2º fator): reautenticar com o Google nunca substitui o MFA.
--   2. oauth_attempts.intent 'reauth' + user_id   a tentativa de reautenticação pertence a UM usuário (CHECK: reauth <=> user_id).
-- Não toca em dados existentes.

ALTER TABLE sessions ADD COLUMN primary_reauth_at TIMESTAMPTZ;

ALTER TABLE oauth_attempts DROP CONSTRAINT oauth_attempts_intent_check;
ALTER TABLE oauth_attempts ADD CONSTRAINT oauth_attempts_intent_check CHECK (intent IN ('login', 'signup', 'reauth'));
ALTER TABLE oauth_attempts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE oauth_attempts ADD CONSTRAINT oauth_attempts_user_iff_reauth CHECK ((intent = 'reauth') = (user_id IS NOT NULL));
