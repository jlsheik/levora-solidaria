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
import { handle as postRevokeInvite } from "../src/endpoints/organization-invites-revoke_POST";
import { lockOrganization } from "../src/helpers/membershipAdmin";
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


// ---------------------------------------------------------------------------
// Fase 73 (auditoria): cobertura adicional exigida pelo briefing — concorrência
// dos casos 2, 4, 5 e 6, convites expirados/revogados/antigos, efeito sobre
// permissões na requisição seguinte, acesso de não-membro/inativo, IDOR e
// estado da organização. Mesmos helpers do bloco acima; nenhum teste anterior
// foi alterado.
// ---------------------------------------------------------------------------

async function activeOwnerCount(orgId: number): Promise<number> {
  const rows = await db
    .selectFrom("memberships")
    .select("id")
    .where("organizationId", "=", orgId)
    .where("role", "=", "proprietario")
    .where("status", "=", "ativo")
    .execute();
  return rows.length;
}

async function newOrganization() {
  const creator = await createAuthenticatedUser();
  const org = await createTestOrganization(creator.userId);
  const creatorMembershipId = (await membershipOf(org.id, creator.userId)).id;
  return { creator, orgId: org.id, creatorMembershipId };
}

async function createInviteToken(
  actor: AuthenticatedTestUser,
  orgId: number,
  email: string,
  role: "administrador" | "operador" | "voluntario"
) {
  const response = await postInvite(
    buildRequest("organization-invites", { method: "POST", cookie: actor.cookie, body: { organizationId: orgId, email, role } })
  );
  expect(response.status).toBe(200);
  const body = await parseJson<{ acceptUrl: string; invite: { id: number } }>(response);
  return { token: body.acceptUrl.split("/convites/")[1], inviteId: body.invite.id };
}

function acceptInvite(person: AuthenticatedTestUser, token: string) {
  return postAccept(buildRequest("organization-invites-accept", { method: "POST", cookie: person.cookie, body: { token } }));
}

function deleteAccount(person: AuthenticatedTestUser) {
  return postAccountDelete(
    buildRequest("auth/account-delete", { method: "POST", cookie: person.cookie, body: { password: "senha-de-teste-123" } })
  );
}

describe("ciclo de vida dos membros — concorrência adicional (Postgres real, Promise.all)", () => {
  beforeEach(() => {
    resetAllRateLimitsForTests();
  });

  it("caso 2: dois administradores alteram o papel do mesmo membro para papéis diferentes — aplicam em série e a cadeia de auditoria é coerente", async () => {
    for (let round = 0; round < 5; round++) {
      const { orgId } = await newOrganization();
      const adminA = await addMember(orgId, "administrador");
      const adminB = await addMember(orgId, "administrador");
      const target = await addMember(orgId, "voluntario");

      const [r1, r2] = await Promise.all([
        callRole(adminA, orgId, target.membershipId, "operador"),
        callRole(adminB, orgId, target.membershipId, "administrador"),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);

      const events = await db
        .selectFrom("auditLog")
        .select("metadata")
        .where("organizationId", "=", orgId)
        .where("action", "=", "organizacao.membro_papel_alterado")
        .orderBy("id", "asc")
        .execute();
      expect(events).toHaveLength(2);
      const [first, second] = events.map((e) => e.metadata as { papelAnterior: string; papelNovo: string });
      expect(first.papelAnterior).toBe("voluntario");
      // o 2º evento parte do estado que o 1º deixou, nunca do estado antigo
      expect(second.papelAnterior).toBe(first.papelNovo);
      expect((await membershipOf(orgId, target.userId)).role).toBe(second.papelNovo);
    }
  });

  it("caso 2b: dois administradores pedem o MESMO papel — um aplica (200), o outro vê o estado já aplicado (409), um único evento", async () => {
    for (let round = 0; round < 5; round++) {
      const { orgId } = await newOrganization();
      const adminA = await addMember(orgId, "administrador");
      const adminB = await addMember(orgId, "administrador");
      const target = await addMember(orgId, "voluntario");

      const [r1, r2] = await Promise.all([
        callRole(adminA, orgId, target.membershipId, "operador"),
        callRole(adminB, orgId, target.membershipId, "operador"),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      expect((await auditActions(orgId)).filter((a) => a === "organizacao.membro_papel_alterado")).toHaveLength(1);
    }
  });

  it("caso 4: proprietário desativa o co-proprietário enquanto ele sai — exatamente um efeito, a organização mantém um proprietário", async () => {
    for (let round = 0; round < 5; round++) {
      const { creator: a, orgId } = await newOrganization();
      const b = await addMember(orgId, "proprietario");

      const [rDeactivate, rLeave] = await Promise.all([callDeactivate(a, orgId, b.membershipId), callLeave(b, orgId)]);
      const statuses = [rDeactivate.status, rLeave.status];
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s !== 200).every((s) => s === 403 || s === 409)).toBe(true);

      expect(await activeOwnerCount(orgId)).toBe(1);
      expect((await membershipOf(orgId, a.userId)).status).toBe("ativo");
      expect((await membershipOf(orgId, b.userId)).status).toBe("inativo");
      const effects = (await auditActions(orgId)).filter((x) => x === "organizacao.membro_desativado" || x === "organizacao.membro_saiu");
      expect(effects).toHaveLength(1);
    }
  });

  it("caso 4b: administrador tenta desativar o proprietário enquanto ele sai — o administrador é sempre recusado (403) e a invariante vale", async () => {
    // dois proprietários: o proprietário consegue sair, o administrador nunca toca nele
    const twoOwners = await newOrganization();
    const second = await addMember(twoOwners.orgId, "proprietario");
    const admin = await addMember(twoOwners.orgId, "administrador");
    const [rAdmin, rLeave] = await Promise.all([
      callDeactivate(admin, twoOwners.orgId, second.membershipId),
      callLeave(second, twoOwners.orgId),
    ]);
    expect(rAdmin.status).toBe(403);
    expect(rLeave.status).toBe(200);
    expect(await activeOwnerCount(twoOwners.orgId)).toBe(1);

    // um único proprietário: nem o administrador o desativa (403) nem ele sai (409)
    const oneOwner = await newOrganization();
    const admin2 = await addMember(oneOwner.orgId, "administrador");
    const [rAdmin2, rLeave2] = await Promise.all([
      callDeactivate(admin2, oneOwner.orgId, oneOwner.creatorMembershipId),
      callLeave(oneOwner.creator, oneOwner.orgId),
    ]);
    expect(rAdmin2.status).toBe(403);
    expect(rLeave2.status).toBe(409);
    expect(await activeOwnerCount(oneOwner.orgId)).toBe(1);
  });

  it("caso 5: rebaixamentos circulares entre três proprietários — sem deadlock, nunca zero proprietários, um evento por sucesso", async () => {
    for (let round = 0; round < 5; round++) {
      const { creator: a, orgId, creatorMembershipId } = await newOrganization();
      const b = await addMember(orgId, "proprietario");
      const c = await addMember(orgId, "proprietario");

      const results = await Promise.all([
        callRole(a, orgId, b.membershipId, "administrador"),
        callRole(b, orgId, c.membershipId, "administrador"),
        callRole(c, orgId, creatorMembershipId, "administrador"),
      ]);
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 200 || s === 403 || s === 409)).toBe(true);
      expect(statuses.some((s) => s >= 500)).toBe(false);

      const successes = statuses.filter((s) => s === 200).length;
      const owners = await activeOwnerCount(orgId);
      expect(owners).toBeGreaterThanOrEqual(1);
      // cada sucesso rebaixa exatamente um proprietário
      expect(owners).toBe(3 - successes);
      expect((await auditActions(orgId)).filter((x) => x === "organizacao.membro_papel_alterado")).toHaveLength(successes);
    }
  });

  it("caso 5b: promover e rebaixar ao mesmo tempo — resultado depende só da ordem do lock e nunca deixa zero proprietários", async () => {
    for (let round = 0; round < 5; round++) {
      const { creator: a, orgId, creatorMembershipId } = await newOrganization();
      const b = await addMember(orgId, "proprietario");
      const d = await addMember(orgId, "administrador");

      const [rPromote, rDemote] = await Promise.all([
        callRole(a, orgId, d.membershipId, "proprietario"),
        callRole(b, orgId, creatorMembershipId, "administrador"),
      ]);
      expect(rDemote.status).toBe(200); // b continua proprietário em qualquer ordem
      expect([200, 403]).toContain(rPromote.status); // 403 se a perdeu o papel antes de promover
      const owners = await activeOwnerCount(orgId);
      expect(owners).toBe(rPromote.status === 200 ? 2 : 1); // b (+ d, se a promoção aconteceu antes)
      expect((await membershipOf(orgId, b.userId)).role).toBe("proprietario");
    }
  });

  it("caso 6a: exclusão de conta de um proprietário simultânea à saída do co-proprietário — exatamente um tem sucesso", async () => {
    for (let round = 0; round < 5; round++) {
      const { creator: a, orgId } = await newOrganization();
      const b = await addMember(orgId, "proprietario");

      const [rDelete, rLeave] = await Promise.all([deleteAccount(a), callLeave(b, orgId)]);
      expect([rDelete.status, rLeave.status].sort()).toEqual([200, 409]);
      expect(await activeOwnerCount(orgId)).toBe(1);
    }
  });

  it("caso 6b: exclusão de conta de um proprietário simultânea ao rebaixamento dele pelo co-proprietário — o co-proprietário permanece", async () => {
    for (let round = 0; round < 5; round++) {
      const { creator: a, orgId, creatorMembershipId } = await newOrganization();
      const b = await addMember(orgId, "proprietario");

      const [rDelete, rDemote] = await Promise.all([deleteAccount(a), callRole(b, orgId, creatorMembershipId, "administrador")]);
      expect(rDelete.status).toBe(200); // há outro proprietário: a exclusão nunca é bloqueada
      expect([200, 409]).toContain(rDemote.status); // 409 se a conta já tinha sido excluída (membro inativo)
      expect(await activeOwnerCount(orgId)).toBe(1);
      expect((await membershipOf(orgId, b.userId)).role).toBe("proprietario");
      expect((await membershipOf(orgId, a.userId)).status).toBe("inativo");
    }
  });

  it("A1 determinístico: a exclusão de conta ESPERA o lock da organização e decide com o estado confirmado depois dele", async () => {
    const { creator: a, orgId } = await newOrganization();
    const b = await addMember(orgId, "proprietario");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // Transação externa segura o lock da organização e, antes de soltá-lo, faz o outro proprietário sair.
    const holder = db.transaction().execute(async (trx) => {
      await lockOrganization(trx, orgId);
      locked();
      await held;
      await trx
        .updateTable("memberships")
        .set({ status: "inativo" })
        .where("organizationId", "=", orgId)
        .where("userId", "=", b.userId)
        .execute();
    });
    await lockAcquired;

    let settled = false;
    const deletion = deleteAccount(a).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 800)); // tempo para o bcrypt terminar e a exclusão chegar ao lock
    expect(settled).toBe(false); // bloqueada, esperando o lock da organização

    release();
    await holder;
    const response = await deletion;
    // sem o lock a exclusão teria rodado antes e visto o co-proprietário ainda ativo (200)
    expect(response.status).toBe(409);
    expect((await membershipOf(orgId, a.userId)).status).toBe("ativo");
    expect(await activeOwnerCount(orgId)).toBe(1);
  });

  it("determinístico: sair e aceitar convite ESPERAM o lock da organização e revalidam com o estado confirmado", async () => {
    const { creator: a, orgId } = await newOrganization();
    const b = await addMember(orgId, "proprietario");
    const invited = await createAuthenticatedUser();
    const { token } = await createInviteToken(a, orgId, invited.email, "operador");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction().execute(async (trx) => {
      await lockOrganization(trx, orgId);
      locked();
      await held;
      // com o lock ainda em mãos, o outro proprietário sai
      await trx
        .updateTable("memberships")
        .set({ status: "inativo" })
        .where("organizationId", "=", orgId)
        .where("userId", "=", b.userId)
        .execute();
    });
    await lockAcquired;

    let leaveSettled = false;
    let acceptSettled = false;
    const leaving = callLeave(a, orgId).then((r) => {
      leaveSettled = true;
      return r;
    });
    const accepting = acceptInvite(invited, token).then((r) => {
      acceptSettled = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(leaveSettled).toBe(false);
    expect(acceptSettled).toBe(false);

    release();
    await holder;
    const [leaveResponse, acceptResponse] = await Promise.all([leaving, accepting]);
    expect(leaveResponse.status).toBe(409); // b já saiu: a é o último proprietário
    expect(acceptResponse.status).toBe(200); // o aceite só prossegue depois do lock
    expect(await activeOwnerCount(orgId)).toBe(1);
    expect((await membershipOf(orgId, invited.userId)).role).toBe("operador");
  });

  it("mistura de 8 operações simultâneas: sem erro 5xx/deadlock, auditoria 1:1 com os sucessos e ao menos um proprietário", async () => {
    for (let round = 0; round < 3; round++) {
      const { creator: o1, orgId, creatorMembershipId } = await newOrganization();
      const o2 = await addMember(orgId, "proprietario");
      const o3 = await addMember(orgId, "proprietario");
      const a1 = await addMember(orgId, "administrador");
      const a2 = await addMember(orgId, "administrador");
      const p1 = await addMember(orgId, "operador");
      const p2 = await addMember(orgId, "operador");
      const p3 = await addMember(orgId, "operador");

      const results = await Promise.all([
        callRole(o1, orgId, o2.membershipId, "administrador"),
        callRole(o2, orgId, o3.membershipId, "administrador"),
        callRole(o3, orgId, creatorMembershipId, "administrador"),
        callDeactivate(a1, orgId, p1.membershipId),
        callRole(a2, orgId, p2.membershipId, "voluntario"),
        callLeave(p3, orgId),
        callDeactivate(o1, orgId, a1.membershipId),
        callRole(a1, orgId, a2.membershipId, "operador"),
      ]);
      const statuses = results.map((r) => r.status);
      expect(statuses.some((s) => s >= 500)).toBe(false);
      expect(statuses.every((s) => [200, 403, 409].includes(s))).toBe(true);

      const successes = statuses.filter((s) => s === 200).length;
      expect((await auditActions(orgId)).length).toBe(successes);
      expect(await activeOwnerCount(orgId)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("ciclo de vida dos membros — convites sobre membership existente", () => {
  let creator: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    resetAllRateLimitsForTests();
    ({ creator, orgId } = await newOrganization());
  });

  it("convite EXPIRADO não reativa ex-membro (410): ele continua inativo e com o papel antigo", async () => {
    const former = await addMember(orgId, "operador");
    await callDeactivate(creator, orgId, former.membershipId);
    const { token, inviteId } = await createInviteToken(creator, orgId, former.email, "administrador");
    await db.updateTable("organizationInvites").set({ expiresAt: new Date(Date.now() - 1000) }).where("id", "=", inviteId).execute();

    const response = await acceptInvite(former, token);
    expect(response.status).toBe(410);
    const membership = await membershipOf(orgId, former.userId);
    expect(membership.status).toBe("inativo");
    expect(membership.role).toBe("operador");
  });

  it("convite REVOGADO não reativa ex-membro (410)", async () => {
    const former = await addMember(orgId, "operador");
    await callDeactivate(creator, orgId, former.membershipId);
    const { token, inviteId } = await createInviteToken(creator, orgId, former.email, "operador");
    const revoke = await postRevokeInvite(
      buildRequest("organization-invites-revoke", { method: "POST", cookie: creator.cookie, body: { organizationId: orgId, inviteId } })
    );
    expect(revoke.status).toBe(200);

    const response = await acceptInvite(former, token);
    expect(response.status).toBe(410);
    expect((await membershipOf(orgId, former.userId)).status).toBe("inativo");
  });

  it("convite ANTIGO não tem precedência: o novo convite revoga o anterior e só o papel do convite atual vale", async () => {
    const former = await addMember(orgId, "voluntario");
    await callDeactivate(creator, orgId, former.membershipId);
    const first = await createInviteToken(creator, orgId, former.email, "administrador");
    const second = await createInviteToken(creator, orgId, former.email, "operador");

    const old = await acceptInvite(former, first.token);
    expect(old.status).toBe(410);
    expect((await membershipOf(orgId, former.userId)).status).toBe("inativo");

    const current = await acceptInvite(former, second.token);
    expect(current.status).toBe(200);
    const membership = await membershipOf(orgId, former.userId);
    expect(membership.status).toBe("ativo");
    expect(membership.role).toBe("operador");
  });

  it("convite não pode nomear proprietário (400): a reativação nunca devolve a propriedade", async () => {
    const response = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: creator.cookie,
        body: { organizationId: orgId, email: "alguem@example.com", role: "proprietario" },
      })
    );
    expect(response.status).toBe(400);
  });

  it("aceitar o convite da organização A não cria nem altera membership na organização B", async () => {
    const other = await newOrganization();
    const person = await createAuthenticatedUser();
    const { token } = await createInviteToken(creator, orgId, person.email, "voluntario");

    const response = await acceptInvite(person, token);
    expect(response.status).toBe(200);
    const memberships = await db.selectFrom("memberships").select(["organizationId", "role"]).where("userId", "=", person.userId).execute();
    expect(memberships).toEqual([{ organizationId: orgId, role: "voluntario" }]);
    const inOther = await db
      .selectFrom("memberships")
      .select("id")
      .where("organizationId", "=", other.orgId)
      .where("userId", "=", person.userId)
      .execute();
    expect(inOther).toHaveLength(0);
  });

  it("pessoa nova que aceita: papel do convite e reativacao=false na auditoria", async () => {
    const person = await createAuthenticatedUser();
    const { token } = await createInviteToken(creator, orgId, person.email, "operador");

    expect((await acceptInvite(person, token)).status).toBe(200);
    const audit = await db
      .selectFrom("auditLog")
      .select("metadata")
      .where("organizationId", "=", orgId)
      .where("action", "=", "organizacao.convite_aceito")
      .executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ reativacao: false, role: "operador" });
    expect((await membershipOf(orgId, person.userId)).role).toBe("operador");
  });

  it("outro e-mail não consegue usar o convite (403) e nenhuma membership é criada", async () => {
    const invited = await createAuthenticatedUser();
    const intruder = await createAuthenticatedUser();
    const { token } = await createInviteToken(creator, orgId, invited.email, "administrador");

    const response = await acceptInvite(intruder, token);
    expect(response.status).toBe(403);
    const rows = await db.selectFrom("memberships").select("id").where("userId", "=", intruder.userId).execute();
    expect(rows).toHaveLength(0);
  });
});

describe("ciclo de vida dos membros — sessão, autorização, estado da organização e IDOR", () => {
  let creator: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    resetAllRateLimitsForTests();
    ({ creator, orgId } = await newOrganization());
  });

  it("rebaixamento vale na requisição SEGUINTE: perde membros.gerencie mas continua lendo a equipe", async () => {
    const admin = await addMember(orgId, "administrador");
    const invite = (email: string) =>
      postInvite(buildRequest("organization-invites", { method: "POST", cookie: admin.cookie, body: { organizationId: orgId, email, role: "voluntario" } }));

    expect((await invite("antes@example.com")).status).toBe(200); // acesso antes
    expect((await callRole(creator, orgId, admin.membershipId, "operador")).status).toBe(200); // alteração
    expect((await invite("depois@example.com")).status).toBe(403); // mesma sessão, próxima requisição
    const members = await getMembers(buildRequest(`organization-members?organizationId=${orgId}`, { cookie: admin.cookie }));
    expect(members.status).toBe(200); // ainda é membro
  });

  it("quem sai perde acesso na requisição seguinte e a organização some da sua lista, com a mesma sessão", async () => {
    const person = await addMember(orgId, "voluntario");
    const read = () => getMembers(buildRequest(`organization-members?organizationId=${orgId}`, { cookie: person.cookie }));

    expect((await read()).status).toBe(200);
    expect((await callLeave(person, orgId)).status).toBe(200);
    expect((await read()).status).toBe(403);

    const list = await parseJson<{ organizations: { id: number }[] }>(
      await getOrganizations(buildRequest("organizations", { cookie: person.cookie }))
    );
    expect(list.organizations.map((o) => o.id)).not.toContain(orgId);
  });

  it("não-membro recebe 403 em alterar papel, desativar e sair, e nada muda", async () => {
    const stranger = await createAuthenticatedUser();
    const target = await addMember(orgId, "operador");

    expect((await callRole(stranger, orgId, target.membershipId, "voluntario")).status).toBe(403);
    expect((await callDeactivate(stranger, orgId, target.membershipId)).status).toBe(403);
    expect((await callLeave(stranger, orgId)).status).toBe(403);
    expect(await membershipOf(orgId, target.userId)).toMatchObject({ role: "operador", status: "ativo" });
  });

  it("membro INATIVO recebe 403 nas três ações, mesmo tendo sido administrador", async () => {
    const former = await addMember(orgId, "administrador", "inativo");
    const target = await addMember(orgId, "operador");

    expect((await callRole(former, orgId, target.membershipId, "voluntario")).status).toBe(403);
    expect((await callDeactivate(former, orgId, target.membershipId)).status).toBe(403);
    expect((await callLeave(former, orgId)).status).toBe(403);
    expect(await membershipOf(orgId, target.userId)).toMatchObject({ role: "operador", status: "ativo" });
  });

  it("desativar é recusado com a organização em análise ou suspensa (403); sair continua permitido na suspensa", async () => {
    for (const status of ["em_analise", "suspensa"] as const) {
      await db.updateTable("organizations").set({ status }).where("id", "=", orgId).execute();
      const target = await addMember(orgId, "operador");
      expect((await callDeactivate(creator, orgId, target.membershipId)).status).toBe(403);
      expect((await membershipOf(orgId, target.userId)).status).toBe("ativo");
    }

    const leaver = await addMember(orgId, "voluntario");
    expect((await callLeave(leaver, orgId)).status).toBe(200); // organização suspensa
    expect((await membershipOf(orgId, leaver.userId)).status).toBe("inativo");
  });

  it("IDOR: membershipId de OUTRA organização é 404 (ator é membro) ou 403 (ator não é membro da outra) e a vítima não muda", async () => {
    const other = await newOrganization();
    const victim = await addMember(other.orgId, "operador");

    expect((await callDeactivate(creator, orgId, victim.membershipId)).status).toBe(404);
    expect((await callRole(creator, orgId, victim.membershipId, "voluntario")).status).toBe(404);
    expect((await callDeactivate(creator, other.orgId, victim.membershipId)).status).toBe(403);
    expect((await callRole(creator, other.orgId, victim.membershipId, "voluntario")).status).toBe(403);
    expect(await membershipOf(other.orgId, victim.userId)).toMatchObject({ role: "operador", status: "ativo" });
  });

  it("administrador não se autopromove nem promove outro a proprietário, por requisição direta (403)", async () => {
    const admin = await addMember(orgId, "administrador");
    const other = await addMember(orgId, "operador");

    expect((await callRole(admin, orgId, admin.membershipId, "proprietario")).status).toBe(403);
    expect((await callRole(admin, orgId, other.membershipId, "proprietario")).status).toBe(403);
    expect((await membershipOf(orgId, admin.userId)).role).toBe("administrador");
    expect((await membershipOf(orgId, other.userId)).role).toBe("operador");
  });

  it("exclusão de conta do único proprietário é recusada (409) e a membership continua ativa", async () => {
    const response = await deleteAccount(creator);
    expect(response.status).toBe(409);
    expect((await membershipOf(orgId, creator.userId)).status).toBe("ativo");
    expect(await activeOwnerCount(orgId)).toBe(1);
  });
});
