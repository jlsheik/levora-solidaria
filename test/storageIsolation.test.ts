/**
 * Isolamento do armazenamento de arquivos da suíte: o resíduo de 2 arquivos em `storage/uploads-test` vinha de `allocationsReceiveProof.test.ts` (enviava arquivos reais e
 * não limpava) e a raiz fixa do repositório podia ser compartilhada por duas execuções. Agora cada execução usa um diretório temporário próprio (test/storageDir.ts).
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStorageDir, removeRunStorageDir, RUN_STORAGE_PREFIX } from "./storageDir";
import { localStorageRoot } from "../src/helpers/storageAdapter";
import { createAuthenticatedUser, createTestOrganization, buildRequest } from "./helpers";
import { handle as postFilesUpload } from "../src/endpoints/files-upload_POST";

const REPO_DIR = path.resolve(process.cwd(), "storage", "uploads-test");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("armazenamento de arquivos da suíte é exclusivo da execução", () => {
  it("os workers usam um diretório temporário do sistema (nunca storage/ do repositório)", () => {
    const root = localStorageRoot();
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root).startsWith(RUN_STORAGE_PREFIX)).toBe(true);
    expect(root.startsWith(path.resolve(process.cwd()) + path.sep)).toBe(false);
  });

  it("um upload real pelo fluxo do app cai no diretório temporário e deixa o diretório do repositório intocado", async () => {
    const before = existsSync(REPO_DIR) ? readdirSync(REPO_DIR, { recursive: true }).map(String).sort() : null;
    const u = await createAuthenticatedUser(); const org = (await createTestOrganization(u.userId)).id;
    const res = await postFilesUpload(buildRequest("files-upload", { method: "POST", cookie: u.cookie, body: { organizationId: org, purpose: "comprovante_entrega", fileName: "iso.png", contentType: "image/png", fileBase64: PNG } }));
    expect(res.status).toBe(200);
    try {
      expect(readdirSync(path.join(localStorageRoot(), String(org))).length).toBe(1); // o arquivo desta execução está no diretório temporário
    } finally { rmSync(path.join(localStorageRoot(), String(org)), { recursive: true, force: true }); } // remove só o que este teste criou
    expect(existsSync(REPO_DIR) ? readdirSync(REPO_DIR, { recursive: true }).map(String).sort() : null).toEqual(before);
  });

  it("createRunStorageDir cria diretórios distintos por chamada (execuções simultâneas não colidem) e removeRunStorageDir relata o que sobrou", () => {
    const a = createRunStorageDir(); const b = createRunStorageDir();
    try {
      expect(a).not.toBe(b);
      mkdirSync(path.join(a, "1")); writeFileSync(path.join(a, "1", "x"), "1"); writeFileSync(path.join(a, "y"), "2");
      expect(removeRunStorageDir(a)).toEqual({ removed: true, leftoverFiles: 2 });
      expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(true); // só o diretório indicado
      expect(removeRunStorageDir(a)).toEqual({ removed: true, leftoverFiles: 0 }); // idempotente
    } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
  });

  it("removeRunStorageDir RECUSA apagar qualquer coisa que não tenha sido criada por createRunStorageDir (raiz do repositório, outro diretório do tmp, caminho relativo, pai)", () => {
    const other = mkdtempSync(path.join(tmpdir(), "outro-diretorio-"));
    try {
      writeFileSync(path.join(other, "precioso.txt"), "não apagar");
      for (const dir of [other, REPO_DIR, process.cwd(), tmpdir(), path.join(tmpdir(), RUN_STORAGE_PREFIX, "..", path.basename(other)), "storage/uploads-test", path.join(other, RUN_STORAGE_PREFIX + "x")]) {
        expect(removeRunStorageDir(dir).removed, dir).toBe(false);
      }
      expect(existsSync(path.join(other, "precioso.txt"))).toBe(true);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
