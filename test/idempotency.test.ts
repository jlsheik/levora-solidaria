/**
 * Testes de idempotência (Fase 2 do pedido de auditoria de segurança):
 * background_task_runs (claimTaskRun) e runMatchingForOpportunity, mais
 * expireOpportunities/expireReservations para fechar a mesma cobertura que
 * já existia só para expireApprovalRequests (test/expireApprovalRequests.test.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { claimTaskRun, finishTaskRun, failTaskRun } from "../src/helpers/backgroundTasks";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import { expireOpportunities } from "../src/helpers/expireOpportunities";
import { expireReservations } from "../src/helpers/expireReservations";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  type AuthenticatedTestUser,
} from "./helpers";

describe("claimTaskRun (background_task_runs) — idempotência", () => {
  it("mesma idempotencyKey chamada duas vezes seguidas: a segunda não executa de novo", async () => {
    const first = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "chave-fixa-1" });
    expect(first.claimed).toBe(true);

    const second = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "chave-fixa-1" });
    expect(second.claimed).toBe(false);
    expect(second.runId).toBe(first.runId);

    const rows = await db.selectFrom("backgroundTaskRuns").select(["id"]).where("idempotencyKey", "=", "chave-fixa-1").execute();
    expect(rows).toHaveLength(1);
  });

  it("chamadas CONCORRENTES com a mesma idempotencyKey não geram execução duplicada nem exceção não tratada", async () => {
    // Antes da correção, a chamada perdedora da corrida (SELECT-then-INSERT
    // sob READ COMMITTED) recebia uma violação de unicidade não tratada em
    // vez de `claimed: false` — ver comentário em backgroundTasks.tsx.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimTaskRun({ taskName: "tarefaConcorrente", idempotencyKey: "chave-concorrente" }))
    );

    const claimed = results.filter((r) => r.claimed);
    const notClaimed = results.filter((r) => !r.claimed);
    expect(claimed).toHaveLength(1);
    expect(notClaimed).toHaveLength(4);
    // Todo mundo (vencedor e perdedores) aponta para a mesma linha.
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);

    const rows = await db.selectFrom("backgroundTaskRuns").select(["id"]).where("idempotencyKey", "=", "chave-concorrente").execute();
    expect(rows).toHaveLength(1);
  });

  it("uma execução concluída não pode ser reprocessada indevidamente", async () => {
    const claim = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "chave-concluida" });
    await finishTaskRun(claim.runId);

    const retry = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "chave-concluida" });
    expect(retry.claimed).toBe(false);
    expect(retry.runId).toBe(claim.runId);
  });

  it("uma execução que falhou É reprocessada, respeitando o limite de tentativas", async () => {
    const claim = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "chave-falha", maxAttempts: 2 });
    await failTaskRun(claim.runId, new Error("falha simulada"));

    const retry = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "chave-falha", maxAttempts: 2 });
    expect(retry.claimed).toBe(true);
    expect(retry.runId).toBe(claim.runId);

    const row = await db.selectFrom("backgroundTaskRuns").select(["attemptCount", "status"]).where("id", "=", claim.runId).executeTakeFirstOrThrow();
    expect(row.attemptCount).toBe(2);
    expect(row.status).toBe("executando");

    // Esgotadas as tentativas, não reprocessa mais.
    await failTaskRun(claim.runId, new Error("falha simulada de novo"));
    const exhausted = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "chave-falha", maxAttempts: 2 });
    expect(exhausted.claimed).toBe(false);
  });

  it("organizações diferentes não interferem entre si: idempotencyKey é isolada por chamador, não por organização (não há organizationId no claim)", async () => {
    // background_task_runs não é uma entidade por organização — a chave é
    // escolhida por quem chama (ex.: `${taskName}:${data}`). Confirma que
    // chaves DIFERENTES nunca colidem entre si.
    const a = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "org-a" });
    const b = await claimTaskRun({ taskName: "tarefaTeste", idempotencyKey: "org-b" });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(a.runId).not.toBe(b.runId);
  });
});

describe("runMatchingForOpportunity — idempotência", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    orgId = org.id;
  });

  async function createNeed(title: string, quantityNeeded: number, priority: "baixa" | "media" | "alta" | "critica" = "media") {
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: orgId, title, quantityNeeded: String(quantityNeeded), unit: "unidade", priority, status: "aberta", createdByUserId: owner.userId })
      .returning(["id"])
      .execute();
    return need.id;
  }

  it("rodar duas vezes para uma oportunidade já com match de ALTA confiança não cria segunda alocação (opportunity vira 'atribuida', 2ª chamada é ignorada)", async () => {
    await createNeed("Cobertores de inverno", 30, "critica"); // urgência alta + palavra-chave forte → score >=90
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "aguardando_destinacao" });
    await db
      .updateTable("opportunityRegistry")
      .set({ title: "Doação de cobertores de inverno", locationCity: "Belo Horizonte", locationState: "MG", quantity: "100" })
      .where("id", "=", opportunity.id)
      .execute();

    const first = await runMatchingForOpportunity(opportunity.id, admin.userId);
    expect(first.skipped).toBe(false);
    expect(first.allocationsCreated).toHaveLength(1);

    const afterFirst = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunity.id).executeTakeFirstOrThrow();
    expect(afterFirst.status).toBe("atribuida");

    const second = await runMatchingForOpportunity(opportunity.id, admin.userId);
    expect(second.skipped).toBe(true);
    expect(second.reason).toContain("status_nao_elegivel");
    expect(second.allocationsCreated).toHaveLength(0);

    const allocations = await db.selectFrom("opportunityAllocations").select(["id"]).where("opportunityRegistryId", "=", opportunity.id).execute();
    expect(allocations).toHaveLength(1); // não duplicou

    const highConfidenceAudits = await db
      .selectFrom("auditLog")
      .select(["id"])
      .where("action", "=", "atribuicao.automatica_alta_confianca")
      .where("organizationId", "=", orgId)
      .execute();
    expect(highConfidenceAudits).toHaveLength(1);
  });

  it("rodar duas vezes com quantidade restante e a mesma organização já candidata não cria uma segunda alocação para ela (existingOrgIds)", async () => {
    // Score deliberadamente médio (70–89.99): urgência baixa reduz o total.
    await createNeed("Cobertores de inverno", 30, "baixa");
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "aguardando_destinacao" });
    await db
      .updateTable("opportunityRegistry")
      .set({ title: "Doação de cobertores de inverno", locationCity: "Belo Horizonte", locationState: "MG", quantity: "100" })
      .where("id", "=", opportunity.id)
      .execute();

    const first = await runMatchingForOpportunity(opportunity.id, admin.userId);
    expect(first.skipped).toBe(false);
    expect(first.allocationsCreated).toHaveLength(1);
    expect(first.allocationsCreated[0].status).toBe("proposta"); // confiança média

    const afterFirst = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunity.id).executeTakeFirstOrThrow();
    // Ainda elegível para nova rodada (não terminal) — é exatamente o
    // cenário em que a proteção por existingOrgIds importa de verdade.
    expect(["aguardando_destinacao", "reservada"]).toContain(afterFirst.status);

    const second = await runMatchingForOpportunity(opportunity.id, admin.userId);
    expect(second.skipped).toBe(false); // a oportunidade continua elegível...
    expect(second.allocationsCreated).toHaveLength(0); // ...mas não reavalia a mesma organização

    const allocations = await db
      .selectFrom("opportunityAllocations")
      .select(["id"])
      .where("opportunityRegistryId", "=", opportunity.id)
      .where("organizationId", "=", orgId)
      .execute();
    expect(allocations).toHaveLength(1);
  });

  it("oportunidade com quantidade já totalmente atribuída: segunda chamada é ignorada (skipped)", async () => {
    await createNeed("Cobertores de inverno", 100, "critica");
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "aguardando_destinacao" });
    await db
      .updateTable("opportunityRegistry")
      .set({ title: "Doação de cobertores de inverno", locationCity: "Belo Horizonte", locationState: "MG", quantity: "100" })
      .where("id", "=", opportunity.id)
      .execute();

    await runMatchingForOpportunity(opportunity.id, admin.userId);
    // Alta confiança marca a oportunidade "atribuida", que já barra a 2ª
    // chamada por status — força o outro caminho (quantidade zerada)
    // reabrindo o status manualmente, como uma tarefa de expiração faria.
    await db.updateTable("opportunityRegistry").set({ status: "aguardando_destinacao" }).where("id", "=", opportunity.id).execute();

    const second = await runMatchingForOpportunity(opportunity.id, admin.userId);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("quantidade_totalmente_atribuida");
  });
});

describe("expireOpportunities (tarefa agendada) — idempotência", () => {
  it("rodar duas vezes seguidas não gera auditoria duplicada nem tenta expirar de novo", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "validada" });
    await db
      .updateTable("opportunityRegistry")
      .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where("id", "=", opportunity.id)
      .execute();

    await expireOpportunities();
    await expireOpportunities();

    const row = await db.selectFrom("opportunityRegistry").select(["status"]).where("id", "=", opportunity.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("expirada");

    const audits = await db
      .selectFrom("auditLog")
      .select(["id"])
      .where("action", "=", "descoberta_central.expirada_automaticamente")
      .where("entityId", "=", String(opportunity.id))
      .execute();
    expect(audits).toHaveLength(1);
  });
});

describe("expireReservations (tarefa agendada) — idempotência", () => {
  it("rodar duas vezes seguidas não cancela a mesma reserva duas vezes nem duplica auditoria", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "reservada" });

    const [allocation] = await db
      .insertInto("opportunityAllocations")
      .values({
        opportunityRegistryId: opportunity.id,
        organizationId: org.id,
        status: "proposta",
        autoMatched: true,
        quantityAllocated: "5",
        reservedUntil: new Date(Date.now() - 60 * 1000), // já vencida
      })
      .returning(["id"])
      .execute();

    await expireReservations();
    await expireReservations();

    const row = await db.selectFrom("opportunityAllocations").select(["status"]).where("id", "=", allocation.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelada");

    const audits = await db
      .selectFrom("auditLog")
      .select(["id"])
      .where("action", "=", "atribuicao.reserva_expirada")
      .where("entityId", "=", String(allocation.id))
      .execute();
    expect(audits).toHaveLength(1);
  });
});
