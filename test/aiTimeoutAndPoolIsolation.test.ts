/**
 * Fase 64 — achado real da Fase 63: opportunityMatching.tsx chama a IA
 * (Anthropic) DENTRO de db.transaction(), sem nenhum timeout até esta
 * fase — uma IA lenta/travada prenderia uma conexão do pool (só 3) pelo
 * tempo que a chamada demorasse, até sem limite. Corrigido com um timeout
 * de 8s + AbortController em src/helpers/aiClient.tsx.
 *
 * Este arquivo prova, com uma IA deliberadamente lenta (mock de
 * `fetch`, nunca o provedor real — Etapa Terceira/Quarta do pedido),
 * que: (1) a chamada realmente é abortada por volta do timeout, não fica
 * pendurada para sempre; (2) o motor de matching continua funcionando
 * via fallback determinístico por palavra-chave, sem erro para o
 * chamador; (3) nenhuma conexão/lock fica presa depois — a prova é que
 * uma segunda chamada de matching, logo em seguida, funciona
 * normalmente; (4) durante a espera da IA lenta, o pool da API continua
 * disponível para outras queries (mesma categoria de proteção já provada
 * na Fase 63 para o scheduler, agora também para a IA).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity, ALGORITHM_VERSION } from "../src/helpers/opportunityMatching";
import { createAuthenticatedUser, createTestOrganization, createTestSource, createTestOpportunityRegistry } from "./helpers";

async function setupNoKeywordMatchScenario() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
  const [need] = await db
    .insertInto("needs")
    .values({
      organizationId: org.id,
      // Sem nenhuma palavra em comum com o título da oportunidade abaixo —
      // força o caminho de IA (weakKeyword/aiBatch), nunca o atalho de
      // correspondência por palavra-chave.
      title: "Preciso urgentemente de cobertores grossos",
      quantityNeeded: "10",
      unit: "unidade",
      priority: "alta",
      status: "aberta",
      createdByUserId: owner.userId,
    })
    .returning(["id"])
    .execute();

  const admin = await createAuthenticatedUser();
  const source = await createTestSource(admin.userId);
  const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, {
    title: "Doação de equipamentos eletrônicos variados",
    status: "aguardando_destinacao",
  });

  return { opportunityId: opportunity.id, needId: need.id, adminUserId: admin.userId };
}

describe("timeout de IA dentro do matching — não prende conexão indefinidamente", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("uma IA que nunca responde é abortada pelo timeout, e o matching termina via fallback por palavra-chave", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-fase64-nao-real";

    // Mock de fetch que nunca resolve sozinho — só rejeita quando o
    // AbortController de aiClient.tsx disparar o abort, exatamente como o
    // fetch nativo real se comporta. Isto prova o timeout de verdade, não
    // só que "o mock responde rápido".
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
    );

    const { opportunityId, adminUserId } = await setupNoKeywordMatchScenario();

    const start = Date.now();
    const result = await runMatchingForOpportunity(opportunityId, adminUserId);
    const elapsedMs = Date.now() - start;

    // Generoso para não ser frágil em CI mais lento, mas prova que não
    // ficou pendurado para sempre (o mock, sem timeout, nunca resolveria
    // sozinho) nem que o timeout foi ignorado.
    expect(elapsedMs).toBeGreaterThan(7000);
    expect(elapsedMs).toBeLessThan(15000);

    // Fallback determinístico: sem IA, a need sem palavra-chave em comum
    // não vira candidata (categoriaScore=0) — resultado funcional
    // preservado, igual a qualquer outra falha de IA já tratada antes
    // desta fase.
    expect(result.skipped).toBe(false);
    expect(result.allocationsCreated).toHaveLength(0);

    const auditRow = await db
      .selectFrom("auditLog")
      .select(["action"])
      .where("entityId", "=", String(opportunityId))
      .where("action", "=", "matching.executado")
      .executeTakeFirst();
    expect(auditRow).toBeDefined();
  }, 20_000);

  it("depois do timeout, a conexão/lock não ficam presos — uma segunda execução de matching funciona normalmente", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-fase64-nao-real";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
    );

    const { opportunityId: opp1, adminUserId } = await setupNoKeywordMatchScenario();
    await runMatchingForOpportunity(opp1, adminUserId);

    // Sem nenhum mock desta vez (ANTHROPIC_API_KEY removida) — exercita o
    // caminho "IA não configurada", que deveria funcionar instantaneamente
    // se nenhuma conexão/lock ficou presa pela execução anterior.
    delete process.env.ANTHROPIC_API_KEY;
    const { opportunityId: opp2, adminUserId: admin2 } = await setupNoKeywordMatchScenario();

    const start = Date.now();
    const result2 = await runMatchingForOpportunity(opp2, admin2);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
    expect(result2.skipped).toBe(false);
  }, 20_000);

  it("enquanto a IA está lenta (conexão presa pela transação), o pool da API continua disponível para outras queries", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-fase64-nao-real";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
    );

    const { opportunityId, adminUserId } = await setupNoKeywordMatchScenario();

    const matchingPromise = runMatchingForOpportunity(opportunityId, adminUserId);

    // Dá tempo da transação de matching abrir e a chamada de IA começar a
    // esperar, antes de medir uma query comum concorrente.
    await new Promise((r) => setTimeout(r, 300));

    const queryStart = Date.now();
    await sql`SELECT 1`.execute(db);
    const queryElapsedMs = Date.now() - queryStart;

    expect(queryElapsedMs).toBeLessThan(1000);

    await matchingPromise;
  }, 20_000);
});
