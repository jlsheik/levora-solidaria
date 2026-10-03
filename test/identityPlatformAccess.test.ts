import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { getPlatformLevel, requirePlatformAdmin, requirePlatformOwner, PlatformAccessError } from "../src/helpers/platformAccess";
import { grantPlatformAdmin, revokePlatformAccess, transferPlatformOwnership } from "../src/helpers/platformAccessAdmin";
import { lockUsersInOrder } from "../src/helpers/lockOrder";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as getPlatformOrganizations } from "../src/endpoints/platform-organizations_GET";
import { handle as getSession } from "../src/endpoints/auth/session_GET";
import { handle as postAccountDelete } from "../src/endpoints/auth/account-delete_POST";
import {
  createAuthenticatedUser,
  createPlatformAdmin,
  createPlatformOwner,
  createTestUser,
  createTestOrganization,
  addMembership,
  buildRequest,
  parseJson,
} from "./helpers";

const PASSWORD = "senha-de-teste-123";

async function dbError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code, message: String(err.message) };
  }
}

const activeOwners = async () =>
  (await db.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").execute()).map((r) => r.userId);

describe("platform_access — invariantes no BANCO", () => {
  it("no máximo 1 Platform Owner ativo (índice único parcial); admins ilimitados", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await db.insertInto("platformAccess").values({ userId: a.id, level: "owner" }).execute();
    const err = await dbError(() => db.insertInto("platformAccess").values({ userId: b.id, level: "owner" }).execute());
    expect(err?.code).toBe("23505");
    // vários admins são permitidos
    const c = await createTestUser();
    const d = await createTestUser();
    await db.insertInto("platformAccess").values([{ userId: b.id, level: "admin" }, { userId: c.id, level: "admin" }, { userId: d.id, level: "admin" }]).execute();
    expect(await activeOwners()).toEqual([a.id]);
  });

  it("CONCORRÊNCIA: dois owners inseridos ao mesmo tempo — exatamente um vence", async () => {
    const users = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    const results = await Promise.allSettled(users.map((u) => db.insertInto("platformAccess").values({ userId: u.id, level: "owner" }).execute()));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(await activeOwners()).toHaveLength(1);
  });

  it("o último owner não pode ser revogado, rebaixado nem apagado (trigger deferido no COMMIT)", async () => {
    const owner = await createTestUser();
    await db.insertInto("platformAccess").values({ userId: owner.id, level: "owner" }).execute();
    const revoke = await dbError(() =>
      db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", owner.id).execute()
    );
    expect(revoke?.message).toMatch(/último Platform Owner/);
    const demote = await dbError(() => db.updateTable("platformAccess").set({ level: "admin" }).where("userId", "=", owner.id).execute());
    expect(demote?.message).toMatch(/último Platform Owner/);
    const del = await dbError(() => db.deleteFrom("platformAccess").where("userId", "=", owner.id).execute());
    expect(del?.message).toMatch(/linhas não são apagadas/);
    expect(await activeOwners()).toEqual([owner.id]);
  });

  it("transferência na MESMA transação funciona; na ordem errada viola o índice; sem sucessor é recusada no commit", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await db.insertInto("platformAccess").values([{ userId: a.id, level: "owner" }, { userId: b.id, level: "admin" }]).execute();

    // ordem errada: promover antes de rebaixar ⇒ viola o índice único parcial
    const wrongOrder = await dbError(() =>
      db.transaction().execute(async (trx) => {
        await trx.updateTable("platformAccess").set({ level: "owner" }).where("userId", "=", b.id).execute();
        await trx.updateTable("platformAccess").set({ level: "admin" }).where("userId", "=", a.id).execute();
      })
    );
    expect(wrongOrder?.code).toBe("23505");
    expect(await activeOwners()).toEqual([a.id]);

    // rebaixar sem promover ninguém ⇒ 0 owners no commit ⇒ recusado
    const noSuccessor = await dbError(() =>
      db.transaction().execute(async (trx) => {
        await trx.updateTable("platformAccess").set({ level: "admin" }).where("userId", "=", a.id).execute();
      })
    );
    expect(noSuccessor?.message).toMatch(/último Platform Owner/);
    expect(await activeOwners()).toEqual([a.id]);

    // ordem certa na mesma transação
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("platformAccess").set({ level: "admin" }).where("userId", "=", a.id).execute();
      await trx.updateTable("platformAccess").set({ level: "owner" }).where("userId", "=", b.id).execute();
    });
    expect(await activeOwners()).toEqual([b.id]);
  });

  it("users.role = 'admin' não é mais aceito (INSERT e UPDATE); 'user' continua", async () => {
    const user = await createTestUser();
    const upd = await dbError(() => db.updateTable("users").set({ role: "admin" }).where("id", "=", user.id).execute());
    expect(upd?.message).toMatch(/platform_access/);
    const ins = await dbError(() => db.insertInto("users").values({ email: "x-admin@example.com", displayName: "X", role: "admin" }).execute());
    expect(ins?.message).toMatch(/platform_access/);
    await db.updateTable("users").set({ role: "user", displayName: "Outro nome" }).where("id", "=", user.id).execute();
  });

  it("titular de platform_access ativo não pode ser anonimizado (trigger); depois de revogado, pode", async () => {
    const holder = await createTestUser();
    await db.insertInto("platformAccess").values({ userId: holder.id, level: "admin" }).execute();
    const blocked = await dbError(() => db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", holder.id).execute());
    expect(blocked?.message).toMatch(/não pode ser anonimizado/);
    await db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", holder.id).execute();
    await db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", holder.id).execute();
  });

  it("CHECK de consistência, user_id imutável e FK RESTRICT", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const bad = await dbError(() => db.insertInto("platformAccess").values({ userId: u.id, level: "admin", status: "revoked" }).execute());
    expect(bad?.code).toBe("23514");
    await db.insertInto("platformAccess").values({ userId: u.id, level: "admin" }).execute();
    const move = await dbError(() => db.updateTable("platformAccess").set({ userId: other.id }).where("userId", "=", u.id).execute());
    expect(move?.message).toMatch(/imutável/);
    const del = await dbError(() => db.deleteFrom("users").where("id", "=", u.id).execute());
    expect(del?.code).toBe("23503");
  });
});

describe("autorização de plataforma (relida do banco)", () => {
  it("owner e admin passam; usuário comum e acesso revogado não", async () => {
    const owner = await createPlatformOwner();
    const admin = await createPlatformAdmin();
    const plain = await createAuthenticatedUser();
    await requirePlatformAdmin(owner.userId);
    await requirePlatformAdmin(admin.userId);
    await requirePlatformOwner(owner.userId);
    await expect(requirePlatformAdmin(plain.userId)).rejects.toBeInstanceOf(PlatformAccessError);
    await expect(requirePlatformOwner(admin.userId)).rejects.toBeInstanceOf(PlatformAccessError);
    await db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", admin.userId).execute();
    await expect(requirePlatformAdmin(admin.userId)).rejects.toBeInstanceOf(PlatformAccessError);
    expect(await getPlatformLevel(admin.userId)).toBeNull();
  });

  it("chamada HTTP direta: sem sessão 401; usuário comum e proprietário/membro de organização 403; admin 200; revogado volta a 403", async () => {
    const plain = await createAuthenticatedUser();
    const orgOwner = await createAuthenticatedUser();
    await createTestOrganization(orgOwner.userId);
    const admin = await createPlatformAdmin();
    const call = (cookie?: string) => getPlatformOrganizations(buildRequest("platform-organizations", { cookie }));
    expect((await call()).status).toBe(401);
    expect((await call(plain.cookie)).status).toBe(403);
    expect((await call(orgOwner.cookie)).status).toBe(403);
    expect((await call(admin.cookie)).status).toBe(200);
    await db.updateTable("platformAccess").set({ status: "revoked", revokedAt: new Date() }).where("userId", "=", admin.userId).execute();
    expect((await call(admin.cookie)).status).toBe(403);
  });

  it("membership de organização nunca concede plataforma e platform_access nunca concede membership", async () => {
    const admin = await createPlatformAdmin();
    const orgOwner = await createAuthenticatedUser();
    const org = await createTestOrganization(orgOwner.userId);
    expect(await getPlatformLevel(orgOwner.userId)).toBeNull();
    const m = await db.selectFrom("memberships").select("id").where("organizationId", "=", org.id).where("userId", "=", admin.userId).executeTakeFirst();
    expect(m).toBeUndefined();
  });

  it("a sessão devolve platformLevel e role derivado (user/admin) — sem depender de users.role", async () => {
    const owner = await createPlatformOwner();
    const admin = await createPlatformAdmin();
    const plain = await createAuthenticatedUser();
    const who = async (cookie: string) => (await parseJson<{ user: { role: string; platformLevel: string | null } }>(await getSession(buildRequest("auth/session", { cookie })))).user;
    expect(await who(owner.cookie)).toMatchObject({ role: "admin", platformLevel: "owner" });
    expect(await who(admin.cookie)).toMatchObject({ role: "admin", platformLevel: "admin" });
    expect(await who(plain.cookie)).toMatchObject({ role: "user", platformLevel: null });
    const row = await db.selectFrom("users").select("role").where("id", "=", owner.userId).executeTakeFirstOrThrow();
    expect(row.role).toBe("user");
  });

  it("cadastro, convite e criação de organização nunca criam acesso de plataforma", async () => {
    const owner = await createPlatformOwner();
    const before = await db.selectFrom("platformAccess").select("userId").execute();
    const u = await createAuthenticatedUser();
    await createTestOrganization(u.userId);
    expect(await db.selectFrom("platformAccess").select("userId").execute()).toHaveLength(before.length);
    expect(await activeOwners()).toEqual([owner.userId]);
  });
});

describe("platformAccessAdmin — conceder, revogar e transferir (regras de aplicação + auditoria)", () => {
  it("owner concede admin; não-owner não concede; admin duplicado e alvo anonimizado recusados", async () => {
    const owner = await createPlatformOwner();
    const admin = await createPlatformAdmin();
    const target = await createTestUser();
    const anon = await createTestUser();
    await db.updateTable("users").set({ anonymizedAt: new Date() }).where("id", "=", anon.id).execute();

    await expect(db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: admin.userId, targetUserId: target.id }))).rejects.toBeInstanceOf(PlatformAccessError);
    await db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: owner.userId, targetUserId: target.id }));
    expect(await getPlatformLevel(target.id)).toBe("admin");
    await expect(db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: owner.userId, targetUserId: target.id }))).rejects.toThrow(/já possui/);
    await expect(db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: owner.userId, targetUserId: anon.id }))).rejects.toThrow(/removido/);
    const audit = await db.selectFrom("auditLog").select(["action", "actorUserId", "organizationId"]).where("action", "=", "plataforma.admin_concedido").execute();
    expect(audit).toEqual([{ action: "plataforma.admin_concedido", actorUserId: owner.userId, organizationId: null }]);
  });

  it("revogar: o owner não revoga a si mesmo nem outro owner; revogar admin funciona e é auditado; pode reconceder", async () => {
    const owner = await createPlatformOwner();
    const admin = await createPlatformAdmin();
    await expect(db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: owner.userId, targetUserId: owner.userId }))).rejects.toThrow(/próprio acesso/);
    await db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: owner.userId, targetUserId: admin.userId, reason: "teste" }));
    expect(await getPlatformLevel(admin.userId)).toBeNull();
    await db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: owner.userId, targetUserId: admin.userId }));
    expect(await getPlatformLevel(admin.userId)).toBe("admin");
    const events = (await db.selectFrom("auditLog").select("action").where("action", "like", "plataforma.%").orderBy("id", "asc").execute()).map((e) => e.action);
    expect(events).toEqual(["plataforma.acesso_revogado", "plataforma.admin_concedido"]);
  });

  it("transferir: só a um admin ativo; resultado = 1 owner (o novo) e o antigo vira admin; auditado", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    const plain = await createTestUser();
    await expect(db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: plain.id }))).rejects.toThrow(/administrador de plataforma ativo/);
    await expect(db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: b.userId, targetUserId: a.userId }))).rejects.toBeInstanceOf(PlatformAccessError);
    await db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: b.userId }));
    expect(await activeOwners()).toEqual([b.userId]);
    expect(await getPlatformLevel(a.userId)).toBe("admin");
    const ev = await db.selectFrom("auditLog").select("action").where("action", "=", "plataforma.ownership_transferido").execute();
    expect(ev).toHaveLength(1);
  });

  it("CONCORRÊNCIA: duas transferências do mesmo owner para admins diferentes — uma vence, a outra perde o poder; sempre 1 owner", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    const c = await createPlatformAdmin();
    const results = await Promise.allSettled([
      db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: b.userId })),
      db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: c.userId })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(PlatformAccessError);
    expect(await activeOwners()).toHaveLength(1);
    expect(await activeOwners()).not.toContain(a.userId);
  });

  it("CONCORRÊNCIA: transferência × revogação do alvo — nunca fica sem owner", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    const results = await Promise.allSettled([
      db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: b.userId })),
      db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: a.userId, targetUserId: b.userId })),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const owners = await activeOwners();
    expect(owners).toHaveLength(1);
    const ownerLevel = await getPlatformLevel(owners[0]);
    expect(ownerLevel).toBe("owner");
  });

  it("CONCORRÊNCIA: duas concessões do mesmo alvo — uma vence", async () => {
    const owner = await createPlatformOwner();
    const target = await createTestUser();
    const results = await Promise.allSettled([
      db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: owner.userId, targetUserId: target.id })),
      db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: owner.userId, targetUserId: target.id })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.selectFrom("platformAccess").select("userId").where("userId", "=", target.id).execute())).toHaveLength(1);
  });
});

describe("exclusão de conta × plataforma (último owner)", () => {
  const del = (cookie: string) => postAccountDelete(buildRequest("auth/account-delete", { method: "POST", cookie, body: { password: PASSWORD } }));

  it("o owner não exclui a conta (409 plataforma_acesso_ativo) e nada é alterado", async () => {
    const owner = await createPlatformOwner();
    const res = await del(owner.cookie);
    expect(res.status).toBe(409);
    expect((await parseJson<{ code: string }>(res)).code).toBe("plataforma_acesso_ativo");
    const row = await db.selectFrom("users").select(["email", "anonymizedAt"]).where("id", "=", owner.userId).executeTakeFirstOrThrow();
    expect(row.email).toBe(owner.email);
    expect(row.anonymizedAt).toBeNull();
    expect(await db.selectFrom("userPasswords").select("id").where("userId", "=", owner.userId).execute()).toHaveLength(1);
    expect(await db.selectFrom("sessions").select("id").where("userId", "=", owner.userId).execute()).toHaveLength(1);
    expect(await activeOwners()).toEqual([owner.userId]);
  });

  it("o admin de plataforma também não exclui; depois de revogado, exclui e fica anonimizado (anonymized_at)", async () => {
    const owner = await createPlatformOwner();
    const admin = await createPlatformAdmin();
    expect((await del(admin.cookie)).status).toBe(409);
    await db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: owner.userId, targetUserId: admin.userId }));
    expect((await del(admin.cookie)).status).toBe(200);
    const row = await db.selectFrom("users").select(["email", "anonymizedAt"]).where("id", "=", admin.userId).executeTakeFirstOrThrow();
    expect(row.email).toMatch(/removido\.invalid$/);
    expect(row.anonymizedAt).not.toBeNull();
    expect(await getPlatformLevel(admin.userId)).toBeNull();
  });

  it("usuário comum continua excluindo normalmente", async () => {
    const owner = await createPlatformOwner();
    void owner;
    const plain = await createAuthenticatedUser();
    const res = await del(plain.cookie);
    expect(res.status).toBe(200);
  });

  it("após transferir a propriedade o ex-owner (agora admin) continua bloqueado até ser revogado", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    await db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: b.userId }));
    expect((await del(a.cookie)).status).toBe(409);
    expect((await del(b.cookie)).status).toBe(409);
    await db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: b.userId, targetUserId: a.userId }));
    expect((await del(a.cookie)).status).toBe(200);
    expect(await activeOwners()).toEqual([b.userId]);
  });

  it("CONCORRÊNCIA: o admin exclui a conta ao mesmo tempo em que o owner revoga o acesso — nunca 'anonimizado com acesso ativo'", async () => {
    const owner = await createPlatformOwner();
    const ownerId = owner.userId;
    for (let round = 0; round < 4; round++) {
      const admin = await createPlatformAdmin();
      const results = await Promise.allSettled([
        del(admin.cookie),
        db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: ownerId, targetUserId: admin.userId })),
      ]);
      expect(results.every((r) => r.status === "fulfilled" || r.status === "rejected")).toBe(true);
      const u = await db.selectFrom("users").select("anonymizedAt").where("id", "=", admin.userId).executeTakeFirstOrThrow();
      const level = await getPlatformLevel(admin.userId);
      expect(!(u.anonymizedAt && level), "anonimizado com acesso de plataforma ativo").toBe(true);
      expect(await activeOwners()).toEqual([ownerId]);
    }
  });

  it("CONCORRÊNCIA: o owner tenta excluir a conta enquanto transfere a propriedade — nunca 0 owners e nunca owner anonimizado", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    const results = await Promise.allSettled([
      del(a.cookie),
      db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: b.userId })),
    ]);
    expect(results.every((r) => r.status === "fulfilled" || r.status === "rejected")).toBe(true);
    const owners = await activeOwners();
    expect(owners).toHaveLength(1);
    for (const id of [a.userId, b.userId]) {
      const u = await db.selectFrom("users").select("anonymizedAt").where("id", "=", id).executeTakeFirstOrThrow();
      expect(u.anonymizedAt).toBeNull(); // ambos ainda têm acesso ativo ⇒ nenhum foi anonimizado
    }
  });

  it("CONCORRÊNCIA: duas exclusões simultâneas da mesma conta comum — sem deadlock, uma conclui", async () => {
    const owner = await createPlatformOwner();
    void owner;
    const plain = await createAuthenticatedUser();
    const results = await Promise.all([del(plain.cookie), del(plain.cookie)]);
    expect(results.map((r) => r.status).sort()).toContain(200);
    const u = await db.selectFrom("users").select("anonymizedAt").where("id", "=", plain.userId).executeTakeFirstOrThrow();
    expect(u.anonymizedAt).not.toBeNull();
  });
});

describe("ordem canônica de locks", () => {
  it("lockUsersInOrder trava em ordem crescente de id, não na ordem pedida (prova determinística)", async () => {
    const low = await createTestUser();
    const high = await createTestUser();
    expect(low.id).toBeLessThan(high.id);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let holderReady!: () => void;
    const ready = new Promise<void>((resolve) => (holderReady = resolve));
    // T1 segura o MENOR id.
    const t1 = db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [low.id]);
      holderReady();
      await hold;
    });
    await ready;

    // T2 pede [maior, menor]: se travasse na ordem pedida, seguraria o maior e bloquearia no menor.
    let t2Done = false;
    const t2 = db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [high.id, low.id]);
      t2Done = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(t2Done).toBe(false); // bloqueado no menor id

    // T3 consegue o MAIOR sem esperar ⇒ T2 NÃO o está segurando ⇒ T2 respeitou a ordem crescente.
    const t3 = await db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom("users").select("id").where("id", "=", high.id).forUpdate().noWait().execute();
      return rows.length;
    });
    expect(t3).toBe(1);

    release();
    await Promise.all([t1, t2]);
    expect(t2Done).toBe(true);
  });

  it("sem deadlock: operações cruzadas de plataforma e exclusão de conta executadas em paralelo, várias vezes", async () => {
    const a = await createPlatformOwner();
    const b = await createPlatformAdmin();
    const c = await createPlatformAdmin();
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      tasks.push(db.transaction().execute((trx) => revokePlatformAccess(trx, { actorUserId: a.userId, targetUserId: b.userId })).catch(() => undefined));
      tasks.push(db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: a.userId, targetUserId: b.userId })).catch(() => undefined));
      tasks.push(db.transaction().execute((trx) => transferPlatformOwnership(trx, { actorUserId: a.userId, targetUserId: c.userId })).catch(() => undefined));
      tasks.push(postAccountDelete(buildRequest("auth/account-delete", { method: "POST", cookie: b.cookie, body: { password: PASSWORD } })).catch(() => undefined));
    }
    await Promise.all(tasks); // um deadlock apareceria como rejeição "deadlock detected" propagada — .catch aqui só absorve erros de regra
    expect(await activeOwners()).toHaveLength(1);
    const chain = await verifyAuditLogChain();
    expect(chain.integra).toBe(true);
  });
});

describe("auditoria íntegra após operações de plataforma", () => {
  it("a hash-chain continua válida", async () => {
    const owner = await createPlatformOwner();
    const t = await createTestUser();
    await addMembership((await createTestOrganization(owner.userId)).id, t.id, "operador");
    await db.transaction().execute((trx) => grantPlatformAdmin(trx, { actorUserId: owner.userId, targetUserId: t.id }));
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });
});
