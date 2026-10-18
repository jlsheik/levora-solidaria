/**
 * Pré-verificação de DADOS LEGADOS antes de `npm run db:migrate:incremental` — SOMENTE LEITURA.
 *
 * Migrações que criam restrições que dados antigos podem violar (as três primeiras provadas em test/schemaMigrationsData.test.ts):
 *   0005  CHECK (quantity IS NULL OR quantity > 0)                     em opportunity_registry
 *   0007  UNIQUE (allocation_id) WHERE allocation_id IS NOT NULL       em match_evaluations
 *   0009  UNIQUE (reverses_fulfillment_id) WHERE entry_type='reversal' em need_fulfillments
 *   0010  FK (stock_transaction_id, organization_id) → stock_transactions   em need_fulfillments
 *   0013  UNIQUE (LOWER(email))                                        em users
 * COMO uma migração nova entra aqui (ou é declarada segura) está em db/migrationCompat.ts — o contrato é testado em test/migrationCompat.test.ts.
 * O runner aplica cada migração numa transação, mas as anteriores já foram confirmadas quando a falha acontece. Esta verificação roda ANTES da primeira escrita do
 * runner e só avalia as migrações realmente PENDENTES. Ela não corrige nada, não cria tabela (nem `schema_migrations`), usa transação READ ONLY e não imprime e-mails:
 * os registros são identificados por id.
 *
 * Estados por migração: ja-aplicada (registrada e com o objeto presente) · pendente (verificada: limpa ou com conflito) · estrutura-ausente (a tabela/coluna não existe: não é o
 * ponto histórico esperado) · inconsistente (registro e objeto não batem) · nao-verificada (erro). Qualquer coisa diferente de "tudo limpo" NÃO autoriza a atualização.
 */
import type postgres from "postgres";
import { MIGRATION_COMPAT } from "./migrationCompat.js";

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
  /**
   * Migrações que criam/alteram a estrutura exigida acima. Se a estrutura ainda não existe PORQUE uma delas está pendente, a tabela/coluna nasce vazia dentro desta mesma
   * atualização: não há linha antiga a violar a restrição (verificação vazia = limpa). Se nenhuma está pendente e a estrutura falta, é "estrutura-ausente" (bloqueia).
   */
  providedBy?: string[];
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
  {
    migration: "0009_need_fulfillments_inheritance_rules.sql",
    rule: "no máximo UMA reversão (need_fulfillments.entry_type = 'reversal') por reverses_fulfillment_id",
    requires: [{ table: "need_fulfillments", column: "id" }, { table: "need_fulfillments", column: "entry_type" }, { table: "need_fulfillments", column: "reverses_fulfillment_id" }],
    providedBy: ["0006_need_fulfillments.sql", "0008_need_fulfillments_ledger_of_events.sql"],
    objectExists: `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_need_fulfillments_one_reversal_per_target') AS e`,
    // mesma chave do índice único parcial; NULL não conta (o índice trata NULLs como distintos)
    conflictQuery: `SELECT array_agg(g.ids_txt ORDER BY g.target) AS ids, sum(g.n)::int AS n FROM (SELECT reverses_fulfillment_id AS target, count(*) AS n, array_to_string(array_agg(id ORDER BY id), ',') AS ids_txt FROM need_fulfillments WHERE entry_type = 'reversal' AND reverses_fulfillment_id IS NOT NULL GROUP BY reverses_fulfillment_id HAVING count(*) > 1) g`,
    fixHint: "para cada grupo de linhas do ledger listado (ids separados por vírgula), decida qual reversão vale; o ledger é append-only, então a correção é uma decisão de dados que exige intervenção manual e revisão",
  },
  {
    migration: "0010_need_fulfillments_stock_transaction_org_fk.sql",
    rule: "o movimento de estoque de um atendimento (stock_transaction_id) precisa pertencer à MESMA organização do atendimento",
    requires: [{ table: "need_fulfillments", column: "id" }, { table: "need_fulfillments", column: "stock_transaction_id" }, { table: "need_fulfillments", column: "organization_id" }, { table: "stock_transactions", column: "id" }, { table: "stock_transactions", column: "organization_id" }],
    providedBy: ["0006_need_fulfillments.sql"],
    objectExists: `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'need_fulfillments_stock_transaction_org_fkey') AS e`,
    // a FK composta só falha com stock_transaction_id não nulo cujo movimento não existe PARA ESSA organização (organization_id é NOT NULL)
    conflictQuery: `SELECT array_agg(nf.id ORDER BY nf.id) AS ids, count(*)::int AS n FROM need_fulfillments nf WHERE nf.stock_transaction_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_transactions s WHERE s.id = nf.stock_transaction_id AND s.organization_id = nf.organization_id)`,
    fixHint: "o ledger é append-only: investigue cada linha listada (o movimento de estoque é de outra organização) e decida a correção manualmente, com revisão",
  },
  {
    migration: "0026_identity_foundation.sql",
    rule: "user_passwords: no máximo UMA senha por user_id (UNIQUE) e, havendo mais de um users.role = 'admin', o Platform Owner precisa ser designado (levora.platform_owner_user_id)",
    requires: [{ table: "user_passwords", column: "id" }, { table: "user_passwords", column: "user_id" }, { table: "users", column: "id" }, { table: "users", column: "role" }, { table: "users", column: "email" }],
    objectExists: `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_passwords_user_id_key' AND conrelid = 'public.user_passwords'::regclass) AS e`,
    // 1) usuários com mais de uma linha em user_passwords (o UNIQUE falharia); 2) mais de um admin ativo SEM designação válida (a migração aborta). O critério de "ativo" replica o da migração: e-mail anonimizado = usuario-excluido-*@removido.invalid. Só ids saem.
    conflictQuery: `SELECT array_agg(x.txt ORDER BY x.k) AS ids, count(*)::int AS n FROM (SELECT user_id AS k, 'senhas:' || array_to_string(array_agg(id ORDER BY id), ',') AS txt FROM user_passwords GROUP BY user_id HAVING count(*) > 1 UNION ALL SELECT 0 AS k, 'admins:' || array_to_string(array_agg(id ORDER BY id), ',') AS txt FROM users WHERE role = 'admin' AND email NOT LIKE 'usuario-excluido-%@removido.invalid' HAVING count(*) > 1 AND (NULLIF(current_setting('levora.platform_owner_user_id', true), '') IS NULL OR NULLIF(current_setting('levora.platform_owner_user_id', true), '')::int NOT IN (SELECT id FROM users WHERE role = 'admin' AND email NOT LIKE 'usuario-excluido-%@removido.invalid'))) x`,
    fixHint: "senhas: mantenha uma linha por usuário em user_passwords; admins: designe o Platform Owner com PGOPTIONS=\"-c levora.platform_owner_user_id=<id>\" (o sistema não escolhe; os demais admins viram usuários comuns)",
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
  const unclassified = pending.filter((f) => !(f in MIGRATION_COMPAT));
  if (unclassified.length) warnings.push(`migração(ões) pendente(s) SEM classificação de compatibilidade com dados legados (db/migrationCompat.ts): ${unclassified.join(", ")} — analise o SQL, registre uma verificação em CHECKS ou declare-a segura com justificativa`);

  const results: CheckResult[] = [];
  for (const c of CHECKS) {
    const isApplied = applied.has(c.migration);
    if (!known.has(c.migration)) { results.push({ migration: c.migration, rule: c.rule, state: "inconsistente", detail: "o arquivo da migração não existe nesta versão do código" }); continue; }
    // colunas necessárias existem?
    const cols = await tx`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
    const have = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = c.requires.filter((r) => !have.has(`${r.table}.${r.column}`));
    if (missing.length && !isApplied && c.providedBy?.some((p) => !applied.has(p) && known.has(p))) {
      // a estrutura ainda não existe porque uma migração anterior pendente a cria nesta mesma atualização: nasce vazia
      results.push({ migration: c.migration, rule: c.rule, state: "pendente-limpa", detail: `pendente; a estrutura (${missing.map((m) => `${m.table}.${m.column}`).join(", ")}) será criada por migração anterior ainda pendente e nasce vazia: nenhum registro antigo a verificar` });
      continue;
    }
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
