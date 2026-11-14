/**
 * Auxiliar de scripts/release-db-check.mjs (M46). Roda com DATABASE_URL apontando para um banco DESCARTÁVEL local (o orquestrador garante).
 * Modos: `seed-audit` (grava registros de auditoria sintéticos pela rotina real da aplicação, formando a cadeia de hash) · `verify` (imprime JSON com contagens, checksum de conteúdo,
 * resultado da verificação da cadeia e da prontidão da aplicação).
 */
import { sql } from "kysely";
import { db, closeDbPool } from "../src/helpers/db.js";
import { recordAuditLogEntry } from "../src/helpers/auditLog.js";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain.js";
import { checkReadiness } from "../src/helpers/readiness.js";

const mode = process.argv[2];

async function main() {
  if (mode === "seed-audit") {
    const org = await sql<{ id: number }>`select id from organizations order by id limit 1`.execute(db);
    const user = await sql<{ id: number }>`select id from users order by id limit 1`.execute(db);
    for (let i = 1; i <= 3; i++) {
      await recordAuditLogEntry({
        organizationId: org.rows[0]?.id ?? null,
        actorUserId: user.rows[0]?.id ?? null,
        action: "release_check.registro_sintetico",
        entityType: "release_check",
        entityId: String(i),
        metadata: { sintetico: true, n: i },
        outcome: "concluida",
      } as never);
    }
    console.log(JSON.stringify({ seeded: 3 }));
    return;
  }
  if (mode === "verify") {
    const tables = await sql<{ t: string }>`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`.execute(db);
    const counts: Record<string, number> = {};
    for (const { t } of tables.rows) {
      const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)}`.execute(db);
      counts[t] = Number(r.rows[0].n);
    }
    // checksum de conteúdo das tabelas sintéticas principais (ordem fixa)
    const checks: Record<string, string> = {};
    for (const t of ["users", "organizations", "needs", "audit_log"]) {
      if (!(t in counts)) continue;
      const r = await sql<{ h: string }>`select coalesce(md5(string_agg(x::text, '|' order by x::text)), 'vazio') as h from ${sql.table(t)} x`.execute(db);
      checks[t] = r.rows[0].h;
    }
    const chain = await verifyAuditLogChain();
    const unvalidated = await sql<{ n: string }>`select count(*)::text as n from pg_constraint where not convalidated`.execute(db);
    const ready = await checkReadiness(process.env.RELEASE_CHECK_MIGRATIONS_DIR ? { migrationsDir: process.env.RELEASE_CHECK_MIGRATIONS_DIR } : {});
    console.log(JSON.stringify({ counts, checks, chainIntegra: chain.integra, unvalidatedConstraints: Number(unvalidated.rows[0].n), ready }));
    return;
  }
  throw new Error("modo desconhecido");
}

main()
  .catch((e) => { console.error("release-db-check-helper falhou:", e?.code ?? e?.name ?? "erro"); process.exitCode = 1; })
  .finally(() => closeDbPool());
