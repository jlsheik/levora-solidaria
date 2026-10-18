-- Fase 93 — login e cadastro com Microsoft (OIDC). Ver docs/IDENTIDADE_FASE93_MICROSOFT_AUDITORIA.md.
--
--   1. oauth_attempts.provider passa a aceitar 'microsoft' (a tentativa continua sendo estado SERVIDOR: hashes + verifier PKCE cifrado).
--   2. user_identities.provider_metadata   atributos NÃO-chave do provedor (Microsoft: oid, tid, ver, idp). A chave da identidade
--                                          continua sendo (provider, issuer, subject); o metadata nunca participa de busca de login.
-- A coluna user_identities.provider já aceitava 'microsoft'. Não toca em dados existentes.

ALTER TABLE oauth_attempts DROP CONSTRAINT oauth_attempts_provider_check;
ALTER TABLE oauth_attempts ADD CONSTRAINT oauth_attempts_provider_check CHECK (provider IN ('google', 'microsoft'));

ALTER TABLE user_identities ADD COLUMN provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE user_identities ADD CONSTRAINT user_identities_provider_metadata_object CHECK (jsonb_typeof(provider_metadata) = 'object');
