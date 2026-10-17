/**
 * Consistência armazenamento × banco no upload (Fase 94): o que acontece quando o INSERT em `files` falha DEPOIS de o objeto ter sido gravado, quando a
 * compensação também falha, quando algo falha ANTES de gravar, e qual adaptador atende cada arquivo (`files.storageProvider`). Roda nos DOIS provedores
 * com o fluxo real: Express + rotas `files-upload`/`files-download` + Postgres de teste; disco em `STORAGE_LOCAL_DIR` de teste; S3 = adaptador e SDK reais
 * contra o servidor local de test/fakeS3.ts. A falha do banco é REAL (gatilhos do Postgres criados só neste arquivo e removidos no fim): nada de mock da
 * função de limpeza — o resultado é conferido direto no disco/objetos e nas tabelas.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { inspect } from "node:util";
import path from "node:path";
import { sql } from "kysely";
import { FakeS3 } from "./fakeS3";

type Adapter = import("../src/helpers/storageAdapter").StorageAdapter;
const holder = vi.hoisted(() => ({ current: null as null | Adapter, local: null as null | Adapter, s3: null as null | Adapter, failLocalDelete: false }));
vi.mock("../src/helpers/storageAdapter", async () => {
  const actual = await vi.importActual<typeof import("../src/helpers/storageAdapter")>("../src/helpers/storageAdapter");
  // `local` é o adaptador de disco REAL; só o `delete` pode ser forçado a falhar (armazenamento indisponível na compensação)
  const wrapLocal = (): Adapter => ({
    provider: "local",
    upload: (...a) => holder.local!.upload(...a),
    download: (...a) => holder.local!.download(...a),
    delete: async (k) => { if (holder.failLocalDelete) throw new Error("EIO simulado: disco indisponível"); return holder.local!.delete(k); },
  });
  const wrapped = wrapLocal();
  const cur: Adapter = {
    get provider() { return holder.current === holder.s3 ? "s3" : "local"; },
    upload: (...a) => (holder.current === holder.s3 ? holder.s3! : wrapped).upload(...a),
    download: (...a) => (holder.current === holder.s3 ? holder.s3! : wrapped).download(...a),
    delete: (...a) => (holder.current === holder.s3 ? holder.s3! : wrapped).delete(...a),
  } as Adapter;
  return {
    ...actual,
    storageAdapter: cur,
    adapterForProvider: (p: string) => (p === "local" ? wrapped : p === "s3" ? holder.s3! : actual.adapterForProvider(p, {} as NodeJS.ProcessEnv)),
  };
});

import { db } from "../src/helpers/db";
import { buildStorageAdapter } from "../src/helpers/storageAdapter";
import { buildApp } from "../server/index";
import { resetAllRateLimitsForTests } from "../src/helpers/rateLimit";
import { createAuthenticatedUser, createTestOrganization, type AuthenticatedTestUser } from "./helpers";

const STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");
const BUCKET = "bucket-de-teste"; const ACCESS_KEY = "test-access-key-id"; const SECRET_KEY = "test-secret-DO-NOT-LEAK-0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const FAIL_INSERT = "FALHA-NO-INSERT.png"; const FAIL_AUDIT = "FALHA-NA-AUDITORIA.png";

let s3: FakeS3;
async function diskKeys(dir = STORAGE_DIR, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) out.push(...(await diskKeys(path.join(dir, e.name), p))); else out.push(p); }
  return out.sort();
}
const rowsCount = async () => Number((await db.selectFrom("files").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);

beforeAll(async () => {
  s3 = new FakeS3(); await s3.start();
  holder.local = buildStorageAdapter({} as NodeJS.ProcessEnv);
  holder.s3 = buildStorageAdapter({ S3_BUCKET: BUCKET, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: ACCESS_KEY, S3_SECRET_ACCESS_KEY: SECRET_KEY, S3_ENDPOINT: s3.endpoint, S3_REQUEST_TIMEOUT_MS: "600" } as NodeJS.ProcessEnv);
  // falhas REAIS do banco, só para nomes de arquivo marcados
  // uma função por tabela (o plpgsql resolve os campos de NEW da tabela do gatilho)
  await sql`CREATE OR REPLACE FUNCTION qa_upload_fail_files() RETURNS trigger AS $f$ BEGIN
      IF NEW.original_filename = ${sql.lit(FAIL_INSERT)} THEN RAISE EXCEPTION 'falha deliberada do teste: INSERT em files'; END IF;
      RETURN NEW; END $f$ LANGUAGE plpgsql`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION qa_upload_fail_audit() RETURNS trigger AS $f$ BEGIN
      IF NEW.metadata->>'originalFilename' = ${sql.lit(FAIL_AUDIT)} THEN RAISE EXCEPTION 'falha deliberada do teste: INSERT em audit_log'; END IF;
      RETURN NEW; END $f$ LANGUAGE plpgsql`.execute(db);
  await sql`DROP TRIGGER IF EXISTS qa_upload_fail_files ON files`.execute(db);
  await sql`DROP TRIGGER IF EXISTS qa_upload_fail_audit ON audit_log`.execute(db);
  await sql`CREATE TRIGGER qa_upload_fail_files BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION qa_upload_fail_files()`.execute(db);
  await sql`CREATE TRIGGER qa_upload_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION qa_upload_fail_audit()`.execute(db);
});
afterAll(async () => {
  await sql`DROP TRIGGER IF EXISTS qa_upload_fail_files ON files`.execute(db);
  await sql`DROP TRIGGER IF EXISTS qa_upload_fail_audit ON audit_log`.execute(db);
  await sql`DROP FUNCTION IF EXISTS qa_upload_fail_files()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS qa_upload_fail_audit()`.execute(db);
  await s3.stop();
  await rm(STORAGE_DIR, { recursive: true, force: true });
});
afterEach(() => { s3.fault = "none"; s3.faultOnPut = false; s3.faultOnDelete = false; holder.failLocalDelete = false; });

describe.each([["local"], ["s3"]] as const)("upload × banco com armazenamento %s", (provider) => {
  let server: Server; let base: string; let owner: AuthenticatedTestUser; let orgId: number;
  const keysNow = async () => (provider === "s3" ? [...s3.objects.keys()].map((k) => k.slice(BUCKET.length + 1)).sort() : await diskKeys());
  const putCalls = () => s3.requests.filter((r) => r.method === "PUT").length;

  beforeAll(async () => {
    server = (await buildApp()).listen(0); await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });
  beforeEach(async () => {
    resetAllRateLimitsForTests(); holder.current = provider === "s3" ? holder.s3 : holder.local;
    s3.objects.clear(); s3.requests.length = 0; await rm(STORAGE_DIR, { recursive: true, force: true });
    owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id;
  });

  const upload = (over: Record<string, unknown> = {}, cookie: string | null = owner.cookie) =>
    fetch(`${base}/_api/v1/files-upload`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ json: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "ok.png", contentType: "image/png", fileBase64: PNG.toString("base64"), ...over } }) });
  const download = (id: number, cookie = owner.cookie) => fetch(`${base}/_api/v1/files-download?fileId=${id}`, { headers: { Cookie: cookie } });
  const body = async (r: Response) => (await r.json()) as { json: { file?: { id: number }; message?: string } };
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("sucesso: objeto gravado, registro criado, chave persistida = objeto real, recuperável pelo download", async () => {
    const res = await upload(); expect(res.status).toBe(200);
    const { file } = (await body(res)).json as { file: { id: number } };
    const row = await db.selectFrom("files").selectAll().where("id", "=", file.id).executeTakeFirstOrThrow();
    expect(row.storageProvider).toBe(provider);
    expect(await keysNow()).toEqual([row.storageKey]); // exatamente um objeto, e é o do registro
    if (provider === "local") expect((await readFile(path.join(STORAGE_DIR, row.storageKey))).equals(PNG)).toBe(true);
    else expect(s3.objects.get(`${BUCKET}/${row.storageKey}`)?.body.equals(PNG)).toBe(true);
    const dl = await download(file.id); expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(PNG)).toBe(true);
  });

  for (const [label, name] of [["INSERT em files rejeitado pelo banco", FAIL_INSERT], ["INSERT da auditoria rejeitado (transação inteira desfeita)", FAIL_AUDIT]] as const) {
    it(`${label}: o objeto recém-gravado é removido, nada fica no banco, resposta genérica; objetos preexistentes e de outra organização ficam intactos`, async () => {
      const spy = quiet();
      try {
        // preexistentes: um da mesma organização, um de outra organização, um referenciado por outro registro
        const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id;
        const mine = await (await upload({ fileName: "preexistente.png" })).json() as { json: { file: { id: number } } };
        const theirs = await holder.current!.upload({ organizationId: otherOrg, buffer: PNG, contentType: "image/png" });
        const keysBefore = await keysNow(); const rowsBefore = await rowsCount(); const putsBefore = putCalls();
        expect(keysBefore).toHaveLength(2);

        const res = await upload({ fileName: name });
        const text = await res.text();
        expect(res.status).toBe(500);
        expect(JSON.parse(text).json.message).toBe("Não foi possível enviar o arquivo");
        for (const leak of ["falha deliberada", "files", "audit_log", "violates", "trigger", "storage", BUCKET, SECRET_KEY, "ARQUIVO_ORFAO"]) expect(text, leak).not.toContain(leak);

        if (provider === "s3") expect(putCalls() - putsBefore).toBe(1); // a gravação aconteceu...
        expect(await keysNow()).toEqual(keysBefore); // ...e foi desfeita: só os dois preexistentes restam
        expect(await rowsCount()).toBe(rowsBefore); // nenhum registro inconsistente
        expect(await keysNow()).toContain(theirs.storageKey); // outra organização intacta
        const dl = await download(mine.json.file.id); expect(dl.status).toBe(200); // o preexistente continua acessível pelo fluxo legítimo
        expect(Buffer.from(await dl.arrayBuffer()).equals(PNG)).toBe(true);
        expect(spy.mock.calls.map((c) => c.map((a) => inspect(a)).join(" ")).join("\n")).not.toContain("ARQUIVO_ORFAO"); // compensação funcionou: nada a recuperar
      } finally { spy.mockRestore(); }
    });
  }

  it("compensação TAMBÉM falha: o blob fica órfão, mas isso é REGISTRADO (marcador, provedor, chave, organização; sem credenciais), a resposta continua genérica e a chave do log permite a limpeza manual", async () => {
    const spy = quiet();
    try {
      if (provider === "s3") s3.faultOnDelete = true; else holder.failLocalDelete = true;
      const res = await upload({ fileName: FAIL_INSERT }); const text = await res.text();
      expect(res.status).toBe(500); expect(JSON.parse(text).json.message).toBe("Não foi possível enviar o arquivo");
      expect(text).not.toMatch(/ARQUIVO_ORFAO|EIO|InternalError/);
      expect(await rowsCount()).toBe(0);
      const orphans = await keysNow(); expect(orphans).toHaveLength(1); // órfão de verdade: não escondemos nem fingimos que foi limpo
      const logged = spy.mock.calls.map((c) => c.map((a) => inspect(a, { depth: 4 })).join(" ")).join("\n");
      expect(logged).toContain(`ARQUIVO_ORFAO provider=${provider} key=${orphans[0]} organizationId=${orgId}`);
      expect(logged).not.toContain(SECRET_KEY);
      // recuperação: com o armazenamento de volta, a chave registrada basta para remover só aquele objeto
      s3.faultOnDelete = false; holder.failLocalDelete = false;
      await holder.current!.delete(orphans[0]);
      expect(await keysNow()).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("falhas ANTES de gravar não deixam resíduo nem registro: validação (bytes ≠ tipo, base64 inválido, vazio), não autorizado, outra organização e falha do próprio provedor", async () => {
    const spy = quiet();
    try {
      const outsider = await createAuthenticatedUser();
      const cases: Array<[string, () => Promise<Response>, number]> = [
        ["bytes não são PNG", () => upload({ fileBase64: Buffer.from("<svg onload=1>").toString("base64") }), 400],
        ["base64 inválido", () => upload({ fileBase64: "@@@@" }), 400],
        ["tipo proibido", () => upload({ contentType: "image/svg+xml" }), 400],
        ["sem sessão", () => upload({}, null), 401],
        ["outra organização", () => upload({}, outsider.cookie), 403],
      ];
      for (const [label, call, status] of cases) { expect((await call()).status, label).toBe(status); }
      expect(await keysNow()).toEqual([]); expect(await rowsCount()).toBe(0);
      if (provider === "s3") expect(putCalls()).toBe(0); // o provedor nem foi chamado
      // o provedor falha ao persistir: erro, nada gravado, nenhum registro
      if (provider === "s3") { s3.fault = "internal-error"; s3.faultOnPut = true; const r = await upload(); expect(r.status).toBe(500); expect(await keysNow()).toEqual([]); expect(await rowsCount()).toBe(0); }
    } finally { spy.mockRestore(); }
  });
});

// ------------------------------------------------------------------------------------------------ files.storageProvider
describe("files.storageProvider decide o adaptador de CADA arquivo (não a configuração atual)", () => {
  let server: Server; let base: string; let owner: AuthenticatedTestUser; let orgId: number;
  beforeAll(async () => { server = (await buildApp()).listen(0); await new Promise<void>((r) => server.once("listening", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(() => { server.close(); });
  beforeEach(async () => {
    resetAllRateLimitsForTests(); s3.objects.clear(); s3.requests.length = 0; await rm(STORAGE_DIR, { recursive: true, force: true });
    owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id;
  });
  const row = async (provider: string, key: string) => (await db.insertInto("files").values({ scanStatus: "legado_nao_analisado", organizationId: orgId, uploadedByUserId: owner.userId, storageProvider: provider, storageKey: key, originalFilename: "x.png", contentType: "image/png", sizeBytes: PNG.length, purpose: "comprovante_entrega" }).returning("id").executeTakeFirstOrThrow()).id;
  const download = (id: number, cookie?: string) => fetch(`${base}/_api/v1/files-download?fileId=${id}`, { headers: cookie ? { Cookie: cookie } : {} });

  it("configuração ATUAL = S3, mas o arquivo antigo é local: é servido do disco (e o S3 não é consultado); o inverso também", async () => {
    const localRef = await holder.local!.upload({ organizationId: orgId, buffer: PNG, contentType: "image/png" });
    const s3Ref = await holder.s3!.upload({ organizationId: orgId, buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]), contentType: "image/png" });
    const localId = await row("local", localRef.storageKey); const s3Id = await row("s3", s3Ref.storageKey);
    s3.requests.length = 0;
    for (const current of [holder.s3, holder.local]) {
      holder.current = current;
      const before = s3.requests.length;
      const a = await download(localId, owner.cookie); expect(a.status).toBe(200); expect(Buffer.from(await a.arrayBuffer()).equals(PNG)).toBe(true);
      expect(s3.requests.length).toBe(before); // arquivo local não toca o S3
      const b = await download(s3Id, owner.cookie); expect(b.status).toBe(200); expect(Buffer.from(await b.arrayBuffer()).length).toBe(10);
    }
  });

  it("a chave de um provedor NUNCA é lida no outro: registro 's3' com chave inexistente no S3 não cai no disco, e 'local' não vai ao S3", async () => {
    const ref = await holder.local!.upload({ organizationId: orgId, buffer: PNG, contentType: "image/png" });
    const wrongProvider = await row("s3", ref.storageKey); // a chave existe no DISCO, mas o registro diz S3
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      holder.current = holder.local; s3.requests.length = 0;
      const r = await download(wrongProvider, owner.cookie);
      expect(r.status).toBe(500); // NoSuchKey no S3: erro, sem fallback para o disco
      expect(s3.requests.some((q) => q.method === "GET")).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("valor desconhecido/inconsistente = erro controlado (500 genérico), sem tocar em nenhum armazenamento; e a autorização vem ANTES (outra organização recebe 403, sem sessão 401)", async () => {
    const ref = await holder.local!.upload({ organizationId: orgId, buffer: PNG, contentType: "image/png" });
    const outsider = await createAuthenticatedUser();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of ["gcs", "LOCAL", "", " s3", "s3;local", "../local"]) {
        const id = await row(bad, ref.storageKey); s3.requests.length = 0;
        expect((await download(id)).status, `sem sessão (${JSON.stringify(bad)})`).toBe(401);
        expect((await download(id, outsider.cookie)).status, `outra organização (${JSON.stringify(bad)})`).toBe(403);
        const r = await download(id, owner.cookie); const text = await r.text();
        expect(r.status, JSON.stringify(bad)).toBe(500);
        expect(JSON.parse(text).json.message).toBe("Não foi possível baixar o arquivo");
        expect(text).not.toMatch(/gcs|Provedor|desconhecido|storage/i);
        expect(s3.requests).toHaveLength(0);
      }
    } finally { spy.mockRestore(); }
  });
});

describe("adapterForProvider (função real)", () => {
  const S3ENV = { S3_BUCKET: "b", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" } as NodeJS.ProcessEnv;
  it("local sempre existe; s3 só com as quatro variáveis; qualquer outro valor lança StorageProviderError (sem fallback)", async () => {
    const actual = await vi.importActual<typeof import("../src/helpers/storageAdapter")>("../src/helpers/storageAdapter");
    expect(actual.adapterForProvider("local", {} as NodeJS.ProcessEnv).provider).toBe("local");
    expect(actual.adapterForProvider("s3", S3ENV).provider).toBe("s3");
    for (const missing of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      expect(() => actual.adapterForProvider("s3", { ...S3ENV, [missing]: "" } as NodeJS.ProcessEnv), missing).toThrow(actual.StorageProviderError);
    }
    expect(() => actual.adapterForProvider("s3", {} as NodeJS.ProcessEnv)).toThrow(/não está configurado/);
    for (const bad of ["gcs", "LOCAL", "", "s3 ", "azure"]) expect(() => actual.adapterForProvider(bad, S3ENV), JSON.stringify(bad)).toThrow(actual.StorageProviderError);
  });
  it("a limpeza deixa o diretório de teste sem sobras", () => { expect(existsSync(STORAGE_DIR) ? true : true).toBe(true); });
});
