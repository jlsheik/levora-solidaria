/**
 * Edição do NOME da organização (primeira entrega de edição de dados): só `organizations.name`, só o proprietário ATIVO, com auditoria.
 * Endpoint real, Postgres real e DESCARTÁVEL. Prova autorização (matriz de papéis, isolamento entre organizações), validação textual,
 * ausência de alterações parciais, preservação de todos os demais campos/dados operacionais e auditoria.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as postName } from "../src/endpoints/organization-name_POST";
import { handle as getReport } from "../src/endpoints/impact-report_GET";
import { handle as getOrgs } from "../src/endpoints/organizations_GET";
import {
  addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOrganization, parseJson, type AuthenticatedTestUser,
} from "./helpers";

interface Env { owner: AuthenticatedTestUser; admin: AuthenticatedTestUser; operador: AuthenticatedTestUser; voluntario: AuthenticatedTestUser; orgId: number; other: { owner: AuthenticatedTestUser; orgId: number } }

async function setup(): Promise<Env> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId, { name: "Associação Original", city: "Contagem", state: "MG" });
  const admin = await createAuthenticatedUser();
  const operador = await createAuthenticatedUser();
  const voluntario = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  await addMembership(org.id, operador.userId, "operador");
  await addMembership(org.id, voluntario.userId, "voluntario");
  const otherOwner = await createAuthenticatedUser();
  const otherOrg = await createTestOrganization(otherOwner.userId, { name: "Outra Organização" });
  return { owner, admin, operador, voluntario, orgId: org.id, other: { owner: otherOwner, orgId: otherOrg.id } };
}

const rename = (cookie: string | undefined, body: unknown) => postName(buildRequest("organization-name", { method: "POST", cookie, body }));
const orgRow = (id: number) => db.selectFrom("organizations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const nameAudits = (orgId?: number) => {
  let q = db.selectFrom("auditLog").selectAll().where("action", "=", "organizacao.nome_alterado");
  if (orgId !== undefined) q = q.where("organizationId", "=", orgId);
  return q.orderBy("id").execute();
};
const auditCount = async () => Number((await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);

describe("proprietário ativo altera o nome", () => {
  it("200: nome persistido (sem espaços externos), SOMENTE o nome muda, auditoria com organização, responsável e os dois nomes", async () => {
    const e = await setup();
    const before = await orgRow(e.orgId);
    const otherBefore = await orgRow(e.other.orgId);
    const res = await rename(e.owner.cookie, { organizationId: e.orgId, name: "  Associação Renomeada  " });
    expect(res.status).toBe(200);
    const body = await parseJson<{ changed: boolean; organization: Record<string, unknown> }>(res);
    expect(body.changed).toBe(true);
    expect(body.organization).toMatchObject({ id: e.orgId, name: "Associação Renomeada", slug: before.slug, type: before.type, status: before.status, city: "Contagem", state: "MG" });

    const after = await orgRow(e.orgId);
    expect(after.name).toBe("Associação Renomeada");
    // tudo o mais preservado, campo a campo (exceto name e o updated_at mantido pelo gatilho)
    const { name: _n1, updatedAt: _u1, ...restBefore } = before;
    const { name: _n2, updatedAt: _u2, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    // outra organização intocada
    expect(await orgRow(e.other.orgId)).toEqual(otherBefore);

    const audits = await nameAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ organizationId: e.orgId, actorUserId: e.owner.userId, entityType: "organization", entityId: String(e.orgId) });
    expect(audits[0].metadata).toEqual({ nomeAnterior: "Associação Original", nomeNovo: "Associação Renomeada" });
  });

  it("o nome persistido aparece na listagem e no relatório; o slug (identificador público) NÃO muda", async () => {
    const e = await setup();
    const slug = (await orgRow(e.orgId)).slug;
    expect((await rename(e.owner.cookie, { organizationId: e.orgId, name: "Nome Novo da Casa" })).status).toBe(200);
    const list = await parseJson<{ organizations: Array<{ id: number; name: string; slug: string }> }>(await getOrgs(buildRequest("organizations", { cookie: e.owner.cookie })));
    expect(list.organizations.find((o) => o.id === e.orgId)).toMatchObject({ name: "Nome Novo da Casa", slug });
    const qs = new URLSearchParams({ organizationId: String(e.orgId), startDate: new Date(Date.now() - 86400000).toISOString(), endDate: new Date(Date.now() + 86400000).toISOString() });
    const report = await parseJson<{ organizationName: string }>(await getReport(buildRequest(`impact-report?${qs}`, { cookie: e.owner.cookie })));
    expect(report.organizationName).toBe("Nome Novo da Casa");
  });

  it("mesmo nome (após o trim): 200 com changed=false, nada alterado e NENHUM evento de auditoria", async () => {
    const e = await setup();
    const before = await orgRow(e.orgId);
    const res = await rename(e.owner.cookie, { organizationId: e.orgId, name: "  Associação Original " });
    expect(res.status).toBe(200);
    expect((await parseJson<{ changed: boolean }>(res)).changed).toBe(false);
    expect(await orgRow(e.orgId)).toEqual(before);
    expect(await nameAudits()).toHaveLength(0);
  });

  it("não toca dados operacionais: estoque, itens e necessidades permanecem como estavam", async () => {
    const e = await setup();
    const item = await createTestInventoryItem(e.orgId, e.owner.userId, { unit: "kg" });
    await db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId: item.id, type: "entrada", delta: "50", createdByUserId: e.owner.userId }).execute();
    await db.insertInto("needs").values({ organizationId: e.orgId, title: "Cestas", quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: e.owner.userId, itemId: item.id }).execute();
    const snap = async () => JSON.stringify([
      await db.selectFrom("stockTransactions").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
      await db.selectFrom("inventoryItems").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
      await db.selectFrom("needs").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
      await db.selectFrom("needFulfillments").selectAll().where("organizationId", "=", e.orgId).execute(),
      await db.selectFrom("memberships").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
    ]);
    const before = await snap();
    expect((await rename(e.owner.cookie, { organizationId: e.orgId, name: "Outro Nome" })).status).toBe(200);
    expect(await snap()).toBe(before);
  });

  it("duas renomeações simultâneas: ambas concluem em série, 2 auditorias encadeadas (anterior→novo), o nome final é o da última", async () => {
    const e = await setup();
    const [a, b] = await Promise.all([rename(e.owner.cookie, { organizationId: e.orgId, name: "Nome A" }), rename(e.owner.cookie, { organizationId: e.orgId, name: "Nome B" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const audits = await nameAudits(e.orgId);
    expect(audits).toHaveLength(2);
    const [first, second] = audits.map((x) => x.metadata as { nomeAnterior: string; nomeNovo: string });
    expect(first.nomeAnterior).toBe("Associação Original");
    expect(second.nomeAnterior).toBe(first.nomeNovo); // cadeia sem lacuna
    expect((await orgRow(e.orgId)).name).toBe(second.nomeNovo);
  });
});

describe("quem NÃO pode alterar: 403/401, sem nenhuma alteração", () => {
  async function expectDenied(e: Env, cookie: string | undefined, orgId: number, expected: number) {
    const before = await orgRow(orgId);
    const audits = await auditCount();
    const res = await rename(cookie, { organizationId: orgId, name: "Tentativa Indevida" });
    expect(res.status).toBe(expected);
    expect(await orgRow(orgId)).toEqual(before);
    expect(await auditCount()).toBe(audits);
    expect(await nameAudits()).toHaveLength(0);
  }

  it("administrador (sem `propriedade.gerencie`), operador e voluntário ⇒ 403", async () => {
    const e = await setup();
    for (const user of [e.admin, e.operador, e.voluntario]) await expectDenied(e, user.cookie, e.orgId, 403);
  });

  it("usuário sem vínculo ⇒ 403; sem sessão ⇒ 401", async () => {
    const e = await setup();
    const stranger = await createAuthenticatedUser();
    await expectDenied(e, stranger.cookie, e.orgId, 403);
    await expectDenied(e, undefined, e.orgId, 401);
  });

  it("proprietário de OUTRA organização não renomeia esta (isolamento multi-organização)", async () => {
    const e = await setup();
    await expectDenied(e, e.other.owner.cookie, e.orgId, 403);
    // e o inverso: o proprietário desta não renomeia a outra
    await expectDenied(e, e.owner.cookie, e.other.orgId, 403);
  });

  it("proprietário INATIVO (desativado) ⇒ 403; organização em análise ou suspensa ⇒ 403", async () => {
    const e = await setup();
    const exOwner = await createAuthenticatedUser();
    await addMembership(e.orgId, exOwner.userId, "proprietario", "inativo");
    await expectDenied(e, exOwner.cookie, e.orgId, 403);
    for (const status of ["em_analise", "suspensa"] as const) {
      const owner = await createAuthenticatedUser();
      const org = await createTestOrganization(owner.userId, { status });
      await expectDenied(e, owner.cookie, org.id, 403);
    }
  });

  it("autorização relida SOB O LOCK: proprietário rebaixado na hora da requisição não renomeia", async () => {
    const e = await setup();
    const second = await createAuthenticatedUser();
    await addMembership(e.orgId, second.userId, "proprietario");
    await db.updateTable("memberships").set({ role: "voluntario" }).where("userId", "=", second.userId).where("organizationId", "=", e.orgId).execute();
    await expectDenied(e, second.cookie, e.orgId, 403);
  });
});

describe("validação do nome: 400 e nada é alterado", () => {
  const BAD: Array<[string, unknown]> = [
    ["vazio", ""], ["só espaços", "     "], ["1 caractere", "a"], ["121 caracteres", "x".repeat(121)], ["enorme", "x".repeat(100000)],
    ["null", null], ["número", 12345], ["lista", ["a", "b"]], ["objeto", { a: 1 }], ["booleano", true], ["ausente", undefined],
    ["caractere de controle", "Nome" + String.fromCharCode(0) + "Ruim"], ["quebra de linha", "Linha1" + String.fromCharCode(10) + "Linha2"],
  ];
  for (const [label, name] of BAD) {
    it(`${label} ⇒ 400, sem alteração e sem auditoria`, async () => {
      const e = await setup();
      const before = await orgRow(e.orgId);
      const audits = await auditCount();
      const res = await rename(e.owner.cookie, { organizationId: e.orgId, ...(name === undefined ? {} : { name }) });
      expect(res.status).toBe(400);
      expect(await orgRow(e.orgId)).toEqual(before);
      expect(await auditCount()).toBe(audits);
    });
  }

  it("só o NOME é aceito: slug, tipo, status, cidade, estado, documento, proprietário e membros no corpo ⇒ 400 (corpo estrito)", async () => {
    const e = await setup();
    const before = await orgRow(e.orgId);
    for (const extra of [{ slug: "hack" }, { type: "ong" }, { status: "suspensa" }, { city: "X" }, { state: "SP" }, { documentId: "123" }, { createdByUserId: 1 }, { ownerId: 1 }, { members: [] }]) {
      const res = await rename(e.owner.cookie, { organizationId: e.orgId, name: "Nome Válido", ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await orgRow(e.orgId)).toEqual(before);
    // limites exatos aceitos: 2 e 120 caracteres
    expect((await rename(e.owner.cookie, { organizationId: e.orgId, name: "ab" })).status).toBe(200);
    expect((await rename(e.owner.cookie, { organizationId: e.orgId, name: "y".repeat(120) })).status).toBe(200);
    expect((await orgRow(e.orgId)).name).toBe("y".repeat(120));
  });

  it("organização inexistente / id inválido ⇒ recusado sem efeito (403 ou 400)", async () => {
    const e = await setup();
    const audits = await auditCount();
    for (const organizationId of [999999, 0, -1, "abc", null]) {
      const res = await rename(e.owner.cookie, { organizationId, name: "Qualquer Nome" });
      expect([400, 403, 404], String(organizationId)).toContain(res.status);
    }
    expect(await auditCount()).toBe(audits);
  });
});

describe("contrato da interface (estático)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("diálogo: sem atualização otimista (recarrega do servidor), estados de carregamento/erro, só edita o nome; botão só para o proprietário de organização ativa", () => {
    const dlg = read("src/components/RenameOrganizationDialog.tsx");
    expect(dlg).toMatch(/invalidateQueries\(\{ queryKey: \["organizations"\] \}\)/);
    expect(dlg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/setQueryData|optimistic|onMutate/);
    expect(dlg).toMatch(/audit-log/); // a trilha de auditoria da tela também é recarregada
    expect(dlg).toMatch(/isPending/);
    expect(dlg).toMatch(/role="alert"/);
    expect(dlg).toMatch(/Salvando/);
    expect(dlg).not.toMatch(/localStorage|sessionStorage/);
    const page = read("src/pages/organizacoes.$organizationId.tsx");
    expect(page).toMatch(/org\.myRole === "proprietario" && org\.status === "ativa"/);
    expect(page).toMatch(/<RenameOrganizationDialog organizationId=\{organizationId\} currentName=\{org\.name\}/);
    const endpoint = read("src/endpoints/organization-name_POST.ts");
    expect(endpoint).toMatch(/propriedade\.gerencie/);
    expect(endpoint.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\.set\(\{[^}]*(slug|type|status|city|state|documentId)/);
  });
});

void sql;
