import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { recordAuditLogEntry, computeAuditEventHash } from "../src/helpers/auditLog";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { createAuthenticatedUser, createTestOrganization } from "./helpers";

describe("hash encadeado da trilha de auditoria", () => {
  it("cada evento novo referencia o event_hash do evento anterior", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.evento_1", entityType: "teste", entityId: "1" });
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.evento_2", entityType: "teste", entityId: "2" });
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.evento_3", entityType: "teste", entityId: "3" });

    const rows = await db
      .selectFrom("auditLog")
      .select(["id", "action", "eventHash", "previousEventHash"])
      .where("entityType", "=", "teste")
      .orderBy("id", "asc")
      .execute();

    expect(rows).toHaveLength(3);
    expect(rows[0].eventHash).toBeTruthy();
    expect(rows[1].previousEventHash).toBe(rows[0].eventHash);
    expect(rows[2].previousEventHash).toBe(rows[1].eventHash);
    // audit_log é truncada entre testes — este é o primeiro evento da cadeia neste teste.
    expect(rows[0].previousEventHash).toBeNull();
  });

  it("computeAuditEventHash é determinístico para a mesma entrada", () => {
    const input = {
      organizationId: 1,
      actorUserId: 2,
      action: "teste.acao",
      entityType: "teste",
      entityId: "5",
      metadata: { chave: "valor" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      previousEventHash: "abc123",
    };
    expect(computeAuditEventHash(input)).toBe(computeAuditEventHash({ ...input }));
  });

  it("computeAuditEventHash muda se qualquer campo mudar", () => {
    const base = {
      organizationId: 1,
      actorUserId: 2,
      action: "teste.acao",
      entityType: "teste",
      entityId: "5",
      metadata: { chave: "valor" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      previousEventHash: "abc123",
    };
    const baseHash = computeAuditEventHash(base);
    expect(computeAuditEventHash({ ...base, action: "teste.outra_acao" })).not.toBe(baseHash);
    expect(computeAuditEventHash({ ...base, metadata: { chave: "outro_valor" } })).not.toBe(baseHash);
    expect(computeAuditEventHash({ ...base, previousEventHash: "outro_hash" })).not.toBe(baseHash);
  });

  it("computeAuditEventHash é insensível à ordem das chaves de metadata (JSONB não preserva ordem de inserção)", () => {
    const shared = { organizationId: 1, actorUserId: 2, action: "a", entityType: "t", entityId: null, createdAt: new Date(), previousEventHash: null };
    const ordemA = computeAuditEventHash({ ...shared, metadata: { nome: "Item X", statusAnterior: "aberta", statusNovo: "atendida" } });
    const ordemB = computeAuditEventHash({ ...shared, metadata: { statusNovo: "atendida", nome: "Item X", statusAnterior: "aberta" } });
    expect(ordemA).toBe(ordemB);
  });

  it("verifyAuditLogChain confirma integridade para um evento gravado com metadata de múltiplas chaves e lido de volta do banco (reproduz o bug real de ordenação de chaves do JSONB)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({
      organizationId: org.id,
      actorUserId: owner.userId,
      action: "organizacao.status_alterado_pela_plataforma",
      entityType: "organization",
      entityId: String(org.id),
      metadata: { name: org.name, statusAnterior: "em_analise", statusNovo: "ativa" },
    });

    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(true);
    expect(result.divergencias).toHaveLength(0);
  });

  it("verifyAuditLogChain confirma integridade quando nada foi alterado", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.integro", entityType: "teste" });

    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(true);
    expect(result.divergencias).toHaveLength(0);
    expect(result.eventosVerificados).toBeGreaterThan(0);
  });

  it("verifyAuditLogChain detecta um event_hash adulterado", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.sera_adulterado", entityType: "teste", entityId: "99" });

    const row = await db
      .selectFrom("auditLog")
      .select(["id"])
      .where("action", "=", "teste.sera_adulterado")
      .executeTakeFirstOrThrow();

    // audit_log é append-only (trigger bloqueia UPDATE) — simula adulteração
    // por acesso direto ao banco inserindo uma linha com hash inconsistente
    // diretamente (INSERT não é bloqueado pelo trigger, só UPDATE/DELETE),
    // exatamente o cenário que o hash encadeado existe para detectar.
    await db
      .insertInto("auditLog")
      .values({
        organizationId: org.id,
        actorUserId: owner.userId,
        action: "teste.linha_forjada",
        entityType: "teste",
        entityId: "forjado",
        metadata: {},
        previousEventHash: "hash-que-nao-bate-com-nada",
        eventHash: "hash-totalmente-inventado",
      })
      .execute();

    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(false);
    expect(result.divergencias.length).toBeGreaterThan(0);
    const idsComProblema = result.divergencias.map((d) => d.id);
    expect(idsComProblema).toContain(String(Number(row.id) + 1));
  });

  it("Fase 53 — caso 2: hash atual alterado isoladamente (previous_event_hash correto, event_hash forjado) é detectado como 'hash_nao_bate', nunca como quebra de predecessor", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.base_caso2", entityType: "teste" });

    const last = await db.selectFrom("auditLog").select(["eventHash"]).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();

    const [forged] = await db
      .insertInto("auditLog")
      .values({
        organizationId: org.id,
        actorUserId: owner.userId,
        action: "teste.hash_atual_forjado",
        entityType: "teste",
        entityId: "caso2",
        metadata: {},
        previousEventHash: last.eventHash, // correto — continua a cadeia de verdade
        eventHash: "hash-atual-forjado-nao-corresponde-ao-conteudo",
      })
      .returning(["id"])
      .execute();

    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(false);
    const divergencia = result.divergencias.find((d) => d.id === String(forged.id));
    expect(divergencia?.reason).toBe("hash_nao_bate");
  });

  it("Fase 53 — caso 3/6: previous_event_hash alterado (mas internamente consistente com o próprio event_hash) é detectado como quebra de predecessor, nunca como 'hash_nao_bate' da própria linha", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.base_caso3", entityType: "teste" });

    // previousEventHash forjado (não é o hash real do evento anterior), mas
    // o eventHash É calculado corretamente EM CIMA desse valor forjado —
    // a linha é "consistente consigo mesma", só desconectada da cadeia real.
    const fakeCreatedAt = new Date();
    const fakePreviousHash = "previous-hash-forjado-nao-e-o-real";
    const selfConsistentHash = computeAuditEventHash({
      organizationId: org.id,
      actorUserId: owner.userId,
      action: "teste.predecessor_forjado",
      entityType: "teste",
      entityId: "caso3",
      metadata: {},
      createdAt: fakeCreatedAt,
      previousEventHash: fakePreviousHash,
    });

    const [forged] = await db
      .insertInto("auditLog")
      .values({
        organizationId: org.id,
        actorUserId: owner.userId,
        action: "teste.predecessor_forjado",
        entityType: "teste",
        entityId: "caso3",
        metadata: {},
        createdAt: fakeCreatedAt,
        previousEventHash: fakePreviousHash,
        eventHash: selfConsistentHash,
      })
      .returning(["id"])
      .execute();

    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(false);
    const divergencia = result.divergencias.find((d) => d.id === String(forged.id));
    expect(divergencia?.reason).toBe("previous_hash_nao_bate_com_evento_anterior");
    // Nenhuma divergência "hash_nao_bate" para esta mesma linha — o hash
    // dela bate exatamente com o conteúdo dela, só o predecessor é falso.
    expect(result.divergencias.filter((d) => d.id === String(forged.id) && d.reason === "hash_nao_bate")).toHaveLength(0);
  });

  it("Fase 53 — caso 4: conteúdo coberto pelo hash alterado (metadata não corresponde ao que gerou o event_hash) é detectado como 'hash_nao_bate'", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.base_caso4", entityType: "teste" });

    const last = await db.selectFrom("auditLog").select(["eventHash"]).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    const createdAt = new Date();
    // Hash calculado para UM metadata, mas o conteúdo gravado é outro —
    // simula alteração do conteúdo coberto pelo hash (nunca possível via
    // UPDATE real, append-only bloqueia — só via INSERT direto forjado,
    // igual aos outros casos desta fase).
    const hashParaOutroConteudo = computeAuditEventHash({
      organizationId: org.id,
      actorUserId: owner.userId,
      action: "teste.conteudo_original",
      entityType: "teste",
      entityId: "caso4",
      metadata: { valorReal: true },
      createdAt,
      previousEventHash: last.eventHash,
    });

    const [forged] = await db
      .insertInto("auditLog")
      .values({
        organizationId: org.id,
        actorUserId: owner.userId,
        action: "teste.conteudo_adulterado", // conteúdo diferente do que gerou o hash acima
        entityType: "teste",
        entityId: "caso4",
        metadata: { valorReal: false },
        createdAt,
        previousEventHash: last.eventHash,
        eventHash: hashParaOutroConteudo,
      })
      .returning(["id"])
      .execute();

    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(false);
    const divergencia = result.divergencias.find((d) => d.id === String(forged.id));
    expect(divergencia?.reason).toBe("hash_nao_bate");
  });

  it("Fase 53 — caso 5: remoção de registro é estruturalmente impossível (não 'tratada pela verificação' — bloqueada antes disso, pelo próprio trigger append-only)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.nao_pode_ser_removido", entityType: "teste" });

    const row = await db.selectFrom("auditLog").select(["id"]).where("action", "=", "teste.nao_pode_ser_removido").executeTakeFirstOrThrow();

    await expect(db.deleteFrom("auditLog").where("id", "=", row.id).execute()).rejects.toThrow(/append-only/);

    // A linha continua lá e a cadeia continua íntegra — não há "remoção
    // tratada", porque não há remoção possível pela aplicação nenhuma.
    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(true);
  });

  it("linhas antigas sem event_hash (pré-migração) não contam como corrupção", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    // Simula uma linha gravada antes da migração 0003 (sem hash nenhum).
    await db
      .insertInto("auditLog")
      .values({
        organizationId: org.id,
        actorUserId: owner.userId,
        action: "teste.legado_sem_hash",
        entityType: "teste",
        metadata: {},
        previousEventHash: null,
        eventHash: null,
      })
      .execute();

    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.depois_do_legado", entityType: "teste" });

    const result = await verifyAuditLogChain();
    expect(result.integra).toBe(true);
    expect(result.eventosPreExistentesSemHash).toBeGreaterThan(0);
  });
});
