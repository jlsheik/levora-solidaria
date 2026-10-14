/**
 * Pré-verificação de DADOS LEGADOS antes de `npm run db:migrate:incremental` — SOMENTE LEITURA.
 *
 * Três migrações criam restrições que dados antigos, válidos no baseline histórico, podem violar (provado em test/schemaMigrationsData.test.ts):
 *   0005  CHECK (quantity IS NULL OR quantity > 0)                     em opportunity_registry
 *   0007  UNIQUE (allocation_id) WHERE allocation_id IS NOT NULL       em match_evaluations
 *   0013  UNIQUE (LOWER(email))                                        em users
 * O runner aplica cada migração numa transação, mas as anteriores já foram confirmadas quando a falha acontece. Esta verificação roda ANTES da primeira escrita do
 * runner e só avalia as migrações realmente PENDENTES. Ela não corrige nada, não cria tabela (nem `schema_migrations`), usa transação READ ONLY e não imprime e-mails:
 * os registros são identificados por id.
 *
 * Estados por migração: ja-aplicada (registrada e com o objeto presente) · pendente (verificada: limpa ou com conflito) · estrutura-ausente (a tabela/coluna não existe: não é o
 * ponto histórico esperado) · inconsistente (registro e objeto não batem) · nao-verificada (erro). Qualquer coisa diferente de "tudo limpo" NÃO autoriza a atualização.
 */
import type postgres from "postgres";

export type CheckState = "ja-aplicada" | "pendente-limpa" | "pendente-com-conflito" | "estrutura-ausente" | "inconsistente";
export type PreflightStatus = "autorizada" | "bloqueada-por-dados" | "bloqueada-por-estado" | "nao-verificada";
export const PREFLIGHT_EXIT = { OK: 0, BLOCKED: 2, UNVERIFIED: 3 } as const;
export const MAX_IDS_SHOWN = 20;

interface Check {
  migration: string;
  /** O que a restrição exige (documentação do bloqueio). */
  rule: string;
  /** Tabela.coluna que precisam existir para a consulta de dados poder rodar. */
  requires: Array<{ table: string; column: string }>;
  /** Como saber se a restrição já existe no banco. */
  objectExists: string;
  /** Linhas que IMPEDEM a criação: `ids` e, se houver, `grupo` (nunca dados pessoais). */
  conflictQuery: string;
  fixHint: string;
}

export const CHECKS: readonly Check[] = [
  {
    migration: "0005_opportunity_registry_quantity_check.sql",
    rule: "opportunity_registry.quantity deve ser NULL ou > 0",
    requires: [{ table: "opportunity_registry", column: "quantity" }, { table: "opportunity_registry", column: "id" }],
    objectExists: `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_registry_quantity_positive_chk' AND conrelid = 'public.opportunity_registry'::regclass) AS e`,
    // negação exata da expressão do CHECK: o CHECK só falha quando a expressão é FALSE (NULL passa)
    conflictQuery: `SELECT array_agg(id ORDER BY id) AS ids, count(*)::int AS n FROM opportunity_registry WHERE NOT (quantity IS NULL OR quantity > 0)`,
    fixHint: "corrija a quantidade (ou ajuste o registro) de cada oportunidade listada; não é permitido 0 nem valor negativo",
  },
  {
    migration: "0007_need_fulfillments_fk_restrict.sql",
    rule: "no máximo UMA avaliação (match_evaluations) por allocation_id não nulo",
    requires: [{ table: "match_evaluations", column: "allocation_id" }, { table: "match_evaluations", column: "id" }],
    objectExists: `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_match_evaluations_allocation_id') AS e`,
    // mesma chave do índice único parcial: allocation_id, apenas onde não é NULL
    conflictQuery: `SELECT array_agg(g.ids_txt ORDER BY g.allocation_id) AS ids, sum(g.n)::int AS n FROM (SELECT allocation_id, count(*) AS n, array_to_string(array_agg(id ORDER BY id), ',') AS ids_txt FROM match_evaluations WHERE allocation_id IS NOT NULL GROUP BY allocation_id HAVING count(*) > 1) g`,
    fixHint: "para cada grupo de avaliações listado (ids separados por vírgula), mantenha uma e desvincule as demais (allocation_id = NULL) depois de decidir qual vale",
  },
  {
    migration: "0013_users_email_case_insensitive.sql",
    rule: "users.email único sem diferenciar maiúsculas/minúsculas (índice sobre LOWER(email))",
    requires: [{ table: "users", column: "email" }, { table: "users", column: "id" }],
    objectExists: `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_users_email_lower') AS e`,
    // a MESMA expressão e a MESMA collation do índice: agrupar por LOWER(email) usa a igualdade que o índice único usaria. Só ids saem.
    conflictQuery: `SELECT array_agg(g.ids_txt ORDER BY g.first_id) AS ids, sum(g.n)::int AS n FROM (SELECT min(id) AS first_id, count(*) AS n, array_to_string(array_agg(id ORDER BY id), ',') AS ids_txt FROM users GROUP BY LOWER(email) HAVING count(*) > 1) g`,
    fixHint: "para cada grupo de contas listado (ids separados por vírgula), decida qual conta mantém o e-mail e altere/consolide as outras manualmente",
  },
];

export interface CheckResult { migration: string; rule: string; state: CheckState; detail: string; offendingGroups?: string[]; conflictingRows?: number; fixHint?: string }
export interface PreflightResult {
  status: PreflightStatus;
  exitCode: number;
  pendingMigrations: string[];
  results: CheckResult[];
  warnings: string[];
  failure?: string;
}

type Sql = Pick<postgres.Sql, "begin">;

/** Executa a verificação numa transação READ ONLY. `migrationFiles` = nomes em db/migrations (ordenados). */
export async function runPreflight(sql: Sql, migrationFiles: string[]): Promise<PreflightResult> {
  try {
    return await (sql.begin("read only", async (tx) => evaluate(tx as unknown as postgres.Sql, migrationFiles)) as Promise<PreflightResult>);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { status: "nao-verificada", exitCode: PREFLIGHT_EXIT.UNVERIFIED, pendingMigrations: [], results: [], warnings: [], failure: `a verificação não pôde ser concluída (${e instanceof Error ? e.name : "erro"}${code ? ` ${code}` : ""}); a atualização NÃO está autorizada` };
  }
}

async function evaluate(tx: postgres.Sql, files: string[]): Promise<PreflightResult> {
  const warnings: string[] = [];
  const hasTable = (await tx`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS e`)[0].e as boolean;
  const applied = new Set<string>(hasTable ? (await tx`SELECT id FROM schema_migrations`).map((r) => String(r.id)) : []);
  if (!hasTable) warnings.push("schema_migrations não existe: nenhuma migração está registrada (todas serão tratadas como pendentes)");
  const known = new Set(files);
  const unknown = [...applied].filter((id) => !known.has(id));
  if (unknown.length) warnings.push(`schema_migrations registra ${unknown.length} migração(ões) que esta versão do código não conhece (${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""})`);
  const pending = files.filter((f) => !applied.has(f));

  const results: CheckResult[] = [];
  for (const c of CHECKS) {
    const isApplied = applied.has(c.migration);
    if (!known.has(c.migration)) { results.push({ migration: c.migration, rule: c.rule, state: "inconsistente", detail: "o arquivo da migração não existe nesta versão do código" }); continue; }
    // colunas necessárias existem?
    const cols = await tx`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
    const have = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = c.requires.filter((r) => !have.has(`${r.table}.${r.column}`));
    if (missing.length) {
      results.push({ migration: c.migration, rule: c.rule, state: "estrutura-ausente", detail: `falta ${missing.map((m) => `${m.table}.${m.column}`).join(", ")}: o banco não está no ponto histórico esperado (instalação nova? use \`npm run db:migrate\`; banco antigo? investigue)` });
      continue;
    }
    const exists = (await tx.unsafe(c.objectExists))[0].e as boolean;
    if (isApplied && exists) { results.push({ migration: c.migration, rule: c.rule, state: "ja-aplicada", detail: "registrada em schema_migrations e a restrição existe" }); continue; }
    if (isApplied && !exists) { results.push({ migration: c.migration, rule: c.rule, state: "inconsistente", detail: "registrada como aplicada em schema_migrations, mas a restrição NÃO existe no banco (alguém a removeu?)" }); continue; }
    if (!isApplied && exists) { results.push({ migration: c.migration, rule: c.rule, state: "inconsistente", detail: "NÃO registrada em schema_migrations, mas a restrição já existe (banco criado de db/schema.sql sem registrar as migrações, ou aplicação manual): o runner falharia ao recriá-la" }); continue; }
    // pendente e com a estrutura necessária: consulta de dados
    const row = (await tx.unsafe(c.conflictQuery))[0] as unknown as { ids: Array<number | string> | null; n: number | null };
    const n = Number(row.n ?? 0);
    if (n === 0) { results.push({ migration: c.migration, rule: c.rule, state: "pendente-limpa", detail: "pendente; nenhum registro impede a criação da restrição" }); continue; }
    const groups = (row.ids ?? []).map(String);
    results.push({ migration: c.migration, rule: c.rule, state: "pendente-com-conflito", detail: `${n} registro(s) impedem a criação da restrição`, offendingGroups: groups.slice(0, MAX_IDS_SHOWN).concat(groups.length > MAX_IDS_SHOWN ? [`… e mais ${groups.length - MAX_IDS_SHOWN}`] : []), conflictingRows: n, fixHint: c.fixHint });
  }

  const dataBlocked = results.some((r) => r.state === "pendente-com-conflito");
  const stateBlocked = results.some((r) => r.state === "estrutura-ausente" || r.state === "inconsistente");
  // sem migração pendente não há atualização a autorizar: estado estranho vira aviso, não bloqueio
  if (pending.length === 0 && stateBlocked && !dataBlocked) {
    for (const r of results.filter((x) => x.state === "estrutura-ausente" || x.state === "inconsistente")) warnings.push(`${r.migration}: ${r.detail}`);
    return { status: "autorizada", exitCode: PREFLIGHT_EXIT.OK, pendingMigrations: pending, results, warnings };
  }
  const status: PreflightStatus = dataBlocked ? "bloqueada-por-dados" : stateBlocked ? "bloqueada-por-estado" : "autorizada";
  return { status, exitCode: status === "autorizada" ? PREFLIGHT_EXIT.OK : PREFLIGHT_EXIT.BLOCKED, pendingMigrations: pending, results, warnings };
}

/** Texto para o terminal: ids e contagens, nunca e-mails ou outros dados pessoais. */
export function formatPreflight(r: PreflightResult): string {
  const lines = [`Pré-verificação de dados legados — ${r.status.toUpperCase()} (código de saída ${r.exitCode})`];
  if (r.failure) lines.push(r.failure);
  lines.push(`Migrações pendentes: ${r.pendingMigrations.length ? r.pendingMigrations.length : "nenhuma"}`);
  for (const c of r.results) {
    lines.push(`  [${c.state}] ${c.migration} — ${c.rule}`, `      ${c.detail}`);
    if (c.offendingGroups) { lines.push(`      ids impeditivos: ${c.offendingGroups.join(" | ")}`); if (c.fixHint) lines.push(`      como corrigir: ${c.fixHint}`); }
  }
  for (const w of r.warnings) lines.push(`  aviso: ${w}`);
  if (r.status !== "autorizada") lines.push("A atualização NÃO foi iniciada: nenhum dado foi alterado e nenhuma migração foi aplicada nem registrada. Corrija o que está listado e rode o comando de novo.");
  return lines.join("\n");
}
