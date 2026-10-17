/**
 * CONTRATO DE COMPATIBILIDADE DAS MIGRAÇÕES COM DADOS LEGADOS.
 *
 * Toda migração em db/migrations/ precisa estar classificada AQUI, explicitamente, como uma de duas coisas:
 *   - "precheck": ela impõe uma condição nova sobre linhas que já existem (CHECK, índice único, chave estrangeira, NOT NULL em coluna existente...). Exige uma entrada em
 *     `CHECKS` (db/legacyPreflight.ts) com a consulta que lista os registros impeditivos; é o que `npm run db:preflight` e o início de `db:migrate:incremental` executam;
 *   - "safe": ela comprovadamente NÃO rejeita dados existentes. Exige uma `category` fixa e uma `reason` ESPECÍFICA, que cite objetos reais da migração (tabela, coluna, índice)
 *     e explique POR QUE nenhuma linha antiga pode violar — quem revisa a migração revisa essa frase.
 * `test/migrationCompat.test.ts` falha se: uma migração existir sem classificação, uma classificação apontar para arquivo inexistente, um "precheck" não tiver verificação (ou
 * uma verificação não tiver classificação "precheck"), uma justificativa for genérica ou não citar nada da migração, ou a categoria contradisser o SQL (p.ex. "tabela nova" com ALTER TABLE).
 * LIMITE: isto garante que NENHUMA migração entra sem uma decisão registrada; NÃO prova que a decisão está certa — não há análise semântica do SQL. A revisão humana da frase continua obrigatória.
 * Em tempo de execução, `db:preflight` apenas AVISA se houver migração pendente sem classificação (não muda os códigos de saída).
 */
export type SafeCategory = "tabela-nova-vazia" | "coluna-nullable-sem-rejeicao" | "restricao-satisfeita-por-construcao";
export type Compat = { kind: "precheck" } | { kind: "safe"; category: SafeCategory; reason: string };
export const SAFE_CATEGORIES: readonly SafeCategory[] = ["tabela-nova-vazia", "coluna-nullable-sem-rejeicao", "restricao-satisfeita-por-construcao"];

export const MIGRATION_COMPAT: Record<string, Compat> = {
  "0001_organization_invites.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria o tipo organization_invite_status e a tabela organization_invites, que não existiam: nenhuma linha antiga pode violar as restrições (UNIQUE em token_hash, índice único parcial de convite pendente, NOT NULL)." },
  "0002_files.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela files, que não existia antes: não há linhas anteriores para violar os NOT NULL nem as chaves estrangeiras para organizations e users." },
  "0003_audit_log_hash_chain.sql": { kind: "safe", category: "coluna-nullable-sem-rejeicao", reason: "adiciona previous_event_hash e event_hash a audit_log como colunas NULLABLE sem backfill e sem constraint: as linhas antigas ficam com NULL, que a verificação da cadeia trata como início de nova cadeia (docs/AUDIT.md; test/schemaMigrationsData.test.ts)." },
  "0004_organization_matching_config.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria organization_capacities, organization_matching_settings e organization_service_areas, tabelas novas sem backfill: os CHECK, UNIQUE e índices únicos só valem para linhas futuras." },
  "0005_opportunity_registry_quantity_check.sql": { kind: "precheck" },
  "0006_need_fulfillments.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela need_fulfillments (ledger de atendimento), que não existia: não há linhas anteriores; as chaves estrangeiras e os UNIQUE só se aplicam a linhas futuras." },
  "0007_need_fulfillments_fk_restrict.sql": { kind: "precheck" },
  "0008_need_fulfillments_ledger_of_events.sql": { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "em need_fulfillments, entry_type nasce com DEFAULT 'original' (valor aceito pelo CHECK entry_type_chk) e is_countable com DEFAULT true; o novo índice único parcial idx_need_fulfillments_one_original_per_allocation é implicado pelo UNIQUE(allocation_id) que ele substitui; DROP NOT NULL em stock_transaction_id só relaxa; reverses_fulfillment_id é nullable e nasce NULL." },
  "0009_need_fulfillments_inheritance_rules.sql": { kind: "precheck" },
  "0010_need_fulfillments_stock_transaction_org_fk.sql": { kind: "precheck" },
  "0011_need_resolutions.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela need_resolutions, que não existia antes: UNIQUE(need_id), o índice único de stock_transaction_id e as chaves estrangeiras só se aplicam a linhas futuras." },
  "0012_opportunity_allocations_need_id.sql": { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "o UNIQUE (id, organization_id) em needs contém a chave primária id, logo é único por construção; opportunity_allocations.need_id é coluna nova NULLABLE que nasce NULL, e a chave estrangeira composta (need_id, organization_id) não valida linhas com need_id NULL (MATCH SIMPLE)." },
  "0013_users_email_case_insensitive.sql": { kind: "precheck" },
  "0014_allocation_response_deadline.sql": { kind: "safe", category: "coluna-nullable-sem-rejeicao", reason: "adiciona response_due_at, closed_at e closed_reason a opportunity_allocations como colunas NULLABLE sem DEFAULT e sem backfill: as linhas antigas ficam NULL, o CHECK de closed_reason aceita NULL e o índice idx_opportunity_allocations_response_due é parcial e não único." },
  "0015_platform_assignment_settings.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela platform_assignment_settings, que não existia antes: não há linhas anteriores para violar os CHECK de id e de response_deadline_hours nem a chave estrangeira para users." },
  "0016_unit_regularization.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria as tabelas unit_regularization_cases e unit_regularization_events, que não existiam: não há linhas anteriores para violar os CHECK, os índices únicos parciais, as chaves estrangeiras ou os gatilhos de integridade; nenhum dado antigo é lido, copiado ou reclassificado (sem backfill)." },
  "0017_item_file_org_keys.sql": { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "o UNIQUE (id, organization_id) em inventory_items e em files contém a chave primária id, logo é único por construção (inventory_items_id_organization_id_key, files_id_organization_id_key): nenhuma linha existente pode violá-lo e nenhum dado é lido, copiado ou alterado." },
  "0018_stock_destinations.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela stock_destinations, que não existia: não há linhas anteriores para violar os CHECK, as chaves estrangeiras compostas, o índice único parcial uq_stock_destinations_reversal_movement ou o gatilho stock_destination_validate; nenhuma saída antiga em stock_transactions é lida, classificada ou copiada (sem backfill)." },
  "0019_need_closures.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela need_closures, que não existia: não há linhas anteriores para violar os CHECK, as chaves estrangeiras compostas, o índice único parcial uq_need_closures_corrected_once ou o gatilho need_closure_validate; needs e need_resolutions não são lidas nem alteradas (sem backfill)." },
  "0020_stock_exit_requests.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela stock_exit_requests, que não existia: não há linhas anteriores para violar os CHECK, a UNIQUE (organization_id, idempotency_key), as chaves estrangeiras compostas ou os gatilhos stock_exit_request_guard; stock_transactions e stock_destinations não são lidas nem alteradas (sem backfill)." },
  "0024_file_scan_status.sql": { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "scan_status entra em files como coluna NOT NULL com DEFAULT 'legado_nao_analisado' (valor aceito por files_scan_status_chk), então toda linha existente já nasce válida; scan_checked_at, scan_engine e scan_signature são NULLABLE sem backfill; o gatilho files_scan_status_guard só restringe UPDATEs futuros de scan_status e a nova versão de stock_destination_proof_validate só vale para linhas futuras de stock_destinations." },
  "0023_destination_proofs.sql": { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "proof_removed entra em stock_destinations como coluna NULLABLE sem DEFAULT: stock_destinations_proof_removed_chk aceita NULL; stock_destinations_proof_only_chk e o índice único uq_stock_destinations_proof_file só restringem linhas com proof_file_id preenchido, e nenhum caminho de código gravou proof_file_id até a Fase 99J (nenhum endpoint o preenche e as destinações existentes têm NULL); o gatilho stock_destination_proof_validate só vale para linhas futuras." },
  "0022_destination_correction_requests.sql": { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela destination_correction_requests, que não existia: não há linhas anteriores para violar a UNIQUE (organization_id, idempotency_key), a UNIQUE do evento, o CHECK do tamanho da chave, as chaves estrangeiras compostas ou os gatilhos de imutabilidade; stock_destinations e stock_transactions não são lidas nem alteradas (sem backfill)." },
  "0021_destination_applied_quantity.sql": { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "applied_quantity e surplus_quantity entram em stock_destinations como colunas NULLABLE sem DEFAULT e sem backfill: as linhas existentes ficam NULL e stock_destinations_applied_shape_chk e stock_destinations_surplus_shape_chk aceitam NULL (só restringem quando preenchidas); o gatilho stock_destination_need_cap só atua em INSERTs futuros, então nenhum dado antigo pode violá-los." },
};

/** Termos que, sozinhos, não justificam nada. */
const GENERIC = /^(n\/?a|nenhum[ao]?|nada|ok|sem risco|seguro|não se aplica|nao se aplica|tabela nova|estrutural|trivial|-+)\.?$/i;
export const MIN_REASON_LENGTH = 60;

export interface CompatInput {
  /** nomes dos arquivos de migração (db/migrations/*.sql) */
  files: string[];
  manifest: Record<string, Compat>;
  /** migrações que têm verificação registrada em CHECKS */
  checkedMigrations: string[];
  /** conteúdo SQL de uma migração (para checar que a justificativa cita objetos reais e que a categoria não contradiz o SQL) */
  readSql: (file: string) => string;
}

const sqlWithoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
/** Palavras do SQL que não identificam nenhum objeto da migração (palavras-chave e tipos). */
const SQL_WORDS = new Set("create table index unique not null default primary key references constraint check alter add column integer text bigint timestamptz boolean serial bigserial numeric true false now enum type trigger before after update delete insert execute function each row where when then else end begin returns language plpgsql replace drop cascade restrict set from into values using with only exists foreign unique int smallint jsonb date time char varchar and the for on in is or as".split(" "));
/** Identificadores (tabelas, colunas, índices, constraints, valores) que aparecem em um texto: palavras de 4+ letras que não são palavras-chave do SQL. Auxílio de revisão, não prova. */
export function identifiersIn(sql: string): Set<string> {
  return new Set([...sqlWithoutComments(sql).matchAll(/\b[a-z][a-z0-9_]{3,}\b/gi)].map((m) => m[0].toLowerCase()).filter((w) => !SQL_WORDS.has(w)));
}

/** Problemas do contrato (lista vazia = contrato íntegro). Função pura: os testes a exercitam com fixtures em memória. */
export function validateCompat(input: CompatInput): string[] {
  const problems: string[] = [];
  const files = new Set(input.files);
  if (files.size !== input.files.length) problems.push("há nomes de migração duplicados em db/migrations/");
  const checks = input.checkedMigrations;
  const dupChecks = checks.filter((m, i) => checks.indexOf(m) !== i);
  for (const d of new Set(dupChecks)) problems.push(`CHECKS tem mais de uma verificação para ${d}`);

  for (const f of input.files) {
    const c = input.manifest[f];
    if (!c) { problems.push(`${f}: migração SEM classificação em db/migrationCompat.ts (classifique como "precheck" com verificação em CHECKS, ou como "safe" com justificativa específica)`); continue; }
    if (c.kind === "precheck") {
      if (!checks.includes(f)) problems.push(`${f}: classificada como "precheck", mas não existe verificação correspondente em CHECKS (db/legacyPreflight.ts)`);
    } else if (c.kind === "safe") {
      if (checks.includes(f)) problems.push(`${f}: tem verificação em CHECKS mas está classificada como "safe" (use "precheck")`);
      if (!SAFE_CATEGORIES.includes(c.category)) problems.push(`${f}: categoria inválida "${String(c.category)}"`);
      const reason = (c.reason ?? "").trim();
      if (reason.length < MIN_REASON_LENGTH || GENERIC.test(reason)) problems.push(`${f}: justificativa genérica ou curta demais (mínimo ${MIN_REASON_LENGTH} caracteres, específica)`);
      else {
        const ids = identifiersIn(input.readSql(f));
        const cited = [...identifiersIn(reason)].filter((i) => ids.has(i));
        if (cited.length === 0) problems.push(`${f}: a justificativa não cita nenhum objeto (tabela, coluna, índice ou constraint) que apareça no SQL da migração`);
      }
      const sql = sqlWithoutComments(input.readSql(f));
      if (c.category === "tabela-nova-vazia" && /\bALTER\s+TABLE\b/i.test(sql)) problems.push(`${f}: categoria "tabela-nova-vazia" contradiz o SQL (contém ALTER TABLE)`);
      if (c.category === "tabela-nova-vazia" && !/\bCREATE\s+TABLE\b/i.test(sql)) problems.push(`${f}: categoria "tabela-nova-vazia" mas o SQL não cria nenhuma tabela`);
      if (c.category === "coluna-nullable-sem-rejeicao" && /\b(ADD\s+CONSTRAINT|CREATE\s+UNIQUE\s+INDEX|SET\s+NOT\s+NULL)\b/i.test(sql)) problems.push(`${f}: categoria "coluna-nullable-sem-rejeicao" contradiz o SQL (contém constraint/índice único/NOT NULL novo)`);
    } else problems.push(`${f}: classificação com "kind" inválido`);
  }
  for (const f of Object.keys(input.manifest)) if (!files.has(f)) problems.push(`${f}: classificada em db/migrationCompat.ts, mas o arquivo NÃO existe em db/migrations/ (referência inválida)`);
  for (const m of checks) {
    if (!files.has(m)) problems.push(`CHECKS referencia ${m}, que não existe em db/migrations/ (verificação órfã)`);
    else if (input.manifest[m]?.kind !== "precheck") problems.push(`CHECKS tem verificação para ${m}, mas a migração não está classificada como "precheck"`);
  }
  return problems;
}
