/**
 * Segurança de upload/download de arquivos (Fase 94, achados do `npm run qa:security`). Cada teste mira um risco concreto do fluxo real
 * `files-upload` → storage → `files-download`: conteúdo que não corresponde ao tipo declarado (SVG/HTML com script declarado como imagem), nomes
 * de arquivo hostis, base64 inválido, linhas antigas com tipo ativo (text/html, image/svg+xml) e erros do Express que viravam HTML.
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/helpers/db";
import { handle as postFilesUpload } from "../src/endpoints/files-upload_POST";
import { handle as getFilesDownload } from "../src/endpoints/files-download_GET";
import { resetAllRateLimitsForTests } from "../src/helpers/rateLimit";
import { storageAdapter } from "../src/helpers/storageAdapter";
import { buildApp } from "../server/index";
import { createAuthenticatedUser, createTestOrganization, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from("JFIF\0"), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
// conteúdo ATIVO, só de teste: pede uma imagem a um host que não existe (nada é executado nos testes, que não usam navegador)
const SVG_ACTIVE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="void((new Image).src=\'http://127.0.0.1:9/h\')"><script>void(0)</script></svg>');
const HTML_ACTIVE = Buffer.from('<!doctype html><script>void((new Image).src="http://127.0.0.1:9/h")</script>');

async function filesOnDisk(dir = STORAGE_DIR): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesOnDisk(p))); else out.push(p);
  }
  return out;
}
const rows = async () => Number((await db.selectFrom("files").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);

// Estes testes cobrem ARMAZENAMENTO/cabeçalhos e usam linhas ANTIGAS (legado_nao_analisado, anteriores à análise), que só são servidas fora do modo obrigatório.
// A premissa é explícita e restaurada a cada teste (não herda FILE_SCAN_MODE do terminal/.env.test). O bloqueio do modo obrigatório (legado, 409, infectado, fail-closed) é provado em test/fileScan.test.ts.
beforeEach(() => { vi.stubEnv("FILE_SCAN_MODE", "disabled"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("upload/download de arquivos: conteúdo, nomes e cabeçalhos", () => {
  let owner: AuthenticatedTestUser; let orgId: number;
  beforeEach(async () => { resetAllRateLimitsForTests(); owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; });
  afterAll(async () => { await rm(STORAGE_DIR, { recursive: true, force: true }); });

  const upload = (body: Record<string, unknown>, cookie = owner.cookie) =>
    postFilesUpload(buildRequest("files-upload", { method: "POST", cookie, body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "a.png", contentType: "image/png", ...body } }));
  const b64 = (b: Buffer) => b.toString("base64");

  it("conteúdo que NÃO corresponde ao tipo declarado é recusado e não deixa linha nem arquivo (SVG/HTML ativo declarado como imagem/PDF)", async () => {
    const before = { rows: await rows(), files: (await filesOnDisk()).length };
    const cases: Array<[string, Buffer, string]> = [["svg como png", SVG_ACTIVE, "image/png"], ["html como pdf", HTML_ACTIVE, "application/pdf"], ["html como jpeg", HTML_ACTIVE, "image/jpeg"], ["png como jpeg", PNG, "image/jpeg"], ["pdf como webp", PDF, "image/webp"], ["texto como png", Buffer.from("AAAA"), "image/png"]];
    for (const [label, bytes, type] of cases) {
      const r = await upload({ contentType: type, fileBase64: b64(bytes) });
      expect(r.status, label).toBe(400);
    }
    expect({ rows: await rows(), files: (await filesOnDisk()).length }).toEqual(before);
  });

  it("aceita os quatro tipos permitidos quando os bytes conferem, e o download devolve o mesmo conteúdo com nosniff e sem cache", async () => {
    const samples: Array<[string, Buffer]> = [["image/png", PNG], ["image/jpeg", JPEG], ["image/webp", WEBP], ["application/pdf", PDF]];
    for (const [type, bytes] of samples) {
      const up = await upload({ contentType: type, fileBase64: b64(bytes) });
      expect(up.status, type).toBe(200);
      const { file } = await parseJson<{ file: { id: number } }>(up);
      const down = await getFilesDownload(buildRequest(`files-download?fileId=${file.id}`, { cookie: owner.cookie }));
      expect(down.status, type).toBe(200);
      expect(down.headers.get("content-type")).toBe(type);
      expect(down.headers.get("x-content-type-options")).toBe("nosniff");
      expect(down.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await down.arrayBuffer()).equals(bytes)).toBe(true);
    }
  });

  it("tipos fora da lista (SVG, HTML, XML, JS) são recusados pelo schema", async () => {
    for (const type of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/javascript", "image/png; charset=x", "IMAGE/PNG"]) {
      expect((await upload({ contentType: type, fileBase64: b64(PNG) })).status, type).toBe(400);
    }
  });

  it("base64 inválido, vazio ou acima do limite de 8 MB é recusado e nada é gravado", async () => {
    const before = { rows: await rows(), files: (await filesOnDisk()).length };
    for (const bad of ["@@@@", "iVBOR w0KGgo=", "iVBORw0KGgoAAAA", "====", b64(Buffer.alloc(8 * 1024 * 1024 + 1, 1))]) expect((await upload({ fileBase64: bad })).status, bad.slice(0, 12)).toBe(400);
    expect({ rows: await rows(), files: (await filesOnDisk()).length }).toEqual(before);
  });

  it("nomes hostis: o caminho no storage é sempre uuid (nada de traversal) e o download funciona, com cabeçalho seguro, inclusive com Unicode", async () => {
    const names = ["../../etc/passwd.png", "..\\..\\windows\\system.ini.png", "a\"b;c=d.png", "日本語のファイル.png", "ação ñ é ü.png", "<img src=x onerror=alert(1)>.png", "x".repeat(251) + ".png", "CON.png", "nul.png"];
    for (const fileName of names) {
      const up = await upload({ fileName, fileBase64: b64(PNG) });
      expect(up.status, fileName.slice(0, 30)).toBe(200);
      const { file } = await parseJson<{ file: { id: number } }>(up);
      const row = await db.selectFrom("files").select(["storageKey"]).where("id", "=", file.id).executeTakeFirstOrThrow();
      expect(row.storageKey, fileName).toMatch(new RegExp(`^${orgId}/[0-9a-f-]{36}$`));
      const down = await getFilesDownload(buildRequest(`files-download?fileId=${file.id}`, { cookie: owner.cookie }));
      expect(down.status, fileName.slice(0, 30)).toBe(200);
      const disposition = down.headers.get("content-disposition") ?? "";
      expect(disposition.startsWith("inline;"), disposition).toBe(true);
      expect(disposition, fileName).toMatch(/^[\x20-\x7e]*$/); // só ASCII no cabeçalho (o nome Unicode vai em filename*)
      expect(disposition.match(/filename="([^"]*)"/)![1]).not.toMatch(/[\\";\/]/);
    }
    expect((await filesOnDisk()).every((f) => f.startsWith(STORAGE_DIR + path.sep))).toBe(true);
  });

  it("linha ANTIGA com tipo ativo (text/html, image/svg+xml): o download nunca devolve conteúdo renderizável (attachment + octet-stream)", async () => {
    for (const [type, bytes, name] of [["text/html", HTML_ACTIVE, "legado.html"], ["image/svg+xml", SVG_ACTIVE, "legado.svg"], ["application/xhtml+xml", HTML_ACTIVE, "legado.xhtml"]] as const) {
      const stored = await storageAdapter.upload({ organizationId: orgId, buffer: bytes, contentType: type });
      const row = await db.insertInto("files").values({ scanStatus: "legado_nao_analisado", organizationId: orgId, uploadedByUserId: owner.userId, storageProvider: stored.storageProvider, storageKey: stored.storageKey, originalFilename: name, contentType: type, sizeBytes: bytes.length, purpose: "comprovante_entrega" }).returning("id").executeTakeFirstOrThrow();
      const down = await getFilesDownload(buildRequest(`files-download?fileId=${row.id}`, { cookie: owner.cookie }));
      expect(down.status, type).toBe(200);
      expect(down.headers.get("content-type"), type).toBe("application/octet-stream");
      expect(down.headers.get("content-disposition"), type).toMatch(/^attachment;/);
      expect(down.headers.get("x-content-type-options"), type).toBe("nosniff");
    }
  });

  it("autorização do download: sem sessão 401, outra organização 403, inexistente 404, membro 200", async () => {
    const { file } = await parseJson<{ file: { id: number } }>(await upload({ fileBase64: b64(PNG) }));
    const get = (cookie?: string, id: number | string = file.id) => getFilesDownload(buildRequest(`files-download?fileId=${id}`, { cookie }));
    expect((await get(undefined)).status).toBe(401);
    expect((await get((await createAuthenticatedUser()).cookie)).status).toBe(403);
    expect((await get(owner.cookie, 999999999)).status).toBe(404);
    expect((await get(owner.cookie)).status).toBe(200);
    expect((await get(owner.cookie, "1 OR 1=1")).status).toBe(400);
  });

  it("um membro de OUTRA organização não consegue enviar arquivo para esta", async () => {
    const outsider = await createAuthenticatedUser();
    const before = { rows: await rows(), files: (await filesOnDisk()).length };
    expect((await upload({ fileBase64: b64(PNG) }, outsider.cookie)).status).toBe(403);
    expect({ rows: await rows(), files: (await filesOnDisk()).length }).toEqual(before);
  });
});

describe("erros do Express na API não viram HTML nem perdem os cabeçalhos de segurança", () => {
  let server: Server; let base: string;
  beforeAll(async () => { server = (await buildApp()).listen(0); await new Promise<void>((r) => server.once("listening", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(() => { server.close(); });
  const send = (body: BodyInit) => fetch(`${base}/_api/v1/files-upload`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body });

  it("corpo acima do limite bruto de 16 MB → 413 em JSON, com CSP da API (frame-ancestors) e nosniff", async () => {
    const r = await send(Buffer.alloc(17 * 1024 * 1024, 0x20));
    expect(r.status).toBe(413);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await r.text();
    expect(text).not.toMatch(/<html|<pre>|at .*\(.*:\d+:\d+\)|node_modules/); // sem página HTML nem stack trace
  });
});
