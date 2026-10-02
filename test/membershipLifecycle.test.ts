import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postRole } from "../src/endpoints/organization-members-role_POST";
import { handle as postDeactivate } from "../src/endpoints/organization-members-deactivate_POST";
import { handle as postLeave } from "../src/endpoints/organization-members-leave_POST";
import { handle as postInvite } from "../src/endpoints/organization-invites_POST";
import { handle as postAccept } from "../src/endpoints/organization-invites-accept_POST";
import { handle as getMembers } from "../src/endpoints/organization-members_GET";
import { handle as getOrganizations } from "../src/endpoints/organizations_GET";
import { handle as getAuditLog } from "../src/endpoints/audit-log_GET";
import { handle as postAccountDelete } from "../src/endpoints/auth/account-delete_POST";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { resetAllRateLimitsForTests } from "../src/helpers/rateLimit";
import type { MembershipRole } from "../src/helpers/schema";
import {
  createAuthenticatedUser,
  createTestOrganization,
  addMembership,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";

async function membershipOf(orgId: number, userId: number) {
  return db
    .selectFrom("memberships")
    .select(["id", "role", "status"])
    .where("organizationId", "=", orgId)
    .where("userId", "=", userId)
    .executeTakeFirstOrThrow();
}

async function addMember(orgId: number, role: MembershipRole, status: "ativo" | "inativo" = "ativo") {
  const person = await createAuthenticatedUser();
  await addMembership(orgId, person.userId, role, status);
  const membership = await membershipOf(orgId, person.userId);
  return { ...person, membershipId: membership.id };
}

function callRole(actor: AuthenticatedTestUser, orgId: number, membershipId: number, role: MembershipRole) {
  return postRole(
    buildRequest("organization-members-role", {
      method: "POST",
      cookie: actor.cookie,
      body: { organizationId: orgId, membershipId, role },
    })
  );
}

function callDeactivate(actor: AuthenticatedTestUser, orgId: number, membershipId: number) {
  return postDeactivate(
    buildRequest("organization-members-deactivate", {
      method: "POST",
      cookie: actor.cookie,
      body: { organizationId: orgId, membershipId },
    })
  );
}

function callLeave(actor: AuthenticatedTestUser, orgId: number) {
  return postLeave(
    buildRequest("organization-members-leave", { method: "POST", cookie: actor.cookie, body: { organizationId: orgId } })
  );
}

async function auditActions(orgId: number): Promise<string[]> {
  const rows = await db
    .selectFrom("auditLog")
    .select("action")
    .where("organizationId", "=", orgId)
    .where("action", "like", "organizacao.membro_%")
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => row.action);
}

describe("ciclo de vida dos membros da organização", () => {
  let owner: AuthenticatedTestUser;
  let ownerMembershipId: number;
  let orgId: number;

  beforeEach(async () => {
    resetAllRateLimitsForTests();
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
    ownerMembershipId = (await membershipOf(orgId, owner.userId)).id;
  });

  describe("alterar papel", () => {
    it("proprietário altera papel de voluntário para operador e a mudança é auditada sem dado pessoal", async () => {
      const member = await addMember(orgId, "voluntario");
      const response = await callRole(owner, orgId, member.membershipId, "operador");
      expect(response.status).toBe(200);
      expect((await membershipOf(orgId, member.userId)).role).toBe("operador");

      const audit = await db
        .selectFrom("auditLog")
        .select(["action", "metadata", "actorUserId"])
        .where("organizationId", "=", orgId)
        .where("action", "=", "organizacao.membro_papel_alterado")
        .executeTakeFirstOrThrow();
      expect(audit.actorUserId).toBe(owner.userId);
      expect(audit.metadata).toEqual({ alvoUserId: member.userId, papelAnterior: "voluntario", papelNovo: "operador" });
      expect(JSON.stringify(audit.metadata)).not.toContain("@");
    });

    it("voluntário e operador não podem alterar papel de ninguém (403)", async () => {
      const target = await addMember(orgId, "voluntario");
      const operator = await addMember(orgId, "operador");
      const volunteer = await addMember(orgId, "voluntario");
      expect((await callRole(operator, orgId, target.membershipId, "operador")).status).toBe(403);
      expect((await callRole(volunteer, orgId, target.membershipId, "operador")).status).toBe(403);
      expect((await membershipOf(orgId, target.userId)).role).toBe("voluntario");
    });

    it("administrador altera operador e outro administrador, mas nunca toca em proprietário nem promove a proprietário", async () => {
      const admin = await addMember(orgId, "administrador");
      const operator = await addMember(orgId, "operador");
      const otherAdmin = await addMember(orgId, "administrador");

      expect((await callRole(admin, orgId, operator.membershipId, "administrador")).status).toBe(200);
      expect((await callRole(admin, orgId, otherAdmin.membershipId, "operador")).status).toBe(200);

      const onOwner = await callRole(admin, orgId, ownerMembershipId, "operador");
      expect(onOwner.status).toBe(403);
      expect((await parseJson<{ message: string }>(onOwner)).message).toContain("proprietários");

      const toOwner = await callRole(admin, orgId, operator.membershipId, "proprietario");
      expect(toOwner.status).toBe(403);
      expect((await membershipOf(orgId, owner.userId)).role).toBe("proprietario");
    });

    it("proprietário promove outro a proprietário e então pode se rebaixar (transferência de propriedade)", async () => {
      const successor = await addMember(orgId, "administrador");
      expect((await callRole(owner, orgId, successor.membershipId, "proprietario")).status).toBe(200);
      expect((await callRole(owner, orgId, ownerMembershipId, "administrador")).status).toBe(200);
      expect((await membershipOf(orgId, owner.userId)).role).toBe("administrador");
      expect((await membershipOf(orgId, successor.userId)).role).toBe("proprietario");
    });

    it("I1: único proprietário não pode se rebaixar (409)", async () => {
      const response = await callRole(owner, orgId, ownerMembershipId, "administrador");
      expect(response.status).toBe(409);
      expect((await parseJson<{ message: string }>(response)).message).toContain("ao menos um proprietário");
      expect((await membershipOf(orgId, owner.userId)).role).toBe("proprietario");
    });

    it("auto-alteração só para baixo: administrador não se promove (409)", async () => {
      const admin = await addMember(orgId, "administrador");
      const response = await callRole(admin, orgId, admin.membershipId, "proprietario");
      expect(response.status).toBe(403);
      const down = await callRole(admin, orgId, admin.membershipId, "operador");
      expect(down.status).toBe(200);
    });

    it("mesmo papel (409) e alvo inativo (409)", async () => {
      const member = await addMember(orgId, "operador");
      expect((await callRole(owner, orgId, member.membershipId, "operador")).status).toBe(409);
      const former = await addMember(orgId, "operador", "inativo");
      expect((await callRole(owner, orgId, former.membershipId, "voluntario")).status).toBe(409);
    });

    it("isolamento: membershipId de outra organização é 404 e nada muda", async () => {
      const otherOwner = await createAuthenticatedUser();
      const otherOrg = await createTestOrganization(otherOwner.userId);
      const outsider = await addMember(otherOrg.id, "voluntario");
      const response = await callRole(owner, orgId, outsider.membershipId, "operador");
      expect(response.status).toBe(404);
      expect((await membershipOf(otherOrg.id, outsider.userId)).role).toBe("voluntario");
    });

    it("organização em análise ou suspensa recusa alteração (403)", async () => {
      const pendingOrg = await createTestOrganization(owner.userId, { status: "em_analise" });
      const member = await addMember(pendingOrg.id, "voluntario");
      expect((await callRole(owner, pendingOrg.id, member.membershipId, "operador")).status).toBe(403);
    });

    it("operações recusadas não geram evento de auditoria", async () => {
      await callRole(owner, orgId, ownerMembershipId, "administrador");
      expect(await auditActions(orgId)).toEqual([]);
    });
  });

  describe("desativar membro", () => {
    it("administrador desativa operador; histórico preservado e efeito imediato (403 + some da lista)", async () => {
      const admin = await addMember(orgId, "administrador");
      const operator = await addMember(orgId, "operador");

      const response = await callDeactivate(admin, orgId, operator.membershipId);
      expect(response.status).toBe(200);
      expect((await membershipOf(orgId, operator.userId)).status).toBe("inativo");

      const stillThere = await db.selectFrom("memberships").select("id").where("id", "=", operator.membershipId).executeTakeFirst();
      expect(stillThere).toBeDefined();

      const afterAccess = await getMembers(
        buildRequest(`organization-members?organizationId=${orgId}`, { cookie: operator.cookie })
      );
      expect(afterAccess.status).toBe(403);

      const orgList = await getOrganizations(buildRequest("organizations", { cookie: operator.cookie }));
      const orgs = await parseJson<{ organizations: Array<{ id: number }> }>(orgList);
      expect(orgs.organizations.map((o) => o.id)).not.toContain(orgId);

      expect(await auditActions(orgId)).toEqual(["organizacao.membro_desativado"]);
    });

    it("não pode desativar a si mesmo (409) nem alvo já inativo (409)", async () => {
      const admin = await addMember(orgId, "administrador");
      expect((await callDeactivate(admin, orgId, admin.membershipId)).status).toBe(409);
      const former = await addMember(orgId, "voluntario", "inativo");
      expect((await callDeactivate(admin, orgId, former.membershipId)).status).toBe(409);
    });

    it("administrador não desativa proprietário (403); proprietário só desativa outro se sobrar um (409/200)", async () => {
      const admin = await addMember(orgId, "administrador");
      expect((await callDeactivate(admin, orgId, ownerMembershipId)).status).toBe(403);

      const coOwner = await addMember(orgId, "proprietario");
      expect((await callDeactivate(owner, orgId, coOwner.membershipId)).status).toBe(200);

      const secondCoOwner = await addMember(orgId, "proprietario");
      // dois ativos agora (owner + secondCoOwner): desativar um é permitido; o último não.
      expect((await callDeactivate(secondCoOwner, orgId, ownerMembershipId)).status).toBe(200);
      expect((await membershipOf(orgId, secondCoOwner.userId)).status).toBe("ativo");
    });

    it("operador e voluntário não desativam ninguém (403)", async () => {
      const operator = await addMember(orgId, "operador");
      const target = await addMember(orgId, "voluntario");
      expect((await callDeactivate(operator, orgId, target.membershipId)).status).toBe(403);
    });

    it("sessão do usuário continua válida para outra organização", async () => {
      const operator = await addMember(orgId, "operador");
      const otherOwner = await createAuthenticatedUser();
      const otherOrg = await createTestOrganization(otherOwner.userId);
      await addMembership(otherOrg.id, operator.userId, "voluntario");

      await callDeactivate(owner, orgId, operator.membershipId);

      const orgList = await getOrganizations(buildRequest("organizations", { cookie: operator.cookie }));
      expect(orgList.status).toBe(200);
      const orgs = await parseJson<{ organizations: Array<{ id: number }> }>(orgList);
      expect(orgs.organizations.map((o) => o.id)).toEqual([otherOrg.id]);
    });
  });

  describe("sair da organização", () => {
    it("qualquer papel não proprietário sai; auditoria registra membro_saiu pelo próprio membro", async () => {
      for (const role of ["administrador", "operador", "voluntario"] as const) {
        const member = await addMember(orgId, role);
        const response = await callLeave(member, orgId);
        expect(response.status).toBe(200);
        expect((await membershipOf(orgId, member.userId)).status).toBe("inativo");
      }
      expect((await auditActions(orgId)).filter((a) => a === "organizacao.membro_saiu")).toHaveLength(3);
    });

    it("I1: único proprietário não sai (409); com co-proprietário sai", async () => {
      const blocked = await callLeave(owner, orgId);
      expect(blocked.status).toBe(409);
      expect((await membershipOf(orgId, owner.userId)).status).toBe("ativo");

      await addMember(orgId, "proprietario");
      expect((await callLeave(owner, orgId)).status).toBe(200);
      expect((await membershipOf(orgId, owner.userId)).status).toBe("inativo");
    });

    it("sair é permitido mesmo com a organização em análise (T-13)", async () => {
      const pendingOrg = await createTestOrganization(owner.userId, { status: "em_analise" });
      const member = await addMember(pendingOrg.id, "operador");
      expect((await callLeave(member, pendingOrg.id)).status).toBe(200);
    });

    it("quem já saiu não consegue sair de novo (403)", async () => {
      const member = await addMember(orgId, "operador");
      await callLeave(member, orgId);
      expect((await callLeave(member, orgId)).status).toBe(403);
    });
  });

  describe("reativação e proteção do aceite de convite (A2)", () => {
    async function inviteAndAccept(email: string, role: "administrador" | "operador" | "voluntario", acceptor: AuthenticatedTestUser) {
      const inviteResponse = await postInvite(
        buildRequest("organization-invites", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, email, role } })
      );
      expect(inviteResponse.status).toBe(200);
      const { acceptUrl } = await parseJson<{ acceptUrl: string }>(inviteResponse);
      const token = acceptUrl.split("/convites/")[1];
      return postAccept(buildRequest("organization-invites-accept", { method: "POST", cookie: acceptor.cookie, body: { token } }));
    }

    it("ex-membro volta por novo convite, com o papel do convite e reativacao=true na auditoria", async () => {
      const former = await addMember(orgId, "operador");
      await callDeactivate(owner, orgId, former.membershipId);

      const response = await inviteAndAccept(former.email, "voluntario", former);
      expect(response.status).toBe(200);
      const membership = await membershipOf(orgId, former.userId);
      expect(membership.status).toBe("ativo");
      expect(membership.role).toBe("voluntario");

      const audit = await db
        .selectFrom("auditLog")
        .select("metadata")
        .where("organizationId", "=", orgId)
        .where("action", "=", "organizacao.convite_aceito")
        .executeTakeFirstOrThrow();
      expect(audit.metadata).toMatchObject({ reativacao: true, papelAnterior: "operador", role: "voluntario" });
    });

    it("convite não pode mudar o papel de quem já é membro ativo (409) e o convite continua pendente", async () => {
      const active = await addMember(orgId, "administrador");
      // Convite criado quando a pessoa não era membro; ela passa a ser membro ativo antes do aceite.
      const inviteRow = await db
        .insertInto("organizationInvites")
        .values({
          organizationId: orgId,
          email: active.email,
          role: "voluntario",
          tokenHash: "hash-de-teste-a2",
          status: "pendente",
          invitedByUserId: owner.userId,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const { hashInviteToken } = await import("../src/helpers/organizationInvites");
      await db.updateTable("organizationInvites").set({ tokenHash: hashInviteToken("token-a2") }).where("id", "=", inviteRow.id).execute();

      const response = await postAccept(
        buildRequest("organization-invites-accept", { method: "POST", cookie: active.cookie, body: { token: "token-a2" } })
      );
      expect(response.status).toBe(409);
      expect((await membershipOf(orgId, active.userId)).role).toBe("administrador");
      const invite = await db.selectFrom("organizationInvites").select("status").where("id", "=", inviteRow.id).executeTakeFirstOrThrow();
      expect(invite.status).toBe("pendente");
    });
  });

  describe("visibilidade de ex-membros (P-3)", () => {
    it("ex-membros só aparecem para quem tem membros.gerencie", async () => {
      const volunteer = await addMember(orgId, "voluntario");
      const former = await addMember(orgId, "operador", "inativo");

      const asOwner = await parseJson<{ members: Array<{ membershipId: number; status: string }> }>(
        await getMembers(buildRequest(`organization-members?organizationId=${orgId}`, { cookie: owner.cookie }))
      );
      expect(asOwner.members.map((m) => m.membershipId)).toContain(former.membershipId);

      const asVolunteer = await parseJson<{ members: Array<{ membershipId: number; status: string }> }>(
        await getMembers(buildRequest(`organization-members?organizationId=${orgId}`, { cookie: volunteer.cookie }))
      );
      expect(asVolunteer.members.map((m) => m.membershipId)).not.toContain(former.membershipId);
      expect(asVolunteer.members.every((m) => m.status === "ativo")).toBe(true);
    });
  });

  describe("auditoria", () => {
    it("cadeia de hash íntegra depois de todas as operações e trilha legível por proprietário", async () => {
      const member = await addMember(orgId, "voluntario");
      await callRole(owner, orgId, member.membershipId, "operador");
      await callDeactivate(owner, orgId, member.membershipId);
      const leaver = await addMember(orgId, "voluntario");
      await callLeave(leaver, orgId);

      expect(await auditActions(orgId)).toEqual([
        "organizacao.membro_papel_alterado",
        "organizacao.membro_desativado",
        "organizacao.membro_saiu",
      ]);
      const chain = await verifyAuditLogChain();
      expect(chain.integra).toBe(true);
      expect(chain.divergencias).toHaveLength(0);

      const log = await getAuditLog(buildRequest(`audit-log?organizationId=${orgId}`, { cookie: owner.cookie }));
      expect(log.status).toBe(200);
    });
  });

  describe("concorrência (I1 e serialização)", () => {
    it("dois proprietários se rebaixam ao mesmo tempo: exatamente um sucede e sobra um proprietário", async () => {
      for (let round = 0; round < 5; round++) {
        const a = await createAuthenticatedUser();
        const org = await createTestOrganization(a.userId);
        const aId = (await membershipOf(org.id, a.userId)).id;
        const b = await addMember(org.id, "proprietario");

        const [r1, r2] = await Promise.all([
          callRole(a, org.id, b.membershipId, "administrador"),
          callRole(b, org.id, aId, "administrador"),
        ]);
        const statuses = [r1.status, r2.status].sort();
        expect(statuses[0]).toBe(200);
        expect([403, 409]).toContain(statuses[1]);

        const owners = await db
          .selectFrom("memberships")
          .select("id")
          .where("organizationId", "=", org.id)
          .where("role", "=", "proprietario")
          .where("status", "=", "ativo")
          .execute();
        expect(owners).toHaveLength(1);
      }
    });

    it("dois administradores desativam o mesmo membro: um 200, um 409, um único evento", async () => {
      const adminA = await addMember(orgId, "administrador");
      const adminB = await addMember(orgId, "administrador");
      const target = await addMember(orgId, "operador");

      const [r1, r2] = await Promise.all([
        callDeactivate(adminA, orgId, target.membershipId),
        callDeactivate(adminB, orgId, target.membershipId),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      expect((await auditActions(orgId)).filter((a) => a === "organizacao.membro_desativado")).toHaveLength(1);
    });

    it("dois proprietários saem ao mesmo tempo: nunca sobram zero proprietários", async () => {
      for (let round = 0; round < 5; round++) {
        const a = await createAuthenticatedUser();
        const org = await createTestOrganization(a.userId);
        const b = await addMember(org.id, "proprietario");

        const [r1, r2] = await Promise.all([callLeave(a, org.id), callLeave(b, org.id)]);
        expect([r1.status, r2.status].sort()).toEqual([200, 409]);

        const owners = await db
          .selectFrom("memberships")
          .select("id")
          .where("organizationId", "=", org.id)
          .where("role", "=", "proprietario")
          .where("status", "=", "ativo")
          .execute();
        expect(owners).toHaveLength(1);
      }
    });

    it("dois co-proprietários excluem a conta ao mesmo tempo: exatamente um é recusado (A1)", async () => {
      for (let round = 0; round < 5; round++) {
        const a = await createAuthenticatedUser();
        const org = await createTestOrganization(a.userId);
        const b = await addMember(org.id, "proprietario");

        const del = (person: AuthenticatedTestUser) =>
          postAccountDelete(
            buildRequest("auth/account-delete", { method: "POST", cookie: person.cookie, body: { password: "senha-de-teste-123" } })
          );
        const [r1, r2] = await Promise.all([del(a), del(b)]);
        expect([r1.status, r2.status].sort()).toEqual([200, 409]);

        const owners = await db
          .selectFrom("memberships")
          .select("id")
          .where("organizationId", "=", org.id)
          .where("role", "=", "proprietario")
          .where("status", "=", "ativo")
          .execute();
        expect(owners).toHaveLength(1);
      }
    });
  });
});
