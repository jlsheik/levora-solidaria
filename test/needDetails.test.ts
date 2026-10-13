/**
 * Edição CADASTRAL da necessidade (título, descrição, prioridade): `necessidades.gerencie`, sem aprovação, com auditoria; NÃO toca em
 * quantidade, unidade, item, status, ledger nem estoque; o matching lê a necessidade viva na próxima avaliação e as avaliações antigas
 * permanecem imutáveis. Endpoint real, Postgres real e DESCARTÁVEL.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "../src/helpers/db";
import * as auditModule from "../src/helpers/auditLog";
import { handle as postDetails } from "../src/endpoints/need-details_POST";
import { handle as postStatus } from "../src/endpoints/needs-status_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as getNeeds } from "../src/endpoints/needs_GET";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import {
  addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource, parseJson,
  type AuthenticatedTestUser,
} from "./helpers";

interface Env {
  owner: AuthenticatedTestUser; admin: AuthenticatedTestUser; operador: AuthenticatedTestUser; voluntario: AuthenticatedTestUser; stranger: AuthenticatedTestUser;
  otherOwner: AuthenticatedTestUser; orgId: number; otherOrgId: number; itemId: number; needId: number; otherNeedId: number;
}

async function setup(): Promise<Env> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  const operador = await createAuthenticatedUser();
  const voluntario = await createAuthenticatedUser();
  const stranger = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  await addMembership(org.id, operador.userId, "operador");
  await addMembership(org.id, voluntario.userId, "voluntario");
  const otherOwner = await createAuthenticatedUser();
  const otherOrg = await createTestOrganization(otherOwner.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
  const mk = async (orgId: number, userId: number, title: string, itemId: number | null) =>
    (
      await db
        .insertInto("needs")
        .values({ organizationId: orgId, title, description: "Descrição original", quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: userId, itemId })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  return { owner, admin, operador, voluntario, stranger, otherOwner, orgId: org.id, otherOrgId: otherOrg.id, itemId: item.id, needId: await mk(org.id, owner.userId, "Cestas básicas", item.id), otherNeedId: await mk(otherOrg.id, otherOwner.userId, "Necessidade de outra org", null) };
}

const edit = (cookie: string | undefined, body: unknown) => postDetails(buildRequest("need-details", { method: "POST", cookie, body }));
const needRow = (id: number) => db.selectFrom("needs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const auditsOf = (needId?: number) => {
  let q = db.selectFrom("auditLog").selectAll().where("action", "=", "necessidade.editada");
  if (needId !== undefined) q = q.where("entityId", "=", String(needId));
  return q.orderBy("id").execute();
};
const auditCount = async () => Number((await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
/** tudo o que NÃO pode mudar numa edição cadastral */
async function operationalSnapshot(e: Env) {
  const n = await needRow(e.needId);
  return JSON.stringify({
    fixed: { id: n.id, organizationId: n.organizationId, itemId: n.itemId, quantityNeeded: n.quantityNeeded, unit: n.unit, status: n.status, createdByUserId: n.createdByUserId, createdAt: n.createdAt },
    stock: await db.selectFrom("stockTransactions").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
    ledger: await db.selectFrom("needFulfillments").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
    items: await db.selectFrom("inventoryItems").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
    resolutions: await db.selectFrom("needResolutions").selectAll().orderBy("id").execute(),
    allocations: await db.selectFrom("opportunityAllocations").selectAll().where("organizationId", "=", e.orgId).orderBy("id").execute(),
  });
}

describe("quem pode editar: proprietário, administrador e operador ativos", () => {
  for (const role of ["owner", "admin", "operador"] as const) {
    it(`${role}: 200, só título/descrição/prioridade mudam; auditoria com organização, ator e antes/depois`, async () => {
      const e = await setup();
      const before = await needRow(e.needId);
      const snap = await operationalSnapshot(e);
      const res = await edit(e[role].cookie, { organizationId: e.orgId, needId: e.needId, title: "  Cestas básicas urgentes  ", description: "Nova descrição\ncom duas linhas", priority: "critica" });
      expect(res.status).toBe(200);
      expect(await parseJson(res)).toEqual({ changed: true, need: { id: e.needId, title: "Cestas básicas urgentes", description: "Nova descrição\ncom duas linhas", priority: "critica" } });
      const after = await needRow(e.needId);
      expect(after).toMatchObject({ title: "Cestas básicas urgentes", description: "Nova descrição\ncom duas linhas", priority: "critica" });
      const { title: _t, description: _d, priority: _p, updatedAt: _u, ...restBefore } = before;
      const { title: _t2, description: _d2, priority: _p2, updatedAt: _u2, ...restAfter } = after;
      expect(restAfter).toEqual(restBefore);
      expect(await operationalSnapshot(e)).toBe(snap);
      const [a] = await auditsOf();
      expect(a).toMatchObject({ organizationId: e.orgId, actorUserId: e[role].userId, entityType: "need", entityId: String(e.needId) });
      expect(a.metadata).toEqual({ alteracoes: { title: { de: "Cestas básicas", para: "Cestas básicas urgentes" }, description: { de: "Descrição original", para: "Nova descrição\ncom duas linhas" }, priority: { de: "media", para: "critica" } } });
    });
  }

  it("edição parcial: só os campos enviados mudam e só eles entram na auditoria; descrição vazia/null limpa o campo", async () => {
    const e = await setup();
    expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, priority: "alta" })).status).toBe(200);
    expect(await needRow(e.needId)).toMatchObject({ title: "Cestas básicas", description: "Descrição original", priority: "alta" });
    expect((await auditsOf())[0].metadata).toEqual({ alteracoes: { priority: { de: "media", para: "alta" } } });
    for (const description of ["   ", null]) {
      await db.updateTable("needs").set({ description: "texto" }).where("id", "=", e.needId).execute();
      expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, description })).status).toBe(200);
      expect((await needRow(e.needId)).description).toBeNull();
    }
  });

  it("valores iguais aos atuais (após normalizar): 200 changed=false, nenhuma escrita (updated_at intacto) e nenhuma auditoria", async () => {
    const e = await setup();
    const before = await needRow(e.needId);
    const res = await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: "  Cestas básicas ", description: " Descrição original  ", priority: "media" });
    expect(res.status).toBe(200);
    expect((await parseJson<{ changed: boolean }>(res)).changed).toBe(false);
    expect(await needRow(e.needId)).toEqual(before);
    expect(await auditsOf()).toHaveLength(0);
  });
});

describe("quem NÃO pode: 401/403/404, sem nenhum efeito", () => {
  async function denied(e: Env, cookie: string | undefined, body: Record<string, unknown>, expected: number) {
    const before = await needRow(Number(body.needId));
    const count = await auditCount();
    expect((await edit(cookie, body)).status).toBe(expected);
    expect(await needRow(Number(body.needId))).toEqual(before);
    expect(await auditCount()).toBe(count);
  }
  it("voluntário ⇒ 403; usuário sem vínculo ⇒ 403; sem sessão ⇒ 401", async () => {
    const e = await setup();
    const body = { organizationId: e.orgId, needId: e.needId, title: "Tentativa indevida" };
    await denied(e, e.voluntario.cookie, body, 403);
    await denied(e, e.stranger.cookie, body, 403);
    await denied(e, undefined, body, 401);
  });
  it("proprietário de OUTRA organização ⇒ 403 (organização A) e 404 ao apontar a necessidade de B pela organização A (sem vazar)", async () => {
    const e = await setup();
    await denied(e, e.otherOwner.cookie, { organizationId: e.orgId, needId: e.needId, title: "Invasão de outra org" }, 403);
    // proprietário de A usando a organização A com o id da necessidade de B: não existe NA organização A
    await denied(e, e.owner.cookie, { organizationId: e.orgId, needId: e.otherNeedId, title: "Invasão por id" }, 404);
    // e o inverso
    await denied(e, e.owner.cookie, { organizationId: e.otherOrgId, needId: e.otherNeedId, title: "Invasão inversa" }, 403);
  });
  it("membro INATIVO ⇒ 403; organização em análise ou suspensa ⇒ 403 (mesmo guard da criação)", async () => {
    const e = await setup();
    const ex = await createAuthenticatedUser();
    await addMembership(e.orgId, ex.userId, "operador", "inativo");
    await denied(e, ex.cookie, { organizationId: e.orgId, needId: e.needId, title: "Membro inativo" }, 403);
    for (const status of ["em_analise", "suspensa"] as const) {
      await db.updateTable("organizations").set({ status }).where("id", "=", e.orgId).execute();
      await denied(e, e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: `Org ${status}` }, 403);
    }
  });
  it("necessidade inexistente ⇒ 404; ids inválidos ⇒ 400", async () => {
    const e = await setup();
    const count = await auditCount();
    expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: 999999, title: "Qualquer coisa" })).status).toBe(404);
    for (const needId of [0, -1, "abc", null]) expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId, title: "Qualquer coisa" })).status, String(needId)).toBe(400);
    expect(await auditCount()).toBe(count);
  });
});

describe("validação: 400 e nenhum efeito", () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ["título vazio", { title: "" }], ["título só espaços", { title: "     " }], ["título curto", { title: "ab" }], ["título com 201 caracteres", { title: "t".repeat(201) }],
    ["título com controle", { title: "Ruim" + String.fromCharCode(0) + "X" }], ["título com quebra de linha", { title: "A" + String.fromCharCode(10) + "B" }], ["título null", { title: null }], ["título número", { title: 123 }],
    ["descrição com 2001 caracteres", { description: "d".repeat(2001) }], ["descrição com controle", { description: "x" + String.fromCharCode(0) + "y" }], ["descrição número", { description: 5 }], ["descrição lista", { description: ["a"] }],
    ["prioridade inválida", { priority: "urgentissima" }], ["prioridade null", { priority: null }], ["prioridade número", { priority: 3 }], ["prioridade vazia", { priority: "" }],
    ["nenhum campo", {}],
  ];
  for (const [label, extra] of BAD) {
    it(`${label} ⇒ 400`, async () => {
      const e = await setup();
      const before = await needRow(e.needId);
      const count = await auditCount();
      expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, ...extra })).status).toBe(400);
      expect(await needRow(e.needId)).toEqual(before);
      expect(await auditCount()).toBe(count);
    });
  }

  it("corpo ESTRITO: quantidade, unidade, item, organização de destino, status, id, autor e datas ⇒ 400 mesmo junto de campos válidos; nada muda", async () => {
    const e = await setup();
    const before = await needRow(e.needId);
    const extras: Array<Record<string, unknown>> = [
      { quantityNeeded: 1 }, { quantity: 1 }, { unit: "caixas" }, { itemId: 99 }, { item: 1 }, { status: "atendida" }, { organizationIdNovo: e.otherOrgId }, { targetOrganizationId: e.otherOrgId }, { id: 1 },
      { createdByUserId: 1 }, { createdAt: new Date() }, { updatedAt: new Date() }, { fulfilled: 1 }, { surplus: 1 },
    ];
    for (const extra of extras) expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: "Título Válido", ...extra })).status, JSON.stringify(Object.keys(extra))).toBe(400);
    expect(await needRow(e.needId)).toEqual(before);
    // limites exatos aceitos: título de 3 e de 200, descrição de 2000
    for (const body of [{ title: "abc" }, { title: "t".repeat(200) }, { description: "d".repeat(2000) }]) expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, ...body })).status).toBe(200);
  });

  it("dados antigos acima do teto continuam válidos e editáveis campo a campo: descrição legada longa não impede corrigir só o título", async () => {
    const e = await setup();
    await db.updateTable("needs").set({ title: "L".repeat(500), description: "D".repeat(5000) }).where("id", "=", e.needId).execute();
    expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: "Título curto e correto" })).status).toBe(200);
    const n = await needRow(e.needId);
    expect(n.title).toBe("Título curto e correto");
    expect(n.description).toBe("D".repeat(5000)); // intacta (nenhum dado antigo é alterado automaticamente)
    expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, description: "D".repeat(5000) })).status).toBe(400); // reenviar o valor longo é recusado
  });
});

describe("atomicidade e concorrência", () => {
  it("se a auditoria falha, a edição é DESFEITA (necessidade e auditoria inalteradas)", async () => {
    const e = await setup();
    const before = await needRow(e.needId);
    const spy = vi.spyOn(auditModule, "recordAuditLogEntry").mockRejectedValueOnce(new Error("falha simulada da auditoria"));
    try {
      expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: "Deve ser desfeito" })).status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    expect(await needRow(e.needId)).toEqual(before);
    expect(await auditsOf()).toHaveLength(0);
  });

  it("edição × mudança de STATUS simultâneas: nenhuma sobrescreve a outra (status novo E campos editados)", async () => {
    const e = await setup();
    for (let round = 0; round < 3; round++) {
      const status = round % 2 === 0 ? "cancelada" : "aberta"; // ("atendida" exigiria saldo do item)
      const [d, s] = await Promise.all([
        edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: `Título rodada ${round}`, priority: round % 2 === 0 ? "alta" : "baixa" }),
        postStatus(buildRequest("needs-status", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, needId: e.needId, status } })),
      ]);
      expect([d.status, s.status]).toEqual([200, 200]);
      expect(await needRow(e.needId)).toMatchObject({ title: `Título rodada ${round}`, status, priority: round % 2 === 0 ? "alta" : "baixa", unit: "kg", quantityNeeded: "300.000", itemId: e.itemId });
    }
  });

  it("edição × RECEBIMENTO (ledger/estoque) simultâneos: ambos concluem, sem deadlock; quantidade/unidade/item intactos e o ledger/estoque são só os do recebimento", async () => {
    const e = await setup();
    for (let round = 0; round < 3; round++) {
      const platform = await createAuthenticatedUser();
      const source = await createTestSource(platform.userId);
      const opp = await createTestOpportunityRegistry(source.id, platform.userId, { status: "reservada" });
      const al = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "100", status: "aceita", needId: e.needId }).returning("id").executeTakeFirstOrThrow();
      const [d, r] = await Promise.all([
        edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: `Título durante recebimento ${round}`, description: `desc ${round}` }),
        postReceive(buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId: al.id, itemId: e.itemId, quantityReceived: 40 } })),
      ]);
      expect([d.status, r.status]).toEqual([200, 200]);
      const n = await needRow(e.needId);
      expect(n).toMatchObject({ title: `Título durante recebimento ${round}`, unit: "kg", quantityNeeded: "300.000", itemId: e.itemId, status: "aberta" });
    }
    const ledgerSum = await db.selectFrom("needFulfillments").select((eb) => eb.fn.sum("quantity").as("t")).where("needId", "=", e.needId).executeTakeFirstOrThrow();
    const stockSum = await db.selectFrom("stockTransactions").select((eb) => eb.fn.sum("delta").as("t")).where("itemId", "=", e.itemId).executeTakeFirstOrThrow();
    expect(Number(ledgerSum.t)).toBe(120); // 3 × 40: o ledger é só o dos recebimentos
    expect(Number(stockSum.t)).toBe(120);
  });

  it("duas edições simultâneas encadeiam as auditorias (de → para sem lacuna) e o resultado final é o da última", async () => {
    const e = await setup();
    const [a, b] = await Promise.all([edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: "Título A" }), edit(e.admin.cookie, { organizationId: e.orgId, needId: e.needId, title: "Título B" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const metas = (await auditsOf()).map((x) => (x.metadata as { alteracoes: { title: { de: string; para: string } } }).alteracoes.title);
    expect(metas[0].de).toBe("Cestas básicas");
    expect(metas[1].de).toBe(metas[0].para);
    expect((await needRow(e.needId)).title).toBe(metas[1].para);
  });
});

describe("matching: lê a necessidade VIVA na próxima avaliação; avaliações antigas são preservadas (imutáveis)", () => {
  it("editar a prioridade não cria nem altera avaliação/atribuição; a avaliação SEGUINTE usa a prioridade nova e a anterior segue intacta", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const need = await db.insertInto("needs").values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "50", unit: "kg", priority: "baixa", status: "aberta", createdByUserId: owner.userId }).returning("id").executeTakeFirstOrThrow();
    const platform = await createAuthenticatedUser();
    const source = await createTestSource(platform.userId);
    const opp = await createTestOpportunityRegistry(source.id, platform.userId, { status: "aguardando_destinacao" });
    await db.updateTable("opportunityRegistry").set({ title: "Alimentos diversos de mercado", category: "Alimentos", quantity: "5", unit: "kg" }).where("id", "=", opp.id).execute();

    const evalRows = () => db.selectFrom("matchEvaluations").select(["id", "needId", "criteria", "decision", "algorithmVersion"]).where("opportunityRegistryId", "=", opp.id).orderBy("id").execute();
    await runMatchingForOpportunity(opp.id, null);
    const first = await evalRows();
    expect(first.length).toBeGreaterThan(0);
    const urgency = (row: (typeof first)[number]) => (row.criteria as Record<string, { score: number | null; detail: string }>).necessidadeUrgencia;
    expect(urgency(first[0]).detail).toContain("baixa");
    const allocationsBefore = await db.selectFrom("opportunityAllocations").selectAll().execute();

    // a edição NÃO dispara avaliação, reserva ou atribuição, e não reescreve o que já foi avaliado
    expect((await edit((await ownerCookie(owner)), { organizationId: org.id, needId: need.id, priority: "critica", title: "Alimentos não perecíveis (urgente)" })).status).toBe(200);
    const afterEdit = await evalRows();
    expect(JSON.stringify(afterEdit)).toBe(JSON.stringify(first));
    expect(await db.selectFrom("opportunityAllocations").selectAll().execute()).toEqual(allocationsBefore);

    // a próxima avaliação (o mesmo caminho da varredura periódica) usa a prioridade viva; a linha antiga NÃO muda
    await runMatchingForOpportunity(opp.id, null);
    const second = await evalRows();
    expect(second.length).toBeGreaterThan(first.length);
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    const fresh = second[second.length - 1];
    expect(urgency(fresh).detail).toContain("critica");
    expect(urgency(fresh).score).toBe(100);
  });
});

async function ownerCookie(owner: AuthenticatedUser): Promise<string> {
  return owner.cookie;
}
type AuthenticatedUser = AuthenticatedTestUser;

describe("a tela mostra os valores persistidos (leitura pelo servidor)", () => {
  it("needs_GET devolve título/descrição/prioridade editados e quantidade/unidade/status como estavam", async () => {
    const e = await setup();
    expect((await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, title: "Título persistido", description: "Descrição persistida", priority: "alta" })).status).toBe(200);
    const list = await parseJson<{ needs: Array<{ id: number; title: string; description: string | null; priority: string; quantityNeeded: number; unit: string; status: string }> }>(
      await getNeeds(buildRequest(`needs?organizationId=${e.orgId}`, { cookie: e.operador.cookie }))
    );
    expect(list.needs.find((n) => n.id === e.needId)).toMatchObject({ title: "Título persistido", description: "Descrição persistida", priority: "alta", quantityNeeded: 300, unit: "kg", status: "aberta" });
  });

  it("contrato estático: diálogo sem atualização otimista, recarrega do servidor, envia só campos alterados, não oferece quantidade/unidade/item/status; ação só para quem gerencia", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const dlg = read("src/components/EditNeedDialog.tsx");
    expect(dlg).toMatch(/invalidateQueries\(\{ queryKey: \["needs", organizationId\] \}\)/);
    expect(dlg).toMatch(/audit-log/);
    expect(strip(dlg)).not.toMatch(/setQueryData|optimistic|onMutate/);
    expect(dlg).toMatch(/isPending/);
    expect(dlg).toMatch(/role="alert"/);
    expect(dlg).toMatch(/Salvando/);
    expect(dlg).toMatch(/\.\.\.\(titleChanged \? \{ title \} : \{\}\)/); // só o que mudou
    expect(strip(dlg)).not.toMatch(/quantityNeeded|itemId|\bunit\b|status:/); // (só `err.status` aparece, para mapear o erro)
    const page = read("src/pages/organizacoes.$organizationId.necessidades.tsx");
    expect(page).toMatch(/<EditNeedDialog organizationId=\{organizationId\} need=\{editNeed\}/);
    expect(page).toMatch(/\{canManage && \(\s*<Button variant="ghost" size="icon-sm" onClick=\{\(\) => setEditNeed/);
    const endpoint = strip(read("src/endpoints/need-details_POST.ts"));
    expect(endpoint).toMatch(/necessidades\.gerencie/);
    expect(endpoint).toMatch(/\.set\(\{ title: next\.title, description: next\.description, priority: next\.priority \}\)/);
    expect(endpoint).toMatch(/forNoKeyUpdate\(\)/);
    expect(endpoint).not.toMatch(/needFulfillments|stockTransactions|runMatching|opportunityAllocations/);
  });

  it("interação seletor de prioridade × diálogo × Salvar (QA no navegador): sem paliativos sobre as camadas do Radix; Salvar por teclado; escolher a opção só altera o estado local", async () => {
    // Causa comprovada no navegador: com a lista do Select aberta, o Radix põe `pointer-events: none` no conteúdo do diálogo (camada abaixo) e o
    // 1º clique fora cai no overlay, que só FECHA a lista (igual a um <select> nativo). É o comportamento do design system, não um defeito do
    // diálogo; contorná-lo exigiria mexer em camadas/ponteiros e quebraria foco e teclado. Este teste trava o contrato que mantém o caminho correto:
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const dlg = strip(readFileSync("src/components/EditNeedDialog.tsx", "utf8"));
    const css = strip(readFileSync("src/components/EditNeedDialog.module.css", "utf8"));
    expect(dlg).toMatch(/from "\.\/Select"/); // Select compartilhado (Radix), sem versão própria
    expect(dlg).toMatch(/onValueChange=\{\(v\) => setPriority\(v as NeedPriority\)\}/); // escolher só altera o estado local; não salva sozinho
    expect(dlg).toMatch(/<form[\s\S]*onSubmit=/); // Enter no formulário e Enter no botão salvam (teclado)
    expect(dlg).toMatch(/<Button (ref=\{saveRef\} )?type="submit"/);
    expect(dlg).not.toMatch(/onInteractOutside|onPointerDownOutside|onFocusOutside|modal=|pointerEvents|pointer-events|setTimeout|requestAnimationFrame/);
    expect(css).not.toMatch(/pointer-events|z-index/);
  });

  it("acessibilidade/teclado (QA em Edge real via CDP): seletor com nome acessível, avisos ligados aos campos, foco devolvido ao abridor e ao Salvar após erro", () => {
    // Defeitos reais achados no navegador: (1) o combobox da prioridade tinha nome acessível VAZIO (o rótulo era um <span> solto); (2) ao fechar
    // (Escape/Cancelar/salvar) o foco ia para o <body>, pois o diálogo é controlado de fora e o Radix não tem DialogTrigger para devolver o foco;
    // (3) após um erro o foco ficava no <body> (Salvar desabilitado durante o envio); (4) avisos de validação não estavam ligados ao campo.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const dlg = strip(readFileSync("src/components/EditNeedDialog.tsx", "utf8"));
    expect(dlg).toMatch(/<span id=\{priorityLabelId\}>Prioridade<\/span>/);
    expect(dlg).toMatch(/<SelectTrigger aria-labelledby=\{priorityLabelId\}>/);
    expect(dlg).toMatch(/aria-describedby=\{titleInvalid \? titleHintId : undefined\}/);
    expect(dlg).toMatch(/aria-describedby=\{descriptionInvalid \? descriptionHintId : undefined\}/);
    expect(dlg).toMatch(/<p id=\{titleHintId\}/);
    expect(dlg).toMatch(/<p id=\{descriptionHintId\}/);
    expect(dlg).toMatch(/onOpenAutoFocus=\{\(\) => \{\s*openerRef\.current = document\.activeElement instanceof HTMLElement/);
    expect(dlg).toMatch(/onCloseAutoFocus=\{\(e\) => \{\s*if \(openerRef\.current\?\.isConnected\) \{\s*e\.preventDefault\(\);\s*openerRef\.current\.focus\(\);/);
    expect(dlg).toMatch(/useEffect\(\(\) => \{\s*if \(mutation\.isError\) saveRef\.current\?\.focus\(\);\s*\}, \[mutation\.isError\]\);/);
    expect(dlg).toMatch(/<Button ref=\{saveRef\} type="submit"/);
  });

  it("alterar SÓ a prioridade (o que o seletor produz) salva e persiste; título e descrição seguem como estavam", async () => {
    const e = await setup();
    const before = await db.selectFrom("needs").select(["title", "description"]).where("id", "=", e.needId).executeTakeFirstOrThrow();
    const res = await edit(e.owner.cookie, { organizationId: e.orgId, needId: e.needId, priority: "baixa" });
    expect(res.status).toBe(200);
    const after = await db.selectFrom("needs").select(["title", "description", "priority"]).where("id", "=", e.needId).executeTakeFirstOrThrow();
    expect(after).toEqual({ ...before, priority: "baixa" });
  });
});
