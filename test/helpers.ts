/**
 * Utilitários compartilhados pelos testes de integração: criam usuário,
 * sessão autenticada e organização diretamente no banco de teste (sem passar
 * pelos endpoints HTTP), e um `Request` (Web Fetch API) pronto para chamar
 * `handle()` de qualquer endpoint em src/endpoints, exatamente como o
 * server/index.ts real faz.
 */
import { randomBytes } from "node:crypto";
import superjson from "superjson";
import { db } from "../src/helpers/db";
import { generatePasswordHash } from "../src/helpers/generatePasswordHash";
import { setServerSession, SessionExpirationSeconds } from "../src/helpers/getSetServerSession";
import type { MembershipRole, OrganizationType } from "../src/helpers/schema";

let emailCounter = 0;

export async function createTestUser(overrides: { email?: string; displayName?: string } = {}) {
  emailCounter += 1;
  const email = overrides.email ?? `teste-${emailCounter}-${randomBytes(4).toString("hex")}@example.com`;
  const displayName = overrides.displayName ?? `Usuário de Teste ${emailCounter}`;

  const [user] = await db
    .insertInto("users")
    .values({ email, displayName, role: "user" })
    .returning(["id", "email", "displayName"])
    .execute();

  await db
    .insertInto("userPasswords")
    .values({ userId: user.id, passwordHash: await generatePasswordHash("senha-de-teste-123") })
    .execute();

  return user;
}

/** Cria uma sessão de verdade na tabela `sessions` e devolve o cookie assinado. */
export async function createSessionCookie(userId: number): Promise<string> {
  const sessionId = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SessionExpirationSeconds * 1000);

  await db
    .insertInto("sessions")
    .values({ id: sessionId, userId, createdAt: now, lastAccessed: now, expiresAt })
    .execute();

  const probe = new Response();
  await setServerSession(probe, { id: sessionId, createdAt: now.getTime(), lastAccessed: now.getTime() });
  const setCookieHeader = probe.headers.get("Set-Cookie")!;
  return setCookieHeader.split(";")[0]; // "floot_built_app_session=<token>"
}

export interface AuthenticatedTestUser {
  userId: number;
  email: string;
  cookie: string;
}

export async function createAuthenticatedUser(overrides?: { email?: string; displayName?: string }): Promise<AuthenticatedTestUser> {
  const user = await createTestUser(overrides);
  const cookie = await createSessionCookie(user.id);
  return { userId: user.id, email: user.email, cookie };
}

export async function createTestOrganization(
  ownerUserId: number,
  overrides: { name?: string; type?: OrganizationType; city?: string; state?: string; status?: "ativa" | "em_analise" | "suspensa" } = {}
) {
  const suffix = randomBytes(4).toString("hex");
  const [org] = await db
    .insertInto("organizations")
    .values({
      name: overrides.name ?? `Organização de Teste ${suffix}`,
      slug: `org-teste-${suffix}`,
      type: overrides.type ?? "organizacao_social",
      city: overrides.city ?? "Belo Horizonte",
      state: overrides.state ?? "MG",
      status: overrides.status ?? "ativa",
      createdByUserId: ownerUserId,
    })
    .returning(["id", "name", "slug", "status", "city", "state"])
    .execute();

  await db
    .insertInto("memberships")
    .values({ organizationId: org.id, userId: ownerUserId, role: "proprietario", status: "ativo" })
    .execute();

  return org;
}

export async function createTestInventoryItem(organizationId: number, userId: number, overrides: { name?: string; unit?: string } = {}) {
  const suffix = randomBytes(3).toString("hex");
  const [item] = await db
    .insertInto("inventoryItems")
    .values({
      organizationId,
      name: overrides.name ?? `Item de teste ${suffix}`,
      unit: overrides.unit ?? "unidade",
      createdByUserId: userId,
    })
    .returning(["id", "name"])
    .execute();
  return item;
}

export async function addMembership(organizationId: number, userId: number, role: MembershipRole, status: "ativo" | "convidado" | "inativo" = "ativo") {
  await db
    .insertInto("memberships")
    .values({ organizationId, userId, role, status })
    .execute();
}

/** Usuário com `platform_access` ativo (nível `admin`) — o que passa por `requirePlatformAdmin`. */
export async function createPlatformAdmin(overrides?: { email?: string; displayName?: string }): Promise<AuthenticatedTestUser> {
  const user = await createTestUser(overrides);
  await db.insertInto("platformAccess").values({ userId: user.id, level: "admin", status: "active", grantOrigin: "test" }).execute();
  const cookie = await createSessionCookie(user.id);
  return { userId: user.id, email: user.email, cookie };
}

/** Platform Owner (no máximo 1 ativo por vez — índice único parcial). */
export async function createPlatformOwner(overrides?: { email?: string; displayName?: string }): Promise<AuthenticatedTestUser> {
  const user = await createTestUser(overrides);
  await db.insertInto("platformAccess").values({ userId: user.id, level: "owner", status: "active", grantOrigin: "test" }).execute();
  const cookie = await createSessionCookie(user.id);
  return { userId: user.id, email: user.email, cookie };
}

/** Fonte "manual" — único connectorKey que nasce `ativa` sem configuração externa (ver connectorsManual.tsx). */
export async function createTestSource(createdByUserId: number, overrides: { name?: string } = {}) {
  const suffix = randomBytes(3).toString("hex");
  const [source] = await db
    .insertInto("sources")
    .values({
      name: overrides.name ?? `Fonte de teste ${suffix}`,
      type: "outro",
      connectorKey: "manual",
      status: "ativa",
      createdByUserId,
    })
    .returning(["id", "name", "status"])
    .execute();
  return source;
}

/** Descoberta no registro central (`opportunity_registry`) — sem organização dona, ver docs/ARCHITECTURE.md. */
export async function createTestOpportunityRegistry(
  sourceId: number,
  discoveredByUserId: number,
  overrides: { title?: string; status?: "descoberta" | "validada" | "aguardando_destinacao" | "reservada" } = {}
) {
  const [opportunity] = await db
    .insertInto("opportunityRegistry")
    .values({
      sourceId,
      title: overrides.title ?? "Doação de teste no registro central",
      status: overrides.status ?? "validada",
      quantity: "10",
      unit: "unidade",
      discoveredByUserId,
    })
    .returning(["id", "title", "status"])
    .execute();
  return opportunity;
}

/** Atribuição de uma descoberta central a uma organização (`opportunity_allocations`). */
export async function createTestAllocation(
  opportunityRegistryId: number,
  organizationId: number,
  overrides: { status?: "proposta" | "aceita" | "recusada" | "em_coleta" | "em_transporte"; quantityAllocated?: number } = {}
) {
  const [allocation] = await db
    .insertInto("opportunityAllocations")
    .values({
      opportunityRegistryId,
      organizationId,
      status: overrides.status ?? "proposta",
      quantityAllocated: String(overrides.quantityAllocated ?? 5),
    })
    .returning(["id", "status", "organizationId"])
    .execute();
  return allocation;
}

/** Constrói um Request (Web Fetch API) igual ao que server/index.ts monta a partir do Express. */
export function buildRequest(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; cookie?: string; ip?: string } = {}
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.cookie) headers.set("Cookie", options.cookie);
  // Mesmo header que server/index.ts injeta a partir de req.ip — ver
  // src/helpers/rateLimit.tsx#getClientIp. Sem isso, todo teste cairia no
  // mesmo identificador "desconhecido" e poluiria o limite entre testes.
  headers.set("x-client-ip-verified", options.ip ?? `test-ip-${Math.random().toString(36).slice(2)}`);
  // Sem "/v1/" de propósito: estes testes chamam `handle()` do endpoint
  // diretamente (nunca passam pelo roteamento do Express em
  // server/index.ts), e nenhum endpoint lê o pathname da URL — só
  // searchParams e o corpo. O prefixo de versão só existe na camada de
  // roteamento HTTP real (ver server/index.ts#API_VERSION_PREFIX), então
  // não afeta o comportamento testado aqui.
  return new Request(`http://localhost/_api/${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? superjson.stringify(options.body) : undefined,
  });
}

export async function parseJson<T>(response: Response): Promise<T> {
  return superjson.parse<T>(await response.text());
}
