-- Fase 91 — códigos de acesso de cadastro (provisionamento de contas). Ver docs/IDENTIDADE_FASE91_AUDITORIA.md.
--
--   1. registration_access_codes  só HMAC do código (pepper versionado) + últimos 4; validade; revogação; resgate. O estado
--                                 (active | redeemed | revoked | expired) é DERIVADO — CHECKs impedem combinações inválidas.
--   2. users.registered_via_code_id  UNIQUE: prova no banco "1 código → no máximo 1 usuário", independente do UPDATE condicional.
--   3. UNIQUE parcial em redeemed_by_user_id: 1 usuário resgata no máximo 1 código.
--
-- Não toca em dados existentes: usuários anteriores (e o owner do bootstrap) ficam com registered_via_code_id NULL.

CREATE TABLE registration_access_codes (
  id SERIAL PRIMARY KEY,
  code_hash BYTEA NOT NULL UNIQUE,
  pepper_version SMALLINT NOT NULL,
  code_last4 TEXT NOT NULL CHECK (char_length(code_last4) = 4),
  label TEXT CHECK (label IS NULL OR char_length(label) <= 120),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id INTEGER REFERENCES users(id),
  redeemed_at TIMESTAMPTZ,
  redeemed_by_user_id INTEGER REFERENCES users(id),
  -- Reservado para extensão futura (código ligado a uma organização). IGNORADO na v1: código = cadastro geral.
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  CONSTRAINT registration_codes_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  CONSTRAINT registration_codes_redeemed_pair CHECK ((redeemed_at IS NULL) = (redeemed_by_user_id IS NULL)),
  CONSTRAINT registration_codes_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
  CONSTRAINT registration_codes_terminal_exclusive CHECK (NOT (redeemed_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX idx_registration_codes_created ON registration_access_codes (created_at DESC);
CREATE INDEX idx_registration_codes_open ON registration_access_codes (expires_at) WHERE redeemed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX registration_codes_one_code_per_user ON registration_access_codes (redeemed_by_user_id) WHERE redeemed_by_user_id IS NOT NULL;

ALTER TABLE users ADD COLUMN registered_via_code_id INTEGER;
ALTER TABLE users ADD CONSTRAINT users_registered_via_code_id_key UNIQUE (registered_via_code_id);
ALTER TABLE users ADD CONSTRAINT users_registered_via_code_id_fkey FOREIGN KEY (registered_via_code_id) REFERENCES registration_access_codes(id);
