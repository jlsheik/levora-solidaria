import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postFilesUpload } from "../src/endpoints/files-upload_POST";
import { handle as getFilesDownload } from "../src/endpoints/files-download_GET";
import { createAuthenticatedUser, createTestOrganization, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";
import { rm } from "node:fs/promises";
import path from "node:path";

const TEST_STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");

// Um PNG mínimo válido (1x1 pixel), só para ter bytes reais de imagem no teste.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Este arquivo verifica validação, autorização e cabeçalhos do upload/download básico (comprovação de entrega), não a análise antimalware: o download só serve arquivo liberado, então os envios precisam nascer liberados.
// Premissa explícita (modo desligado: envios nascem 'dispensado' e são liberados), restaurada a cada teste; não herda FILE_SCAN_MODE do terminal/.env.test. A análise e o bloqueio do modo obrigatório (409, infectado, legado, fail-closed) são provados em test/fileScan.test.ts.
beforeEach(() => { vi.stubEnv("FILE_SCAN_MODE", "disabled"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("upload e download de arquivo (comprovação de entrega)", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
  });

  afterAll(async () => {
    await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
  });

  it("envia um arquivo real e o grava no storage local + tabela files", async () => {
    const response = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "entrega.png", contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ file: { id: number; downloadUrl: string; sizeBytes: number } }>(response);
    expect(data.file.sizeBytes).toBeGreaterThan(0);
    expect(data.file.downloadUrl).toBe(`/_api/v1/files-download?fileId=${data.file.id}`);

    const row = await db.selectFrom("files").select(["storageProvider", "organizationId"]).where("id", "=", data.file.id).executeTakeFirstOrThrow();
    expect(row.storageProvider).toBe("local");
    expect(row.organizationId).toBe(orgId);
  });

  it("baixa de volta os bytes exatos do arquivo enviado, só para membro da organização", async () => {
    const uploadResponse = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "entrega.png", contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
      })
    );
    const { file } = await parseJson<{ file: { id: number } }>(uploadResponse);

    const downloadResponse = await getFilesDownload(buildRequest(`files-download?fileId=${file.id}`, { cookie: owner.cookie }));
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("Content-Type")).toBe("image/png");
    const downloadedBytes = Buffer.from(await downloadResponse.arrayBuffer());
    expect(downloadedBytes.equals(Buffer.from(TINY_PNG_BASE64, "base64"))).toBe(true);

    const outsider = await createAuthenticatedUser();
    const forbiddenResponse = await getFilesDownload(buildRequest(`files-download?fileId=${file.id}`, { cookie: outsider.cookie }));
    expect(forbiddenResponse.status).toBe(403);
  });

  it("rejeita tipo de conteúdo não permitido", async () => {
    const response = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        // Propositalmente fora do enum ALLOWED_CONTENT_TYPES, para testar a validação do schema no servidor.
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "script.exe", contentType: "application/x-msdownload", fileBase64: "AAAA" },
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejeita arquivo maior que o limite permitido", async () => {
    const oversized = Buffer.alloc(9 * 1024 * 1024).toString("base64"); // 9MB > limite de 8MB
    const response = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "grande.png", contentType: "image/png", fileBase64: oversized },
      })
    );
    expect(response.status).toBe(400);
  });

  it("nega upload (403) para quem não é membro da organização", async () => {
    const outsider = await createAuthenticatedUser();
    const response = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: outsider.cookie,
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "entrega.png", contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
      })
    );
    expect(response.status).toBe(403);
  });

  it("retorna 404 ao tentar baixar um arquivo inexistente", async () => {
    const response = await getFilesDownload(buildRequest(`files-download?fileId=999999`, { cookie: owner.cookie }));
    expect(response.status).toBe(404);
  });

  it("rejeita nome de arquivo com caractere de controle (CRLF) — proteção contra injeção de cabeçalho HTTP no download", async () => {
    const response = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        body: {
          organizationId: orgId,
          purpose: "comprovante_entrega",
          fileName: "entrega.png\r\nSet-Cookie: adulterado=1",
          contentType: "image/png",
          fileBase64: TINY_PNG_BASE64,
        },
      })
    );
    expect(response.status).toBe(400);

    const rows = await db.selectFrom("files").select(["id"]).where("organizationId", "=", orgId).execute();
    expect(rows).toHaveLength(0); // nada foi gravado
  });

  it("defesa em profundidade: mesmo se um nome de arquivo malicioso já existisse no banco, o download nunca gera um Content-Disposition adulterado", async () => {
    // Simula uma linha gravada antes da validação existir (ou por qualquer
    // outro caminho futuro) — grava direto no banco, sem passar pelo schema.
    const uploadResponse = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "entrega.png", contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
      })
    );
    const { file } = await parseJson<{ file: { id: number } }>(uploadResponse);
    await db
      .updateTable("files")
      .set({ originalFilename: 'entrega.png"\r\nX-Injetado: sim' })
      .where("id", "=", file.id)
      .execute();

    const downloadResponse = await getFilesDownload(buildRequest(`files-download?fileId=${file.id}`, { cookie: owner.cookie }));
    expect(downloadResponse.status).toBe(200);
    const disposition = downloadResponse.headers.get("Content-Disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain('"sim');
    expect(downloadResponse.headers.get("X-Injetado")).toBeNull();
  });

  it("bloqueia (429) muitos uploads em pouco tempo, por usuário", async () => {
    for (let i = 0; i < 30; i++) {
      const response = await postFilesUpload(
        buildRequest("files-upload", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: `entrega-${i}.png`, contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
        })
      );
      expect(response.status).toBe(200);
    }

    const blocked = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "extra.png", contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
      })
    );
    expect(blocked.status).toBe(429);
  });
});
