/**
 * Revisão independente do PR #1: a chave de armazenamento gravada em `files.storage_key` precisa pertencer à organização do próprio registro.
 * Defesa em profundidade para uma linha adulterada no banco (o endpoint nunca usa entrada do usuário como chave): a guarda de formato do S3 e a do disco
 * impediam sair da raiz, mas `<outra-org>/<uuid>` tem o formato válido e `1/../2/<uuid>` continua DENTRO da raiz do disco.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/helpers/db";
import { handle as getFilesDownload } from "../src/endpoints/files-download_GET";
import { storageAdapter } from "../src/helpers/storageAdapter";
import { resetAllRateLimitsForTests } from "../src/helpers/rateLimit";
import { createAuthenticatedUser, createTestOrganization, buildRequest } from "./helpers";

const STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SECRET = Buffer.concat([PNG, Buffer.from("segredo-da-outra-organizacao")]);

// Estes testes cobrem ARMAZENAMENTO/cabeçalhos e usam linhas ANTIGAS (legado_nao_analisado, anteriores à análise), que só são servidas fora do modo obrigatório.
// A premissa é explícita e restaurada a cada teste (não herda FILE_SCAN_MODE do terminal/.env.test). O bloqueio do modo obrigatório (legado, 409, infectado, fail-closed) é provado em test/fileScan.test.ts.
beforeEach(() => { vi.stubEnv("FILE_SCAN_MODE", "disabled"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("a chave de armazenamento tem de pertencer à organização do registro", () => {
  afterAll(async () => { await rm(STORAGE_DIR, { recursive: true, force: true }); });
  beforeEach(() => resetAllRateLimitsForTests());

  async function setup() {
    const a = await createAuthenticatedUser(); const orgA = (await createTestOrganization(a.userId)).id;
    const b = await createAuthenticatedUser(); const orgB = (await createTestOrganization(b.userId)).id;
    const objB = await storageAdapter.upload({ organizationId: orgB, buffer: SECRET, contentType: "image/png" });
    const own = await storageAdapter.upload({ organizationId: orgA, buffer: PNG, contentType: "image/png" });
    const row = await db.insertInto("files").values({ scanStatus: "legado_nao_analisado", organizationId: orgA, uploadedByUserId: a.userId, storageProvider: own.storageProvider, storageKey: own.storageKey, originalFilename: "a.png", contentType: "image/png", sizeBytes: PNG.length, purpose: "comprovante_entrega" }).returning("id").executeTakeFirstOrThrow();
    return { a, orgA, orgB, objB, row };
  }
  const download = (cookie: string, id: number) => getFilesDownload(buildRequest(`files-download?fileId=${id}`, { cookie }));
  const tamper = (id: number, key: string) => db.updateTable("files").set({ storageKey: key }).where("id", "=", id).execute();

  it("controle: o arquivo da própria organização é servido", async () => {
    const { a, row } = await setup();
    expect((await download(a.cookie, row.id)).status).toBe(200);
  });

  it("registro da org A apontando para o objeto da org B (chave de formato VÁLIDO) não entrega o conteúdo de B", async () => {
    const { a, row, objB } = await setup();
    await tamper(row.id, objB.storageKey);
    const res = await download(a.cookie, row.id);
    expect(res.status).not.toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).includes(Buffer.from("segredo-da-outra-organizacao"))).toBe(false);
  });

  it("travessia que continua dentro da raiz do disco (`<orgA>/../<orgB>/<uuid>`) também não entrega o conteúdo de B", async () => {
    const { a, orgA, row, objB } = await setup();
    await tamper(row.id, `${orgA}/../${objB.storageKey}`);
    const res = await download(a.cookie, row.id);
    expect(res.status).not.toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).includes(Buffer.from("segredo-da-outra-organizacao"))).toBe(false);
  });

  it("o adaptador de disco recusa chaves fora do formato `<org>/<uuid>` (download e remoção)", async () => {
    const { orgA, objB } = await setup();
    for (const key of [`${orgA}/../${objB.storageKey}`, `./${objB.storageKey}`, `${objB.storageKey}/`, "../x", ""]) {
      await expect(storageAdapter.download(key), key).rejects.toThrow();
    }
    await storageAdapter.delete(`${orgA}/../${objB.storageKey}`).catch(() => undefined);
    expect((await storageAdapter.download(objB.storageKey)).length).toBe(SECRET.length); // o objeto de B continua lá
  });
});
