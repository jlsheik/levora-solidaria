// Semente SINTÉTICA da verificação de segurança (banco descartável `_qa`; ver lib/guard.mjs). Guarda cargas de XSS inofensivas (ver payloads.mjs)
// em todos os campos de texto livre que o app exibe, e linhas "legadas" com proofUrl `javascript:` (como se tivessem sido gravadas antes de
// qualquer validação), para provar que a interface não executa nada disso. As credenciais existem só neste banco descartável.
import { db } from "../../../src/helpers/db";
import { generatePasswordHash } from "../../../src/helpers/generatePasswordHash";
import { storageAdapter } from "../../../src/helpers/storageAdapter";
import { combined, javascriptUrl, hitCode } from "./payloads.mjs";

const QA_PASSWORD = process.env.QA_PASSWORD ?? "";
const COLLECTOR = process.env.QA_SEC_COLLECTOR ?? "";
if (!QA_PASSWORD || !COLLECTOR) throw new Error("QA_PASSWORD/QA_SEC_COLLECTOR não definidas (a semente deve ser executada por scripts/qa-visual/security.mjs)");
const P = (field: string) => combined(COLLECTOR, field);

const mk = async (email: string, name: string, platformLevel?: "admin") => {
  const u = await db.insertInto("users").values({ email, displayName: name, role: "user" }).returning("id").executeTakeFirstOrThrow();
  // Identidade (Fase 89): users.role = admin foi abolido; o poder de plataforma é platform_access.
  if (platformLevel) await db.insertInto("platformAccess").values({ userId: u.id, level: platformLevel, status: "active", grantOrigin: "qa" }).execute();
  await db.insertInto("userPasswords").values({ userId: u.id, passwordHash: await generatePasswordHash(QA_PASSWORD) }).execute();
  return u.id;
};

const owner = await mk("dono@qa.example", P("user-name"));
await mk("voluntario@qa.example", "Voluntária QA");
await mk("admin@qa.example", "Admin QA", "admin");
const org = await db.insertInto("organizations").values({ name: P("org-name"), slug: "associacao-sec", type: "organizacao_social", city: P("org-city"), state: "MG", status: "ativa", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
await db.insertInto("memberships").values({ organizationId: org.id, userId: owner, role: "proprietario", status: "ativo" }).execute();
// segundo usuário da MESMA organização (administrador; o limite de envio de arquivos é por usuário, e cada navegador usa um) e um usuário de OUTRA organização
const adm = await mk("adm@qa.example", "Adm QA");
await db.insertInto("memberships").values({ organizationId: org.id, userId: adm, role: "administrador", status: "ativo" }).execute();
const outsider = await mk("fora@qa.example", "Fora QA");
const org2 = await db.insertInto("organizations").values({ name: "Outra Organização QA", slug: "outra-organizacao", type: "organizacao_social", city: "Betim", state: "MG", status: "ativa", createdByUserId: outsider }).returning("id").executeTakeFirstOrThrow();
await db.insertInto("memberships").values({ organizationId: org2.id, userId: outsider, role: "proprietario", status: "ativo" }).execute();
// linhas ANTIGAS de arquivo com tipo ativo, gravadas direto (nenhum fluxo atual as produz; o upload só aceita imagens e PDF). O conteúdo só pede
// uma imagem ao coletor local, se algum navegador chegar a renderizá-lo.
const legacy = async (name: string, type: string, content: string) => {
  const buffer = Buffer.from(content);
  const stored = await storageAdapter.upload({ organizationId: org.id, buffer, contentType: type });
  await db.insertInto("files").values({ scanStatus: "legado_nao_analisado", organizationId: org.id, uploadedByUserId: owner, storageProvider: stored.storageProvider, storageKey: stored.storageKey, originalFilename: name, contentType: type, sizeBytes: buffer.length, purpose: "comprovante_entrega" }).execute();
};
await legacy("legado.html", "text/html", `<!doctype html><title>legado</title><script>${hitCode(COLLECTOR, "FILE@legacy-html")}</script>`);
await legacy("legado.svg", "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" onload="${hitCode(COLLECTOR, "FILE@legacy-svg")}"><script>${hitCode(COLLECTOR, "FILE@legacy-svg-script")}</script></svg>`);
const item = await db.insertInto("inventoryItems").values({ organizationId: org.id, name: P("item-name"), unit: "kg", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "5", reason: P("tx-reason"), createdByUserId: owner }).execute();
await db.insertInto("needs").values({ organizationId: org.id, title: P("need-title"), description: P("need-description"), quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner }).execute();
await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "alimentos", unit: "kg", maxCapacity: "500", createdByUserId: owner }).execute();

const source = await db.insertInto("sources").values({ name: P("source-name"), type: "manual", connectorKey: "manual", status: "ativa", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
const opp = (title: string, description: string | null) => db.insertInto("opportunityRegistry").values({ sourceId: source.id, title, description, status: "validada", quantity: "10", unit: "kg", discoveredByUserId: owner }).returning("id").executeTakeFirstOrThrow();
const o1 = await opp(P("opp-title"), P("opp-description"));
const o2 = await opp("Doação sintética para a tentativa pela API", null);
// A1: em transporte (só estas atribuições mostram a linha do tempo), com um evento LEGADO cujo comprovante é uma URL javascript: — um estado
// que os fluxos atuais não produzem, mas que o código exibe se existir (dados antigos/gravados direto) — cenário de XSS por href
const a1 = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: o1.id, organizationId: org.id, status: "em_transporte", quantityAllocated: "5" }).returning("id").executeTakeFirstOrThrow();
await db.insertInto("logisticsEvents").values({ opportunityAllocationId: a1.id, organizationId: org.id, eventType: "entrega_confirmada", notes: P("event-notes"), proofUrl: javascriptUrl(COLLECTOR, "P9@legacy-proof-url"), actorUserId: owner }).execute();
// A2: aceita; o orquestrador tenta gravar um comprovante javascript: pelo endpoint real (o servidor deve recusar)
await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: o2.id, organizationId: org.id, status: "aceita", quantityAllocated: "5" }).execute();

await db.destroy();
console.log("semente de segurança aplicada");
