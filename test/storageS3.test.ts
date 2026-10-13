/**
 * Adaptador S3 de arquivos (src/helpers/storageAdapter.tsx) exercitado de verdade: o `S3StorageAdapter` REAL, com o SDK REAL (`@aws-sdk/client-s3`),
 * fala HTTP com um servidor S3 local controlado pelo teste (test/fakeS3.ts) — nada de mock do SDK. Cobre o contrato com o restante do sistema pelas
 * rotas reais `files-upload`/`files-download` (banco de teste, sessão, autorização por organização) e as falhas de armazenamento. LIMITES: o servidor
 * local NÃO valida assinaturas SigV4, não implementa versionamento/ACL/URLs pré-assinadas e não prova compatibilidade com um bucket real da AWS/R2/MinIO;
 * prova o contrato HTTP que o SDK emite e como o app reage ao que um S3 responde.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { FakeS3 } from "./fakeS3";

const holder = vi.hoisted(() => ({ adapter: null as null | import("../src/helpers/storageAdapter").StorageAdapter }));
vi.mock("../src/helpers/storageAdapter", async () => {
  const actual = await vi.importActual<typeof import("../src/helpers/storageAdapter")>("../src/helpers/storageAdapter");
  return {
    ...actual,
    // as rotas importam `storageAdapter`: aqui ele delega ao adaptador S3 REAL criado no beforeAll (apontado para o servidor local)
    storageAdapter: {
      get provider() { return holder.adapter!.provider; },
      upload: (...a: Parameters<typeof actual.storageAdapter.upload>) => holder.adapter!.upload(...a),
      download: (...a: Parameters<typeof actual.storageAdapter.download>) => holder.adapter!.download(...a),
      delete: (...a: Parameters<typeof actual.storageAdapter.delete>) => holder.adapter!.delete(...a),
    },
    // a rota resolve o adaptador pelo provedor GRAVADO no registro; aqui o único provedor é o S3 real apontado ao servidor local
    adapterForProvider: (p: string) => { if (p !== "s3") return actual.adapterForProvider(p, {} as NodeJS.ProcessEnv); return holder.adapter!; },
  };
});

import { db } from "../src/helpers/db";
import { buildStorageAdapter } from "../src/helpers/storageAdapter";
import { buildApp } from "../server/index";
import { resetAllRateLimitsForTests } from "../src/helpers/rateLimit";
import { addMembership, createAuthenticatedUser, createTestOrganization, type AuthenticatedTestUser } from "./helpers";

const ACCESS_KEY = "test-access-key-id";
const SECRET_KEY = "test-secret-DO-NOT-LEAK-0123456789abcdef";
const BUCKET = "bucket-de-teste";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const KEY_SHAPE = /^\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let s3: FakeS3; let adapter: import("../src/helpers/storageAdapter").StorageAdapter;
const env = (over: Record<string, string> = {}) => ({ S3_BUCKET: BUCKET, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: ACCESS_KEY, S3_SECRET_ACCESS_KEY: SECRET_KEY, S3_ENDPOINT: s3.endpoint, S3_REQUEST_TIMEOUT_MS: "600", ...over }) as NodeJS.ProcessEnv;

beforeAll(async () => { s3 = new FakeS3(); await s3.start(); adapter = buildStorageAdapter(env()); holder.adapter = adapter; });
afterAll(async () => { await s3.stop(); });
afterEach(() => { s3.fault = "none"; s3.faultOnPut = false; s3.faultOnDelete = false; });

describe("adaptador S3 real contra um endpoint HTTP local", () => {
  it("é o adaptador S3 (não o de disco) quando as variáveis S3_* existem, e o de disco sem elas", () => {
    expect(adapter.provider).toBe("s3");
    expect(buildStorageAdapter({ ...env(), S3_BUCKET: "" } as NodeJS.ProcessEnv).provider).toBe("local");
    expect(buildStorageAdapter({} as NodeJS.ProcessEnv).provider).toBe("local");
  });

  it("upload → download devolve os bytes EXATOS (todos os 256 valores, 5 MB), sem truncar", async () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const big = randomBytes(5 * 1024 * 1024);
    for (const body of [all, big, Buffer.from([0]), PNG]) {
      const ref = await adapter.upload({ organizationId: 7, buffer: body, contentType: "image/png" });
      expect(ref.storageProvider).toBe("s3");
      const back = await adapter.download(ref.storageKey);
      expect(back.length).toBe(body.length);
      expect(back.equals(body)).toBe(true);
    }
  });

  it("a chave é <organizationId>/<uuid> e o objeto vai para o bucket configurado, em path-style, com o Content-Type declarado", async () => {
    const ref = await adapter.upload({ organizationId: 42, buffer: PNG, contentType: "image/png" });
    expect(ref.storageKey).toMatch(KEY_SHAPE);
    expect(ref.storageKey.startsWith("42/")).toBe(true);
    const put = s3.requests.filter((r) => r.method === "PUT").at(-1)!;
    expect(put.path).toBe(`/${BUCKET}/${ref.storageKey}`);
    expect(s3.objects.get(`${BUCKET}/${ref.storageKey}`)?.contentType).toBe("image/png");
    const other = await adapter.upload({ organizationId: 42, buffer: PNG, contentType: "image/png" });
    expect(other.storageKey).not.toBe(ref.storageKey); // sem colisão
  });

  it("toda requisição sai ASSINADA (SigV4) com a credencial sintética, e o segredo nunca trafega", async () => {
    const before = s3.requests.length;
    const ref = await adapter.upload({ organizationId: 1, buffer: PNG, contentType: "image/png" });
    await adapter.download(ref.storageKey); await adapter.delete(ref.storageKey);
    const mine = s3.requests.slice(before);
    expect(mine.map((r) => r.method)).toEqual(["PUT", "GET", "DELETE"]);
    for (const r of mine) {
      expect(r.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/\\d{8}/us-east-1/s3/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$`));
      expect(JSON.stringify(r.headers)).not.toContain(SECRET_KEY);
    }
  });

  it("delete remove o objeto e não falha para chave inexistente", async () => {
    const ref = await adapter.upload({ organizationId: 3, buffer: PNG, contentType: "image/png" });
    expect(s3.objects.has(`${BUCKET}/${ref.storageKey}`)).toBe(true);
    await adapter.delete(ref.storageKey);
    expect(s3.objects.has(`${BUCKET}/${ref.storageKey}`)).toBe(false);
    await expect(adapter.delete("3/00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });

  it("chave controlada por usuário não escapa do bucket/prefixo: segmentos '..', barras, esquemas e valores fora do formato são recusados ANTES de ir à rede", async () => {
    const before = s3.requests.length;
    const hostile = ["../outra-org/x", "1/../../outro-bucket/x", "1/../2/00000000-0000-0000-0000-000000000000", "/etc/passwd", "1//x", "http://evil.example/x", "1/%2e%2e/2/x", "1/a\r\nHost: evil", "", "1/uuid-com-espaço x", "\\\\servidor\\x"];
    for (const key of hostile) {
      await expect(adapter.download(key), key).rejects.toThrow();
      await expect(adapter.delete(key), key).resolves.toBeUndefined(); // delete é best-effort, mas também não pode sair do formato
    }
    expect(s3.requests.length).toBe(before); // nenhuma chamada à rede
  });

  it("objeto inexistente, acesso negado e erro 500 do serviço viram erro (nunca bytes vazios), e o 500 é tentado de novo pelo SDK", async () => {
    await expect(adapter.download("9/11111111-1111-1111-1111-111111111111")).rejects.toThrow();
    s3.fault = "access-denied"; await expect(adapter.download("9/22222222-2222-2222-2222-222222222222")).rejects.toThrow();
    const n = s3.requests.length; s3.fault = "internal-error";
    await expect(adapter.download("9/33333333-3333-3333-3333-333333333333")).rejects.toThrow();
    expect(s3.requests.length - n).toBeGreaterThan(1); // retentativas do SDK
    s3.fault = "no-such-key"; await expect(adapter.download("9/44444444-4444-4444-4444-444444444444")).rejects.toThrow();
  });

  it("falha na gravação (500/403) propaga erro e não deixa objeto", async () => {
    const before = s3.objects.size;
    s3.fault = "internal-error"; s3.faultOnPut = true;
    await expect(adapter.upload({ organizationId: 5, buffer: PNG, contentType: "image/png" })).rejects.toThrow();
    s3.fault = "access-denied";
    await expect(adapter.upload({ organizationId: 5, buffer: PNG, contentType: "image/png" })).rejects.toThrow();
    expect(s3.objects.size).toBe(before);
  });

  it("serviço que não responde (timeout), corpo truncado e corpo que trava no meio REJEITAM em tempo limitado — nunca devolvem parte do arquivo nem ficam pendurados", async () => {
    const ref = await adapter.upload({ organizationId: 8, buffer: randomBytes(64 * 1024), contentType: "image/png" });
    for (const fault of ["hang", "truncate", "stall"] as const) {
      s3.fault = fault; const t0 = Date.now();
      await expect(adapter.download(ref.storageKey), fault).rejects.toThrow();
      expect(Date.now() - t0, `${fault} deveria falhar em poucos segundos`).toBeLessThan(15000);
    }
  }, 60000);
});

// ------------------------------------------------------------------------------------------------ rotas reais sobre o adaptador S3
describe("files-upload / files-download pelo Express real, com armazenamento S3", () => {
  let server: Server; let base: string; let owner: AuthenticatedTestUser; let orgId: number;
  beforeAll(async () => {
    server = (await buildApp()).listen(0); await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  // o setup global limpa as tabelas entre os testes: usuário e organização são criados a cada teste
  beforeEach(async () => { resetAllRateLimitsForTests(); owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; });
  afterAll(() => { server.close(); });

  const upload = (body: Record<string, unknown>, cookie = owner.cookie) =>
    fetch(`${base}/_api/v1/files-upload`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", Cookie: cookie }, body: JSON.stringify({ json: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "a.png", contentType: "image/png", fileBase64: PNG.toString("base64"), ...body } }) });
  const download = (id: number | string, cookie?: string) => fetch(`${base}/_api/v1/files-download?fileId=${id}`, { headers: cookie ? { Cookie: cookie } : {} });
  const uploaded = async (over: Record<string, unknown> = {}) => (await (await upload(over)).json() as { json: { file: { id: number; downloadUrl: string } } }).json.file;

  it("envia e baixa pelo S3: bytes idênticos, Content-Type exato, nosniff, no-store, Content-Length correto, disposição inline só ASCII", async () => {
    const file = await uploaded({ fileName: "日本語 ñ \"x\";y.png" });
    const row = await db.selectFrom("files").select(["storageProvider", "storageKey", "contentType", "sizeBytes"]).where("id", "=", file.id).executeTakeFirstOrThrow();
    expect(row.storageProvider).toBe("s3"); expect(row.storageKey).toMatch(KEY_SHAPE);
    expect(s3.objects.has(`${BUCKET}/${row.storageKey}`)).toBe(true);
    const res = await download(file.id, owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    const disp = res.headers.get("content-disposition")!;
    expect(disp.startsWith("inline;")).toBe(true); expect(disp).toMatch(/^[\x20-\x7e]*$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("nome de arquivo (Unicode, hostil, longo) NUNCA entra na chave: o objeto vai para <org>/<uuid> e o nome é só dado", async () => {
    const before = new Set(s3.objects.keys());
    for (const fileName of ["../../outro-bucket/x.png", "x".repeat(250) + ".png", "日本語.png", "a/b\\c.png", "%2e%2e/x.png"]) {
      const file = await uploaded({ fileName });
      const row = await db.selectFrom("files").select(["storageKey", "originalFilename"]).where("id", "=", file.id).executeTakeFirstOrThrow();
      expect(row.storageKey).toMatch(KEY_SHAPE); expect(row.originalFilename).toBe(fileName);
    }
    const added = [...s3.objects.keys()].filter((k) => !before.has(k));
    expect(added.length).toBe(5);
    for (const k of added) expect(k.startsWith(`${BUCKET}/${orgId}/`)).toBe(true);
    expect(s3.requests.every((r) => r.path.startsWith(`/${BUCKET}/`))).toBe(true); // nenhuma chamada fora do bucket configurado
  });

  it("autorização é por SESSÃO + organização, não pela chave: sem sessão 401, outra organização 403, membro inativo 403 — e o S3 nem é consultado", async () => {
    const file = await uploaded();
    const outsider = await createAuthenticatedUser();
    const inactive = await createAuthenticatedUser(); await addMembership(orgId, inactive.userId, "voluntario", "inativo");
    const n = s3.requests.length;
    expect((await download(file.id)).status).toBe(401);
    expect((await download(file.id, outsider.cookie)).status).toBe(403);
    expect((await download(file.id, inactive.cookie)).status).toBe(403);
    expect((await download(999999999, owner.cookie)).status).toBe(404);
    expect((await download("1 OR 1=1", owner.cookie)).status).toBe(400);
    expect(s3.requests.length).toBe(n); // nenhuma leitura no armazenamento sem autorização
    expect((await download(file.id, owner.cookie)).status).toBe(200);
    const volunteer = await createAuthenticatedUser(); await addMembership(orgId, volunteer.userId, "voluntario");
    expect((await download(file.id, volunteer.cookie)).status).toBe(200); // membro ATIVO da organização lê
  });

  it("outra organização não consegue enviar para esta, e o envio rejeitado não deixa objeto no S3", async () => {
    const outsider = await createAuthenticatedUser(); const before = s3.objects.size;
    expect((await upload({}, outsider.cookie)).status).toBe(403);
    expect((await upload({ fileBase64: Buffer.from("<svg onload=alert(1)>").toString("base64") })).status).toBe(400); // conteúdo não é PNG
    expect(s3.objects.size).toBe(before);
  });

  it("linha ANTIGA com tipo ativo guardada no S3 (text/html, image/svg+xml) é servida como octet-stream + attachment + nosniff", async () => {
    for (const [type, content] of [["text/html", "<script>1</script>"], ["image/svg+xml", "<svg onload='1'/>"]] as const) {
      const ref = await adapter.upload({ organizationId: orgId, buffer: Buffer.from(content), contentType: type });
      const row = await db.insertInto("files").values({ organizationId: orgId, uploadedByUserId: owner.userId, storageProvider: "s3", storageKey: ref.storageKey, originalFilename: "legado", contentType: type, sizeBytes: content.length, purpose: "comprovante_entrega" }).returning("id").executeTakeFirstOrThrow();
      const res = await download(row.id, owner.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("falhas do S3 (inexistente, acesso negado, 500, sem resposta, truncado, travado) viram 500 em JSON genérico — sem vazar bucket, endpoint, chaves, assinatura ou stack — e o log também não vaza o segredo", async () => {
    const file = await uploaded();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const fault of ["no-such-key", "access-denied", "internal-error", "hang", "truncate", "stall"] as const) {
        s3.fault = fault;
        const res = await download(file.id, owner.cookie);
        const text = await res.text();
        expect(res.status, fault).toBe(500);
        expect(res.headers.get("content-type"), fault).toMatch(/^application\/json/);
        expect(JSON.parse(text).json.message, fault).toBe("Não foi possível baixar o arquivo");
        for (const secret of [BUCKET, String(s3.port), ACCESS_KEY, SECRET_KEY, "AWS4-HMAC", "Signature=", "X-Amz", "NoSuchKey", "AccessDenied", "fake-request-id", "127.0.0.1"]) expect(text, `${fault}: resposta contém ${secret}`).not.toContain(secret);
      }
      const logged = spy.mock.calls.map((c) => c.map((a) => inspect(a, { depth: 6 })).join(" ")).join("\n");
      expect(logged).not.toContain(SECRET_KEY);
      expect(logged).not.toMatch(/Signature=|X-Amz-Signature|Authorization/i);
    } finally { spy.mockRestore(); }
  }, 120000);

  it("depois das falhas o S3 volta a servir normalmente (nenhum estado preso)", async () => {
    const file = await uploaded(); s3.fault = "none";
    const res = await download(file.id, owner.cookie);
    expect(res.status).toBe(200); expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });
});
