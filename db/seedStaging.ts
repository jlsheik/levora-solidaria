/**
 * Fase 68 — seed sintético, idempotente e SEMPRE via domínio real.
 *
 * NÃO use este módulo diretamente: o ponto de entrada é db/seed-staging.ts,
 * que chama a guarda de ambiente (db/seedStagingGuard.ts) antes de importar
 * este arquivo (importar `src/helpers/db` abre o pool de conexões).
 *
 * Princípio: nenhum estado é fabricado. Cada registro nasce pelo mesmo
 * `handle()` que a API HTTP usa para um usuário real — com RBAC, auditoria
 * encadeada, triggers append-only e máquinas de estado do servidor. O
 * lifecycle de uma oportunidade só chega a `concluida` porque houve uma
 * atribuição aceita, logística registrada e um recebimento real (que gera
 * stock_transaction + need_fulfillment).
 *
 * Únicas escritas SQL diretas (sem endpoint equivalente, todas restritas
 * aos e-mails sintéticos deste seed):
 *   - promover o e-mail do admin sintético a `users.role = 'admin'` (não
 *     existe endpoint de promoção — o papel de plataforma é um bootstrap);
 *   - redefinir a senha dos usuários sintéticos (opção --reset-passwords);
 *   - criar/apagar as linhas de `sessions` usadas para autenticar as
 *     chamadas internas (mesmo caminho da tabela que o login usa).
 * Nenhum trigger é desativado, nenhuma FK é relaxada.
 *
 * Idempotência: cada entidade é localizada por chave determinística
 * (e-mail, nome, `origin_reference`, `reason`) ANTES de ser criada, e cada
 * passo do lifecycle só roda se o estado atual ainda não o alcançou — um
 * segundo run não chama nenhum endpoint de escrita (logo, não gera audit).
 */
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import superjson from "superjson";
import { db } from "../src/helpers/db.js";
import { generatePasswordHash } from "../src/helpers/generatePasswordHash.js";
import { setServerSession, SessionExpirationSeconds } from "../src/helpers/getSetServerSession.js";
import { getItemStockBalance } from "../src/helpers/stockBalance.js";
import { getNeedFulfillmentBalance, computeNeedProgress } from "../src/helpers/needFulfillment.js";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain.js";
import { ALGORITHM_VERSION } from "../src/helpers/opportunityMatching.js";
import { TASK_HANDLERS } from "../src/helpers/taskHandlers.js";

import { handle as registerHandle } from "../src/endpoints/auth/register_with_password_POST.js";
import { handle as organizationsPost } from "../src/endpoints/organizations_POST.js";
import { handle as platformOrgStatus } from "../src/endpoints/platform-organizations-status_POST.js";
import { handle as invitesPost } from "../src/endpoints/organization-invites_POST.js";
import { handle as invitesAccept } from "../src/endpoints/organization-invites-accept_POST.js";
import { handle as capacitiesPost } from "../src/endpoints/organization-capacities_POST.js";
import { handle as serviceAreasPost } from "../src/endpoints/organization-service-areas_POST.js";
import { handle as matchingSettingsPost } from "../src/endpoints/organization-matching-settings_POST.js";
import { handle as inventoryItemsPost } from "../src/endpoints/inventory-items_POST.js";
import { handle as stockTransactionsPost } from "../src/endpoints/stock-transactions_POST.js";
import { handle as needsPost } from "../src/endpoints/needs_POST.js";
import { handle as needsStatusPost } from "../src/endpoints/needs-status_POST.js";
import { handle as sourcesPost } from "../src/endpoints/sources_POST.js";
import { handle as registryPost } from "../src/endpoints/opportunity-registry_POST.js";
import { handle as registryStatusPost } from "../src/endpoints/opportunity-registry-status_POST.js";
import { handle as registryMatchPost } from "../src/endpoints/opportunity-registry-match_POST.js";
import { handle as allocationsPost } from "../src/endpoints/opportunity-allocations_POST.js";
import { handle as allocationsDecidePost } from "../src/endpoints/allocations-decide_POST.js";
import { handle as logisticsPost } from "../src/endpoints/allocations-logistics_POST.js";
import { handle as receivePost } from "../src/endpoints/allocations-receive_POST.js";
import { handle as legacyOpportunityPost } from "../src/endpoints/opportunities_POST.js";
import { handle as legacyOpportunityStatusPost } from "../src/endpoints/opportunities-status_POST.js";

// ---------------------------------------------------------------------------
// Dataset (100% sintético — domínio .local reservado, nomes marcados "Demo")
// ---------------------------------------------------------------------------

export const SEED_EMAIL_DOMAIN = "staging.levora.local";
const marker = (s: string) => `[Demo] ${s}`;

export const SEED_USERS = {
  admin: { email: `admin@${SEED_EMAIL_DOMAIN}`, displayName: "Demo - Equipe da Plataforma" },
  demo: { email: `demo@${SEED_EMAIL_DOMAIN}`, displayName: "Demo - Coordenação Esperança Viva" },
  operador: { email: `operador@${SEED_EMAIL_DOMAIN}`, displayName: "Demo - Operação Esperança Viva" },
  parceiro: { email: `parceiro@${SEED_EMAIL_DOMAIN}`, displayName: "Demo - Parceiros Horizonte e Aurora" },
} as const;
type UserKey = keyof typeof SEED_USERS;

const ORG_A = { name: "Associação Esperança Viva (Demo)", type: "organizacao_social", city: "Belo Horizonte", state: "MG" } as const;
const ORG_B = { name: "Ponto de Distribuição Horizonte (Demo)", type: "ponto_distribuicao", city: "Contagem", state: "MG" } as const;
const ORG_C = { name: "Igreja Nova Aurora (Demo)", type: "igreja", city: "Betim", state: "MG" } as const;

const SOURCE_NAME = "Cadastro manual (Demo)";
const ORIGIN_PREFIX = "DEMO-STAGING:";

/** Tabelas contadas para provar idempotência (nome físico no Postgres). */
const COUNTED_TABLES = [
  "users", "user_passwords", "organizations", "memberships", "organization_invites",
  "organization_capacities", "organization_service_areas", "organization_matching_settings",
  "inventory_items", "stock_transactions", "needs", "need_resolutions", "need_fulfillments",
  "sources", "donation_opportunities", "opportunity_registry", "opportunity_allocations", "match_evaluations",
  "logistics_events", "approval_requests", "background_task_runs", "audit_log",
] as const;

// ---------------------------------------------------------------------------
// Infra interna
// ---------------------------------------------------------------------------

type Handler = (request: Request) => Promise<Response>;
interface Actor { userId: number; email: string; cookie: string }

export class SeedStepError extends Error {
  constructor(label: string, status: number, message: string) {
    super(`Passo "${label}" falhou (HTTP ${status}): ${message}`);
    this.name = "SeedStepError";
  }
}

export interface SeedStats { endpointWrites: number; startedAt: number }

async function call(
  stats: SeedStats,
  label: string,
  handler: Handler,
  actor: Actor | null,
  body: unknown,
  path: string
): Promise<Record<string, any>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers.Cookie = actor.cookie;
  const response = await handler(
    new Request(`http://staging-seed.local/_api/v1/${path}`, {
      method: "POST",
      headers,
      body: superjson.stringify(body),
    })
  );
  const text = await response.text();
  stats.endpointWrites += 1;
  if (!response.ok) {
    let message = text;
    try { message = (superjson.parse(text) as { message?: string })?.message ?? text; } catch { /* corpo não-JSON */ }
    throw new SeedStepError(label, response.status, message);
  }
  return superjson.parse(text) as Record<string, any>;
}

/** Sessão real na tabela `sessions` + cookie assinado (mesmo mecanismo do login). */
async function openSession(userId: number, email: string, sessionIds: string[]): Promise<Actor> {
  const sessionId = randomBytes(32).toString("hex");
  const now = new Date();
  await db
    .insertInto("sessions")
    .values({
      id: sessionId, userId, createdAt: now, lastAccessed: now,
      expiresAt: new Date(now.getTime() + SessionExpirationSeconds * 1000),
    })
    .execute();
  sessionIds.push(sessionId);
  const probe = new Response();
  await setServerSession(probe, { id: sessionId, createdAt: now.getTime(), lastAccessed: now.getTime() });
  return { userId, email, cookie: probe.headers.get("Set-Cookie")!.split(";")[0] };
}

// ---------------------------------------------------------------------------
// Passos idempotentes
// ---------------------------------------------------------------------------

async function userIdByEmail(email: string): Promise<number | null> {
  const row = await db
    .selectFrom("users").select("id")
    .where(sql<string>`LOWER(email)`, "=", email.toLowerCase())
    .executeTakeFirst();
  return row?.id ?? null;
}

interface EnsuredUser { id: number; created: boolean; password?: string }

async function ensureUser(
  stats: SeedStats, key: UserKey, resetPasswords: boolean
): Promise<EnsuredUser> {
  const spec = SEED_USERS[key];
  const existingId = await userIdByEmail(spec.email);

  if (existingId === null) {
    const password = randomBytes(12).toString("base64url");
    // Cadastro pelo endpoint oficial: valida e-mail, aplica o hash oficial
    // e respeita a política de enumeração da Fase 51.
    await call(stats, `cadastro ${spec.email}`, registerHandle, null,
      { email: spec.email, password, displayName: spec.displayName }, "auth/register_with_password");
    const id = await userIdByEmail(spec.email);
    if (id === null) throw new SeedStepError(`cadastro ${spec.email}`, 0, "usuário não foi criado");
    return { id, created: true, password };
  }

  if (resetPasswords) {
    const password = randomBytes(12).toString("base64url");
    const hash = await generatePasswordHash(password);
    const updated = await db.updateTable("userPasswords").set({ passwordHash: hash }).where("userId", "=", existingId).execute();
    if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
      await db.insertInto("userPasswords").values({ userId: existingId, passwordHash: hash }).execute();
    }
    return { id: existingId, created: false, password };
  }
  return { id: existingId, created: false };
}

async function ensureOrganization(
  stats: SeedStats, spec: { name: string; type: string; city: string; state: string },
  owner: Actor, admin: Actor, activate: boolean
): Promise<number> {
  let org = await db.selectFrom("organizations").select(["id", "status"]).where("name", "=", spec.name).executeTakeFirst();
  if (!org) {
    const created = await call(stats, `organização ${spec.name}`, organizationsPost, owner, spec, "organizations");
    org = { id: created.organization.id as number, status: created.organization.status };
  }
  if (activate && org.status !== "ativa") {
    await call(stats, `ativar ${spec.name}`, platformOrgStatus, admin,
      { organizationId: org.id, status: "ativa" }, "platform-organizations-status");
  }
  return org.id;
}

async function ensureMember(
  stats: SeedStats, orgId: number, email: string, role: "administrador" | "operador" | "voluntario",
  owner: Actor, member: Actor
): Promise<void> {
  const existing = await db.selectFrom("memberships").select("id")
    .where("organizationId", "=", orgId).where("userId", "=", member.userId).executeTakeFirst();
  if (existing) return;
  const invite = await call(stats, `convite ${email}`, invitesPost, owner,
    { organizationId: orgId, email, role }, "organization-invites");
  const url = new URL(invite.acceptUrl as string, "http://staging-seed.local");
  const token = url.searchParams.get("token") ?? url.pathname.split("/").filter(Boolean).pop() ?? "";
  await call(stats, `aceitar convite ${email}`, invitesAccept, member, { token }, "organization-invites-accept");
}

async function ensureMatchingConfig(
  stats: SeedStats, orgId: number, owner: Actor,
  config: { capacities: { category: string; unit: string; maxCapacity: number }[]; areas: { city: string; state: string }[]; coleta: { realizaColeta: boolean; raioColetaKm: number; observacoesLogisticas: string } }
): Promise<void> {
  for (const c of config.capacities) {
    const found = await db.selectFrom("organizationCapacities").select("id")
      .where("organizationId", "=", orgId).where("category", "=", c.category).where("unit", "=", c.unit).executeTakeFirst();
    if (!found) await call(stats, `capacidade ${c.category}`, capacitiesPost, owner, { organizationId: orgId, ...c }, "organization-capacities");
  }
  for (const a of config.areas) {
    const found = await db.selectFrom("organizationServiceAreas").select("id")
      .where("organizationId", "=", orgId).where("city", "=", a.city).where("state", "=", a.state).executeTakeFirst();
    if (!found) await call(stats, `área ${a.city}`, serviceAreasPost, owner, { organizationId: orgId, ...a }, "organization-service-areas");
  }
  const settings = await db.selectFrom("organizationMatchingSettings").select("organizationId").where("organizationId", "=", orgId).executeTakeFirst();
  if (!settings) await call(stats, "configuração de coleta", matchingSettingsPost, owner, { organizationId: orgId, ...config.coleta }, "organization-matching-settings");
}

async function ensureItem(
  stats: SeedStats, orgId: number, actor: Actor,
  spec: { name: string; unit: string; category: string; initialQuantity?: number }
): Promise<number> {
  const found = await db.selectFrom("inventoryItems").select("id")
    .where("organizationId", "=", orgId).where("name", "=", spec.name).executeTakeFirst();
  if (found) return found.id;
  const created = await call(stats, `item ${spec.name}`, inventoryItemsPost, actor,
    { organizationId: orgId, ...spec }, "inventory-items");
  return (created.item?.id ?? created.id) as number;
}

async function ensureStockTx(
  stats: SeedStats, orgId: number, itemId: number, actor: Actor,
  type: "entrada" | "saida", quantity: number, reason: string
): Promise<void> {
  const found = await db.selectFrom("stockTransactions").select("id")
    .where("itemId", "=", itemId).where("reason", "=", reason).executeTakeFirst();
  if (found) return;
  await call(stats, `estoque ${reason}`, stockTransactionsPost, actor,
    { organizationId: orgId, itemId, type, quantity, reason }, "stock-transactions");
}

async function ensureNeed(
  stats: SeedStats, orgId: number, actor: Actor,
  spec: { title: string; description: string; itemId?: number; quantityNeeded: number; unit: string; priority: "baixa" | "media" | "alta" | "critica" }
): Promise<number> {
  const found = await db.selectFrom("needs").select("id").where("organizationId", "=", orgId).where("title", "=", spec.title).executeTakeFirst();
  if (found) return found.id;
  const created = await call(stats, `necessidade ${spec.title}`, needsPost, actor, { organizationId: orgId, ...spec }, "needs");
  return created.need.id as number;
}

async function ensureNeedStatus(
  stats: SeedStats, orgId: number, needId: number, status: "atendida" | "cancelada", actor: Actor
): Promise<void> {
  const need = await db.selectFrom("needs").select("status").where("id", "=", needId).executeTakeFirstOrThrow();
  if (need.status !== "aberta") return; // já foi movida (por este seed ou pelo fluxo normal)
  await call(stats, `status da necessidade ${needId} → ${status}`, needsStatusPost, actor, { organizationId: orgId, needId, status }, "needs-status");
}

async function ensureSource(stats: SeedStats, admin: Actor): Promise<number> {
  const found = await db.selectFrom("sources").select("id").where("name", "=", SOURCE_NAME).executeTakeFirst();
  if (found) return found.id;
  const created = await call(stats, "fonte manual", sourcesPost, admin, {
    name: SOURCE_NAME, type: "manual", connectorKey: "manual",
    policyNotes: "Fonte sintética do seed de staging (Fase 68). Nenhum dado real.",
  }, "sources");
  return (created.source?.id ?? created.id) as number;
}


/**
 * Oportunidades do modelo por organização (tela "Oportunidades" da
 * organização; tabela donation_opportunities). Criadas e movidas pelos
 * mesmos endpoints da interface — o estado "recebida" fica de fora de
 * propósito: ele só existe via recebimento real (que mexe em estoque).
 */
async function ensureLegacyOpportunity(
  stats: SeedStats, orgId: number, actor: Actor, linkedNeedId: number | null,
  spec: { title: string; description: string; category: string; quantityOffered: number; unit: string; donorName: string },
  target: "registrada" | "em_contato"
): Promise<void> {
  let row = await db.selectFrom("donationOpportunities").select(["id", "status"])
    .where("organizationId", "=", orgId).where("title", "=", spec.title).executeTakeFirst();
  if (!row) {
    const created = await call(stats, `oportunidade ${spec.title}`, legacyOpportunityPost, actor,
      { organizationId: orgId, ...spec, donorContact: "Contato sintético (sem dados reais)", ...(linkedNeedId ? { linkedNeedId } : {}) },
      "opportunities");
    row = { id: created.opportunity.id as number, status: "registrada" };
  }
  if (target === "em_contato" && row.status === "registrada") {
    await call(stats, `oportunidade ${row.id} → em_contato`, legacyOpportunityStatusPost, actor,
      { organizationId: orgId, opportunityId: row.id, status: "em_contato" }, "opportunities-status");
  }
}


/**
 * Histórico de tarefas de fundo: executa UMA vez, pelos mesmos handlers que
 * o scheduler (cron) chama, cada tarefa de manutenção que ainda não tem
 * nenhuma execução registrada. Assim a tela "Tarefas de fundo" mostra
 * execuções reais desde o primeiro minuto, em vez de esperar o cron.
 * runMatchingSweep fica de fora de propósito: reavaliaria o matching e
 * poderia mover oportunidades já validadas pelo seed — o scheduler o roda
 * normalmente a cada 15 minutos.
 */
const SEEDED_TASKS = ["expireReservations", "expireOpportunities", "expireApprovalRequests", "verifyAuditChain"] as const;

async function ensureBackgroundTaskHistory(): Promise<void> {
  for (const taskName of SEEDED_TASKS) {
    const existing = await db.selectFrom("backgroundTaskRuns").select("id").where("taskName", "=", taskName).executeTakeFirst();
    if (!existing) await TASK_HANDLERS[taskName]();
  }
}

const CURATION_CHAIN = ["descoberta", "em_verificacao", "validada", "aguardando_destinacao"] as const;

async function ensureRegistry(
  stats: SeedStats, sourceId: number, admin: Actor, key: string,
  spec: { title: string; description: string; category: string; quantity: number; unit: string; condition: string; locationCity: string; locationState: string; urgency: "baixa" | "media" | "alta" | "critica" },
  target: (typeof CURATION_CHAIN)[number]
): Promise<number> {
  const ref = `${ORIGIN_PREFIX}${key}`;
  let row = await db.selectFrom("opportunityRegistry").select(["id", "status"]).where("originReference", "=", ref).executeTakeFirst();
  if (!row) {
    const created = await call(stats, `descoberta ${key}`, registryPost, admin, {
      sourceId, ...spec, availability: "Sintético - disponível para demonstração",
      originReference: ref, originContact: "Contato sintético (sem dados reais)",
      confidence: 90, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    }, "opportunity-registry");
    row = { id: created.opportunity.id as number, status: "descoberta" };
  }
  // Só avança pela cadeia de curadoria; nunca "volta" nem força estado terminal.
  const idx = CURATION_CHAIN.indexOf(row.status as (typeof CURATION_CHAIN)[number]);
  if (idx !== -1) {
    for (let i = idx + 1; i <= CURATION_CHAIN.indexOf(target); i++) {
      await call(stats, `curadoria ${key} → ${CURATION_CHAIN[i]}`, registryStatusPost, admin,
        { opportunityId: row.id, status: CURATION_CHAIN[i], reason: "Seed sintético de staging" }, "opportunity-registry-status");
    }
  }
  return row.id;
}

type AllocationStop = "aceita" | "em_coleta" | "recebida";

/** Leva a atribuição pelo fluxo real até `stop`, pulando o que já aconteceu. */
async function ensureAllocationFlow(
  stats: SeedStats,
  p: { key: string; registryId: number; orgId: number; needId: number; quantity: number; itemId: number; stop: AllocationStop; admin: Actor; decider: Actor; operator: Actor }
): Promise<number> {
  const findAllocation = () =>
    db.selectFrom("opportunityAllocations").select(["id", "status"])
      .where("opportunityRegistryId", "=", p.registryId).where("organizationId", "=", p.orgId).where("needId", "=", p.needId)
      .where("status", "not in", ["recusada", "cancelada"]).executeTakeFirst();

  let allocation = await findAllocation();
  if (!allocation) {
    await call(stats, `atribuição ${p.key}`, allocationsPost, p.admin, {
      opportunityId: p.registryId, organizationId: p.orgId, quantityAllocated: p.quantity, needId: p.needId,
      notes: "Atribuição curada pela equipe da plataforma (seed sintético)",
    }, "opportunity-allocations");
    allocation = await findAllocation();
  }
  if (!allocation) throw new SeedStepError(`atribuição ${p.key}`, 0, "atribuição não encontrada após criação");
  const allocationId = allocation.id;
  const status = () => db.selectFrom("opportunityAllocations").select("status").where("id", "=", allocationId).executeTakeFirstOrThrow().then((r) => r.status as string);
  const logistics = (eventType: string, notes: string) =>
    call(stats, `logística ${p.key} ${eventType}`, logisticsPost, p.operator,
      { organizationId: p.orgId, allocationId, eventType, notes }, "allocations-logistics");

  if ((await status()) === "proposta") {
    await call(stats, `decisão ${p.key}`, allocationsDecidePost, p.decider,
      { organizationId: p.orgId, allocationId, decision: "aceita" }, "allocations-decide");
  }
  if (p.stop === "aceita") return allocationId;

  if ((await status()) === "aceita") await logistics("coleta_agendada", "Coleta agendada (sintético)");
  if (p.stop === "em_coleta") return allocationId;

  if ((await status()) === "em_coleta") {
    const done = await db.selectFrom("logisticsEvents").select("id")
      .where("opportunityAllocationId", "=", allocationId).where("eventType", "=", "coleta_concluida").executeTakeFirst();
    if (!done) await logistics("coleta_concluida", "Coleta concluída (sintético)");
    await logistics("transporte_iniciado", "Em transporte (sintético)");
  }
  if ((await status()) === "em_transporte") {
    await call(stats, `recebimento ${p.key}`, receivePost, p.operator, {
      organizationId: p.orgId, allocationId, itemId: p.itemId, quantityReceived: p.quantity,
      notes: "Recebimento sintético conferido (seed de staging)",
    }, "allocations-receive");
  }
  return allocationId;
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

export interface SeedResult {
  credentials: { email: string; role: string; password?: string }[];
  counts: Record<string, number>;
  checks: { name: string; ok: boolean; detail: string }[];
  endpointWrites: number;
  durationMs: number;
}

export async function countTables(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db);
    counts[table] = r.rows[0].n;
  }
  return counts;
}

export async function runStagingSeed(options: { resetPasswords?: boolean } = {}): Promise<SeedResult> {
  const stats: SeedStats = { endpointWrites: 0, startedAt: Date.now() };
  const sessionIds: string[] = [];
  try {
    // --- Usuários --------------------------------------------------------
    const users = {} as Record<UserKey, EnsuredUser>;
    for (const key of Object.keys(SEED_USERS) as UserKey[]) users[key] = await ensureUser(stats, key, options.resetPasswords ?? false);

    // Bootstrap do papel de plataforma (sem endpoint de promoção; ver cabeçalho).
    await db.updateTable("users").set({ role: "admin" })
      .where("id", "=", users.admin.id).where("role", "!=", "admin").execute();

    const actor = {} as Record<UserKey, Actor>;
    for (const key of Object.keys(SEED_USERS) as UserKey[]) {
      actor[key] = await openSession(users[key].id, SEED_USERS[key].email, sessionIds);
    }

    // --- Organizações e membros -----------------------------------------
    const orgA = await ensureOrganization(stats, ORG_A, actor.demo, actor.admin, true);
    const orgB = await ensureOrganization(stats, ORG_B, actor.parceiro, actor.admin, true);
    await ensureOrganization(stats, ORG_C, actor.parceiro, actor.admin, false); // permanece em_analise (demonstra a regra)
    await ensureMember(stats, orgA, SEED_USERS.operador.email, "operador", actor.demo, actor.operador);

    await ensureMatchingConfig(stats, orgA, actor.demo, {
      capacities: [
        { category: "alimentos", unit: "kg", maxCapacity: 500 },
        { category: "agasalhos", unit: "un", maxCapacity: 200 },
      ],
      areas: [{ city: "Belo Horizonte", state: "MG" }, { city: "Contagem", state: "MG" }],
      coleta: { realizaColeta: true, raioColetaKm: 20, observacoesLogisticas: "Coleta com veículo próprio, dias úteis (sintético)." },
    });
    await ensureMatchingConfig(stats, orgB, actor.parceiro, {
      capacities: [
        { category: "higiene", unit: "un", maxCapacity: 400 },
        { category: "alimentos", unit: "kg", maxCapacity: 200 },
      ],
      areas: [{ city: "Contagem", state: "MG" }, { city: "Betim", state: "MG" }],
      coleta: { realizaColeta: true, raioColetaKm: 15, observacoesLogisticas: "Retirada no ponto de distribuição (sintético)." },
    });

    // --- Estoque (sempre por movimentações; nunca saldo direto) -----------
    const arroz = await ensureItem(stats, orgA, actor.demo, { name: "Arroz branco 5kg (Demo)", unit: "kg", category: "alimentos", initialQuantity: 20 });
    await ensureStockTx(stats, orgA, arroz, actor.operador, "entrada", 30, marker("Doação de campanha (sintético)"));
    await ensureStockTx(stats, orgA, arroz, actor.operador, "saida", 10, marker("Distribuição semanal (sintético)"));
    const leite = await ensureItem(stats, orgA, actor.demo, { name: "Leite em pó lata (Demo)", unit: "un", category: "alimentos", initialQuantity: 60 });
    const cobertor = await ensureItem(stats, orgA, actor.demo, { name: "Cobertor casal (Demo)", unit: "un", category: "agasalhos", initialQuantity: 5 });
    const fralda = await ensureItem(stats, orgB, actor.parceiro, { name: "Fralda infantil M (Demo)", unit: "un", category: "higiene", initialQuantity: 100 });

    // --- Necessidades -----------------------------------------------------
    const needCobertor = await ensureNeed(stats, orgA, actor.demo, {
      title: marker("Cobertores para o inverno"), description: "Necessidade aberta e ainda não atendida (cenário 1).",
      itemId: cobertor, quantityNeeded: 30, unit: "un", priority: "alta",
    });
    const needArroz = await ensureNeed(stats, orgA, actor.demo, {
      title: marker("Arroz para cestas básicas"), description: "Parcialmente atendida por uma doação recebida (cenário 2).",
      itemId: arroz, quantityNeeded: 100, unit: "kg", priority: "critica",
    });
    const needLeite = await ensureNeed(stats, orgA, actor.demo, {
      title: marker("Leite em pó para lactentes"), description: "Atendida com o estoque próprio (cenário 3).",
      itemId: leite, quantityNeeded: 20, unit: "un", priority: "media",
    });
    const needKit = await ensureNeed(stats, orgA, actor.demo, {
      title: marker("Kit escolar (campanha encerrada)"), description: "Cancelada — histórico (cenário 4).",
      quantityNeeded: 15, unit: "un", priority: "baixa",
    });
    await ensureNeed(stats, orgB, actor.parceiro, {
      title: marker("Fraldas infantis tamanho M"), description: "Necessidade aberta que alimenta o matching real.",
      itemId: fralda, quantityNeeded: 150, unit: "un", priority: "alta",
    });
    await ensureNeedStatus(stats, orgA, needLeite, "atendida", actor.demo);
    await ensureNeedStatus(stats, orgA, needKit, "cancelada", actor.demo);


    // --- Oportunidades do modelo por organização (tela da organização) -----
    await ensureLegacyOpportunity(stats, orgA, actor.demo, needCobertor, {
      title: marker("Doação de cobertores - Associação de Moradores Fictícia"), description: "Contato inicial com doador, ainda sem retorno.",
      category: "agasalhos", quantityOffered: 15, unit: "un", donorName: "Associação de Moradores Fictícia",
    }, "registrada");
    await ensureLegacyOpportunity(stats, orgA, actor.operador, needArroz, {
      title: marker("Cestas de arroz - Supermercado Fictício"), description: "Doador em negociação.",
      category: "alimentos", quantityOffered: 30, unit: "kg", donorName: "Supermercado Fictício",
    }, "em_contato");

    // --- Oportunidades (lifecycle real) ----------------------------------
    const source = await ensureSource(stats, actor.admin);
    const base = { condition: "novo", locationState: "MG" };

    await ensureRegistry(stats, source, actor.admin, "O1-descoberta", {
      ...base, title: marker("Roupas de inverno - Padaria Fictícia"), description: "Recém-descoberta, aguardando verificação.",
      category: "agasalhos", quantity: 40, unit: "un", locationCity: "Belo Horizonte", urgency: "media",
    }, "descoberta");
    await ensureRegistry(stats, source, actor.admin, "O2-verificacao", {
      ...base, title: marker("Excedente de legumes - Feira Fictícia"), description: "Em verificação pela equipe.",
      category: "alimentos", quantity: 25, unit: "kg", locationCity: "Belo Horizonte", urgency: "alta",
    }, "em_verificacao");
    await ensureRegistry(stats, source, actor.admin, "O3-validada", {
      ...base, title: marker("Cestas de higiene - Empresa Fictícia"), description: "Validada, ainda sem destinação.",
      category: "higiene", quantity: 60, unit: "un", locationCity: "Contagem", urgency: "media",
    }, "validada");

    const o4 = await ensureRegistry(stats, source, actor.admin, "O4-matching", {
      ...base, title: marker("Fraldas infantis - Comércio Fictício"), description: "Aguardando destinação: o matching real avalia as organizações.",
      category: "higiene", quantity: 120, unit: "un", locationCity: "Contagem", urgency: "alta",
    }, "aguardando_destinacao");
    // A transição para aguardando_destinacao já dispara o matching; se por
    // qualquer falha não houver nenhuma avaliação, roda explicitamente.
    const evaluated = await db.selectFrom("matchEvaluations").select("id").where("opportunityRegistryId", "=", o4).executeTakeFirst();
    const o4Status = await db.selectFrom("opportunityRegistry").select("status").where("id", "=", o4).executeTakeFirstOrThrow();
    if (!evaluated && o4Status.status === "aguardando_destinacao") {
      await call(stats, "matching O4", registryMatchPost, actor.admin, { opportunityId: o4 }, "opportunity-registry-match");
    }

    // O7: nenhuma organização atende a região (Curitiba/PR) nem declara capacidade, então o
    // matching real não encontra candidata elegível e ela PERMANECE em
    // aguardando_destinacao (estado legítimo, não forçado).
    const o7 = await ensureRegistry(stats, source, actor.admin, "O7-aguardando-destinacao", {
      ...base, title: marker("Brinquedos educativos - Loja Fictícia"), description: "Aguardando destinação: sem organização elegível por enquanto.",
      category: "brinquedos", quantity: 30, unit: "un", locationCity: "Curitiba", locationState: "PR", urgency: "baixa",
    }, "aguardando_destinacao");

    const o5 = await ensureRegistry(stats, source, actor.admin, "O5-concluida", {
      ...base, title: marker("Arroz 40 kg - Mercado Fictício"), description: "Percorre todo o lifecycle até concluída.",
      category: "alimentos", quantity: 40, unit: "kg", locationCity: "Belo Horizonte", urgency: "critica",
    }, "validada");
    await ensureAllocationFlow(stats, {
      key: "O5", registryId: o5, orgId: orgA, needId: needArroz, quantity: 40, itemId: arroz, stop: "recebida",
      admin: actor.admin, decider: actor.demo, operator: actor.operador,
    });

    const o6 = await ensureRegistry(stats, source, actor.admin, "O6-em-coleta", {
      ...base, title: marker("Cobertores 20 un - Igreja Fictícia"), description: "Atribuída e com coleta agendada.",
      category: "agasalhos", quantity: 20, unit: "un", locationCity: "Belo Horizonte", urgency: "alta",
    }, "validada");
    await ensureAllocationFlow(stats, {
      key: "O6", registryId: o6, orgId: orgA, needId: needCobertor, quantity: 20, itemId: cobertor, stop: "em_coleta",
      admin: actor.admin, decider: actor.demo, operator: actor.operador,
    });

    await ensureBackgroundTaskHistory();

    // --- Validação do resultado ------------------------------------------
    const checks = await verifySeedResult({ orgA, orgB, arroz, leite, cobertor, fralda, needArroz, needLeite, needCobertor, needKit, o5, o6, o7 });

    const credentials = (Object.keys(SEED_USERS) as UserKey[]).map((key) => ({
      email: SEED_USERS[key].email,
      role: key === "admin" ? "Administrador da plataforma" : key === "demo" ? "Proprietário - Esperança Viva (CONTA DEMO)" : key === "operador" ? "Operador - Esperança Viva" : "Proprietário - Horizonte e Aurora",
      password: users[key].password,
    }));

    return { credentials, counts: await countTables(), checks, endpointWrites: stats.endpointWrites, durationMs: Date.now() - stats.startedAt };
  } finally {
    if (sessionIds.length > 0) await db.deleteFrom("sessions").where("id", "in", sessionIds).execute();
  }
}

async function verifySeedResult(ids: {
  orgA: number; orgB: number; arroz: number; leite: number; cobertor: number; fralda: number;
  needArroz: number; needLeite: number; needCobertor: number; needKit: number; o5: number; o6: number; o7: number;
}): Promise<SeedResult["checks"]> {
  const checks: SeedResult["checks"] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // Saldos derivados de stock_transactions (única fonte de verdade).
  const balance = (id: number) => db.transaction().execute((trx) => getItemStockBalance(trx, id));
  const expected: [string, number, number][] = [
    ["Arroz (20+30-10 + 40 recebidos)", ids.arroz, 80],
    ["Leite (60 - 20 baixa da necessidade atendida)", ids.leite, 40],
    ["Cobertor (5 iniciais)", ids.cobertor, 5],
    ["Fralda (100 iniciais)", ids.fralda, 100],
  ];
  for (const [name, id, want] of expected) {
    const got = await balance(id);
    check(`saldo derivado: ${name}`, got === want, `esperado ${want}, obtido ${got}`);
  }

  // Progresso real da necessidade parcialmente atendida.
  const fulfilled = await getNeedFulfillmentBalance(db, ids.needArroz);
  const progress = computeNeedProgress(100, fulfilled);
  check("necessidade parcial: fulfilled=40, requiredRemaining=60, surplus=0",
    fulfilled === 40 && progress.requiredRemaining === 60 && progress.surplus === 0,
    `fulfilled=${fulfilled} requiredRemaining=${progress.requiredRemaining} surplus=${progress.surplus}`);

  const status = async (id: number) => (await db.selectFrom("needs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
  check("necessidades: aberta / atendida / cancelada",
    (await status(ids.needCobertor)) === "aberta" && (await status(ids.needArroz)) === "aberta" &&
    (await status(ids.needLeite)) === "atendida" && (await status(ids.needKit)) === "cancelada",
    "cobertor=aberta arroz=aberta leite=atendida kit=cancelada");

  const resolution = await db.selectFrom("needResolutions").select("id").where("needId", "=", ids.needLeite).executeTakeFirst();
  check("necessidade atendida possui need_resolution", Boolean(resolution), resolution ? "sim" : "ausente");

  const regStatus = async (id: number) => (await db.selectFrom("opportunityRegistry").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status as string;
  check("lifecycle: O5 concluída (via recebimento real)", (await regStatus(ids.o5)) === "concluida", `status=${await regStatus(ids.o5)}`);
  const o6Status = await regStatus(ids.o6);
  check("lifecycle: O6 em andamento (coleta agendada)", ["atribuida", "aguardando_coleta"].includes(o6Status), `status=${o6Status}`);

  const o7Status = await regStatus(ids.o7);
  check("lifecycle: O7 aguardando destinação (matching real sem candidata elegível)", o7Status === "aguardando_destinacao", `status=${o7Status}`);

  const orgs = await db.selectFrom("organizations").select(["name", "status"]).where("name", "in", [ORG_A.name, ORG_B.name, ORG_C.name]).execute();
  const statusOf = (n: string) => orgs.find((o) => o.name === n)?.status;
  check("organizações: A e B ativas, C em análise",
    statusOf(ORG_A.name) === "ativa" && statusOf(ORG_B.name) === "ativa" && statusOf(ORG_C.name) === "em_analise",
    `A=${statusOf(ORG_A.name)} B=${statusOf(ORG_B.name)} C=${statusOf(ORG_C.name)}`);

  const matchRows = await db.selectFrom("matchEvaluations").select(["algorithmVersion"]).execute();
  check(`matching real avaliado (ALGORITHM_VERSION ${ALGORITHM_VERSION})`,
    matchRows.length > 0 && matchRows.every((m) => m.algorithmVersion === ALGORITHM_VERSION),
    `${matchRows.length} avaliação(ões)`);

  const taskRuns = await db.selectFrom("backgroundTaskRuns").select(["taskName", "status"]).execute();
  const done = new Set(taskRuns.filter((r) => r.status === "concluida").map((r) => r.taskName));
  check("tarefas de fundo executadas pelos handlers reais", SEEDED_TASKS.every((t) => done.has(t)), [...done].sort().join(", ") || "nenhuma");

  const chain = await verifyAuditLogChain();
  check("cadeia de auditoria íntegra", chain.integra, `${chain.eventosVerificados}/${chain.totalEventos} eventos verificados, ${chain.divergencias.length} divergência(s)`);
  return checks;
}
