-- Fase 92 — identidades externas (Google OIDC) e tentativas OAuth (state/nonce/PKCE). Ver docs/IDENTIDADE_FASE92_GOOGLE_AUDITORIA.md.
--
--   1. user_identities  chave da identidade = (provider, issuer, subject). E-mail é só ATRIBUTO (snapshot). UNIQUE barra a mesma
--                       identidade externa em dois usuários. Nenhum token do provedor é armazenado.
--   2. oauth_attempts   estado SERVIDOR de um fluxo de login/cadastro social: só hashes de state/nonce/vínculo, o verifier PKCE
--                       CIFRADO e o access_code_id (o código de acesso nunca viaja na URL). Uso único (status), TTL curto.
-- Não toca em dados existentes.

CREATE TABLE user_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'apple')),
  issuer TEXT NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 255),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  email_snapshot TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  CONSTRAINT user_identities_provider_issuer_subject_key UNIQUE (provider, issuer, subject)
);
CREATE INDEX idx_user_identities_user ON user_identities (user_id);

CREATE TABLE oauth_attempts (
  id BIGSERIAL PRIMARY KEY,
  state_hash BYTEA NOT NULL UNIQUE,
  binding_hash BYTEA NOT NULL,
  nonce_hash BYTEA NOT NULL,
  pepper_version SMALLINT NOT NULL,
  pkce_verifier_ct BYTEA NOT NULL,
  pkce_key_id SMALLINT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  intent TEXT NOT NULL CHECK (intent IN ('login', 'signup')),
  access_code_id INTEGER REFERENCES registration_access_codes(id),
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'processing', 'completed', 'failed')),
  ip_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  CONSTRAINT oauth_attempts_expiry CHECK (expires_at > created_at),
  -- cadastro SEMPRE carrega o código; login NUNCA (login não cria conta e não consome nada)
  CONSTRAINT oauth_attempts_code_iff_signup CHECK ((intent = 'signup') = (access_code_id IS NOT NULL))
);
CREATE INDEX idx_oauth_attempts_expires ON oauth_attempts (expires_at);
