/**
 * Contrato de compatibilidade das migrações com dados legados (db/migrationCompat.ts × CHECKS de db/legacyPreflight.ts). Garante que NENHUMA migração nova entra sem uma decisão
 * registrada: ou "precheck" (com verificação em CHECKS) ou "safe" (com categoria e justificativa específica que cita objetos reais do SQL). Não prova que a decisão está certa —
 * não há análise semântica do SQL —, só que ela existe, é revisável e é coerente. Os cenários de omissão usam metadados em memória; os arquivos de produção NUNCA são alterados.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MIGRATION_COMPAT, SAFE_CATEGORIES, MIN_REASON_LENGTH, validateCompat, identifiersIn, type Compat, type CompatInput } from "../db/migrationCompat";
import { CHECKS } from "../db/legacyPreflight";

const DIR = path.join(process.cwd(), "db", "migrations");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const readSql = (f: string) => readFileSync(path.join(DIR, f), "utf8");
const real = (): CompatInput => ({ files: [...FILES], manifest: structuredClone(MIGRATION_COMPAT), checkedMigrations: CHECKS.map((c) => c.migration), readSql });
/** SQL em memória para migrações fictícias; as reais continuam vindo do disco. */
const withSql = (extra: Record<string, string>) => (f: string) => extra[f] ?? readSql(f);

describe("o contrato real (arquivos de db/migrations/ × db/migrationCompat.ts × CHECKS)", () => {
  it("está íntegro: nenhum problema", () => {
    expect(validateCompat(real())).toEqual([]);
  });

  it("TODA migração existente tem classificação explícita, e não há classificação para arquivo inexistente", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(13);
    for (const f of FILES) expect(MIGRATION_COMPAT[f], f).toBeDefined();
    expect(Object.keys(MIGRATION_COMPAT).sort()).toEqual(FILES);
  });

  it("os nomes das migrações são únicos e seguem a sequência numérica (a ordem do runner é a ordem do nome)", () => {
    expect(new Set(FILES).size).toBe(FILES.length);
    FILES.forEach((f, i) => expect(f.startsWith(String(i + 1).padStart(4, "0") + "_"), f).toBe(true));
  });

  it("'precheck' ⇔ existe verificação em CHECKS (relação exata, sem órfãs nem duplicatas)", () => {
    const prechecked = FILES.filter((f) => MIGRATION_COMPAT[f].kind === "precheck");
    expect(prechecked.sort()).toEqual(CHECKS.map((c) => c.migration).sort());
    expect(new Set(CHECKS.map((c) => c.migration)).size).toBe(CHECKS.length);
    expect(prechecked).toEqual(expect.arrayContaining(["0005_opportunity_registry_quantity_check.sql", "0007_need_fulfillments_fk_restrict.sql", "0013_users_email_case_insensitive.sql"]));
  });

  it("as migrações 'safe' têm categoria válida e justificativa específica que cita objetos do próprio SQL", () => {
    for (const [f, c] of Object.entries(MIGRATION_COMPAT)) {
      if (c.kind !== "safe") continue;
      expect(SAFE_CATEGORIES, f).toContain(c.category);
      expect(c.reason.length, f).toBeGreaterThanOrEqual(MIN_REASON_LENGTH);
      const cited = [...identifiersIn(c.reason)].filter((i) => identifiersIn(readSql(f)).has(i));
      expect(cited.length, `${f} não cita objetos do SQL`).toBeGreaterThan(0);
    }
  });
});

describe("o contrato DETECTA omissões (metadados em memória; nenhum arquivo de produção é alterado)", () => {
  it("1) migração nova SEM classificação falha", () => {
    const input = real(); input.files.push("0014_nova_migracao.sql");
    const problems = validateCompat({ ...input, readSql: withSql({ "0014_nova_migracao.sql": "CREATE TABLE notificacoes (id SERIAL PRIMARY KEY);" }) });
    expect(problems).toEqual([expect.stringContaining("0014_nova_migracao.sql: migração SEM classificação")]);
  });

  it("2) 'precheck' sem verificação correspondente falha (e o inverso: verificação sem 'precheck' também)", () => {
    const input = real(); input.files.push("0014_x.sql"); input.manifest["0014_x.sql"] = { kind: "precheck" };
    expect(validateCompat({ ...input, readSql: withSql({ "0014_x.sql": "ALTER TABLE users ADD CONSTRAINT x CHECK (id > 0);" }) })).toEqual([expect.stringContaining('classificada como "precheck", mas não existe verificação')]);
    const noCheck = real(); noCheck.checkedMigrations = noCheck.checkedMigrations.filter((m) => !m.startsWith("0013"));
    expect(validateCompat(noCheck)).toEqual([expect.stringContaining("0013_users_email_case_insensitive.sql: classificada como \"precheck\"")]);
    const reclassified = real(); reclassified.manifest["0013_users_email_case_insensitive.sql"] = { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "o índice idx_users_email_lower sobre users não rejeita nenhum e-mail antigo, pois todos são distintos." };
    const p = validateCompat(reclassified); expect(p.some((x) => x.includes("tem verificação em CHECKS mas está classificada como \"safe\""))).toBe(true);
  });

  it("3) referência a migração inexistente falha (classificação órfã e verificação órfã)", () => {
    const a = real(); a.manifest["0099_fantasma.sql"] = { kind: "precheck" };
    expect(validateCompat(a).some((x) => x.includes("0099_fantasma.sql: classificada em db/migrationCompat.ts, mas o arquivo NÃO existe"))).toBe(true);
    const b = real(); b.checkedMigrations.push("0098_orfa.sql");
    expect(validateCompat(b)).toEqual([expect.stringContaining("CHECKS referencia 0098_orfa.sql, que não existe em db/migrations/ (verificação órfã)")]);
  });

  it("4) migração explicitamente 'safe' com justificativa válida PASSA", () => {
    const input = real(); input.files.push("0014_notificacoes.sql");
    input.manifest["0014_notificacoes.sql"] = { kind: "safe", category: "tabela-nova-vazia", reason: "cria a tabela notificacoes, que não existia antes: não há linhas anteriores para violar as restrições NOT NULL e a chave estrangeira para users." };
    expect(validateCompat({ ...input, readSql: withSql({ "0014_notificacoes.sql": "CREATE TABLE notificacoes (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));" }) })).toEqual([]);
  });

  it("justificativas vazias, genéricas, curtas ou que não citam nada da migração FALHAM", () => {
    const sql = "CREATE TABLE notificacoes (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL);";
    const attempt = (reason: string) => {
      const input = real(); input.files.push("0014_n.sql"); input.manifest["0014_n.sql"] = { kind: "safe", category: "tabela-nova-vazia", reason };
      return validateCompat({ ...input, readSql: withSql({ "0014_n.sql": sql }) });
    };
    for (const generic of ["", "n/a", "sem risco", "ok", "não se aplica", "tabela nova", "estrutural", "-", "   "]) expect(attempt(generic).length, JSON.stringify(generic)).toBeGreaterThan(0);
    expect(attempt("x".repeat(80)).join()).toContain("não cita nenhum objeto");
    expect(attempt("Esta migração é segura porque nada pode dar errado com os dados que já existem hoje no banco.").join()).toContain("não cita nenhum objeto");
    expect(attempt("cria a tabela notificacoes, nova e sem linhas anteriores, então nenhuma restrição pode ser violada.")).toEqual([]);
  });

  it("categoria que contradiz o SQL falha (tabela nova com ALTER TABLE; coluna nullable com constraint nova)", () => {
    const reason = "altera a tabela notificacoes e a coluna user_id, que são seguras porque estão vazias e nenhuma linha existe ainda.";
    const a = real(); a.files.push("0014_a.sql"); a.manifest["0014_a.sql"] = { kind: "safe", category: "tabela-nova-vazia", reason };
    expect(validateCompat({ ...a, readSql: withSql({ "0014_a.sql": "CREATE TABLE notificacoes (user_id INT); ALTER TABLE notificacoes ADD COLUMN x INT;" }) }).join()).toContain("contradiz o SQL (contém ALTER TABLE)");
    const b = real(); b.files.push("0014_b.sql"); b.manifest["0014_b.sql"] = { kind: "safe", category: "coluna-nullable-sem-rejeicao", reason };
    expect(validateCompat({ ...b, readSql: withSql({ "0014_b.sql": "ALTER TABLE notificacoes ADD COLUMN user_id INT; ALTER TABLE notificacoes ADD CONSTRAINT chk CHECK (user_id > 0);" }) }).join()).toContain("contradiz o SQL");
    const c = real(); c.files.push("0014_c.sql"); c.manifest["0014_c.sql"] = { kind: "safe", category: "tabela-nova-vazia", reason };
    expect(validateCompat({ ...c, readSql: withSql({ "0014_c.sql": "ALTER TABLE notificacoes ADD COLUMN user_id INT;" }) }).join()).toMatch(/contradiz|não cria nenhuma tabela/);
  });

  it("categoria inválida, 'kind' inválido, nomes duplicados e verificação duplicada falham", () => {
    const a = real(); a.manifest["0001_organization_invites.sql"] = { kind: "safe", category: "qualquer-coisa" as never, reason: (a.manifest["0001_organization_invites.sql"] as { reason: string }).reason };
    expect(validateCompat(a).join()).toContain('categoria inválida "qualquer-coisa"');
    const b = real(); b.manifest["0002_files.sql"] = { kind: "talvez" } as unknown as Compat;
    expect(validateCompat(b).join()).toContain('"kind" inválido');
    const c = real(); c.files.push(FILES[0]); expect(validateCompat(c).join()).toContain("nomes de migração duplicados");
    const d = real(); d.checkedMigrations.push(d.checkedMigrations[0]); expect(validateCompat(d).join()).toContain("mais de uma verificação");
  });

  it("as classificações reais resistem a mutações: trocar 'precheck' por 'safe' (ou o contrário) em QUALQUER migração é detectado", () => {
    for (const f of FILES) {
      const input = real(); const cur = input.manifest[f];
      input.manifest[f] = cur.kind === "precheck" ? { kind: "safe", category: "restricao-satisfeita-por-construcao", reason: "o índice qualquer_coisa em outra_tabela não rejeita nenhuma linha antiga porque é implicado pela chave primária." } : { kind: "precheck" };
      expect(validateCompat(input).length, f).toBeGreaterThan(0);
    }
    for (const f of FILES) { const input = real(); delete input.manifest[f]; expect(validateCompat(input).length, `sem ${f}`).toBeGreaterThan(0); }
  });
});
