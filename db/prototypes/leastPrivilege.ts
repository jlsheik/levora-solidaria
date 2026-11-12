import type postgres from "postgres";

/**
 * M39 — PROTÓTIPO de privilégios mínimos do banco. NÃO é migration, NÃO é carregado pela aplicação e NÃO deve ser executado em banco operacional: só o teste
 * `test/dbLeastPrivilege.test.ts` o aplica, em PostgreSQL DESCARTÁVEL, com papéis sintéticos de senha aleatória. Nenhuma credencial real é lida ou alterada.
 *
 * Papéis (todos LOGIN apenas no protótipo; em produção a separação exigiria decisão de infraestrutura):
 *   runtime      — a aplicação. DML nas tabelas de negócio; nas tabelas APPEND-ONLY (as que têm o gatilho `audit_log_block_mutation`, incluindo `audit_log`) só SELECT+INSERT;
 *                  em `audit_chain_verifications` SELECT+INSERT e UPDATE só das colunas de resultado (o gatilho já limita a uma transição). Sem DDL, sem TRIGGER, sem TRUNCATE.
 *   auditReader  — consulta/verificação externa: SELECT em `audit_log`, verificações, comprovantes e comparações; isolamento por organização via RLS (`levora.org_id`).
 *   migrator     — migrations: CREATE no schema public; nenhum acesso aos DADOS de auditoria. (Para alterar tabelas EXISTENTES ele precisaria ser o DONO delas — mudança de deploy não
 *                  feita aqui.)
 *
 * LIMITES (não escondê-los): superusuário e DONO das tabelas continuam podendo desativar gatilhos, alterar e apagar; privilégios mínimos reduzem o raio de dano da CREDENCIAL DA
 * APLICAÇÃO, não eliminam a adulteração por quem administra o banco. O banco também não aplica o RBAC da aplicação (quem pode alterar política): `runtime` tem DML nessas tabelas.
 * RLS não vale para superusuário/dono. `runtime` ainda pode INSERIR registros novos (inclusive comprovantes), o que o banco não distingue de legítimos.
 */

export interface LeastPrivilegeRoles { runtime: string; auditReader: string; migrator: string }
export interface LeastPrivilegePasswords { runtime: string; auditReader: string; migrator: string }

const RESULT_COLUMNS = ["max_audit_id_at_start", "status", "finished_at", "total_events", "verified_events", "unhashed_events", "divergence_count", "divergences", "error_kind", "duration_ms"];
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Tabelas com o gatilho append-only do projeto (inclui `audit_log`). Descobertas no catálogo, não listadas à mão. */
export async function appendOnlyTables(admin: postgres.Sql): Promise<string[]> {
  const rows = await admin<{ t: string }[]>`
    SELECT DISTINCT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid
     WHERE NOT g.tgisinternal AND p.proname = 'audit_log_block_mutation' AND c.relnamespace = 'public'::regnamespace ORDER BY 1`;
  return rows.map((r) => r.t);
}

export async function applyLeastPrivilege(admin: postgres.Sql, roles: LeastPrivilegeRoles, pw: LeastPrivilegePasswords): Promise<{ appendOnly: string[]; dml: string[] }> {
  const all = (await admin<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).map((r) => r.t);
  const appendOnly = await appendOnlyTables(admin);
  const special = new Set(["audit_chain_verifications"]);
  const dml = all.filter((t) => !appendOnly.includes(t) && !special.has(t));

  for (const [role, pass] of [[roles.runtime, pw.runtime], [roles.auditReader, pw.auditReader], [roles.migrator, pw.migrator]] as const) {
    await admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${ident(role)} LOGIN PASSWORD '${pass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF; END $$`);
    await admin.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ident(role)}`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${ident((await admin<{ d: string }[]>`SELECT current_database() AS d`)[0].d)} TO ${ident(role)}`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${ident(role)}`);
  }
  // runtime
  for (const t of dml) await admin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(t)} TO ${ident(roles.runtime)}`);
  for (const t of appendOnly) await admin.unsafe(`GRANT SELECT, INSERT ON ${ident(t)} TO ${ident(roles.runtime)}`);
  await admin.unsafe(`GRANT SELECT, INSERT ON audit_chain_verifications TO ${ident(roles.runtime)}`);
  await admin.unsafe(`GRANT UPDATE (${RESULT_COLUMNS.join(", ")}) ON audit_chain_verifications TO ${ident(roles.runtime)}`);
  await admin.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(roles.runtime)}`);
  // auditReader
  for (const t of ["audit_log", "audit_chain_verifications", "audit_chain_receipts", "audit_chain_receipt_comparisons"]) await admin.unsafe(`GRANT SELECT ON ${ident(t)} TO ${ident(roles.auditReader)}`);
  // migrator: só DDL no schema; nenhum dado de auditoria
  await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${ident(roles.migrator)}`);
  // RLS de leitura por organização para o leitor; o runtime mantém acesso total (a aplicação já filtra por organização e a cadeia é global)
  await admin.unsafe(`ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY`);
  await admin.unsafe(`DROP POLICY IF EXISTS m39_runtime_all ON audit_log`);
  await admin.unsafe(`DROP POLICY IF EXISTS m39_reader_by_org ON audit_log`);
  await admin.unsafe(`CREATE POLICY m39_runtime_all ON audit_log FOR ALL TO ${ident(roles.runtime)} USING (true) WITH CHECK (true)`);
  await admin.unsafe(`CREATE POLICY m39_reader_by_org ON audit_log FOR SELECT TO ${ident(roles.auditReader)} USING (organization_id = NULLIF(current_setting('levora.org_id', true), '')::int)`);
  return { appendOnly, dml };
}

/** Desfaz TUDO o que o protótipo criou (para o banco de teste voltar ao estado original). */
export async function revokeLeastPrivilege(admin: postgres.Sql, roles: LeastPrivilegeRoles): Promise<void> {
  await admin.unsafe(`DROP POLICY IF EXISTS m39_runtime_all ON audit_log`);
  await admin.unsafe(`DROP POLICY IF EXISTS m39_reader_by_org ON audit_log`);
  await admin.unsafe(`ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY`);
  for (const role of [roles.runtime, roles.auditReader, roles.migrator]) {
    await admin.unsafe(`DROP TABLE IF EXISTS public.m39_migration_probe`);
    await admin.unsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN DROP OWNED BY ${ident(role)}; DROP ROLE ${ident(role)}; END IF; END $$`);
  }
}
