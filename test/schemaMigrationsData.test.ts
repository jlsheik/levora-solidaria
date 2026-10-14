/**
 * Migrações COM DADOS PREEXISTENTES (complementa test/schemaMigrations.test.ts, que só compara estrutura). Parte do baseline histórico congelado (commit 590ff60, anterior a
 * qualquer migração), semeia registros SINTÉTICOS e plausíveis em todas as tabelas que o baseline já tinha, e roda o runner REAL (`db/run-migrations.ts`) UMA MIGRAÇÃO POR VEZ:
 * o runner só aplica as pendentes, então as demais ficam "carimbadas" em `schema_migrations` e cada passo é atribuível a uma única migração (nenhuma lógica do runner é copiada).
 * Depois de cada passo os registros do baseline são comparados LINHA A LINHA (não só contagens) com o instantâneo anterior à atualização.
 * Também cobre o que acontece quando os dados antigos são incompatíveis com uma migração (falha ruidosa e atômica, com recuperação) e o uso normal após atualizar.
 * Bancos descartáveis `*_mig_*_test`, criados e removidos por este arquivo. Limites: só o baseline 590ff60; volumes pequenos; sem concorrência durante a migração.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = new URL(process.env.DATABASE_URL!);
const PREFIX = BASE.pathname.slice(1).replace(/_test$/, "").toLowerCase();
const NAMES = { main: `${PREFIX}_mig_main_test`, f13: `${PREFIX}_mig_f13_test`, f5: `${PREFIX}_mig_f5_test`, f7: `${PREFIX}_mig_f7_test` };
const created = new Set<string>();
const urlFor = (db: string) => { const u = new URL(BASE); u.pathname = `/${db}`; return u.toString(); };
const MIGRATIONS = readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const BASELINE = readFileSync(path.join(ROOT, "test", "fixtures", "schema-baseline-590ff60.sql"), "utf8");

let admin: postgres.Sql;
const open = (name: string) => postgres(urlFor(name), { max: 1, prepare: false, onnotice: () => {} });
const runner = (dbName: string) => { const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "db/run-migrations.ts"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(dbName) }, timeout: 120000 }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; };
async function recreate(name: string) {
  if (!name.endsWith("_test") || !name.includes("_mig_")) throw new Error(`banco descartável fora do padrão: ${name}`); // só mexe em bancos que ESTE arquivo nomeia
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.unsafe(`CREATE DATABASE "${name}"`); created.add(name);
}

// ---------------------------------------------------------------------------------------------- dados sintéticos (estado anterior às migrações)
const T = "'2025-02-01 10:00:00+00'";
const SEED = `
INSERT INTO users (id,email,display_name,avatar_url,role,created_at,updated_at) VALUES
 (1,'ana.souza@exemplo.org','Ana Souza',NULL,'user',${T},${T}),
 (2,'bruno.lima@exemplo.org','Bruno Lima','https://exemplo.org/avatar-bruno.png','user',${T},${T}),
 (3,'admin@exemplo.org','Admin da Plataforma',NULL,'admin',${T},${T});
INSERT INTO user_passwords (id,user_id,password_hash,created_at) VALUES (1,1,'$2a$10$hashSinteticoNaoReal1',${T}),(2,2,'$2a$10$hashSinteticoNaoReal2',${T}),(3,3,'$2a$10$hashSinteticoNaoReal3',${T});
INSERT INTO sessions (id,user_id,expires_at,created_at,last_accessed) VALUES ('sessao-sintetica-1',1,'2025-02-08 10:00:00+00',${T},${T}),('sessao-sintetica-2',2,'2025-02-08 10:00:00+00',${T},${T});
INSERT INTO login_attempts (id,email,success,attempted_at) VALUES (1,'ana.souza@exemplo.org',true,${T}),(2,'bruno.lima@exemplo.org',false,${T}),(3,'inexistente@exemplo.org',false,${T});
INSERT INTO organizations (id,name,slug,type,status,city,state,document_id,created_by_user_id,created_at,updated_at) VALUES
 (1,'Associação Esperança','associacao-esperanca','organizacao_social','ativa','Contagem','MG','00.000.000/0001-00',1,${T},${T}),
 (2,'Igreja Boa Nova','igreja-boa-nova','igreja','em_analise','Betim','MG',NULL,2,${T},${T});
INSERT INTO memberships (id,organization_id,user_id,role,status,invited_by_user_id,created_at,updated_at) VALUES
 (1,1,1,'proprietario','ativo',NULL,${T},${T}),(2,1,2,'voluntario','ativo',1,${T},${T}),(3,2,2,'proprietario','ativo',NULL,${T},${T});
INSERT INTO audit_log (id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at) VALUES
 (1,1,1,'organizacao.criada','organization','1','{"nome":"Associação Esperança"}',${T}),
 (2,1,1,'estoque.entrada','stock_transaction','1','{"quantidade":50,"unidade":"kg"}',${T}),
 (3,NULL,NULL,'tarefa.agendada','system',NULL,'{}',${T});
INSERT INTO inventory_items (id,organization_id,name,unit,category,created_by_user_id,created_at,updated_at) VALUES
 (1,1,'Arroz','kg','alimentos',1,${T},${T}),(2,1,'Cobertor','unidade','vestuário',1,${T},${T}),(3,2,'Arroz','kg',NULL,2,${T},${T});
INSERT INTO stock_transactions (id,organization_id,item_id,type,delta,reason,created_by_user_id,created_at) VALUES
 (1,1,1,'entrada',50,'doação inicial',1,${T}),(2,1,1,'saida',-10,'distribuição',1,${T}),(3,1,2,'ajuste',-2,'ajuste de inventário',1,${T});
INSERT INTO needs (id,organization_id,title,description,item_id,quantity_needed,unit,priority,status,created_by_user_id,created_at,updated_at) VALUES
 (1,1,'Cestas básicas','Famílias do bairro',1,300,'kg','alta','aberta',1,${T},${T}),
 (2,1,'Cobertores',NULL,2,40,'unidade','media','aberta',1,${T},${T}),
 (3,2,'Alimentos para a ceia',NULL,3,100,'kg','media','atendida',2,${T},${T});
INSERT INTO donation_opportunities (id,organization_id,title,category,quantity_offered,unit,donor_name,donor_contact,linked_need_id,status,created_by_user_id,created_at,updated_at) VALUES
 (1,1,'Doação de arroz','alimentos',20,'kg','Mercado Bom Preço','contato@exemplo.org',1,'confirmada',1,${T},${T});
INSERT INTO sources (id,name,type,connector_key,status,permissions,created_by_user_id,created_at,updated_at) VALUES (1,'Cadastro manual','manual','manual','ativa','{"leitura":true}',1,${T},${T});
INSERT INTO opportunity_registry (id,source_id,discovered_by_user_id,title,category,quantity,unit,urgency,confidence,status,created_at,updated_at) VALUES
 (1,1,1,'40 cobertores doados','agasalhos',40,'unidade','media',80,'validada',${T},${T}),
 (2,1,1,'Oferta sem quantidade definida',NULL,NULL,NULL,'baixa',NULL,'descoberta',${T},${T}),
 (3,1,2,'Arroz excedente',  'alimentos',5.5,'kg','alta',95,'recebida',${T},${T});
INSERT INTO opportunity_allocations (id,opportunity_registry_id,organization_id,quantity_allocated,status,decided_by_user_id,notes,auto_matched,created_by_user_id,created_at,updated_at) VALUES
 (1,1,1,40,'aceita',1,'combinado por telefone',false,1,${T},${T}),(2,3,2,5.5,'recebida',2,NULL,true,2,${T},${T});
INSERT INTO match_evaluations (id,opportunity_registry_id,organization_id,need_id,criteria,final_score,algorithm_version,ai_model_used,decision,allocation_id,created_at) VALUES
 (1,1,1,2,'{"distancia":0.9,"urgencia":"media"}',92.50,'1.3',NULL,'atribuir',1,${T}),(2,2,2,NULL,'{}',40.00,'1.3',NULL,'descartar',NULL,${T});
UPDATE opportunity_allocations SET match_evaluation_id = 1 WHERE id = 1;
INSERT INTO background_task_runs (id,task_name,idempotency_key,status,payload,result,created_at,updated_at) VALUES (1,'matching-sweep','varredura-2025-02-01','concluida','{"lote":1}','{"avaliadas":2}',${T},${T});
INSERT INTO logistics_events (id,opportunity_allocation_id,organization_id,event_type,scheduled_for,notes,proof_url,actor_user_id,occurred_at) VALUES
 (1,1,1,'coleta_agendada','2025-02-02 09:00:00+00','combinado com o doador',NULL,1,${T}),(2,1,1,'entrega_confirmada',NULL,'recebido','https://exemplo.org/recibo.pdf',1,${T});
INSERT INTO approval_requests (id,action_type,organization_id,payload,reason,requested_by_user_id,status,decided_by_user_id,decision_notes,created_at,decided_at) VALUES
 (1,'stock.adjust',1,'{"itemId":2,"delta":-2}','conferência de inventário',2,'aprovada',1,'conferido',${T},${T});
`;
const SERIAL_TABLES = ["users", "user_passwords", "login_attempts", "organizations", "memberships", "audit_log", "inventory_items", "stock_transactions", "needs", "donation_opportunities", "sources", "opportunity_registry", "opportunity_allocations", "match_evaluations", "background_task_runs", "logistics_events", "approval_requests"];
const BASELINE_TABLES = [...SERIAL_TABLES, "sessions"];

async function seed(sql: postgres.Sql) {
  await sql.unsafe(SEED);
  for (const t of SERIAL_TABLES) await sql.unsafe(`SELECT setval(pg_get_serial_sequence('${t}','id'), (SELECT max(id) FROM ${t}))`); // ids explícitos: avança as sequências, como num banco real
}

type Snapshot = Record<string, Array<Record<string, unknown>>>;
/** Todas as linhas de cada tabela do baseline, restritas às COLUNAS que o baseline tinha (colunas novas não entram na comparação). */
async function snapshot(sql: postgres.Sql, columns: Record<string, string[]>): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const t of BASELINE_TABLES) {
    const rows = await sql.unsafe(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`);
    out[t] = rows.map((r) => Object.fromEntries(Object.entries(r.r as Record<string, unknown>).filter(([k]) => columns[t].includes(k))));
  }
  return out;
}
/** Diferenças linha a linha (por id): linhas perdidas, novas e campos alterados. Contagem igual NÃO basta. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const diffs: string[] = [];
  for (const t of Object.keys(before)) {
    const a = new Map(after[t].map((r) => [String(r.id), r])); const b = new Map(before[t].map((r) => [String(r.id), r]));
    for (const [id, row] of b) {
      const now = a.get(id);
      if (!now) { diffs.push(`${t}#${id}: linha PERDIDA`); continue; }
      for (const k of Object.keys(row)) if (JSON.stringify(row[k]) !== JSON.stringify(now[k])) diffs.push(`${t}#${id}.${k}: ${JSON.stringify(row[k])} → ${JSON.stringify(now[k])}`);
    }
    for (const id of a.keys()) if (!b.has(id)) diffs.push(`${t}#${id}: linha NOVA inesperada`);
  }
  return diffs;
}
const columnsOf = async (sql: postgres.Sql) => {
  const cols: Record<string, string[]> = {};
  for (const t of BASELINE_TABLES) cols[t] = (await sql.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'`)).map((r) => String(r.column_name));
  return cols;
};
const rejects = async (sql: postgres.Sql, text: string, code?: string) => { try { await sql.unsafe(text); } catch (e) { if (code) expect((e as { code?: string }).code).toBe(code); return; } throw new Error(`esperava falha, mas executou: ${text.slice(0, 80)}`); };

// ---------------------------------------------------------------------------------------------- preparação
let MAIN: postgres.Sql; let before: Snapshot; let baselineColumns: Record<string, string[]>;
const stepLog: Array<{ file: string; diffs: string[]; out: string }> = [];

beforeAll(async () => {
  if (!BASE.pathname.slice(1).endsWith("_test")) throw new Error("DATABASE_URL de teste deve terminar em _test");
  const a = new URL(BASE); a.pathname = "/postgres"; admin = postgres(a.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await recreate(NAMES.main); MAIN = open(NAMES.main);
  await MAIN.unsafe(BASELINE); await seed(MAIN);
  baselineColumns = await columnsOf(MAIN); before = await snapshot(MAIN, baselineColumns);
  // carimba TODAS como aplicadas e libera uma por vez: o runner real aplica só a liberada (e registra sozinho)
  await MAIN.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  for (const f of MIGRATIONS) await MAIN`INSERT INTO schema_migrations (id) VALUES (${f})`;
  for (const f of MIGRATIONS) {
    await MAIN`DELETE FROM schema_migrations WHERE id = ${f}`;
    const r = runner(NAMES.main);
    const applied = [...r.out.matchAll(/Aplicada com sucesso: (\S+)/g)].map((m) => m[1]);
    if (r.status !== 0 || applied.join() !== f) throw new Error(`o passo ${f} não aplicou exatamente essa migração (status ${r.status}): ${r.out.slice(-300)}`);
    stepLog.push({ file: f, diffs: diffSnapshots(before, await snapshot(MAIN, baselineColumns)), out: r.out });
  }
}, 240000);

afterAll(async () => {
  await MAIN?.end({ timeout: 2 }).catch(() => undefined);
  if (admin) { for (const n of created) await admin.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => undefined); await admin.end({ timeout: 2 }).catch(() => undefined); }
});

// ---------------------------------------------------------------------------------------------- testes
describe("o estado anterior é realista e o instantâneo é fiel", () => {
  it("o baseline tem dados em todas as tabelas semeadas e nenhuma das tabelas que as migrações criam", async () => {
    for (const t of BASELINE_TABLES) expect(before[t].length, t).toBeGreaterThan(0);
    expect(before.users).toHaveLength(3); expect(before.opportunity_allocations).toHaveLength(2); expect(before.audit_log).toHaveLength(3);
    for (const novo of ["files", "organization_invites", "need_fulfillments", "need_resolutions", "organization_capacities", "schema_migrations_nao_existia"]) expect(Object.keys(before)).not.toContain(novo);
  });

  it("o comparador DETECTA corrupção (controle): valor alterado, linha perdida, linha nova e relacionamento rompido, mesmo com a mesma contagem", () => {
    const clone = (): Snapshot => JSON.parse(JSON.stringify(before));
    expect(diffSnapshots(before, clone())).toEqual([]);
    const changed = clone(); (changed.needs[0] as Record<string, unknown>).title = "Cestas básicas (alterado)";
    expect(diffSnapshots(before, changed)).toEqual([expect.stringContaining("needs#1.title")]);
    const swapped = clone(); swapped.users[0].email = before.users[1].email; swapped.users[1].email = before.users[0].email; // mesma contagem, registros trocados
    expect(diffSnapshots(before, swapped).length).toBe(2);
    const lost = clone(); lost.memberships.pop();
    expect(diffSnapshots(before, lost)).toEqual([expect.stringContaining("memberships#3: linha PERDIDA")]);
    const extra = clone(); extra.sessions.push({ id: "intrusa", user_id: 1 });
    expect(diffSnapshots(before, extra)).toEqual([expect.stringContaining("sessions#intrusa: linha NOVA")]);
    const broken = clone(); (broken.opportunity_allocations[0] as Record<string, unknown>).match_evaluation_id = null; // relacionamento rompido
    expect(diffSnapshots(before, broken)).toEqual([expect.stringContaining("opportunity_allocations#1.match_evaluation_id")]);
  });
});

describe("atualização migração por migração com o runner real", () => {
  it("cada passo aplica exatamente UMA migração, na ordem, e as 13 ficam registradas uma vez", async () => {
    expect(stepLog.map((s) => s.file)).toEqual(MIGRATIONS);
    expect((await MAIN`SELECT id FROM schema_migrations ORDER BY id`).map((r) => r.id)).toEqual(MIGRATIONS);
    expect((await MAIN`SELECT count(*)::int AS n FROM schema_migrations`)[0].n).toBe(MIGRATIONS.length);
  });

  it("NENHUMA migração altera, perde, troca ou duplica registro do baseline (comparação linha a linha após cada passo)", () => {
    for (const s of stepLog) expect(s.diffs, `${s.file} alterou dados do baseline`).toEqual([]);
  });

  it("os relacionamentos do baseline continuam íntegros (nenhuma chave estrangeira órfã) e as sequências seguem usáveis", async () => {
    const orphans = await MAIN.unsafe(`
      SELECT 'memberships.user' AS r FROM memberships m LEFT JOIN users u ON u.id=m.user_id WHERE u.id IS NULL
      UNION ALL SELECT 'needs.item' FROM needs n LEFT JOIN inventory_items i ON i.id=n.item_id WHERE n.item_id IS NOT NULL AND i.id IS NULL
      UNION ALL SELECT 'stock.item' FROM stock_transactions s LEFT JOIN inventory_items i ON i.id=s.item_id WHERE i.id IS NULL
      UNION ALL SELECT 'allocations.registry' FROM opportunity_allocations a LEFT JOIN opportunity_registry r ON r.id=a.opportunity_registry_id WHERE r.id IS NULL
      UNION ALL SELECT 'allocations.evaluation' FROM opportunity_allocations a LEFT JOIN match_evaluations e ON e.id=a.match_evaluation_id WHERE a.match_evaluation_id IS NOT NULL AND e.id IS NULL
      UNION ALL SELECT 'evaluations.allocation' FROM match_evaluations e LEFT JOIN opportunity_allocations a ON a.id=e.allocation_id WHERE e.allocation_id IS NOT NULL AND a.id IS NULL
      UNION ALL SELECT 'logistics.allocation' FROM logistics_events l LEFT JOIN opportunity_allocations a ON a.id=l.opportunity_allocation_id WHERE a.id IS NULL`);
    expect(orphans).toEqual([]);
    const [{ id }] = await MAIN`INSERT INTO users (email, display_name) VALUES ('novo.depois@exemplo.org', 'Depois da atualização') RETURNING id`;
    expect(id).toBe(4); // a sequência continuou de onde o baseline parou
    await MAIN`DELETE FROM users WHERE id = 4`;
  });
});

describe("transformações e valores introduzidos pelas migrações (a partir do código real)", () => {
  it("0003: linhas antigas do audit_log ficam com os hashes NULL (início de uma nova cadeia, não corrupção) e novas linhas aceitam hash", async () => {
    const legacy = await MAIN`SELECT id, previous_event_hash, event_hash FROM audit_log ORDER BY id`;
    expect(legacy).toHaveLength(3); for (const r of legacy) { expect(r.previous_event_hash).toBeNull(); expect(r.event_hash).toBeNull(); }
    await MAIN`INSERT INTO audit_log (action, entity_type, previous_event_hash, event_hash) VALUES ('teste.pos', 'sistema', NULL, 'abc123')`;
    expect((await MAIN`SELECT count(*)::int AS n FROM audit_log WHERE event_hash IS NOT NULL`)[0].n).toBe(1);
  });

  it("0012: as alocações antigas ficam com need_id NULL (sem backfill) e o vínculo passa a respeitar a organização (FK composta)", async () => {
    expect((await MAIN`SELECT need_id FROM opportunity_allocations ORDER BY id`).map((r) => r.need_id)).toEqual([null, null]);
    // numa transação DESFEITA ao final: o UPDATE tocaria updated_at (gatilho) e este teste não pode alterar os registros de referência
    await MAIN.begin(async (tx) => {
      await tx`UPDATE opportunity_allocations SET need_id = 1 WHERE id = 1`; // necessidade da MESMA organização
      await tx`SAVEPOINT s`;
      await expect(tx.unsafe(`UPDATE opportunity_allocations SET need_id = 3 WHERE id = 1`)).rejects.toMatchObject({ code: "23503" }); // necessidade de OUTRA organização
      await tx`ROLLBACK TO SAVEPOINT s`;
      throw new Error("desfaz");
    }).catch((e) => { if (String(e.message) !== "desfaz") throw e; });
  });

  it("tabelas novas (0001, 0002, 0004, 0006, 0011) nascem vazias: nenhuma migração fabricou dados a partir dos registros antigos", async () => {
    for (const t of ["organization_invites", "files", "organization_capacities", "organization_matching_settings", "organization_service_areas", "need_fulfillments", "need_resolutions"]) {
      expect((await MAIN.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0].n, t).toBe(0);
    }
  });

  it("0005: o CHECK de quantidade vale para dados novos e os antigos (inclusive NULL) permanecem", async () => {
    expect((await MAIN`SELECT id FROM opportunity_registry WHERE quantity IS NULL`).map((r) => r.id)).toEqual([2]);
    await rejects(MAIN, `INSERT INTO opportunity_registry (source_id, title, quantity) VALUES (1, 'zero', 0)`, "23514");
    await rejects(MAIN, `INSERT INTO opportunity_registry (source_id, title, quantity) VALUES (1, 'negativa', -1)`, "23514");
    await MAIN`INSERT INTO opportunity_registry (source_id, title, quantity) VALUES (1, 'ok', 1.5)`; await MAIN`DELETE FROM opportunity_registry WHERE title = 'ok'`;
  });

  it("0013: o e-mail passa a ser único sem diferenciar maiúsculas, valendo contra os usuários antigos", async () => {
    await rejects(MAIN, `INSERT INTO users (email, display_name) VALUES ('ANA.SOUZA@exemplo.org', 'duplicada')`, "23505");
    expect((await MAIN`SELECT count(*)::int AS n FROM users`)[0].n).toBe(3);
  });

  it("0007: a unicidade de match_evaluations.allocation_id vale para as linhas antigas (NULLs coexistem, duplicata é recusada)", async () => {
    await rejects(MAIN, `INSERT INTO match_evaluations (opportunity_registry_id, organization_id, criteria, final_score, algorithm_version, decision, allocation_id) VALUES (1, 1, '{}', 10, '1.3', 'x', 1)`, "23505");
    await MAIN`INSERT INTO match_evaluations (opportunity_registry_id, organization_id, criteria, final_score, algorithm_version, decision) VALUES (1, 1, '{}', 10, '1.3', 'sem alocação')`;
    await MAIN`DELETE FROM match_evaluations WHERE decision = 'sem alocação'`;
  });

  it("uso normal depois de atualizar: arquivo, recebimento no ledger, resolução, convite, configurações — com as regras novas efetivas sobre os dados antigos", async () => {
    await MAIN`INSERT INTO files (organization_id, uploaded_by_user_id, storage_provider, storage_key, original_filename, content_type, size_bytes, purpose) VALUES (1, 1, 'local', '1/00000000-0000-0000-0000-000000000001', 'recibo.png', 'image/png', 10, 'comprovante_entrega')`;
    // recebimento "original" ligado à alocação e ao movimento de estoque ANTIGOS (defaults de 0008: entry_type='original', is_countable=true)
    const [nf] = await MAIN`INSERT INTO need_fulfillments (organization_id, need_id, allocation_id, stock_transaction_id, quantity, unit) VALUES (1, 1, 1, 1, 10, 'kg') RETURNING id, entry_type, is_countable, reverses_fulfillment_id`;
    expect(nf).toMatchObject({ entry_type: "original", is_countable: true, reverses_fulfillment_id: null });
    await rejects(MAIN, `INSERT INTO need_fulfillments (organization_id, allocation_id, stock_transaction_id, quantity, unit) VALUES (2, 2, 2, 1, 'kg')`, "23503"); // movimento 2 é da organização 1, alocação 2 da organização 2 (0010)
    await rejects(MAIN, `DELETE FROM needs WHERE id = 1`, "23503"); // a necessidade está no ledger: RESTRICT em vez de SET NULL (0007)
    await rejects(MAIN, `DELETE FROM need_fulfillments WHERE id = ${nf.id}`); // append-only (0006)
    await rejects(MAIN, `INSERT INTO need_fulfillments (organization_id, allocation_id, quantity, unit) VALUES (1, 2, 1, 'kg')`); // original sem movimento físico (0008)
    await MAIN`INSERT INTO need_resolutions (need_id, stock_transaction_id, created_by_user_id) VALUES (2, 3, 1)`;
    await rejects(MAIN, `INSERT INTO need_resolutions (need_id) VALUES (2)`, "23505");
    await MAIN`INSERT INTO organization_matching_settings (organization_id, realiza_coleta) VALUES (2, true)`; // organização antiga ganha configuração
    await MAIN`INSERT INTO organization_invites (organization_id, email, role, token_hash, invited_by_user_id, expires_at) VALUES (1, 'Convidado@Exemplo.org', 'operador', 'hash-1', 1, now() + interval '7 days')`;
    await rejects(MAIN, `INSERT INTO organization_invites (organization_id, email, role, token_hash, invited_by_user_id, expires_at) VALUES (1, 'convidado@exemplo.org', 'operador', 'hash-2', 1, now() + interval '7 days')`, "23505");
  });
});

describe("segunda execução e estado final", () => {
  it("rodar o runner de novo não aplica nada e os registros do baseline continuam idênticos (o uso acima só acrescentou dados novos)", async () => {
    const r = runner(NAMES.main);
    expect(r.status).toBe(0); expect(r.out).toContain("Nenhuma migração pendente"); expect(r.out).not.toContain("Aplicando:");
    const now = await snapshot(MAIN, baselineColumns);
    // os testes de uso só ACRESCENTARAM linhas (as inserções de controle foram removidas): as de referência seguem idênticas
    const diffs = diffSnapshots(before, now);
    const novas = diffs.filter((d) => /linha NOVA/.test(d)); // a linha de audit_log inserida pelo teste da 0003 é a única acrescentada a uma tabela do baseline
    expect(diffs.filter((d) => !/linha NOVA/.test(d))).toEqual([]);
    expect(novas).toEqual([expect.stringContaining("audit_log#4: linha NOVA")]);
  });
});

// ---------------------------------------------------------------------------------------------- dados antigos INCOMPATÍVEIS
async function failure(name: string, seedBad: string, expectFailAt: string, absent: string, fix: string) {
  await recreate(name); const sql = open(name);
  try {
    await sql.unsafe(BASELINE); await seed(sql); await sql.unsafe(seedBad);
    const cols = await columnsOf(sql); const snap = await snapshot(sql, cols);
    const r = runner(name);
    expect(r.status).toBe(1); expect(r.out).toContain("Falha ao aplicar migração");
    const attempted = [...r.out.matchAll(/Aplicando: (\S+)\.\.\./g)].map((m) => m[1]); const ok = [...r.out.matchAll(/Aplicada com sucesso: (\S+)/g)].map((m) => m[1]);
    expect(attempted.at(-1)).toBe(expectFailAt); expect(ok).toEqual(MIGRATIONS.slice(0, MIGRATIONS.indexOf(expectFailAt))); // as anteriores aplicadas; a que falhou, não
    expect((await sql`SELECT id FROM schema_migrations ORDER BY id`).map((x) => x.id)).toEqual(ok); // a falha NÃO é registrada
    expect(r.out).not.toMatch(/senha-de-teste|postgres:\/\//);
    expect((await sql.unsafe(absent))[0].n).toBe(0); // atomicidade: nada da migração que falhou ficou aplicado
    expect(diffSnapshots(snap, await snapshot(sql, cols))).toEqual([]); // e nenhum dado foi alterado ou perdido
    await sql.unsafe(fix); // recuperação: corrige o dado antigo e roda de novo
    const again = runner(name);
    expect(again.status, again.out).toBe(0);
    expect((await sql`SELECT id FROM schema_migrations ORDER BY id`).map((x) => x.id)).toEqual(MIGRATIONS);
  } finally { await sql.end({ timeout: 2 }).catch(() => undefined); }
}

describe("dados antigos incompatíveis com uma migração: falha ruidosa, atômica e recuperável", () => {
  it("0013: dois usuários que diferem só em maiúsculas impedem o índice único; nada fica pela metade e, deduplicado o dado, a atualização conclui", async () => {
    await failure(NAMES.f13, `INSERT INTO users (id,email,display_name) VALUES (10,'Ana.Souza@exemplo.org','Ana (duplicada por maiúsculas)')`,
      "0013_users_email_case_insensitive.sql", `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='idx_users_email_lower'`, `DELETE FROM users WHERE id = 10`);
  }, 120000);

  it("0005: oportunidade antiga com quantidade 0 (o baseline permitia) impede o CHECK; nada fica pela metade e, corrigido o dado, conclui", async () => {
    await failure(NAMES.f5, `INSERT INTO opportunity_registry (id,source_id,title,quantity) VALUES (10,1,'quantidade zerada herdada',0)`,
      "0005_opportunity_registry_quantity_check.sql", `SELECT count(*)::int AS n FROM pg_constraint WHERE conname='opportunity_registry_quantity_positive_chk'`, `UPDATE opportunity_registry SET quantity = NULL WHERE id = 10`);
  }, 120000);

  it("0007: duas avaliações antigas apontando para a mesma alocação impedem o índice único; nada fica pela metade e, corrigido o dado, conclui", async () => {
    await failure(NAMES.f7, `INSERT INTO match_evaluations (id,opportunity_registry_id,organization_id,criteria,final_score,algorithm_version,decision,allocation_id) VALUES (10,1,1,'{}',50,'1.2','duplicada',1)`,
      "0007_need_fulfillments_fk_restrict.sql", `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='idx_match_evaluations_allocation_id'`, `UPDATE match_evaluations SET allocation_id = NULL WHERE id = 10`);
  }, 120000);
});
