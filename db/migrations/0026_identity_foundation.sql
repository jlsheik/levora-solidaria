-- Fase 89 — Fundação de identidade (docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md, §25.1, §25.3, §25.15, §25.16).
--
--   1. platform_access  — poder de plataforma separado da identidade (owner | admin), no máximo 1 owner ativo.
--   2. backfill         — users.role='admin' → platform_access, de forma determinística (não adivinha).
--   3. users.role       — 'admin' deixa de ser aceito (trigger); a coluna fica por compatibilidade.
--   4. último owner     — trigger deferido: nunca sai o último Platform Owner ativo; transferência na mesma transação.
--   5. users.anonymized_at + trigger: titular de platform_access ativo não pode ser anonimizado.
--   6. sessions         — absolute_expires_at (imposto), primary_method, mfa_verified_at, last_reauth_at.
--   7. user_passwords   — UNIQUE(user_id).
--
-- Numeração: originalmente 0015 (branch fase-89-identidade). Renumerada para 0026 na integração com a master, que já ocupa 0014–0025 com outras migrações.
-- Mapa: 0015→0026 identity_foundation, 0016→0027 mfa_foundation, 0017→0028 registration_access_codes, 0018→0029 google_identity, 0019→0030 social_reauth, 0020→0031 microsoft_identity.
-- O runner registra o NOME do arquivo: um banco que aplicou os nomes antigos (0015_identity_foundation.sql etc.) NÃO pode receber estes arquivos sem verificação (ver docs/IDENTIDADE_INTEGRACAO_MIGRATIONS.md).
--
-- POLÍTICA DE DESIGNAÇÃO (Platform Owner): NINGUÉM é promovido por contagem. Existindo QUALQUER users.role='admin' ativo, a migração exige a designação explícita
-- do responsável e aborta (rollback total) sem ela, com valor inválido, ou se o designado não for um admin legado ativo:
--   PGOPTIONS="-c levora.platform_owner_user_id=<id>"  npm run db:migrate:incremental      (db/connectionOptions.ts aceita SÓ este parâmetro, uma única vez)
-- Só o designado recebe platform_access (owner); os demais admins viram usuários comuns (menor privilégio) e o aviso lista os ids. Sem NENHUM admin legado ativo
-- nada é promovido, platform_state fica sem bootstrap e o owner nasce pelo bootstrap offline autorizado (npm run platform:bootstrap-owner); informar uma designação
-- nesse caso também aborta (a designação não corresponderia a ninguém). O preflight (db:preflight) verifica as mesmas condições sem alterar nada.
-- Os trechos entre os marcadores MIGRATION_ONLY só rodam em banco existente; db/schema.sql (banco novo) os omite.

-- @@MIGRATION_ONLY_BEGIN
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_passwords GROUP BY user_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Migração abortada: existem usuários com mais de uma linha em user_passwords. Resolva as duplicatas manualmente antes de aplicar UNIQUE(user_id).';
  END IF;
END $$;
-- @@MIGRATION_ONLY_END

-- ------------------------------------------------------------
-- users.anonymized_at
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN anonymized_at TIMESTAMPTZ;

-- @@MIGRATION_ONLY_BEGIN
UPDATE users SET anonymized_at = COALESCE(updated_at, now())
 WHERE email LIKE 'usuario-excluido-%@removido.invalid' AND anonymized_at IS NULL;
-- @@MIGRATION_ONLY_END

-- ------------------------------------------------------------
-- platform_access
-- ------------------------------------------------------------
CREATE TYPE platform_access_level AS ENUM ('owner', 'admin');
CREATE TYPE platform_access_status AS ENUM ('active', 'revoked');

CREATE TABLE platform_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  level platform_access_level NOT NULL,
  status platform_access_status NOT NULL DEFAULT 'active',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = não foi um usuário que concedeu (migração, bootstrap offline, seed sintético de staging).
  granted_by_user_id INTEGER REFERENCES users(id),
  grant_origin TEXT NOT NULL DEFAULT 'owner_grant',
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id INTEGER REFERENCES users(id),
  revoked_reason TEXT,
  CONSTRAINT platform_access_status_consistency CHECK ((status = 'active') = (revoked_at IS NULL))
);

-- INVARIANTE: no máximo UM Platform Owner ativo (mesmo sob concorrência).
CREATE UNIQUE INDEX platform_access_single_active_owner ON platform_access ((1)) WHERE level = 'owner' AND status = 'active';
CREATE INDEX idx_platform_access_active ON platform_access (level) WHERE status = 'active';

-- Singleton reservado para o bootstrap offline (Fase 90); preenchido pelo backfill quando já existe owner.
CREATE TABLE platform_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  owner_bootstrapped_at TIMESTAMPTZ
);
INSERT INTO platform_state (id) VALUES (1);

CREATE FUNCTION platform_access_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_access: linhas não são apagadas; use status = revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'platform_access: user_id é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER platform_access_guard BEFORE UPDATE OR DELETE ON platform_access FOR EACH ROW EXECUTE FUNCTION platform_access_guard();

-- Último owner: uma mudança que remove/rebaixa/revoga um owner ATIVO só é aceita se, no COMMIT, existir um owner ativo.
-- Deferido de propósito: a transferência (antigo → admin, novo → owner) acontece na MESMA transação.
CREATE FUNCTION platform_access_keep_owner() RETURNS trigger AS $$
BEGIN
  IF OLD.level = 'owner' AND OLD.status = 'active'
     AND NOT (TG_OP = 'UPDATE' AND NEW.level = 'owner' AND NEW.status = 'active') THEN
    IF NOT EXISTS (SELECT 1 FROM platform_access WHERE level = 'owner' AND status = 'active') THEN
      RAISE EXCEPTION 'platform_access: o último Platform Owner ativo não pode ser removido, rebaixado ou revogado' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER platform_access_keep_owner AFTER UPDATE OR DELETE ON platform_access
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_access_keep_owner();

-- ------------------------------------------------------------
-- Backfill: users.role = 'admin' → platform_access (determinístico; não adivinha)
-- ------------------------------------------------------------
-- @@MIGRATION_ONLY_BEGIN
DO $$
DECLARE
  admin_count INTEGER;
  designated_raw TEXT := NULLIF(current_setting('levora.platform_owner_user_id', true), '');
  designated INTEGER;
BEGIN
  IF designated_raw IS NOT NULL THEN
    IF designated_raw !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'Migração abortada: levora.platform_owner_user_id inválido (esperado: inteiro positivo de até 9 dígitos).';
    END IF;
    designated := designated_raw::INTEGER;
  END IF;

  SELECT count(*) INTO admin_count FROM users WHERE role = 'admin' AND anonymized_at IS NULL;

  IF admin_count = 0 THEN
    IF designated IS NOT NULL THEN
      RAISE EXCEPTION 'Migração abortada: levora.platform_owner_user_id=% foi informado, mas não existe administrador legado ativo para designar. Nada é promovido; retire a designação e use o bootstrap offline (npm run platform:bootstrap-owner).', designated;
    END IF;
  ELSE
    IF designated IS NULL THEN
      RAISE EXCEPTION 'Migração abortada: existem % usuário(s) com role=admin. Designe o Platform Owner explicitamente (PGOPTIONS="-c levora.platform_owner_user_id=<id>"); o sistema não promove ninguém apenas por contagem.', admin_count;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = designated AND role = 'admin' AND anonymized_at IS NULL) THEN
      RAISE EXCEPTION 'Migração abortada: o usuário designado (%) não é um admin ativo.', designated;
    END IF;

    INSERT INTO platform_access (user_id, level, status, grant_origin) VALUES (designated, 'owner', 'active', 'migrated_from_users_role');
    -- Regra de menor privilégio: os OUTROS admins NÃO recebem platform_access (viram usuários comuns). O owner pode reconceder o nível admin depois, de forma
    -- auditada. Nada é perdido em silêncio: os ids ficam no aviso abaixo (o log do runner é a evidência; arquive-o junto do backup anterior à migração).
    IF admin_count > 1 THEN
      RAISE NOTICE 'platform_access: owner = % (designado); admins sem acesso de plataforma após a migração: %', designated,
        (SELECT string_agg(id::text, ', ' ORDER BY id) FROM users WHERE role = 'admin' AND anonymized_at IS NULL AND id <> designated);
    ELSE
      RAISE NOTICE 'platform_access: owner = % (designado); nenhum outro admin ativo', designated;
    END IF;
    UPDATE platform_state SET owner_bootstrapped_at = now() WHERE id = 1;
  END IF;

  -- Remoção gradual: nenhuma linha fica com role='admin' (inclui "admins zumbis" já anonimizados, que não recebem acesso).
  UPDATE users SET role = 'user' WHERE role = 'admin';
END $$;
-- @@MIGRATION_ONLY_END

-- users.role = 'admin' deixa de ser aceito: a autorização de plataforma é platform_access.
CREATE FUNCTION users_forbid_admin_role() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'admin' THEN
    RAISE EXCEPTION 'users.role = admin não é mais permitido; a autorização de plataforma é platform_access' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_forbid_admin_role BEFORE INSERT OR UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION users_forbid_admin_role();

-- Titular de platform_access ATIVO nunca é anonimizado (evita "admin sem identidade" e conta de plataforma apagada por LGPD).
CREATE FUNCTION users_protect_platform_holder() RETURNS trigger AS $$
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL
     AND EXISTS (SELECT 1 FROM platform_access WHERE user_id = NEW.id AND status = 'active') THEN
    RAISE EXCEPTION 'users: titular de platform_access ativo não pode ser anonimizado; revogue/transfira o acesso antes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_protect_platform_holder BEFORE UPDATE OF anonymized_at ON users FOR EACH ROW EXECUTE FUNCTION users_protect_platform_holder();

-- ------------------------------------------------------------
-- sessions
-- ------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN absolute_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  ADD COLUMN primary_method TEXT,
  ADD COLUMN mfa_verified_at TIMESTAMPTZ,
  ADD COLUMN last_reauth_at TIMESTAMPTZ;

-- @@MIGRATION_ONLY_BEGIN
UPDATE sessions SET absolute_expires_at = COALESCE(created_at, now()) + interval '30 days', primary_method = 'password';
-- @@MIGRATION_ONLY_END

-- ------------------------------------------------------------
-- user_passwords: 0..1 senha por usuário
-- ------------------------------------------------------------
ALTER TABLE user_passwords ADD CONSTRAINT user_passwords_user_id_key UNIQUE (user_id);
