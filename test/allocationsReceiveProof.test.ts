import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { storageAdapter } from "../src/helpers/storageAdapter";
import { db } from "../src/helpers/db";
import { handle as postFilesUpload } from "../src/endpoints/files-upload_POST";
import { handle as postAllocationsReceive } from "../src/endpoints/allocations-receive_POST";
import { createAuthenticatedUser, createTestOrganization, createTestInventoryItem, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function createAcceptedAllocation(organizationId: number, userId: number) {
  const [source] = await db.insertInto("sources").values({ name: "Fonte manual", type: "manual", connectorKey: "manual", createdByUserId: userId }).returning(["id"]).execute();
  const [registry] = await db
    .insertInto("opportunityRegistry")
    .values({ sourceId: source.id, title: "40 cobertores doados", quantity: 40, unit: "unidade", discoveryAgent: "manual" })
    .returning(["id"])
    .execute();
  const [allocation] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: registry.id, organizationId, quantityAllocated: 40, status: "aceita" })
    .returning(["id"])
    .execute();
  return allocation.id;
}

describe("recebimento de atribuição com comprovante enviado por upload real", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  // Este teste envia arquivos de verdade e antes NÃO os removia (deixava 2 arquivos por execução em storage/uploads-test). Agora remove exatamente os objetos que criou
  // (as chaves estão nas linhas de `files` deste teste) — e a falha da limpeza aparece, em vez de ser engolida. O diretório já é exclusivo da execução (test/storageDir.ts).
  afterEach(async () => {
    const rows = await db.selectFrom("files").select(["storageKey"]).execute();
    const results = await Promise.allSettled(rows.map((r) => storageAdapter.delete(r.storageKey)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) throw new Error(`não consegui remover ${failed.length} arquivo(s) criado(s) pelo teste`);
  });

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
  });

  it("vincula o arquivo enviado como proofUrl do evento de logística", async () => {
    const item = await createTestInventoryItem(orgId, owner.userId);
    const allocationId = await createAcceptedAllocation(orgId, owner.userId);

    const uploadResponse = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, purpose: "comprovante_entrega", fileName: "entrega.png", contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
      })
    );
    const { file } = await parseJson<{ file: { id: number } }>(uploadResponse);

    const receiveResponse = await postAllocationsReceive(
      buildRequest("allocations-receive", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, allocationId, itemId: item.id, quantityReceived: 40, proofFileId: file.id },
      })
    );
    expect(receiveResponse.status).toBe(200);

    const event = await db
      .selectFrom("logisticsEvents")
      .select(["proofUrl", "eventType"])
      .where("opportunityAllocationId", "=", allocationId)
      .executeTakeFirstOrThrow();
    expect(event.eventType).toBe("entrega_confirmada");
    expect(event.proofUrl).toBe(`/_api/v1/files-download?fileId=${file.id}`);
  });

  it("recusa (404) usar um arquivo de outra organização como comprovante", async () => {
    const item = await createTestInventoryItem(orgId, owner.userId);
    const allocationId = await createAcceptedAllocation(orgId, owner.userId);

    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const otherUploadResponse = await postFilesUpload(
      buildRequest("files-upload", {
        method: "POST",
        cookie: otherOwner.cookie,
        body: { organizationId: otherOrg.id, purpose: "comprovante_entrega", fileName: "entrega.png", contentType: "image/png", fileBase64: TINY_PNG_BASE64 },
      })
    );
    const { file } = await parseJson<{ file: { id: number } }>(otherUploadResponse);

    const receiveResponse = await postAllocationsReceive(
      buildRequest("allocations-receive", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, allocationId, itemId: item.id, quantityReceived: 40, proofFileId: file.id },
      })
    );
    expect(receiveResponse.status).toBe(404);
  });
});
