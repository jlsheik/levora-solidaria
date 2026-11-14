/**
 * Diagnóstico de integridade do armazenamento (src/helpers/storageIntegrity.ts + db/storage-audit.ts): classificação correta, auditoria INCOMPLETA quando algo não pôde
 * ser verificado, e a propriedade de SOMENTE LEITURA provada de três formas — (1) instantâneo antes/depois do disco, do banco e dos objetos do S3 local; (2) a transação
 * do banco é READ ONLY (o Postgres recusa escrita); (3) o código-fonte não contém nenhuma operação de gravação/remoção. Disco: diretório temporário isolado. S3: o
 * adaptador e o SDK REAIS contra o servidor local de test/fakeS3.ts. Banco: o Postgres de teste (descartável).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { buildStorageAdapter } from "../src/helpers/storageAdapter";
import { analyze, runAudit, readFileRecords, enumerateLocal, EXIT_CODES, type AuditReport, type FileRecord } from "../src/helpers/storageIntegrity";
import { FakeS3 } from "./fakeS3";
import { createAuthenticatedUser, createTestOrganization } from "./helpers";

const BUCKET = "bucket-de-teste"; const ACCESS_KEY = "test-access-key-id"; const SECRET_KEY = "test-secret-DO-NOT-LEAK-0123456789abcdef";
const uuid = () => randomUUID();
let s3: FakeS3; let sandbox: string; let root: string; let outside: string;

const s3Env = () => ({ S3_BUCKET: BUCKET, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: ACCESS_KEY, S3_SECRET_ACCESS_KEY: SECRET_KEY, S3_ENDPOINT: s3.endpoint, S3_REQUEST_TIMEOUT_MS: "600" }) as NodeJS.ProcessEnv;
const s3Adapter = () => { const a = buildStorageAdapter(s3Env()); return { listKeys: () => a.listKeys!() }; };

function put(base: string, key: string, content = "conteúdo sintético") { const p = path.join(base, ...key.split("/")); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, content); }
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = lstatSync(p); if (e.isDirectory()) { out.push(`D ${path.relative(dir, p)}`); walk(p); } else if (e.isSymbolicLink()) out.push(`L ${path.relative(dir, p)}`); else out.push(`F ${path.relative(dir, p)} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`); } };
  walk(dir); return out.sort();
}
const insert = async (r: { organizationId: number; provider: string; key: string }, userId: number) =>
  (await db.insertInto("files").values({ scanStatus: "legado_nao_analisado", organizationId: r.organizationId, uploadedByUserId: userId, storageProvider: r.provider, storageKey: r.key, originalFilename: "dado-pessoal.png", contentType: "image/png", sizeBytes: 3, purpose: "comprovante_entrega" }).returning("id").executeTakeFirstOrThrow()).id;
const tableDump = async () => JSON.stringify(await db.selectFrom("files").selectAll().orderBy("id").execute());

beforeAll(async () => { s3 = new FakeS3(); await s3.start(); });
afterAll(async () => { await s3.stop(); });
beforeEach(() => { sandbox = mkdtempSync(path.join(tmpdir(), "levora-test-audit-")); root = path.join(sandbox, "storage"); outside = path.join(sandbox, "fora-da-raiz"); mkdirSync(root); mkdirSync(outside); s3.objects.clear(); s3.requests.length = 0; });
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); s3.listPageSize = 1000; s3.listFailAtPage = 0; s3.listHang = false; s3.listBrokenPagination = false; });

const audit = (over: Partial<Parameters<typeof runAudit>[0]> = {}) => runAudit({ db: db as never, providers: ["local"], localRoot: root, s3Adapter: null, ...over });
const set = (items: Array<{ key: string }>) => items.map((i) => i.key).sort();

describe("auditoria em disco (diretório temporário isolado)", () => {
  it("classifica registrado / órfão / registro sem arquivo / chave inválida / provedor desconhecido / prefixo / duplicata, e ignora o que está fora da raiz", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const org2 = (await createTestOrganization(u.userId)).id;
    const [ok1, ok2, orphan, missing, dup] = [uuid(), uuid(), uuid(), uuid(), uuid()];
    put(root, `${org}/${ok1}`); put(root, `${org2}/${ok2}`); put(root, `${org}/${orphan}`); put(root, `${org}/${dup}`);
    put(root, ".keep", ""); put(root, `${org}/subpasta/estranho.txt`); // não reconhecidos (informativos)
    put(outside, `${org}/${uuid()}`); put(outside, "qualquer.txt"); // FORA da raiz: nunca examinados
    const id1 = await insert({ organizationId: org, provider: "local", key: `${org}/${ok1}` }, u.userId);
    await insert({ organizationId: org2, provider: "local", key: `${org2}/${ok2}` }, u.userId);
    const idMissing = await insert({ organizationId: org, provider: "local", key: `${org}/${missing}` }, u.userId);
    const idBad = await insert({ organizationId: org, provider: "local", key: "../../etc/passwd" }, u.userId);
    const idGcs = await insert({ organizationId: org, provider: "gcs", key: `${org}/${uuid()}` }, u.userId);
    const idPrefix = await insert({ organizationId: org, provider: "local", key: `${org2}/${uuid()}` }, u.userId);
    const d1 = await insert({ organizationId: org, provider: "local", key: `${org}/${dup}` }, u.userId); const d2 = await insert({ organizationId: org, provider: "local", key: `${org}/${dup}` }, u.userId);

    const r = await audit();
    expect(r.status).toBe("completo-com-inconsistencias"); expect(r.exitCode).toBe(EXIT_CODES.INCONSISTENCIES);
    expect(r.orphans).toEqual([{ provider: "local", key: `${org}/${orphan}` }]);
    expect(r.recordsWithoutObject.map((x) => x.fileId)).toEqual([idMissing]);
    expect(r.recordsWithoutObject[0]).toMatchObject({ key: `${org}/${missing}`, organizationId: org, provider: "local" });
    const kinds = Object.fromEntries(r.inconsistentMetadata.map((m) => [`${m.kind}:${m.fileId}`, true]));
    for (const k of [`chave-fora-do-formato:${idBad}`, `provedor-desconhecido:${idGcs}`, `prefixo-diferente-da-organizacao:${idPrefix}`, `chave-duplicada:${d1}`, `chave-duplicada:${d2}`]) expect(kinds[k], k).toBe(true);
    expect(r.inconsistentMetadata).toHaveLength(5);
    expect(set(r.unrecognizedObjects)).toEqual([".keep", `${org}/subpasta/estranho.txt`].sort());
    expect(JSON.stringify(r)).not.toContain("passwd:") ; // sem conteúdo
    const everything = JSON.stringify(r); expect(everything).not.toContain("fora-da-raiz"); expect(everything).not.toContain("qualquer.txt"); expect(everything).not.toContain(sandbox);
    expect(r.providers.find((p) => p.provider === "local")).toMatchObject({ examined: true, complete: true, objectsEnumerated: 6 }); // ok1, ok2, orphan, dup, .keep, estranho
    void id1;
  });

  it("raiz limpa: tudo registrado e nada mais → completo sem inconsistências (código 0)", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const k = `${org}/${uuid()}`;
    put(root, k); await insert({ organizationId: org, provider: "local", key: k }, u.userId);
    const r = await audit();
    expect(r.status).toBe("completo-sem-inconsistencias"); expect(r.exitCode).toBe(EXIT_CODES.OK);
    expect(r.totals).toMatchObject({ orphans: 0, recordsWithoutObject: 0, inconsistentMetadata: 0, unverified: 0, recordsConsulted: 1, objectsEnumerated: 1 });
  });

  it("SOMENTE LEITURA: disco (raiz e fora da raiz) e tabela files ficam byte a byte idênticos; a transação do banco é READ ONLY", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id;
    const reg = `${org}/${uuid()}`; put(root, reg); put(root, `${org}/${uuid()}`); put(outside, "x/y.bin", "intocado"); await insert({ organizationId: org, provider: "local", key: reg }, u.userId); await insert({ organizationId: org, provider: "local", key: `${org}/${uuid()}` }, u.userId);
    const before = { disk: snapshot(sandbox), table: await tableDump() };
    let readOnly = "";
    const spying = { transaction: () => ({ execute: <T,>(fn: (trx: never) => Promise<T>) => db.transaction().execute(async (trx) => { const out = await fn(trx as never); readOnly = String(Object.values((await sql<Record<string, string>>`SHOW transaction_read_only`.execute(trx)).rows[0])[0]); return out; }) }) };
    const r = await audit({ db: spying as never });
    expect(r.exitCode).toBe(EXIT_CODES.INCONSISTENCIES);
    expect(readOnly).toBe("on"); // o próprio Postgres recusaria qualquer escrita
    expect({ disk: snapshot(sandbox), table: await tableDump() }).toEqual(before);
  });

  it("o mecanismo é real: numa transação READ ONLY o Postgres recusa o INSERT", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id;
    await expect(db.transaction().execute(async (trx) => { await sql`SET TRANSACTION READ ONLY`.execute(trx); await trx.insertInto("files").values({ scanStatus: "legado_nao_analisado", organizationId: org, uploadedByUserId: u.userId, storageProvider: "local", storageKey: `${org}/${uuid()}`, originalFilename: "x", contentType: "image/png", sizeBytes: 1, purpose: "comprovante_entrega" }).execute(); })).rejects.toMatchObject({ code: "25006" }); // read_only_sql_transaction (SQLSTATE: independe do idioma)
  });

  it("links simbólicos não são seguidos (nem o conteúdo de fora da raiz é lido) — ficam como não reconhecidos", async () => {
    put(outside, "segredo.txt", "nao-ler"); const u = await createAuthenticatedUser(); void u;
    try { symlinkSync(outside, path.join(root, "link-para-fora"), "junction"); } catch { return; /* sem permissão de link neste ambiente: nada a provar */ }
    const inv = await enumerateLocal(root, { hasLocalRecords: false });
    expect(inv.complete).toBe(true);
    if (inv.complete) { expect(inv.keys.some((k) => k.includes("segredo"))).toBe(false); expect(JSON.stringify(inv)).not.toContain("segredo.txt"); }
  });

  it("raiz inexistente: com registros locais é INCOMPLETO (não vira 'sem arquivo'); sem registros é vazio completo; raiz que é arquivo é incompleta", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id;
    const none = path.join(sandbox, "nao-existe");
    expect((await audit({ localRoot: none })).status).toBe("completo-sem-inconsistencias");
    await insert({ organizationId: org, provider: "local", key: `${org}/${uuid()}` }, u.userId);
    const r = await audit({ localRoot: none });
    expect(r.status).toBe("incompleto"); expect(r.exitCode).toBe(EXIT_CODES.INCOMPLETE);
    expect(r.recordsWithoutObject).toEqual([]); // nada foi dado como ausente
    writeFileSync(path.join(sandbox, "arquivo.txt"), "x");
    expect((await audit({ localRoot: path.join(sandbox, "arquivo.txt") })).status).toBe("incompleto");
  });

  it("banco indisponível: incompleto, e NENHUMA categoria é preenchida a partir de resultado parcial", async () => {
    put(root, `1/${uuid()}`);
    const broken = { transaction: () => ({ execute: async () => { throw new Error("connection refused postgres://u:senha-secreta@h/db"); } }) };
    const r = await audit({ db: broken as never });
    expect(r.status).toBe("incompleto"); expect(r.database.complete).toBe(false);
    expect(r.orphans).toEqual([]); expect(r.recordsWithoutObject).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/senha-secreta|postgres:\/\//); // só o nome do erro, nunca a mensagem
  });
});

describe("auditoria no S3 (adaptador e SDK reais contra o servidor local)", () => {
  const key = (org: number) => `${org}/${uuid()}`;
  it("lista todas as páginas, compara com os registros 's3' e classifica; as chaves exatas dos órfãos estão no relatório e nada além disso", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; s3.listPageSize = 2;
    const registered = [key(org), key(org), key(org)]; const orphans = [key(org), key(org), key(org)]; const missing = key(org);
    for (const k of [...registered, ...orphans]) s3.objects.set(`${BUCKET}/${k}`, { body: Buffer.from("x"), contentType: "image/png" });
    for (const k of registered) await insert({ organizationId: org, provider: "s3", key: k }, u.userId);
    const idMissing = await insert({ organizationId: org, provider: "s3", key: missing }, u.userId);
    const r = await audit({ providers: ["s3"], s3Adapter: s3Adapter() });
    expect(r.status).toBe("completo-com-inconsistencias");
    expect(set(r.orphans)).toEqual([...orphans].sort()); // inclui órfãos que estão nas páginas seguintes
    expect(r.recordsWithoutObject.map((x) => x.fileId)).toEqual([idMissing]);
    expect(r.providers.find((p) => p.provider === "s3")).toMatchObject({ complete: true, objectsEnumerated: 6 });
    expect(s3.requests.filter((x) => x.method === "GET").length).toBeGreaterThanOrEqual(3); // 6 objetos / 2 por página
    const text = JSON.stringify(r);
    for (const secret of [BUCKET, ACCESS_KEY, SECRET_KEY, s3.endpoint, String(s3.port), "us-east-1", "AWS4-HMAC", "dado-pessoal"]) expect(text, secret).not.toContain(secret);
  });

  it("SOMENTE LEITURA: só requisições GET de listagem; os objetos (chaves e bytes) e a tabela files ficam idênticos", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id;
    for (let i = 0; i < 5; i++) s3.objects.set(`${BUCKET}/${key(org)}`, { body: Buffer.from(`obj-${i}`), contentType: "image/png" });
    await insert({ organizationId: org, provider: "s3", key: key(org) }, u.userId);
    const dump = () => JSON.stringify([...s3.objects.entries()].map(([k, v]) => [k, v.body.toString("hex"), v.contentType]).sort());
    const before = { objects: dump(), table: await tableDump() }; s3.requests.length = 0; s3.listPageSize = 2;
    await audit({ providers: ["s3"], s3Adapter: s3Adapter() });
    expect(s3.requests.length).toBeGreaterThan(0);
    for (const q of s3.requests) { expect(q.method).toBe("GET"); expect(q.path).toMatch(new RegExp(`^/${BUCKET}/?$`)); } // listagem do bucket, nunca de um objeto, nunca PUT/DELETE/POST
    expect({ objects: dump(), table: await tableDump() }).toEqual(before);
  });

  it("listagem que falha na 2ª página, que trava (timeout) ou que vem truncada sem token → INCOMPLETO, sem tratar a parte obtida como definitiva", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id;
    const ks = [key(org), key(org), key(org), key(org)]; for (const k of ks) s3.objects.set(`${BUCKET}/${k}`, { body: Buffer.from("x"), contentType: "image/png" });
    await insert({ organizationId: org, provider: "s3", key: ks[3] }, u.userId);
    for (const [label, arm] of [["500 na página 2", () => { s3.listFailAtPage = 2; }], ["timeout", () => { s3.listHang = true; }], ["truncada sem token", () => { s3.listBrokenPagination = true; }]] as const) {
      s3.listFailAtPage = 0; s3.listHang = false; s3.listBrokenPagination = false; s3.listPageSize = 2; arm();
      const t0 = Date.now(); const r = await audit({ providers: ["s3"], s3Adapter: s3Adapter() });
      expect(r.status, label).toBe("incompleto"); expect(r.exitCode, label).toBe(EXIT_CODES.INCOMPLETE);
      expect(r.orphans, label).toEqual([]); expect(r.recordsWithoutObject, label).toEqual([]); // 3 órfãos reais existem, mas NÃO foram afirmados
      expect(r.providers.find((p) => p.provider === "s3"), label).toMatchObject({ complete: false, objectsEnumerated: 0 });
      expect(Date.now() - t0, label).toBeLessThan(15000);
      expect(JSON.stringify(r), label).not.toContain(s3.endpoint);
    }
  }, 60000);

  it("S3 solicitado mas não configurado: incompleto (nunca 'limpo'); o disco continua sendo classificado normalmente", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const k = `${org}/${uuid()}`; put(root, k);
    const r = await audit({ providers: ["local", "s3"], s3Adapter: null });
    expect(r.status).toBe("incompleto");
    expect(r.unverified.join(" ")).toMatch(/s3.*não configurado/);
    expect(r.orphans).toEqual([{ provider: "local", key: k }]); // o que foi verificado é relatado, marcado como parte de uma auditoria incompleta
  });

  it("o provedor vale por registro: chave local ausente no disco mas presente no S3 é 'sem objeto' (local) e órfã (s3) — as categorias não se misturam", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const k = `${org}/${uuid()}`;
    s3.objects.set(`${BUCKET}/${k}`, { body: Buffer.from("x"), contentType: "image/png" });
    const id = await insert({ organizationId: org, provider: "local", key: k }, u.userId);
    const r = await audit({ providers: ["local", "s3"], s3Adapter: s3Adapter() });
    expect(r.recordsWithoutObject).toEqual([{ provider: "local", key: k, fileId: id, organizationId: org }]);
    expect(r.orphans).toEqual([{ provider: "s3", key: k }]);
  });
});

describe("analyze (função pura)", () => {
  const rec = (id: number, o: Partial<FileRecord> = {}): FileRecord => ({ id, organizationId: 1, storageProvider: "local", storageKey: `1/${uuid()}`, ...o });
  it("sem registros do banco nada é classificado e o resultado é incompleto", () => {
    const r = analyze({ records: null, databaseFailure: "x", inventories: [{ provider: "local", complete: true, keys: [`1/${uuid()}`] }], requested: ["local"] });
    expect(r.status).toBe("incompleto"); expect(r.orphans).toEqual([]);
  });
  it("provedor não solicitado não é examinado nem conta como falha", () => {
    const r = analyze({ records: [rec(1, { storageProvider: "s3" })], inventories: [{ provider: "local", complete: true, keys: [] }], requested: ["local"] });
    expect(r.status).toBe("completo-sem-inconsistencias"); expect(r.providers.find((p) => p.provider === "s3")?.examined).toBe(false);
  });
  it("o relatório distingue os três resultados gerais", () => {
    const k = `1/${uuid()}`;
    expect(analyze({ records: [rec(1, { storageKey: k })], inventories: [{ provider: "local", complete: true, keys: [k] }], requested: ["local"] }).status).toBe("completo-sem-inconsistencias");
    expect(analyze({ records: [], inventories: [{ provider: "local", complete: true, keys: [k] }], requested: ["local"] }).status).toBe("completo-com-inconsistencias");
    expect(analyze({ records: [], inventories: [{ provider: "local", complete: false, failure: "EACCES" }], requested: ["local"] }).status).toBe("incompleto");
  });
});

describe("garantia estática de somente leitura", () => {
  const FORBIDDEN = /PutObject|DeleteObject|CopyObject|AbortMultipart|PutBucket|\bunlink|\brmSync|\brm\(|\brmdir|\brename|\bmkdir|\bwriteFile|\bappendFile|\bcopyFile|\btruncate|\bchmod|\bchown|\.upload\(|\.delete\(|insertInto|updateTable|deleteFrom|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bALTER\b/;
  const code = (f: string) => readFileSync(f, "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  it("o módulo de auditoria não contém nenhuma operação de escrita, remoção ou alteração", () => {
    expect(code("src/helpers/storageIntegrity.ts")).not.toMatch(FORBIDDEN);
  });
  it("o comando só grava o arquivo de relatório pedido em --out e não oferece opção de reparo/exclusão", () => {
    const cli = code("db/storage-audit.ts");
    expect(cli).not.toMatch(new RegExp(FORBIDDEN.source.replace("|\\bmkdir|\\bwriteFile", "")));
    expect((cli.match(/writeFileSync\(/g) ?? []).length).toBe(1);
    expect(cli).toMatch(/writeFileSync\(file,/);
    expect(cli).not.toMatch(/repair|fix|clean|prune|purge|remove|--delete|apply/i);
  });
  it("o listKeys do adaptador S3 usa só ListObjectsV2", () => {
    const src = readFileSync("src/helpers/storageAdapter.tsx", "utf8").replace(/\r\n/g, "\n"); const m = /async listKeys\(\)[\s\S]*?\n  }\n/.exec(src)!;
    expect(m[0]).toContain("ListObjectsV2Command"); expect(m[0]).not.toMatch(/Put|Delete|Copy|Upload/);
  });
});

describe("comando npm run storage:audit (processo real, banco de teste)", () => {
  // ASSÍNCRONO de propósito: o servidor S3 de teste vive neste processo; um spawnSync bloquearia o laço de eventos e o filho esperaria a resposta dele para sempre
  const run = (args: string[], env: Record<string, string | undefined> = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const e = { ...process.env, ...env }; for (const k of Object.keys(e)) if (k.startsWith("S3_") && !(k in env)) delete e[k];
    const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "db/storage-audit.ts", ...args], { env: e as NodeJS.ProcessEnv });
    let stdout = ""; let stderr = ""; child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  it("códigos de saída 0 / 1 / 2 / 3, relatório JSON sem segredos e nenhuma alteração no disco", async () => {
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id; const k = `${org}/${uuid()}`;
    put(root, k); await insert({ organizationId: org, provider: "local", key: k }, u.userId);
    const out = path.join(sandbox, "relatorio.json");
    const before = snapshot(root);
    const ok = await run(["--provider", "local", "--local-root", root, "--out", out]);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    const rep = JSON.parse(readFileSync(out, "utf8")) as AuditReport; expect(rep.status).toBe("completo-sem-inconsistencias");
    const orphan = `${org}/${uuid()}`; put(root, orphan);
    const withOrphan = await run(["--provider", "local", "--local-root", root, "--out", out]);
    expect(withOrphan.status).toBe(1); expect(JSON.parse(readFileSync(out, "utf8")).orphans[0].key).toBe(orphan);
    expect(withOrphan.stdout).toContain(`ÓRFÃO local ${orphan}`);
    expect((await run(["--provider", "s3"])).status).toBe(2); // S3 não configurado = incompleto
    expect((await run(["--provider", "local", "--local-root", path.join(sandbox, "nao-existe")])).status).toBe(2);
    expect((await run(["--repair"])).status).toBe(3); expect((await run(["--provider", "azure"])).status).toBe(3);
    const withS3 = await run(["--provider", "s3", "--out", out], { S3_BUCKET: BUCKET, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: ACCESS_KEY, S3_SECRET_ACCESS_KEY: SECRET_KEY, S3_ENDPOINT: s3.endpoint });
    expect(withS3.status).toBe(0); // bucket vazio e nenhum registro s3: completo e sem inconsistências (o registro local não entra nesta execução)
    const all = readFileSync(out, "utf8") + ok.stdout + withOrphan.stdout;
    for (const secret of [SECRET_KEY, ACCESS_KEY, s3.endpoint, BUCKET]) expect(all).not.toContain(secret);
    expect(snapshot(root).filter((l) => !l.includes(orphan.split("/")[1]))).toEqual(before.filter((l) => !l.includes(orphan.split("/")[1])));
    expect(existsSync(out)).toBe(true);
  }, 180000);
});
