/**
 * Fase 68 — ponto de entrada de `npm run seed:staging`.
 *
 * EXCLUSIVO de staging/demonstração. Ordem deliberada:
 *   1. guarda de ambiente (módulo puro — nenhuma conexão aberta ainda);
 *   2. só então `import()` dinâmico do seed (importar db.tsx abre o pool);
 *   3. seed + validação + credenciais temporárias no terminal.
 *
 * Não carrega `.env` (sem `dotenv/config`): o ambiente precisa declarar
 * explicitamente LEVORA_ENVIRONMENT=staging e DATABASE_URL — um `.env` de
 * desenvolvimento nunca "promove" este script por acidente.
 *
 * Uso: ver docs/STAGING_DEMO.md. NUNCA faz parte do processo de produção.
 */
import { assertStagingEnvironment, SeedGuardError } from "./seedStagingGuard.js";

async function main() {
  const resetPasswords = process.argv.includes("--reset-passwords");

  try {
    const guard = assertStagingEnvironment();
    console.log(`Guarda de ambiente OK — banco "${guard.database}" em "${guard.host}" (modo ${guard.mode}).`);
  } catch (error) {
    if (error instanceof SeedGuardError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }

  const { runStagingSeed } = await import("./seedStaging.js");
  const { closeDbPool } = await import("../src/helpers/db.js");

  let exitCode = 0;
  try {
    const result = await runStagingSeed({ resetPasswords });

    console.log("\n=== Validações pós-seed ===");
    for (const c of result.checks) console.log(`${c.ok ? "OK  " : "FALHA"} ${c.name} — ${c.detail}`);
    if (result.checks.some((c) => !c.ok)) exitCode = 1;

    console.log("\n=== Contagens (compare com uma segunda execução: devem ser idênticas) ===");
    for (const [table, n] of Object.entries(result.counts)) console.log(`${table.padEnd(34)} ${n}`);

    console.log(`\nEscritas via endpoints neste run: ${result.endpointWrites} | duração: ${(result.durationMs / 1000).toFixed(1)}s`);

    console.log("\n=== Credenciais TEMPORÁRIAS (exibidas só agora; não ficam em nenhum arquivo) ===");
    const anyPassword = result.credentials.some((c) => c.password);
    for (const c of result.credentials) {
      console.log(`${c.role}\n  e-mail: ${c.email}\n  senha:  ${c.password ?? "(já existia — inalterada; use --reset-passwords para gerar nova)"}`);
    }
    if (!anyPassword) {
      console.log("\nNenhuma senha nova foi gerada. Para obter novas: npm run seed:staging -- --reset-passwords");
    }
  } catch (error) {
    console.error("Seed interrompido:", error instanceof Error ? error.message : error);
    exitCode = 1;
  } finally {
    await closeDbPool().catch(() => undefined);
  }
  process.exit(exitCode);
}

void main();
