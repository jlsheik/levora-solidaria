import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postInvite } from "../src/endpoints/organization-invites_POST";
import { handle as getInvites } from "../src/endpoints/organization-invites_GET";
import { handle as postRevoke } from "../src/endpoints/organization-invites-revoke_POST";
import { handle as postAccept } from "../src/endpoints/organization-invites-accept_POST";
import { handle as getLookup } from "../src/endpoints/organization-invites-lookup_GET";
import { createAuthenticatedUser, createTestOrganization, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

function tokenFromAcceptUrl(acceptUrl: string): string {
  return acceptUrl.split("/convites/")[1];
}

describe("fluxo de convite de membro", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
  });

  it("proprietário cria um convite e recebe o link de aceite (SMTP não configurado no ambiente de teste)", async () => {
    const response = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "convidado@example.com", role: "operador" },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ invite: { status: string }; acceptUrl: string; emailSent: boolean }>(response);
    expect(data.invite.status).toBe("pendente");
    expect(data.acceptUrl).toContain("/convites/");
    expect(data.emailSent).toBe(false); // .env.test não tem SMTP configurado — nunca finge que enviou
  });

  it("recusa convidar quem já é membro ativo (409)", async () => {
    const response = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: owner.email, role: "operador" },
      })
    );
    expect(response.status).toBe(409);
  });

  it("apenas proprietário/administrador podem convidar (403 para operador)", async () => {
    const operatorUser = await createAuthenticatedUser();
    await db.insertInto("memberships").values({ organizationId: orgId, userId: operatorUser.userId, role: "operador", status: "ativo" }).execute();

    const response = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: operatorUser.cookie,
        body: { organizationId: orgId, email: "outra@example.com", role: "operador" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("pessoa convidada com conta e e-mail correspondente aceita e vira membro ativo", async () => {
    const inviteResponse = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "aceita@example.com", role: "voluntario" },
      })
    );
    const { acceptUrl } = await parseJson<{ acceptUrl: string }>(inviteResponse);
    const token = tokenFromAcceptUrl(acceptUrl);

    const lookupResponse = await getLookup(buildRequest(`organization-invites-lookup?token=${token}`));
    const lookupData = await parseJson<{ valid: boolean; organizationName: string; role: string }>(lookupResponse);
    expect(lookupData.valid).toBe(true);
    expect(lookupData.role).toBe("voluntario");

    const invitedPerson = await createAuthenticatedUser({ email: "aceita@example.com" });
    const acceptResponse = await postAccept(
      buildRequest("organization-invites-accept", { method: "POST", cookie: invitedPerson.cookie, body: { token } })
    );
    expect(acceptResponse.status).toBe(200);
    const acceptData = await parseJson<{ organizationId: number; role: string }>(acceptResponse);
    expect(acceptData.organizationId).toBe(orgId);
    expect(acceptData.role).toBe("voluntario");

    const membership = await db
      .selectFrom("memberships")
      .select(["role", "status"])
      .where("organizationId", "=", orgId)
      .where("userId", "=", invitedPerson.userId)
      .executeTakeFirstOrThrow();
    expect(membership.status).toBe("ativo");
    expect(membership.role).toBe("voluntario");

    const invite = await db
      .selectFrom("organizationInvites")
      .select(["status", "acceptedByUserId"])
      .where("organizationId", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(invite.status).toBe("aceito");
    expect(invite.acceptedByUserId).toBe(invitedPerson.userId);
  });

  it("recusa aceite quando a conta logada tem e-mail diferente do convite (403)", async () => {
    const inviteResponse = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "so-para-fulano@example.com", role: "operador" },
      })
    );
    const { acceptUrl } = await parseJson<{ acceptUrl: string }>(inviteResponse);
    const token = tokenFromAcceptUrl(acceptUrl);

    const outrapessoa = await createAuthenticatedUser({ email: "outra-pessoa@example.com" });
    const response = await postAccept(
      buildRequest("organization-invites-accept", { method: "POST", cookie: outrapessoa.cookie, body: { token } })
    );
    expect(response.status).toBe(403);

    const membership = await db
      .selectFrom("memberships")
      .select(["id"])
      .where("organizationId", "=", orgId)
      .where("userId", "=", outrapessoa.userId)
      .executeTakeFirst();
    expect(membership).toBeUndefined();
  });

  it("convite revogado não pode mais ser aceito", async () => {
    const inviteResponse = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "revogado@example.com", role: "operador" },
      })
    );
    const { invite, acceptUrl } = await parseJson<{ invite: { id: number }; acceptUrl: string }>(inviteResponse);
    const token = tokenFromAcceptUrl(acceptUrl);

    const revokeResponse = await postRevoke(
      buildRequest("organization-invites-revoke", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, inviteId: invite.id },
      })
    );
    expect(revokeResponse.status).toBe(200);

    const invitedPerson = await createAuthenticatedUser({ email: "revogado@example.com" });
    const acceptResponse = await postAccept(
      buildRequest("organization-invites-accept", { method: "POST", cookie: invitedPerson.cookie, body: { token } })
    );
    expect(acceptResponse.status).toBe(410);
  });

  it("convite expirado não pode ser aceito", async () => {
    const inviteResponse = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "expirado@example.com", role: "operador" },
      })
    );
    const { acceptUrl } = await parseJson<{ acceptUrl: string }>(inviteResponse);
    const token = tokenFromAcceptUrl(acceptUrl);

    await db
      .updateTable("organizationInvites")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("organizationId", "=", orgId)
      .execute();

    const invitedPerson = await createAuthenticatedUser({ email: "expirado@example.com" });
    const acceptResponse = await postAccept(
      buildRequest("organization-invites-accept", { method: "POST", cookie: invitedPerson.cookie, body: { token } })
    );
    expect(acceptResponse.status).toBe(410);

    // A expiração automática, como toda outra expiração automática do
    // sistema, deixa rastro em audit_log — não é só um UPDATE silencioso.
    const auditEntry = await db
      .selectFrom("auditLog")
      .select(["action", "organizationId"])
      .where("action", "=", "organizacao.convite_expirado_automaticamente")
      .where("organizationId", "=", orgId)
      .executeTakeFirst();
    expect(auditEntry).toBeDefined();
  });

  it("lista convites da organização, visível só para proprietário/administrador", async () => {
    await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "listado@example.com", role: "operador" },
      })
    );

    const response = await getInvites(buildRequest(`organization-invites?organizationId=${orgId}`, { cookie: owner.cookie }));
    expect(response.status).toBe(200);
    const data = await parseJson<{ invites: Array<{ email: string; status: string }> }>(response);
    expect(data.invites).toHaveLength(1);
    expect(data.invites[0].email).toBe("listado@example.com");

    const operatorUser = await createAuthenticatedUser();
    await db.insertInto("memberships").values({ organizationId: orgId, userId: operatorUser.userId, role: "operador", status: "ativo" }).execute();
    const forbiddenResponse = await getInvites(buildRequest(`organization-invites?organizationId=${orgId}`, { cookie: operatorUser.cookie }));
    expect(forbiddenResponse.status).toBe(403);
  });

  it("um novo convite para o mesmo e-mail revoga o pendente anterior automaticamente", async () => {
    await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "duplicado@example.com", role: "operador" },
      })
    );
    await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "duplicado@example.com", role: "administrador" },
      })
    );

    const rows = await db
      .selectFrom("organizationInvites")
      .select(["status", "role"])
      .where("organizationId", "=", orgId)
      .where("email", "=", "duplicado@example.com")
      .orderBy("createdAt", "asc")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("revogado");
    expect(rows[1].status).toBe("pendente");
    expect(rows[1].role).toBe("administrador");
  });

  it("bloqueia (429) criar muitos convites em pouco tempo, por usuário", async () => {
    for (let i = 0; i < 20; i++) {
      const response = await postInvite(
        buildRequest("organization-invites", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, email: `convidado-${i}@example.com`, role: "operador" },
        })
      );
      expect(response.status).toBe(200);
    }

    const blocked = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, email: "convidado-extra@example.com", role: "operador" },
      })
    );
    expect(blocked.status).toBe(429);
  });

  it("bloqueia (429) varredura de tokens no endpoint público de consulta de convite", async () => {
    const ip = "ip-varredura-token";
    for (let i = 0; i < 30; i++) {
      const response = await getLookup(buildRequest(`organization-invites-lookup?token=token-invalido-${i}`, { ip }));
      expect(response.status).toBe(200); // token inválido não é erro HTTP, é {valid:false}
    }

    const blocked = await getLookup(buildRequest(`organization-invites-lookup?token=mais-uma-tentativa`, { ip }));
    expect(blocked.status).toBe(429);
  });
});
