import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postAccountDelete } from "../src/endpoints/auth/account-delete_POST";
import { createAuthenticatedUser, createTestOrganization, addMembership, buildRequest, parseJson } from "./helpers";

const TEST_PASSWORD = "senha-de-teste-123"; // ver test/helpers.ts#createTestUser

describe("exclusão de conta (LGPD)", () => {
  it("anonimiza o usuário, remove senha/sessões e inativa memberships", async () => {
    const user = await createAuthenticatedUser();
    const org = await createTestOrganization(user.userId); // vira proprietário

    // Precisa não ser o único proprietário para poder excluir — adiciona um segundo.
    const secondOwner = await createAuthenticatedUser();
    await addMembership(org.id, secondOwner.userId, "proprietario");

    const response = await postAccountDelete(
      buildRequest("auth/account-delete", { method: "POST", cookie: user.cookie, body: { password: TEST_PASSWORD } })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0"); // sessão limpa

    const updatedUser = await db.selectFrom("users").select(["email", "displayName", "avatarUrl"]).where("id", "=", user.userId).executeTakeFirstOrThrow();
    expect(updatedUser.displayName).toBe("Usuário removido");
    expect(updatedUser.email).toBe(`usuario-excluido-${user.userId}@removido.invalid`);
    expect(updatedUser.avatarUrl).toBeNull();

    const password = await db.selectFrom("userPasswords").select(["id"]).where("userId", "=", user.userId).executeTakeFirst();
    expect(password).toBeUndefined();

    const sessions = await db.selectFrom("sessions").select(["id"]).where("userId", "=", user.userId).execute();
    expect(sessions).toHaveLength(0);

    const membership = await db.selectFrom("memberships").select(["status"]).where("organizationId", "=", org.id).where("userId", "=", user.userId).executeTakeFirstOrThrow();
    expect(membership.status).toBe("inativo");

    const auditEntry = await db
      .selectFrom("auditLog")
      .select(["action", "actorUserId"])
      .where("entityType", "=", "user")
      .where("entityId", "=", String(user.userId))
      .executeTakeFirst();
    expect(auditEntry?.action).toBe("usuario.conta_excluida");
    expect(auditEntry?.actorUserId).toBe(user.userId);
  });

  it("recusa (401) com senha incorreta e não altera nada", async () => {
    const user = await createAuthenticatedUser();

    const response = await postAccountDelete(
      buildRequest("auth/account-delete", { method: "POST", cookie: user.cookie, body: { password: "senha-completamente-errada" } })
    );
    expect(response.status).toBe(401);

    const stillThere = await db.selectFrom("userPasswords").select(["id"]).where("userId", "=", user.userId).executeTakeFirst();
    expect(stillThere).toBeDefined();
  });

  it("bloqueia (409) exclusão quando o usuário é o único proprietário ativo de uma organização", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    const response = await postAccountDelete(
      buildRequest("auth/account-delete", { method: "POST", cookie: owner.cookie, body: { password: TEST_PASSWORD } })
    );
    expect(response.status).toBe(409);
    const data = await parseJson<{ message: string }>(response);
    expect(data.message).toContain(org.name);

    const stillActive = await db.selectFrom("users").select(["email"]).where("id", "=", owner.userId).executeTakeFirstOrThrow();
    expect(stillActive.email).toBe(owner.email); // não foi anonimizado
  });

  it("permite excluir quando outro proprietário ativo assume a organização", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const otherOwner = await createAuthenticatedUser();
    await addMembership(org.id, otherOwner.userId, "proprietario");

    const response = await postAccountDelete(
      buildRequest("auth/account-delete", { method: "POST", cookie: owner.cookie, body: { password: TEST_PASSWORD } })
    );
    expect(response.status).toBe(200);
  });

  it("não é bloqueado por ser proprietário de uma organização onde o outro proprietário está inativo (não conta)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const inactiveOwner = await createAuthenticatedUser();
    await addMembership(org.id, inactiveOwner.userId, "proprietario", "inativo");

    const response = await postAccountDelete(
      buildRequest("auth/account-delete", { method: "POST", cookie: owner.cookie, body: { password: TEST_PASSWORD } })
    );
    expect(response.status).toBe(409); // inactiveOwner não conta como proprietário ativo
  });
});
