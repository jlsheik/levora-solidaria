// Semente mínima e SINTÉTICA da verificação visual (banco descartável `_qa`; ver lib/guard.mjs). Cria só o que os cenários precisam renderizar:
// dono e voluntário de uma organização ativa, uma necessidade, um item de estoque COM movimentações (entrada de 5 kg e saída de 1 kg, pelos
// endpoints reais, para exibir a variação negativa), uma capacidade (diálogo de exclusão) e uma atribuição aceita (diálogo de recebimento com o
// FileDropzone). As credenciais abaixo existem só neste banco descartável.
import { sql } from "kysely";
import { businessDateOf } from "../../src/helpers/businessDate";
import { db } from "../../src/helpers/db";
import { generatePasswordHash } from "../../src/helpers/generatePasswordHash";
import { buildRequest, createSessionCookie } from "../../test/helpers";
import { handle as stockTransaction } from "../../src/endpoints/stock-transactions_POST";
import { handle as stockDestination } from "../../src/endpoints/stock-destinations_POST";
import { handle as receiveAllocation } from "../../src/endpoints/allocations-receive_POST";
import { handle as needClosure } from "../../src/endpoints/need-closure_POST";
import { handle as destinationReversal } from "../../src/endpoints/stock-destination-reversal_POST";
import { handle as destinationCorrection } from "../../src/endpoints/stock-destination-correction_POST";
import superjson from "superjson";
import { handle as filesUpload } from "../../src/endpoints/files-upload_POST";
import { handle as destinationProof } from "../../src/endpoints/stock-destination-proof_POST";

// vem do orquestrador (scenarios.mjs), para a semente e o login do navegador nunca divergirem
const QA_PASSWORD = process.env.QA_PASSWORD ?? "";
if (!QA_PASSWORD) throw new Error("QA_PASSWORD não definida (a semente deve ser executada por scripts/qa-visual/run.mjs)");

const mk = async (email: string, name: string) => {
  const u = await db.insertInto("users").values({ email, displayName: name, role: "user" }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("userPasswords").values({ userId: u.id, passwordHash: await generatePasswordHash(QA_PASSWORD) }).execute();
  return u.id;
};

const owner = await mk("dono@qa.example", "Dona QA");
const volunteer = await mk("voluntario@qa.example", "Voluntária QA");
const org = await db.insertInto("organizations").values({ name: "Associação QA", slug: "associacao-qa", type: "organizacao_social", city: "Contagem", state: "MG", status: "ativa", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
const emptyOrg = await db.insertInto("organizations").values({ name: "Associação QA Vazia", slug: "associacao-qa-vazia", type: "organizacao_social", city: "Contagem", state: "MG", status: "ativa", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow(); // Fase 99B: organização SEM nenhum valor de unidade (estado vazio do diagnóstico)
await db.insertInto("memberships").values([
  { organizationId: emptyOrg.id, userId: owner, role: "proprietario", status: "ativo" },
  { organizationId: org.id, userId: owner, role: "proprietario", status: "ativo" },
  { organizationId: org.id, userId: volunteer, role: "voluntario", status: "ativo" },
]).execute();
const item = await db.insertInto("inventoryItems").values({ organizationId: org.id, name: "Arroz", unit: "kg", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
// Fase 99B: valores de unidade variados (alias, desconhecido; ambíguo e ausente na doação local) para o diagnóstico de unidades
await db.insertInto("inventoryItems").values([
  { organizationId: org.id, name: "Água", unit: "litros", createdByUserId: owner },
  { organizationId: org.id, name: "Lenço", unit: "x", createdByUserId: owner },
]).execute();
await db.insertInto("donationOpportunities").values([
  { organizationId: org.id, title: "Doação QA com unidade ambígua", donorName: "Doador QA", unit: "un", createdByUserId: owner },
  { organizationId: org.id, title: "Doação QA sem unidade", donorName: "Doador QA", createdByUserId: owner },
]).execute();
await db.insertInto("needs").values({ organizationId: org.id, title: "Cestas básicas", description: "Famílias do bairro", quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner }).execute();
await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "alimentos", unit: "kg", maxCapacity: "500", createdByUserId: owner }).execute();

// movimentações reais do estoque (entrada de 5 kg pelo endpoint e saída de 1 kg COM destinação, como um usuário faria; a saída física exige destinação desde a Fase 99E)
const cookie = await createSessionCookie(owner);
const entrada = await stockTransaction(buildRequest("stock-transactions", { method: "POST", cookie, body: { organizationId: org.id, itemId: item.id, type: "entrada", quantity: 5, reason: "entrada sintética para a verificação visual" } }));
if (entrada.status !== 200) throw new Error(`movimentação entrada falhou (${entrada.status})`);
const saida = await stockDestination(buildRequest("stock-destinations", { method: "POST", cookie, body: { organizationId: org.id, itemId: item.id, quantity: 1, destinationType: "uso_operacional_instituicao", deliveredOn: businessDateOf(new Date()), notes: "saída sintética de 1 kg para a verificação visual", idempotencyKey: "qa-visual-seed-saida-1" } }));
if (saida.status !== 200) throw new Error(`saída com destinação falhou (${saida.status})`);

// Fase 99G: a saída acima ganha uma correção documental e um estorno documental PARCIAL (sem movimento de estoque), para o histórico de destinações exibir a linha do tempo
const saidaDestinationId = (superjson.parse(await saida.text()) as { destination: { id: string } }).destination.id;
const correcao = await destinationCorrection(buildRequest("stock-destination-correction", { method: "POST", cookie, body: { organizationId: org.id, destinationId: saidaDestinationId, notes: "saída sintética corrigida para a verificação visual", reason: "Ajuste da descrição sintética", idempotencyKey: "qa-visual-seed-correcao-1" } }));
if (correcao.status !== 200) throw new Error(`correção documental falhou (${correcao.status})`);
const estorno = await destinationReversal(buildRequest("stock-destination-reversal", { method: "POST", cookie, body: { organizationId: org.id, destinationId: saidaDestinationId, kind: "estorno_documental", quantity: 0.25, reason: "Parte do registro estava errada (sintético)", idempotencyKey: "qa-visual-seed-estorno-1" } }));
if (estorno.status !== 200) throw new Error(`estorno documental falhou (${estorno.status})`);

// Fase 99J: comprovante sintético (PNG 1x1) enviado e vinculado pelos endpoints reais à saída acima; a destinação parcial seguinte fica SEM comprovante (botão de anexar)
const proofUpload = await filesUpload(buildRequest("files-upload", { method: "POST", cookie, body: { organizationId: org.id, purpose: "comprovante_destinacao", fileName: "recibo-sintetico.png", contentType: "image/png", fileBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }));
if (proofUpload.status !== 200) throw new Error(`envio do comprovante falhou (${proofUpload.status})`);
const proofFileId = (superjson.parse(await proofUpload.text()) as { file: { id: number } }).file.id;
const proofLink = await destinationProof(buildRequest("stock-destination-proof", { method: "POST", cookie, body: { organizationId: org.id, destinationId: saidaDestinationId, action: "anexar", fileId: proofFileId, reason: "Recibo sintético da saída", idempotencyKey: "qa-visual-seed-comprovante-1" } }));
if (proofLink.status !== 200) throw new Error(`vínculo do comprovante falhou (${proofLink.status})`);
// Fase 99K: um segundo comprovante enviado e NÃO vinculado (aparece na conciliação somente leitura)
const pendingUpload = await filesUpload(buildRequest("files-upload", { method: "POST", cookie, body: { organizationId: org.id, purpose: "comprovante_destinacao", fileName: "pendente-sintetico.png", contentType: "image/png", fileBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }));
if (pendingUpload.status !== 200) throw new Error(`envio do comprovante pendente falhou (${pendingUpload.status})`);

// Fase 99F: necessidade PARCIALMENTE atendida (1 de 4 kg, por uma destinação real vinculada), uma ENCERRADA com motivo (pelo endpoint) e uma "atendida" HISTÓRICA (sem destinação)
const [partialNeed] = await db.insertInto("needs").values({ organizationId: org.id, itemId: item.id, title: "Arroz para a campanha", quantityNeeded: "4", unit: "kg", priority: "baixa", status: "aberta", createdByUserId: owner }).returning("id").execute();
const partial = await stockDestination(buildRequest("stock-destinations", { method: "POST", cookie, body: { organizationId: org.id, itemId: item.id, quantity: 1, destinationType: "distribuicao_familias", needId: partialNeed.id, deliveredOn: businessDateOf(new Date()), idempotencyKey: "qa-visual-seed-parcial-1" } }));
if (partial.status !== 200) throw new Error(`destinação parcial falhou (${partial.status})`);
const [closedNeed] = await db.insertInto("needs").values({ organizationId: org.id, title: "Cobertores da campanha encerrada", quantityNeeded: "10", unit: "unidade", priority: "baixa", status: "aberta", createdByUserId: owner }).returning("id").execute();
const closed = await needClosure(buildRequest("need-closure", { method: "POST", cookie, body: { action: "encerrar", organizationId: org.id, needId: closedNeed.id, reasonCode: "necessidade_superada", reasonText: "Campanha encerrada pela coordenação" } }));
if (closed.status !== 200) throw new Error(`encerramento falhou (${closed.status})`);
await db.insertInto("needs").values({ organizationId: org.id, title: "Kit escolar (registro antigo)", quantityNeeded: "15", unit: "unidade", priority: "baixa", status: "atendida", createdByUserId: owner }).execute();

// atribuição aceita (abre o diálogo "Registrar recebimento", onde fica o FileDropzone)
const source = await db.insertInto("sources").values({ name: "Fonte QA", type: "manual", connectorKey: "manual", status: "ativa", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
const opp = await db.insertInto("opportunityRegistry").values({ sourceId: source.id, title: "Doação sintética aceita", status: "validada", quantity: "10", unit: "kg", discoveredByUserId: owner }).returning("id").executeTakeFirstOrThrow();
// Fase 98: é uma atribuição AUTOMÁTICA com prazo próximo do vencimento (5 h), para a tela renderizar a seção de pendências no estado "vence em breve".
await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: org.id, status: "aceita", quantityAllocated: "5", autoMatched: true, responseDueAt: sql<Date>`now() + interval '5 hours'` }).execute();

// Fase 99C: uma atribuição ACEITA cuja oferta está em "caixa" e o item em "kg": o recebimento pelo endpoint real vira um caso de regularização de unidade (fila de pendências).
const opp2 = await db.insertInto("opportunityRegistry").values({ sourceId: source.id, title: "Doação sintética em caixas", status: "validada", quantity: "4", unit: "caixa", discoveredByUserId: owner }).returning("id").executeTakeFirstOrThrow();
const alloc2 = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp2.id, organizationId: org.id, status: "aceita", quantityAllocated: "4" }).returning("id").executeTakeFirstOrThrow();
const pendingRes = await receiveAllocation(buildRequest("allocations-receive", { method: "POST", cookie, body: { organizationId: org.id, allocationId: alloc2.id, itemId: item.id, quantityReceived: 4 } }));
if (pendingRes.status !== 202) throw new Error(`o recebimento divergente da semente deveria abrir um caso (202), veio ${pendingRes.status}`);

await db.destroy();
console.log("semente QA aplicada");
