/**
 * Migração 0015 (fundação de identidade) aplicada sobre o schema ANTERIOR (HEAD a628bd4) em bancos temporários,
 * para provar o backfill de users.role='admin' → platform_access SEM adivinhar, a remoção gradual de role='admin',
 * o backfill de sessões e o aborto seguro quando há dados ambíguos (várias senhas por usuário, vários admins).
 * Banco temporário `levora_f89_mig_test` (sufixo _test — mesma guarda dos testes de integração).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const BASELINE_COMMIT = "a628bd4"; // último commit ANTES da Fase 89
const MIGRATION = readFileSync(path.resolve(__dirname, "../db/migrations/0015_identity_foundation.sql"), "utf-8").replace(/\r\n/g, "\n");
const MIGRATION_0016 = readFileSync(path.resolve(__dirname, "../db/migrations/0016_mfa_foundation.sql"), "utf-8").replace(/\r\n/g, "\n");
const MIGRATION_0017 = readFileSync(path.resolve(__dirname, "../db/migrations/0017_registration_access_codes.sql"), "utf-8").replace(/\r\n/g, "\n");
const MIGRATION_0018 = readFileSync(path.resolve(__dirname, "../db/migrations/0018_google_identity.sql"), "utf-8").replace(/\r\n/g, "\n");
const MIG_DB = "levora_f89_mig_test";

function adminUrl(): URL {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = "/postgres";
  return u;
}
function migUrl(): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${MIG_DB}`;
  return u.toString();
}

function baselineSchema(): string {
  try {
    return execFileSync("git", ["show", `${BASELINE_COMMIT}:db/schema.sql`], { cwd: path.resolve(__dirname, ".."), encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`Não foi possível ler o schema anterior (git show ${BASELINE_COMMIT}:db/schema.sql). Este teste precisa do histórico do repositório. ${(e as Error).message}`);
  }
}

let sql: postgres.Sql;

async function freshOldDatabase() {
  const admin = postgres(adminUrl().toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${MIG_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${MIG_DB}`);
  } finally {
    await admin.end();
  }
  sql = postgres(migUrl(), { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe(baselineSchema());
}

async function runMigration(designatedOwnerId?: number) {
  await sql.begin(async (trx) => {
    if (designatedOwnerId !== undefined) await trx.unsafe(`SET LOCAL levora.platform_owner_user_id = '${designatedOwnerId}'`);
    await trx.unsafe(MIGRATION);
  });
}

async function addUser(email: string, role: "admin" | "user" = "user", opts: { anonymized?: boolean } = {}) {
  const finalEmail = opts.anonymized ? `usuario-excluido-${Math.floor(Math.random() * 1e6)}@removido.invalid` : email;
  const [row] = await sql`INSERT INTO users (email, display_name, role) VALUES (${finalEmail}, ${"U " + email}, ${role}::user_role) RETURNING id`;
  return row.id as number;
}

beforeEach(async () => {
  if (sql) await sql.end();
  await freshOldDatabase();
});

afterAll(async () => {
  if (sql) await sql.end();
  const admin = postgres(adminUrl().toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${MIG_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

const access = async () => await sql`SELECT user_id, level, status, grant_origin FROM platform_access ORDER BY user_id`;

describe("migração 0015 — backfill de platform_access", () => {
  it("0 admins: nenhuma concessão; platform_state fica sem bootstrap (exige o CLI de bootstrap)", async () => {
    await addUser("a@x.com");
    await runMigration();
    expect(await access()).toHaveLength(0);
    const [state] = await sql`SELECT owner_bootstrapped_at FROM platform_state WHERE id = 1`;
    expect(state.owner_bootstrapped_at).toBeNull();
  });

  it("exatamente 1 admin: vira OWNER (migrated_from_users_role), platform_state preenchido e users.role volta a 'user'", async () => {
    const admin = await addUser("admin@x.com", "admin");
    await addUser("comum@x.com");
    await runMigration();
    expect(await access()).toEqual([{ user_id: admin, level: "owner", status: "active", grant_origin: "migrated_from_users_role" }]);
    const [state] = await sql`SELECT owner_bootstrapped_at FROM platform_state WHERE id = 1`;
    expect(state.owner_bootstrapped_at).not.toBeNull();
    expect(await sql`SELECT id FROM users WHERE role = 'admin'`).toHaveLength(0);
  });

  it("2+ admins SEM designação: a migração ABORTA (não escolhe) e NADA é aplicado (rollback)", async () => {
    await addUser("a1@x.com", "admin");
    await addUser("a2@x.com", "admin");
    await expect(runMigration()).rejects.toThrow(/Designe o Platform Owner/);
    // rollback total: a tabela nova nem existe e os admins continuam como estavam
    await expect(sql`SELECT 1 FROM platform_access`).rejects.toThrow();
    expect(await sql`SELECT id FROM users WHERE role = 'admin'`).toHaveLength(2);
  });

  it("2+ admins COM designação: o designado vira owner; os OUTROS viram usuários comuns (sem platform_access — menor privilégio); role='admin' removido de todos", async () => {
    const a1 = await addUser("a1@x.com", "admin");
    const a2 = await addUser("a2@x.com", "admin");
    const a3 = await addUser("a3@x.com", "admin");
    await runMigration(a2);
    const rows = await access();
    expect(rows.map((r) => [r.user_id, r.level, r.status])).toEqual([[a2, "owner", "active"]]);
    expect(await sql`SELECT id FROM users WHERE role = 'admin'`).toHaveLength(0);
    const roles = await sql`SELECT id, role FROM users WHERE id IN ${sql([a1, a3])} ORDER BY id`;
    expect(roles.map((r) => r.role)).toEqual(["user", "user"]);
  });

  it("designação inválida (não é admin ativo, ou diverge do único admin) ABORTA", async () => {
    const a1 = await addUser("a1@x.com", "admin");
    await addUser("a2@x.com", "admin");
    const plain = await addUser("plain@x.com");
    await expect(runMigration(plain)).rejects.toThrow(/não é um admin ativo/);
    await sql.end();
    await freshOldDatabase();
    const only = await addUser("only@x.com", "admin");
    await expect(runMigration(only + 100)).rejects.toThrow(/não é o único admin/);
    void a1;
  });

  it("'admin zumbi' (já anonimizado pela exclusão LGPD) NÃO recebe acesso e perde role='admin'", async () => {
    const zombie = await addUser("z@x.com", "admin", { anonymized: true });
    const real = await addUser("real@x.com", "admin");
    await runMigration(); // 1 admin ATIVO + 1 zumbi ⇒ sem ambiguidade
    expect((await access()).map((r) => r.user_id)).toEqual([real]);
    const [z] = await sql`SELECT role, anonymized_at FROM users WHERE id = ${zombie}`;
    expect(z.role).toBe("user");
    expect(z.anonymized_at).not.toBeNull(); // backfill de anonymized_at
  });

  it("só zumbis: nenhum acesso concedido", async () => {
    await addUser("z1@x.com", "admin", { anonymized: true });
    await runMigration();
    expect(await access()).toHaveLength(0);
  });
});

describe("migração 0015 — sessões, senhas e triggers", () => {
  it("sessões existentes ganham absolute_expires_at = created_at + 30 d, primary_method=password e continuam válidas", async () => {
    const u = await addUser("s@x.com");
    await sql`INSERT INTO sessions (id, user_id, expires_at, created_at, last_accessed) VALUES ('s1', ${u}, now() + interval '7 days', now() - interval '2 days', now())`;
    await runMigration();
    const [s] = await sql`SELECT absolute_expires_at, created_at, primary_method, mfa_verified_at, last_reauth_at FROM sessions WHERE id = 's1'`;
    expect(Math.abs(new Date(s.absolute_expires_at).getTime() - (new Date(s.created_at).getTime() + 30 * 86400000))).toBeLessThan(1000);
    expect(s.primary_method).toBe("password");
    expect(s.mfa_verified_at).toBeNull();
  });

  it("senhas duplicadas (mais de uma linha por usuário): a migração ABORTA sem alterar nada", async () => {
    const u = await addUser("dup@x.com");
    await sql`INSERT INTO user_passwords (user_id, password_hash) VALUES (${u}, 'h1'), (${u}, 'h2')`;
    await expect(runMigration()).rejects.toThrow(/mais de uma linha em user_passwords/);
    await expect(sql`SELECT 1 FROM platform_access`).rejects.toThrow();
  });

  it("depois de aplicada: UNIQUE(user_id) e trigger de role valem; usuários anonimizados antes têm anonymized_at", async () => {
    const u = await addUser("ok@x.com");
    await sql`INSERT INTO user_passwords (user_id, password_hash) VALUES (${u}, 'h1')`;
    await runMigration();
    await expect(sql`INSERT INTO user_passwords (user_id, password_hash) VALUES (${u}, 'h2')`).rejects.toThrow(/duplicate key|user_passwords_user_id_key/);
    await expect(sql`UPDATE users SET role = 'admin' WHERE id = ${u}`).rejects.toThrow(/platform_access/);
  });

  it("a migração NÃO é reaplicável por engano (objetos já existem) e o schema.sql novo cria o MESMO conjunto de objetos", async () => {
    await runMigration();
    await expect(runMigration()).rejects.toThrow();
    // schema.sql atual = baseline + 0015 + 0016 (Fase 90) + 0017 (Fase 91) + 0018 (Fase 92)
    await sql.begin((trx) => trx.unsafe(MIGRATION_0016));
    await sql.begin((trx) => trx.unsafe(MIGRATION_0017));
    await sql.begin((trx) => trx.unsafe(MIGRATION_0018));
    const migrated = await sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('platform_access','platform_state','sessions','users','user_passwords','registration_access_codes','user_identities','oauth_attempts') ORDER BY 1, 2`;
    // banco novo a partir do schema.sql ATUAL (o mesmo que a suíte usa)
    const admin = postgres(adminUrl().toString(), { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${MIG_DB}_new WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${MIG_DB}_new`);
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = `/${MIG_DB}_new`;
    const fresh = postgres(u.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await fresh.unsafe(readFileSync(path.resolve(__dirname, "../db/schema.sql"), "utf-8"));
      const created = await fresh`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('platform_access','platform_state','sessions','users','user_passwords','registration_access_codes','user_identities','oauth_attempts') ORDER BY 1, 2`;
      expect(created.map((r) => `${r.table_name}.${r.column_name}`)).toEqual(migrated.map((r) => `${r.table_name}.${r.column_name}`));
      const [{ n: triggersFresh }] = await fresh`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`;
      const [{ n: triggersMig }] = await sql`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`;
      expect(triggersFresh).toBe(triggersMig);
      const [{ n: idxFresh }] = await fresh`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'`;
      const [{ n: idxMig }] = await sql`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'`;
      expect(idxFresh).toBe(idxMig);
    } finally {
      await fresh.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${MIG_DB}_new WITH (FORCE)`);
      await admin.end();
    }
  });
});

async function snapshot(): Promise<string> {
  const cols = await sql`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`;
  const rel = await sql`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace ORDER BY 1`;
  const trg = await sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`;
  const fns = await sql`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`;
  const enums = await sql`SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e' ORDER BY 1`;
  const users = await sql`SELECT * FROM users ORDER BY id`;
  const pw = await sql`SELECT * FROM user_passwords ORDER BY id`;
  const sess = await sql`SELECT * FROM sessions ORDER BY id`;
  return JSON.stringify([cols, rel, trg, fns, enums, users, pw, sess]);
}

describe("migração 0015 — atomicidade, ordem e ausência de auto-bloqueio", () => {
  it("banco SEM nenhum usuário: a migração conclui (o trigger do último owner não bloqueia a própria migração) e deixa 0 owners", async () => {
    await runMigration();
    expect(await access()).toHaveLength(0);
    const triggers = (await sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`).map((r) => r.tgname);
    expect(triggers).toEqual(expect.arrayContaining(["platform_access_guard", "platform_access_keep_owner", "users_forbid_admin_role", "users_protect_platform_holder"]));
  });

  it("1 admin: o backfill INSERE o owner com o trigger do último owner já instalado e a migração conclui; depois o trigger está ATIVO (revogar o único owner falha)", async () => {
    const admin = await addUser("admin@x.com", "admin");
    await runMigration();
    expect((await access()).map((r) => r.user_id)).toEqual([admin]);
    await expect(sql`UPDATE platform_access SET status = 'revoked', revoked_at = now() WHERE user_id = ${admin}`).rejects.toThrow(/último Platform Owner/);
    await expect(sql`UPDATE users SET role = 'admin' WHERE id = ${admin}`).rejects.toThrow(/platform_access/);
    await expect(sql`INSERT INTO platform_access (user_id, level) VALUES (${await addUser("o2@x.com")}, 'owner')`).rejects.toThrow(/duplicate key|single_active_owner/);
  });

  it("ROLLBACK TOTAL: toda migração abortada (2 admins sem designação, designação inválida, senhas duplicadas) deixa o banco BYTE A BYTE como estava (colunas, tabelas, triggers, funções, enums e dados)", async () => {
    const a1 = await addUser("a1@x.com", "admin");
    await addUser("a2@x.com", "admin");
    const u = await addUser("u@x.com");
    await sql`INSERT INTO user_passwords (user_id, password_hash) VALUES (${u}, 'h1')`;
    await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES ('sess1', ${u}, now() + interval '1 day')`;
    const before = await snapshot();

    await expect(runMigration()).rejects.toThrow(/Designe o Platform Owner/);
    expect(await snapshot()).toBe(before);

    await expect(runMigration(u)).rejects.toThrow(/não é um admin ativo/);
    expect(await snapshot()).toBe(before);

    await expect(runMigration(a1 + 9999)).rejects.toThrow(/não é um admin ativo/);
    expect(await snapshot()).toBe(before);

    await sql`INSERT INTO user_passwords (user_id, password_hash) VALUES (${u}, 'h2')`;
    const beforeDup = await snapshot();
    await expect(runMigration(a1)).rejects.toThrow(/mais de uma linha em user_passwords/);
    expect(await snapshot()).toBe(beforeDup);
  });

  it("ORDEM: as tabelas/índices/triggers nascem ANTES do backfill e o trigger de users.role só entra DEPOIS dele (um UPDATE de role 'admin'→'user' no backfill nunca é bloqueado)", () => {
    const text = MIGRATION;
    const at = (needle: string) => text.indexOf(needle);
    const order = [
      "-- @@MIGRATION_ONLY_BEGIN", // 1. pré-checagem de senhas duplicadas
      "ALTER TABLE users ADD COLUMN anonymized_at", // 2. coluna
      "CREATE TABLE platform_access", // 3. tabela
      "CREATE UNIQUE INDEX platform_access_single_active_owner", // 4. índice de owner único
      "CREATE TABLE platform_state", // 5. singleton
      "CREATE TRIGGER platform_access_guard", // 6. guarda
      "CREATE CONSTRAINT TRIGGER platform_access_keep_owner", // 7. último owner (deferido)
      "DO $$\nDECLARE\n  admin_count", // 8. backfill (inclui UPDATE users SET role='user')
      "CREATE TRIGGER users_forbid_admin_role", // 9. veto a role='admin'
      "CREATE TRIGGER users_protect_platform_holder", // 10. veto à anonimização
      "ALTER TABLE sessions", // 11. sessões
      "ALTER TABLE user_passwords ADD CONSTRAINT user_passwords_user_id_key", // 12. UNIQUE
    ].map(at);
    for (const p of order) expect(p).toBeGreaterThanOrEqual(0);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("depois da migração o estado é válido: no máximo 1 owner e nenhum users.role='admin' (o invariante vale para qualquer cenário aceito)", async () => {
    const a = await addUser("a@x.com", "admin");
    await addUser("b@x.com", "admin");
    await addUser("c@x.com", "admin", { anonymized: true });
    await runMigration(a);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM platform_access WHERE level = 'owner' AND status = 'active'`;
    expect(n).toBe(1);
    expect(await sql`SELECT id FROM users WHERE role = 'admin'`).toHaveLength(0);
  });
});

describe("migração 0016 (MFA) sobre o estado da Fase 89", () => {
  it("aplica sem bloquear um owner migrado SEM MFA (o trigger só protege quem já tem TOTP ativo), mantém login_attempts e cria as tabelas vazias", async () => {
    const admin = await addUser("admin@x.com", "admin");
    await sql`INSERT INTO login_attempts (email, success) VALUES ('a@x.com', false)`;
    await runMigration();
    await sql.begin((trx) => trx.unsafe(MIGRATION_0016));
    expect((await access()).map((r) => r.user_id)).toEqual([admin]);
    expect(await sql`SELECT id FROM mfa_methods`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth_challenges`).toHaveLength(0);
    expect(await sql`SELECT id FROM platform_bootstrap_tokens`).toHaveLength(0);
    const [attempt] = await sql`SELECT ip_prefix FROM login_attempts`;
    expect(attempt.ip_prefix).toBeNull();
    // o owner sem TOTP continua podendo ser tratado normalmente; com TOTP ativo o trigger passa a proteger
    await sql`INSERT INTO mfa_methods (user_id, status, secret_ciphertext, secret_key_id, confirmed_at) VALUES (${admin}, 'active', decode('00', 'hex'), 1, now())`;
    await expect(sql`DELETE FROM mfa_methods WHERE user_id = ${admin}`).rejects.toThrow(/sem MFA ativo/);
    await expect(sql`INSERT INTO platform_bootstrap_tokens (purpose, token_hash, pepper_version, expires_at, issued_by) VALUES ('owner', decode('01', 'hex'), 1, now() + interval '1 minute', 'a'), ('owner', decode('02', 'hex'), 1, now() + interval '1 minute', 'b')`).rejects.toThrow(/one_pending|duplicate key/);
  });

  it("a migração é atômica: falhando no meio (tipo já existente), nada do 0016 fica", async () => {
    await runMigration();
    await sql`CREATE TYPE auth_challenge_status AS ENUM ('x')`; // conflito no meio do arquivo
    await expect(sql.begin((trx) => trx.unsafe(MIGRATION_0016))).rejects.toThrow();
    await expect(sql`SELECT 1 FROM mfa_methods`).rejects.toThrow();
    await expect(sql`SELECT 1 FROM platform_bootstrap_tokens`).rejects.toThrow();
  });
});

describe("migração 0017 (códigos de acesso) sobre o estado da Fase 90", () => {
  it("aplica sem tocar nos usuários existentes (registered_via_code_id NULL), cria a tabela vazia e a UNIQUE por código", async () => {
    const existing = await addUser("antigo@x.com");
    await runMigration();
    await sql.begin((trx) => trx.unsafe(MIGRATION_0016));
    await sql.begin((trx) => trx.unsafe(MIGRATION_0017));
    expect(await sql`SELECT id FROM registration_access_codes`).toHaveLength(0);
    const [u] = await sql`SELECT registered_via_code_id FROM users WHERE id = ${existing}`;
    expect(u.registered_via_code_id).toBeNull();
    const [code] = await sql`INSERT INTO registration_access_codes (code_hash, pepper_version, code_last4, created_by_user_id, expires_at) VALUES (decode(repeat('01', 32), 'hex'), 1, 'ABCD', ${existing}, now() + interval '1 day') RETURNING id`;
    const second = await addUser("segundo@x.com");
    await sql`UPDATE users SET registered_via_code_id = ${code.id} WHERE id = ${existing}`;
    await expect(sql`UPDATE users SET registered_via_code_id = ${code.id} WHERE id = ${second}`).rejects.toThrow(/registered_via_code/);
    await expect(sql`INSERT INTO registration_access_codes (code_hash, pepper_version, code_last4, created_by_user_id, expires_at) VALUES (decode(repeat('02', 32), 'hex'), 1, 'ABCD', ${existing}, now() + interval '100 days')`).rejects.toThrow(/check/i);
  });

  it("a migração é atômica: falhando no meio (tabela já existente), a coluna de users não fica", async () => {
    await runMigration();
    await sql.begin((trx) => trx.unsafe(MIGRATION_0016));
    await sql`CREATE TABLE registration_access_codes (x int)`; // conflito logo no início do arquivo
    await expect(sql.begin((trx) => trx.unsafe(MIGRATION_0017))).rejects.toThrow();
    const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'registered_via_code_id'`;
    expect(cols).toHaveLength(0);
  });
});

describe("migração 0018 (Google: user_identities + oauth_attempts) sobre o estado da Fase 91", () => {
  it("aplica sem tocar nos dados existentes; UNIQUE(provider,issuer,subject); CHECK: signup SEMPRE com código, login NUNCA", async () => {
    const existing = await addUser("antigo@x.com");
    await runMigration();
    await sql.begin((trx) => trx.unsafe(MIGRATION_0016));
    await sql.begin((trx) => trx.unsafe(MIGRATION_0017));
    await sql.begin((trx) => trx.unsafe(MIGRATION_0018));
    expect(await sql`SELECT id FROM user_identities`).toHaveLength(0);
    expect(await sql`SELECT id FROM oauth_attempts`).toHaveLength(0);
    const other = await addUser("outro@x.com");
    await sql`INSERT INTO user_identities (user_id, provider, issuer, subject) VALUES (${existing}, 'google', 'https://accounts.google.com', 'S1')`;
    await expect(sql`INSERT INTO user_identities (user_id, provider, issuer, subject) VALUES (${other}, 'google', 'https://accounts.google.com', 'S1')`).rejects.toThrow(/user_identities_provider_issuer_subject_key/);
    await sql`INSERT INTO user_identities (user_id, provider, issuer, subject) VALUES (${other}, 'google', 'https://accounts.google.com', 'S2')`;
    const attempt = (intent: string, code: string) => sql.unsafe(`INSERT INTO oauth_attempts (state_hash, binding_hash, nonce_hash, pepper_version, pkce_verifier_ct, pkce_key_id, provider, intent, access_code_id, expires_at) VALUES (decode(md5(random()::text) || md5(random()::text), 'hex'), decode('00','hex'), decode('00','hex'), 1, decode('00','hex'), 1, 'google', '${intent}', ${code}, now() + interval '10 minutes')`);
    await expect(attempt("signup", "NULL")).rejects.toThrow(/oauth_attempts_code_iff_signup/);
    await attempt("login", "NULL");
  });

  it("a migração é atômica: falhando no meio (tabela já existente), user_identities não fica", async () => {
    await runMigration();
    await sql.begin((trx) => trx.unsafe(MIGRATION_0016));
    await sql.begin((trx) => trx.unsafe(MIGRATION_0017));
    await sql`CREATE TABLE oauth_attempts (x int)`;
    await expect(sql.begin((trx) => trx.unsafe(MIGRATION_0018))).rejects.toThrow();
    await expect(sql`SELECT 1 FROM user_identities`).rejects.toThrow();
  });
});
