-- Fase 90 — MFA (TOTP), recovery codes, auth_challenges, bootstrap do Platform Owner, ip_prefix em login_attempts.
-- (docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §4.4–4.7, §25.2, §25.13, §25.14; docs/IDENTIDADE_FASE90_AUDITORIA.md)
--
--   1. mfa_methods                 segredo TOTP CIFRADO (AES-256-GCM; secret_key_id versiona a chave), last_used_step anti-replay,
--                                  contadores de falha persistidos; no máximo 1 método "aberto" (pending|active) por usuário.
--   2. mfa_recovery_codes          só HMAC (pepper versionado); uso único (used_at) e invalidação por lote (invalidated_at).
--   3. auth_challenges             estado PARCIAL de autenticação (NÃO é sessão): segredo opaco só em hash, TTL curto, uso único.
--   4. platform_bootstrap_tokens   token de ativação do Platform Owner (CLI offline): só HMAC, TTL, uso único, 1 pendente por vez.
--   5. platform_access.bootstrap_token_id
--   6. trigger deferido            titular de platform_access ativo nunca fica sem TOTP ativo no COMMIT (troca na mesma transação ok).
--   7. login_attempts.ip_prefix    chave do lock de login por (e-mail, rede) — ver docs (lock não pode ser DoS contra o owner).

CREATE TYPE mfa_method_type AS ENUM ('totp');
CREATE TYPE mfa_method_status AS ENUM ('pending', 'active', 'disabled');

CREATE TABLE mfa_methods (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type mfa_method_type NOT NULL DEFAULT 'totp',
  status mfa_method_status NOT NULL DEFAULT 'pending',
  -- iv(12) || tag(16) || ciphertext  (AES-256-GCM; AAD = "mfa:<user_id>"); nunca texto puro.
  secret_ciphertext BYTEA NOT NULL,
  secret_key_id SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_step BIGINT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_failed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT mfa_methods_active_confirmed CHECK (status <> 'active' OR confirmed_at IS NOT NULL)
);
CREATE UNIQUE INDEX mfa_methods_one_open_per_user ON mfa_methods (user_id) WHERE status IN ('pending', 'active');

CREATE TABLE mfa_recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL,
  code_hash BYTEA NOT NULL UNIQUE,
  pepper_version SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ
);
CREATE INDEX idx_mfa_recovery_codes_user_open ON mfa_recovery_codes (user_id) WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TYPE auth_challenge_purpose AS ENUM ('mfa_login', 'mfa_enroll', 'bootstrap_owner', 'owner_recovery');
CREATE TYPE auth_challenge_status AS ENUM ('pending', 'consumed', 'cancelled', 'failed');

CREATE TABLE auth_challenges (
  id BIGSERIAL PRIMARY KEY,
  secret_hash BYTEA NOT NULL UNIQUE,
  pepper_version SMALLINT NOT NULL,
  purpose auth_challenge_purpose NOT NULL,
  status auth_challenge_status NOT NULL DEFAULT 'pending',
  -- NULL só no bootstrap do owner (o usuário ainda não existe).
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  primary_method TEXT,
  bootstrap_token_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  -- Estado do bootstrap/recuperação enquanto o usuário/MFA ainda não existem (nada disto vira conta antes da transação final).
  pending_display_name TEXT,
  pending_password_hash TEXT,
  pending_secret_ciphertext BYTEA,
  pending_secret_key_id SMALLINT,
  pending_secret_step BIGINT,
  CONSTRAINT auth_challenges_user_required CHECK (user_id IS NOT NULL OR purpose = 'bootstrap_owner'),
  CONSTRAINT auth_challenges_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_auth_challenges_user_pending ON auth_challenges (user_id) WHERE status = 'pending';

CREATE TYPE platform_bootstrap_purpose AS ENUM ('owner', 'owner_recovery');

CREATE TABLE platform_bootstrap_tokens (
  id SERIAL PRIMARY KEY,
  purpose platform_bootstrap_purpose NOT NULL,
  token_hash BYTEA NOT NULL UNIQUE,
  pepper_version SMALLINT NOT NULL,
  expected_email TEXT,
  target_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  claimed_challenge_id BIGINT,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  issued_by TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT platform_bootstrap_expiry CHECK (expires_at > created_at),
  CONSTRAINT platform_bootstrap_target CHECK ((purpose = 'owner_recovery') = (target_user_id IS NOT NULL))
);
-- INVARIANTE: um único token pendente (não usado e não revogado) por vez.
CREATE UNIQUE INDEX platform_bootstrap_one_pending ON platform_bootstrap_tokens ((1)) WHERE used_at IS NULL AND revoked_at IS NULL;

ALTER TABLE platform_access ADD COLUMN bootstrap_token_id INTEGER REFERENCES platform_bootstrap_tokens(id);

-- Titular de platform_access ATIVO nunca termina uma transação sem um TOTP ativo QUANDO ele já tinha um (remoção/desativação
-- de MFA do owner/admin é recusada; a recuperação administrativa troca o método na MESMA transação). Contas ainda sem MFA
-- (migradas na Fase 89) não são afetadas: elas nunca obtêm sessão sem MFA (getServerUserSession) e se inscrevem no 1º login.
CREATE FUNCTION mfa_methods_keep_holder_protected() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'active' AND (TG_OP = 'DELETE' OR NEW.status <> 'active') THEN
    IF EXISTS (SELECT 1 FROM platform_access WHERE user_id = OLD.user_id AND status = 'active')
       AND NOT EXISTS (SELECT 1 FROM mfa_methods WHERE user_id = OLD.user_id AND status = 'active') THEN
      RAISE EXCEPTION 'mfa_methods: titular de platform_access ativo não pode ficar sem MFA ativo' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER mfa_methods_keep_holder_protected AFTER UPDATE OR DELETE ON mfa_methods
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mfa_methods_keep_holder_protected();

ALTER TABLE login_attempts ADD COLUMN ip_prefix TEXT;
CREATE INDEX idx_login_attempts_email_ip_time ON login_attempts (email, ip_prefix, attempted_at DESC);
