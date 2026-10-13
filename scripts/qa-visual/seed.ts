// Semente mínima e SINTÉTICA da verificação visual (banco descartável `_qa`; ver lib/guard.mjs). Cria só o que os cenários precisam renderizar:
// dono e voluntário de uma organização ativa, uma necessidade, um item de estoque e uma capacidade (para o diálogo de exclusão).
// As credenciais abaixo existem só neste banco descartável.
import { db } from "../../src/helpers/db";
import { generatePasswordHash } from "../../src/helpers/generatePasswordHash";

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
await db.insertInto("inventoryItems").values({ organizationId: org.id, name: "Arroz", unit: "kg", createdByUserId: owner }).execute();
await db.insertInto("needs").values({ organizationId: org.id, title: "Cestas básicas", description: "Famílias do bairro", quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner }).execute();
await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "alimentos", unit: "kg", maxCapacity: "500", createdByUserId: owner }).execute();
await db.destroy();
console.log("semente QA aplicada");
