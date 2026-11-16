-- F1 — RECUPERAÇÃO DE SENHA POR E-MAIL (docs/RECUPERACAO_DE_ACESSO_ESPECIFICACAO.md §3).
--
-- `password_reset_tokens`: um token de redefinição por linha. O token em si (256 bits, `randomBytes`) NUNCA é gravado: só o HMAC-SHA-256 com o pepper
-- versionado e o contexto `password-reset:v1:` (mesmo desenho de `mfa_recovery_codes` e `auth_challenges`). `token_hash` UNIQUE: o acesso é por
-- igualdade do HASH (o atacante não escolhe a pré-imagem). `pepper_version` permite rotação do pepper.
--
--   * Estado do token: ativo (`used_at` e `invalidated_at` nulos) → usado (`used_at`) | invalidado (`invalidated_at`: substituído por um pedido
--     mais recente, tentativas esgotadas ou conta tornada inelegível) | expirado (`expires_at` vencido; não precisa de marca).
--   * No máximo UM token ativo por usuário (índice único parcial): pedir de novo invalida o anterior na mesma transação.
--   * `attempts`/`max_attempts`: tentativas FALHAS de segundo fator (TOTP/código de recuperação) usando este token; ao esgotar o token é invalidado.
--   * Sem e-mail, IP ou dado pessoal na tabela (só `user_id`): minimiza dado pessoal e retenção. A retenção é curta: o próprio fluxo remove tokens
--     usados/invalidados/expirados há mais de 7 dias (limpeza oportunista no pedido), nada além dos próprios tokens.
--
-- Tabela nova e vazia: nenhuma linha existente é alterada. Preserva 0032–0040. Não toca `user_passwords`, `sessions`, `mfa_*` nem `auth_challenges`.

CREATE TABLE password_reset_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL CONSTRAINT password_reset_tokens_hash_uniq UNIQUE,
  pepper_version SMALLINT NOT NULL CONSTRAINT password_reset_tokens_pepper_chk CHECK (pepper_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT password_reset_tokens_attempts_chk CHECK (attempts >= 0),
  max_attempts SMALLINT NOT NULL DEFAULT 5 CONSTRAINT password_reset_tokens_max_attempts_chk CHECK (max_attempts BETWEEN 1 AND 20),
  CONSTRAINT password_reset_tokens_expiry_chk CHECK (expires_at > created_at),
  CONSTRAINT password_reset_tokens_final_state_chk CHECK (NOT (used_at IS NOT NULL AND invalidated_at IS NOT NULL))
);
CREATE UNIQUE INDEX idx_password_reset_tokens_one_active ON password_reset_tokens (user_id) WHERE used_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX idx_password_reset_tokens_retention ON password_reset_tokens (created_at);
