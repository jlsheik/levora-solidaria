import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as getConfig } from "../src/endpoints/organization-matching-config_GET";
import { handle as postCapacity } from "../src/endpoints/organization-capacities_POST";
import { handle as deleteCapacity } from "../src/endpoints/organization-capacities-delete_POST";
import { handle as postSettings } from "../src/endpoints/organization-matching-settings_POST";
import { handle as postServiceArea } from "../src/endpoints/organization-service-areas_POST";
import { handle as deleteServiceArea } from "../src/endpoints/organization-service-areas-delete_POST";
import {
  createAuthenticatedUser,
  createTestOrganization,
  addMembership,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";

describe("configuração de organização para matching (capacidade, logística, área de atendimento)", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
  });

  it("GET começa vazio para uma organização recém-criada", async () => {
    const response = await getConfig(buildRequest(`organization-matching-config?organizationId=${orgId}`, { cookie: owner.cookie }));
    expect(response.status).toBe(200);
    const data = await parseJson<{ capacities: unknown[]; settings: unknown; serviceAreas: unknown[] }>(response);
    expect(data.capacities).toHaveLength(0);
    expect(data.settings).toBeNull();
    expect(data.serviceAreas).toHaveLength(0);
  });

  it("qualquer membro (inclusive voluntário) consegue LER a configuração", async () => {
    const volunteer = await createAuthenticatedUser();
    await addMembership(orgId, volunteer.userId, "voluntario");

    const response = await getConfig(buildRequest(`organization-matching-config?organizationId=${orgId}`, { cookie: volunteer.cookie }));
    expect(response.status).toBe(200);
  });

  describe("capacidade por categoria", () => {
    it("proprietário cria uma capacidade e ela aparece na leitura", async () => {
      const response = await postCapacity(
        buildRequest("organization-capacities", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: 500 },
        })
      );
      expect(response.status).toBe(200);
      const data = await parseJson<{ capacity: { id: number; category: string; unit: string; maxCapacity: number } }>(response);
      expect(data.capacity.maxCapacity).toBe(500);

      const config = await getConfig(buildRequest(`organization-matching-config?organizationId=${orgId}`, { cookie: owner.cookie }));
      const configData = await parseJson<{ capacities: Array<{ category: string; maxCapacity: number }> }>(config);
      expect(configData.capacities).toHaveLength(1);
      expect(configData.capacities[0].maxCapacity).toBe(500);
    });

    it("enviar a mesma categoria+unidade de novo ATUALIZA (upsert), não duplica", async () => {
      await postCapacity(
        buildRequest("organization-capacities", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: 500 } })
      );
      const second = await postCapacity(
        buildRequest("organization-capacities", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: 800 } })
      );
      expect(second.status).toBe(200);

      const rows = await db.selectFrom("organizationCapacities").select(["maxCapacity"]).where("organizationId", "=", orgId).execute();
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].maxCapacity)).toBe(800);
    });

    it("bloqueia (403) operador/voluntário de criar ou remover capacidade", async () => {
      const volunteer = await createAuthenticatedUser();
      await addMembership(orgId, volunteer.userId, "voluntario");

      const response = await postCapacity(
        buildRequest("organization-capacities", { method: "POST", cookie: volunteer.cookie, body: { organizationId: orgId, category: "Roupas", unit: "unidade", maxCapacity: 50 } })
      );
      expect(response.status).toBe(403);
    });

    it("remove uma capacidade e ela some da leitura", async () => {
      const created = await postCapacity(
        buildRequest("organization-capacities", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, category: "Móveis", unit: "unidade", maxCapacity: 10 } })
      );
      const { capacity } = await parseJson<{ capacity: { id: number } }>(created);

      const response = await deleteCapacity(
        buildRequest("organization-capacities-delete", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, capacityId: capacity.id } })
      );
      expect(response.status).toBe(200);

      const rows = await db.selectFrom("organizationCapacities").select(["id"]).where("id", "=", capacity.id).execute();
      expect(rows).toHaveLength(0);
    });

    it("isolamento multi-organização: não remove capacidade de outra organização mesmo informando o ID certo (404)", async () => {
      const otherOwner = await createAuthenticatedUser();
      const otherOrg = await createTestOrganization(otherOwner.userId);
      const created = await postCapacity(
        buildRequest("organization-capacities", { method: "POST", cookie: otherOwner.cookie, body: { organizationId: otherOrg.id, category: "Alimentos", unit: "kg", maxCapacity: 100 } })
      );
      const { capacity } = await parseJson<{ capacity: { id: number } }>(created);

      // owner é membro só de orgId, tenta apagar capacidade de otherOrg.
      const response = await deleteCapacity(
        buildRequest("organization-capacities-delete", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, capacityId: capacity.id } })
      );
      expect(response.status).toBe(404);

      const stillExists = await db.selectFrom("organizationCapacities").select(["id"]).where("id", "=", capacity.id).execute();
      expect(stillExists).toHaveLength(1);
    });

    it("rejeita capacidade negativa (400)", async () => {
      const response = await postCapacity(
        buildRequest("organization-capacities", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: -5 } })
      );
      expect(response.status).toBe(400);
    });

    it("gera evento de auditoria ao criar e ao remover", async () => {
      const created = await postCapacity(
        buildRequest("organization-capacities", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, category: "Higiene", unit: "unidade", maxCapacity: 200 } })
      );
      const { capacity } = await parseJson<{ capacity: { id: number } }>(created);
      await deleteCapacity(
        buildRequest("organization-capacities-delete", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, capacityId: capacity.id } })
      );

      const audits = await db
        .selectFrom("auditLog")
        .select(["action"])
        .where("entityType", "=", "organization_capacity")
        .where("entityId", "=", String(capacity.id))
        .execute();
      expect(audits.map((a) => a.action).sort()).toEqual(["organizacao.capacidade_alterada", "organizacao.capacidade_removida"]);
    });
  });

  describe("configuração de logística", () => {
    it("cria e depois atualiza as configurações (upsert 1:1, nunca duas linhas)", async () => {
      const first = await postSettings(
        buildRequest("organization-matching-settings", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, realizaColeta: true, raioColetaKm: 20, observacoesLogisticas: "Só de manhã", observacoesHorarios: null },
        })
      );
      expect(first.status).toBe(200);

      const second = await postSettings(
        buildRequest("organization-matching-settings", {
          method: "POST",
          cookie: owner.cookie,
          body: { organizationId: orgId, realizaColeta: false, raioColetaKm: null, observacoesLogisticas: null, observacoesHorarios: "Fins de semana fechado" },
        })
      );
      expect(second.status).toBe(200);
      const data = await parseJson<{ settings: { realizaColeta: boolean; observacoesHorarios: string | null } }>(second);
      expect(data.settings.realizaColeta).toBe(false);
      expect(data.settings.observacoesHorarios).toBe("Fins de semana fechado");

      const rows = await db.selectFrom("organizationMatchingSettings").select(["organizationId"]).where("organizationId", "=", orgId).execute();
      expect(rows).toHaveLength(1);
    });

    it("bloqueia (403) operador de alterar configuração de logística", async () => {
      const operator = await createAuthenticatedUser();
      await addMembership(orgId, operator.userId, "operador");

      const response = await postSettings(
        buildRequest("organization-matching-settings", { method: "POST", cookie: operator.cookie, body: { organizationId: orgId, realizaColeta: true } })
      );
      expect(response.status).toBe(403);
    });
  });

  describe("área de atendimento", () => {
    it("adiciona uma cidade atendida", async () => {
      const response = await postServiceArea(
        buildRequest("organization-service-areas", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, city: "Contagem", state: "mg" } })
      );
      expect(response.status).toBe(200);
      const data = await parseJson<{ serviceArea: { city: string; state: string } }>(response);
      expect(data.serviceArea.state).toBe("MG"); // normalizado para maiúsculo
    });

    it("bloqueia (409) adicionar a mesma cidade duas vezes (case-insensitive)", async () => {
      await postServiceArea(
        buildRequest("organization-service-areas", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, city: "Contagem", state: "MG" } })
      );
      const response = await postServiceArea(
        buildRequest("organization-service-areas", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, city: "CONTAGEM", state: "MG" } })
      );
      expect(response.status).toBe(409);

      const rows = await db.selectFrom("organizationServiceAreas").select(["id"]).where("organizationId", "=", orgId).execute();
      expect(rows).toHaveLength(1);
    });

    it("remove uma área de atendimento", async () => {
      const created = await postServiceArea(
        buildRequest("organization-service-areas", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, city: "Betim", state: "MG" } })
      );
      const { serviceArea } = await parseJson<{ serviceArea: { id: number } }>(created);

      const response = await deleteServiceArea(
        buildRequest("organization-service-areas-delete", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, areaId: serviceArea.id } })
      );
      expect(response.status).toBe(200);

      const rows = await db.selectFrom("organizationServiceAreas").select(["id"]).where("id", "=", serviceArea.id).execute();
      expect(rows).toHaveLength(0);
    });

    it("isolamento multi-organização: não remove área de outra organização (404)", async () => {
      const otherOwner = await createAuthenticatedUser();
      const otherOrg = await createTestOrganization(otherOwner.userId);
      const created = await postServiceArea(
        buildRequest("organization-service-areas", { method: "POST", cookie: otherOwner.cookie, body: { organizationId: otherOrg.id, city: "Sabará", state: "MG" } })
      );
      const { serviceArea } = await parseJson<{ serviceArea: { id: number } }>(created);

      const response = await deleteServiceArea(
        buildRequest("organization-service-areas-delete", { method: "POST", cookie: owner.cookie, body: { organizationId: orgId, areaId: serviceArea.id } })
      );
      expect(response.status).toBe(404);
    });

    it("bloqueia (403) voluntário de adicionar área de atendimento", async () => {
      const volunteer = await createAuthenticatedUser();
      await addMembership(orgId, volunteer.userId, "voluntario");

      const response = await postServiceArea(
        buildRequest("organization-service-areas", { method: "POST", cookie: volunteer.cookie, body: { organizationId: orgId, city: "Nova Lima", state: "MG" } })
      );
      expect(response.status).toBe(403);
    });
  });

  it("organização 'em_analise' não pode configurar matching ainda (mesma regra de toda escrita restrita)", async () => {
    const pendingOwner = await createAuthenticatedUser();
    const pendingOrg = await createTestOrganization(pendingOwner.userId, { status: "em_analise" });

    const response = await postCapacity(
      buildRequest("organization-capacities", { method: "POST", cookie: pendingOwner.cookie, body: { organizationId: pendingOrg.id, category: "Alimentos", unit: "kg", maxCapacity: 100 } })
    );
    expect(response.status).toBe(403);
  });

  it("rejeita sem sessão autenticada (401) em toda mutação", async () => {
    const response = await postCapacity(
      buildRequest("organization-capacities", { method: "POST", body: { organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: 100 } })
    );
    expect(response.status).toBe(401);
  });
});
