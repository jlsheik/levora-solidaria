// Semente mínima e SINTÉTICA da verificação visual (banco descartável `_qa`; ver lib/guard.mjs). Cria só o que os cenários precisam renderizar:
// dono e voluntário de uma organização ativa, uma necessidade, um item de estoque COM movimentações (entrada de 5 kg e saída de 1 kg, pelos
// endpoints reais, para exibir a variação negativa), uma capacidade (diálogo de exclusão) e uma atribuição aceita (diálogo de recebimento com o
// FileDropzone). As credenciais abaixo existem só neste banco descartável.
import { sql } from "kysely";
import { db } from "../../src/helpers/db";
import { generatePasswordHash } from "../../src/helpers/generatePasswordHash";
import { buildRequest, createSessionCookie } from "../../test/helpers";
import { handle as stockTransaction } from "../../src/endpoints/stock-transactions_POST";

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
await db.insertInto("memberships").values([
  { organizationId: org.id, userId: owner, role: "proprietario", status: "ativo" },
  { organizationId: org.id, userId: volunteer, role: "voluntario", status: "ativo" },
]).execute();
const item = await db.insertInto("inventoryItems").values({ organizationId: org.id, name: "Arroz", unit: "kg", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
await db.insertInto("needs").values({ organizationId: org.id, title: "Cestas básicas", description: "Famílias do bairro", quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner }).execute();
await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "alimentos", unit: "kg", maxCapacity: "500", createdByUserId: owner }).execute();

// movimentações reais do estoque (entrada de 5 kg e saída de 1 kg) pelo endpoint, como um usuário faria
const cookie = await createSessionCookie(owner);
for (const [type, quantity, reason] of [["entrada", 5, "entrada sintética para a verificação visual"], ["saida", 1, "saída sintética de 1 kg para a verificação visual"]] as const) {
  const res = await stockTransaction(buildRequest("stock-transactions", { method: "POST", cookie, body: { organizationId: org.id, itemId: item.id, type, quantity, reason } }));
  if (res.status !== 200) throw new Error(`movimentação ${type} falhou (${res.status})`);
}

// atribuição aceita (abre o diálogo "Registrar recebimento", onde fica o FileDropzone)
const source = await db.insertInto("sources").values({ name: "Fonte QA", type: "manual", connectorKey: "manual", status: "ativa", createdByUserId: owner }).returning("id").executeTakeFirstOrThrow();
const opp = await db.insertInto("opportunityRegistry").values({ sourceId: source.id, title: "Doação sintética aceita", status: "validada", quantity: "10", unit: "kg", discoveredByUserId: owner }).returning("id").executeTakeFirstOrThrow();
// Fase 98: é uma atribuição AUTOMÁTICA com prazo próximo do vencimento (5 h), para a tela renderizar a seção de pendências no estado "vence em breve".
await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: org.id, status: "aceita", quantityAllocated: "5", autoMatched: true, responseDueAt: sql<Date>`now() + interval '5 hours'` }).execute();

await db.destroy();
console.log("semente QA aplicada");
