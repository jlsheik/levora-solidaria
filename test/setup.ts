/**
 * Roda antes de cada arquivo de teste (vitest setupFiles). Garante DATABASE_URL
 * apontando para o banco de teste antes de qualquer módulo do app (ex:
 * src/helpers/db.tsx) ser importado, e trunca todas as tabelas de negócio
 * entre testes para que cada teste comece de um estado limpo e previsível.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env.test") });

if (!process.env.DATABASE_URL?.endsWith("_test")) {
  throw new Error(
    'DATABASE_URL de teste precisa apontar para um banco cujo nome termine em "_test" (ver .env.test). Abortando para não truncar o banco de desenvolvimento por engano.'
  );
}

const { beforeEach, afterAll } = await import("vitest");
const { db } = await import("../src/helpers/db");
const { resetAllRateLimitsForTests } = await import("../src/helpers/rateLimit");

// audit_log, stock_transactions e logistics_events são append-only (triggers
// de banco bloqueiam DELETE) — TRUNCATE ainda é permitido porque não passa
// pelo trigger de linha, e é isto que usamos para limpar entre testes.
const TABLES_IN_DEPENDENCY_ORDER = [
  "audit_chain_receipt_comparisons",
  "audit_chain_receipts",
  "audit_chain_verifications",
  "opportunity_changes",
  "agent_event_reevaluations",
  "agent_event_run_history",
  "agent_event_runs",
  "exception_decisions",
  "exception_queue",
  "integrity_alerts",
  "domain_event_consumptions",
  "domain_events",
  "policy_limits",
  "automation_controls",
  "files",
  "matching_run_needs",
  "match_evaluations",
  "matching_runs",
  "approval_requests",
  "logistics_events",
  "opportunity_allocations",
  "opportunity_registry",
  "sources",
  "background_task_runs",
  "donation_opportunities",
  "needs",
  "stock_transactions",
  "inventory_items",
  "audit_log",
  "agent_principals",
  "organization_invites",
  "organization_capacities",
  "organization_matching_settings",
  "organization_service_areas",
  "memberships",
  "organizations",
  "sessions",
  "login_attempts",
  "oauth_attempts",
  "user_identities",
  "registration_access_codes",
  "user_passwords",
  "users",
];

beforeEach(async () => {
  await truncateAll();
  resetAllRateLimitsForTests();
});

async function truncateAll() {
  const { sql } = await import("kysely");
  await sql
    .raw(`TRUNCATE TABLE ${TABLES_IN_DEPENDENCY_ORDER.join(", ")} RESTART IDENTITY CASCADE`)
    .execute(db);
}

afterAll(async () => {
  await db.destroy();
});
