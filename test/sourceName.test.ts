/**
 * Edição do NOME da fonte (somente `sources.name`): só administrador da plataforma, com auditoria e sem tocar em nenhum campo
 * operacional (tipo, conector, acesso, credencial, permissões, status, execução). Endpoint real, Postgres real e DESCARTÁVEL.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "../src/helpers/db";
import * as auditModule from "../src/helpers/auditLog";
import { handle as postName } from "../src/endpoints/source-name_POST";
import { handle as getRegistry } from "../src/endpoints/opportunity-registry_GET";
import { handle as getSources } from "../src/endpoints/sources_GET";
import {
  addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestOpportunityRegistry, createTestOrganization, parseJson,
} from "./helpers";

/** Fonte com TODOS os campos operacionais preenchidos com valores não padrão (para provar que nenhum muda). */
async function fullSource(adminId: number, orgId: number, name = "Fonte Original") {
  const s = await db
    .insertInto("sources")
    .values({
      name, type: "outro", connectorKey: "manual", endpointOrAddress: "https://exemplo.invalid/api", accessMethod: "api", status: "ativa", credentialRef: "ref-secreta-nao-exibir",
      authorizingOrganizationId: orgId, permissions: { ler: true }, rateLimitPerRun: 7, policyNotes: "notas de política", connectionState: "conectado", runFrequencyMinutes: 15,
      recentErrors: [{ em: "x" }], lastValidatedAt: new Date("2026-01-01T00:00:00Z"), lastRunAt: new Date("2026-01-02T00:00:00Z"), nextRunAt: new Date("2026-01-03T00:00:00Z"), createdByUserId: adminId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return s.id;
}
async function setup() {
  const admin = await createPlatformAdmin();
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const operador = await createAuthenticatedUser();
  await addMembership(org.id, operador.userId, "operador");
  const common = await createAuthenticatedUser();
  const sourceId = await fullSource(admin.userId, org.id);
  const otherSourceId = await fullSource(admin.userId, org.id, "Outra Fonte");
  return { admin, owner, operador, common, orgId: org.id, sourceId, otherSourceId };
}
type Env = Awaited<ReturnType<typeof setup>>;

const rename = (cookie: string | undefined, body: unknown) => postName(buildRequest("source-name", { method: "POST", cookie, body }));
const row = (id: number) => db.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const audits = () => db.selectFrom("auditLog").selectAll().where("action", "=", "fonte.nome_alterado").orderBy("id").execute();
const auditCount = async () => Number((await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);

describe("administrador da plataforma renomeia a fonte", () => {
  it("200: só `name` muda (todos os demais campos idênticos); auditoria com a fonte, o ator e os dois nomes", async () => {
    const e = await setup();
    const before = await row(e.sourceId);
    const otherBefore = await row(e.otherSourceId);
    const res = await rename(e.admin.cookie, { sourceId: e.sourceId, name: "  Fonte Renomeada  " });
    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({ changed: true, source: { id: e.sourceId, name: "Fonte Renomeada" } });
    const after = await row(e.sourceId);
    const { name: _a, updatedAt: _b, ...restBefore } = before;
    const { name: _c, updatedAt: _d, ...restAfter } = after;
    expect(after.name).toBe("Fonte Renomeada");
    expect(restAfter).toEqual(restBefore); // type, connectorKey, endpoint, accessMethod, credentialRef, authorizingOrganizationId, permissions, status, connectionState, execução…
    expect(await row(e.otherSourceId)).toEqual(otherBefore);
    const [a] = await audits();
    expect(a).toMatchObject({ organizationId: null, actorUserId: e.admin.userId, entityType: "source", entityId: String(e.sourceId) });
    expect(a.metadata).toEqual({ nomeAnterior: "Fonte Original", nomeNovo: "Fonte Renomeada" });
    expect(JSON.stringify(a)).not.toContain("ref-secreta"); // nenhuma referência de credencial na auditoria
  });

  it("nome igual (após normalizar): 200 changed=false, sem escrita e sem auditoria", async () => {
    const e = await setup();
    const before = await row(e.sourceId);
    const res = await rename(e.admin.cookie, { sourceId: e.sourceId, name: "   Fonte Original  " });
    expect(res.status).toBe(200);
    expect((await parseJson<{ changed: boolean }>(res)).changed).toBe(false);
    expect(await row(e.sourceId)).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });

  it("o novo nome aparece nas telas que o exibem (lista de descobertas) e nada mais na descoberta muda", async () => {
    const e = await setup();
    const opp = await createTestOpportunityRegistry(e.sourceId, e.admin.userId, { status: "validada" });
    expect((await rename(e.admin.cookie, { sourceId: e.sourceId, name: "Fonte Nova" })).status).toBe(200);
    const list = await parseJson<{ opportunities: Array<{ id: number; sourceName: string; status: string }> }>(await getRegistry(buildRequest("opportunity-registry", { cookie: e.admin.cookie })));
    expect(list.opportunities.find((o) => o.id === opp.id)).toMatchObject({ sourceName: "Fonte Nova", status: "validada" });
  });

  it("a listagem de fontes devolve o nome confirmado e NUNCA expõe a referência de credencial", async () => {
    const e = await setup();
    await rename(e.admin.cookie, { sourceId: e.sourceId, name: "Fonte Confirmada" });
    const text = await (await getSources(buildRequest("sources", { cookie: e.admin.cookie }))).text();
    expect(text).toContain("Fonte Confirmada");
    expect(text).not.toContain("ref-secreta");
    expect(text).not.toMatch(/credentialRef/);
  });

  it("concorrência: duas renomeações encadeiam as auditorias; uma escrita operacional simultânea (status) não é perdida", async () => {
    const e = await setup();
    const [a, b] = await Promise.all([rename(e.admin.cookie, { sourceId: e.sourceId, name: "Nome A" }), rename(e.admin.cookie, { sourceId: e.sourceId, name: "Nome B" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [first, second] = (await audits()).map((x) => x.metadata as { nomeAnterior: string; nomeNovo: string });
    expect(second.nomeAnterior).toBe(first.nomeNovo);
    expect((await row(e.sourceId)).name).toBe(second.nomeNovo);

    const [c] = await Promise.all([rename(e.admin.cookie, { sourceId: e.sourceId, name: "Nome C" }), db.updateTable("sources").set({ status: "erro", connectionState: "erro" }).where("id", "=", e.sourceId).execute()]);
    expect(c.status).toBe(200);
    const final = await row(e.sourceId);
    expect(final).toMatchObject({ name: "Nome C", status: "erro", connectionState: "erro" }); // sem atualização perdida
  });
});

describe("quem NÃO pode renomear: 401/403, sem nenhum efeito", () => {
  async function denied(e: Env, cookie: string | undefined, expected: number) {
    const before = await row(e.sourceId);
    const count = await auditCount();
    expect((await rename(cookie, { sourceId: e.sourceId, name: "Tentativa Indevida" })).status).toBe(expected);
    expect(await row(e.sourceId)).toEqual(before);
    expect(await auditCount()).toBe(count);
  }
  it("sem sessão ⇒ 401", async () => denied(await setup(), undefined, 401));
  it("usuário comum, operador e proprietário de organização (não são administradores da plataforma) ⇒ 403", async () => {
    const e = await setup();
    for (const user of [e.common, e.operador, e.owner]) await denied(e, user.cookie, 403);
  });
  it("fonte inexistente ⇒ 404 para o administrador, sem auditoria; id inválido ⇒ 400", async () => {
    const e = await setup();
    const count = await auditCount();
    expect((await rename(e.admin.cookie, { sourceId: 999999, name: "Qualquer Nome" })).status).toBe(404);
    for (const sourceId of [0, -1, "abc", null]) expect((await rename(e.admin.cookie, { sourceId, name: "Qualquer Nome" })).status, String(sourceId)).toBe(400);
    expect(await auditCount()).toBe(count);
  });
});

describe("validação: 400 e nenhum efeito", () => {
  const BAD: Array<[string, unknown]> = [
    ["vazio", ""], ["só espaços", "     "], ["1 caractere", "a"], ["121 caracteres", "x".repeat(121)], ["enorme", "x".repeat(100000)], ["null", null], ["número", 123],
    ["lista", ["a"]], ["objeto", { a: 1 }], ["booleano", true], ["ausente", undefined], ["controle", "Fonte" + String.fromCharCode(0) + "X"], ["quebra de linha", "A" + String.fromCharCode(10) + "B"],
  ];
  for (const [label, name] of BAD) {
    it(`${label} ⇒ 400`, async () => {
      const e = await setup();
      const before = await row(e.sourceId);
      const count = await auditCount();
      expect((await rename(e.admin.cookie, { sourceId: e.sourceId, ...(name === undefined ? {} : { name }) })).status).toBe(400);
      expect(await row(e.sourceId)).toEqual(before);
      expect(await auditCount()).toBe(count);
    });
  }

  it("corpo ESTRITO: tipo, conector, acesso, credencial, organização, permissões, política, status, conexão, execução, id, autor e datas ⇒ 400 (nada muda)", async () => {
    const e = await setup();
    const before = await row(e.sourceId);
    const extras: Array<Record<string, unknown>> = [
      { type: "api" }, { connectorKey: "outro" }, { endpointOrAddress: "x" }, { accessMethod: "y" }, { credentialRef: "novo" }, { authorizingOrganizationId: e.orgId },
      { permissions: {} }, { policyNotes: "n" }, { status: "ativa" }, { connectionState: "conectado" }, { runFrequencyMinutes: 1 }, { rateLimitPerRun: 1 },
      { lastRunAt: new Date() }, { nextRunAt: new Date() }, { recentErrors: [] }, { id: 1 }, { createdByUserId: 1 }, { createdAt: new Date() }, { updatedAt: new Date() },
    ];
    for (const extra of extras) expect((await rename(e.admin.cookie, { sourceId: e.sourceId, name: "Nome Válido", ...extra })).status, JSON.stringify(Object.keys(extra))).toBe(400);
    expect(await row(e.sourceId)).toEqual(before);
    // limites exatos aceitos
    expect((await rename(e.admin.cookie, { sourceId: e.sourceId, name: "ab" })).status).toBe(200);
    expect((await rename(e.admin.cookie, { sourceId: e.sourceId, name: "z".repeat(120) })).status).toBe(200);
  });

  it("fonte já cadastrada com nome LONGO (>120, permitido na criação) continua funcionando e pode ser renomeada para um nome válido", async () => {
    const e = await setup();
    const longId = await fullSource(e.admin.userId, e.orgId, "L".repeat(300));
    expect((await rename(e.admin.cookie, { sourceId: longId, name: "L".repeat(300) })).status).toBe(400); // reenviar o mesmo nome longo é recusado (teto da edição)
    expect((await row(longId)).name).toBe("L".repeat(300)); // a fonte não foi invalidada
    expect((await rename(e.admin.cookie, { sourceId: longId, name: "Nome Curto" })).status).toBe(200);
  });
});

describe("atomicidade", () => {
  it("se a auditoria falha, a renomeação é DESFEITA (nome e auditoria inalterados) e a resposta é erro", async () => {
    const e = await setup();
    const before = await row(e.sourceId);
    const spy = vi.spyOn(auditModule, "recordAuditLogEntry").mockRejectedValueOnce(new Error("falha simulada da auditoria"));
    try {
      const res = await rename(e.admin.cookie, { sourceId: e.sourceId, name: "Nome Que Deve Desfazer" });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    expect(await row(e.sourceId)).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
});

describe("contrato da interface (estático)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("diálogo: sem atualização otimista (recarrega as fontes do servidor), carregamento/erro, não exibe dado operacional; ação na lista de fontes da plataforma", () => {
    const dlg = read("src/components/RenameSourceDialog.tsx");
    expect(dlg).toMatch(/invalidateQueries\(\{ queryKey: \["sources"\] \}\)/);
    expect(strip(dlg)).not.toMatch(/setQueryData|optimistic|onMutate/);
    expect(dlg).toMatch(/isPending/);
    expect(dlg).toMatch(/role="alert"/);
    expect(dlg).toMatch(/Salvando/);
    expect(strip(dlg)).not.toMatch(/credential|connectorKey|endpointOrAddress|localStorage|sessionStorage/i);
    const page = read("src/pages/plataforma.tsx");
    expect(page).toMatch(/<RenameSourceDialog source=\{renameSource\}/);
    expect(page).toMatch(/setRenameSource\(\{ id: s\.id, name: s\.name \}\)/);
    const endpoint = strip(read("src/endpoints/source-name_POST.ts"));
    expect(endpoint).toMatch(/requirePlatformAdmin/);
    expect(endpoint).toMatch(/\.set\(\{ name: input\.name \}\)/); // o UPDATE só escreve `name`
  });
});
