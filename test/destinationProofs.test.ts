/**
 * Fase 99J — comprovantes de destinação (PostgreSQL real, banco `_test`; armazenamento local descartável): upload privado, vínculo por evento imutável, remoção da referência sem apagar o
 * objeto, autorização de download por finalidade/vínculo, isolamento entre organizações, idempotência, atomicidade e garantias do banco. Comprovante é opcional.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { businessDateOf } from "../src/helpers/businessDate";
import { buildImpactReport } from "../src/helpers/impactReport";
import { handle as uploadHandle } from "../src/endpoints/files-upload_POST";
import { handle as downloadHandle } from "../src/endpoints/files-download_GET";
import { handle as proofHandle } from "../src/endpoints/stock-destination-proof_POST";
import { handle as listHandle } from "../src/endpoints/stock-destinations_GET";
import { handle as destHandle } from "../src/endpoints/stock-destinations_POST";
import { handle as reverseHandle } from "../src/endpoints/stock-destination-reversal_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOrganization, parseJson } from "./helpers";
import type { OutputType } from "../src/endpoints/stock-destinations_GET.schema";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const TEST_STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");
afterAll(async () => rm(TEST_STORAGE_DIR, { recursive: true, force: true }));

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;
const today = () => businessDateOf(new Date());

async function world() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const operator2 = await createAuthenticatedUser();
  await addMembership(org.id, operator2.userId, "operador");
  const volunteer = await createAuthenticatedUser();
  await addMembership(org.id, volunteer.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
  await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "10000", reason: "saldo inicial", createdByUserId: owner.userId }).execute();
  return { owner, admin, operator, operator2, volunteer, org, item };
}
type W = Awaited<ReturnType<typeof world>>;

const dest = async (w: W, user: Auth = w.operator, quantity = 5) =>
  (await parseJson<{ destination: { id: string } }>(await destHandle(post("stock-destinations", user.cookie, { organizationId: w.org.id, itemId: w.item.id, quantity, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key() })))).destination.id;
const upload = async (w: W, user: Auth = w.operator, over: Record<string, unknown> = {}) => {
  const res = await uploadHandle(post("files-upload", user.cookie, { organizationId: w.org.id, purpose: "comprovante_destinacao", fileName: "recibo.png", contentType: "image/png", fileBase64: PNG, ...over }));
  const out = res.status === 200 ? await parseJson<{ file: { id: number } }>(res) : null;
  return { status: res.status, id: out?.file.id as number };
};
const proof = (w: W, destinationId: string, action: "anexar" | "remover", fileId: number, user: Auth = w.operator, over: Record<string, unknown> = {}) =>
  proofHandle(post("stock-destination-proof", user.cookie, { organizationId: w.org.id, destinationId, action, fileId, reason: "Comprovante da entrega", idempotencyKey: key(), ...over }));
const download = (fileId: number, user: Auth) => downloadHandle(buildRequest(`files-download?fileId=${fileId}`, { method: "GET", cookie: user.cookie }));
const list = async (w: W, user: Auth = w.operator) => (await parseJson<OutputType>(await listHandle(buildRequest(`stock-destinations?organizationId=${w.org.id}`, { method: "GET", cookie: user.cookie })))).destinations;
const code = async (r: Response) => (await parseJson<{ code?: string }>(r)).code;
const events = (destId: string) => db.selectFrom("stockDestinations").selectAll().where("reversesDestinationId", "=", destId).orderBy("id").execute();

describe("A. upload e vínculo", () => {
  it("fluxo completo: envia, anexa (evento imutável), lista e baixa; original, estoque e atendimento intactos; comprovante é opcional", async () => {
    const w = await world();
    const d = await dest(w);
    expect((await list(w))[0].proof).toBeNull(); // sem comprovante: normal, nada obrigatório
    const [origBefore] = await db.selectFrom("stockDestinations").selectAll().where("id", "=", d).execute();
    const balanceBefore = Number((await db.selectFrom("stockTransactions").select(sql<string>`SUM(delta)`.as("t")).executeTakeFirstOrThrow()).t);
    const up = await upload(w);
    expect(up.status).toBe(200);
    expect((await proof(w, d, "anexar", up.id)).status).toBe(200);
    const [ev] = await events(d);
    expect(ev).toMatchObject({ entryType: "correction", proofFileId: up.id, proofRemoved: null, stockTransactionId: null, quantity: null, needId: null, createdByUserId: w.operator.userId });
    expect((await db.selectFrom("stockDestinations").selectAll().where("id", "=", d).execute())[0]).toEqual(origBefore);
    expect(Number((await db.selectFrom("stockTransactions").select(sql<string>`SUM(delta)`.as("t")).executeTakeFirstOrThrow()).t)).toBe(balanceBefore);
    const view = (await list(w))[0];
    expect(view.proof).toMatchObject({ fileId: up.id, name: "recibo.png", contentType: "image/png", attachedByDisplayName: expect.any(String) });
    expect(JSON.stringify(view)).not.toMatch(/storageKey|storage_key|local\//);
    expect(view.events[0].proof).toMatchObject({ fileId: up.id, action: "anexado" });
    const dl = await download(up.id, w.operator);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Buffer.from(await dl.arrayBuffer()).toString("base64")).toBe(PNG);
    const a = await db.selectFrom("auditLog").select("metadata").where("action", "=", "destinacao.comprovante_anexado").execute();
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0].metadata)).not.toMatch(/storage/i);
  });

  it("o evento de comprovante não conta como correção documental nem altera o relatório de saldos", async () => {
    const w = await world();
    const d = await dest(w);
    const up = await upload(w);
    await proof(w, d, "anexar", up.id);
    const win = { startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() + 86400000) };
    const r = await buildImpactReport(db, { organizationId: w.org.id, ...win } as never);
    expect(r.destination).toMatchObject({ correctedRecords: 0, proofs: { withProof: 1, withoutProof: 0 } });
    expect(r.destination.eventsInPeriod.corrections).toBe(0);
    const filtered = await parseJson<OutputType>(await listHandle(buildRequest(`stock-destinations?organizationId=${w.org.id}&state=com_correcao`, { method: "GET", cookie: w.admin.cookie })));
    expect(filtered.destinations).toHaveLength(0);
    expect(r.reconciliation.every((x) => x.balanced && x.exitsBalanced)).toBe(true);
  });

  it("substituir = remover + anexar outro; o objeto removido continua armazenado e o histórico mostra tudo", async () => {
    const w = await world();
    const d = await dest(w);
    const a = await upload(w);
    const b = await upload(w, w.operator, { fileName: "novo.png" });
    await proof(w, d, "anexar", a.id);
    expect((await proof(w, d, "remover", a.id, w.admin, { reason: "Arquivo errado" })).status).toBe(200);
    expect((await list(w))[0].proof).toBeNull();
    expect((await proof(w, d, "anexar", b.id)).status).toBe(200);
    const view = (await list(w))[0];
    expect(view.proof?.fileId).toBe(b.id);
    expect(view.events.map((e) => e.proof?.action)).toEqual(["anexado", "removido", "anexado"]);
    const file = await db.selectFrom("files").select("storageKey").where("id", "=", a.id).executeTakeFirst();
    expect(file).toBeDefined(); // registro e objeto preservados
    // removido não volta a ser vinculado
    const again = await proof(w, (await dest(w)), "anexar", a.id, w.admin);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("arquivo_ja_vinculado");
  });
});

describe("A2. canAttachProof só aparece para quem pode", () => {
  it("quem registrou e o administrador veem a ação; outro operador não; some depois que há comprovante vigente", async () => {
    const w = await world();
    const d = await dest(w, w.operator);
    const can = async (u: Auth) => (await list(w, u)).find((x) => x.id === d)!.canAttachProof;
    expect([await can(w.operator), await can(w.operator2), await can(w.admin)]).toEqual([true, false, true]);
    const up = await upload(w, w.operator);
    await proof(w, d, "anexar", up.id, w.operator);
    expect([await can(w.operator), await can(w.admin)]).toEqual([false, false]);
  });
});

describe("B. upload: validação do conteúdo", () => {
  it("tipo/MIME/arquivo inválidos, nome inseguro e base64 quebrado são recusados sem gravar nada", async () => {
    const w = await world();
    const before = (await db.selectFrom("files").select("id").execute()).length;
    expect((await upload(w, w.operator, { contentType: "image/svg+xml" })).status).toBe(400);
    expect((await upload(w, w.operator, { contentType: "application/pdf" })).status).toBe(400); // PNG declarado como PDF
    expect((await upload(w, w.operator, { fileBase64: "bm90IGFuIGltYWdl" })).status).toBe(400); // conteúdo que não é imagem
    expect((await upload(w, w.operator, { fileBase64: "###" })).status).toBe(400);
    expect((await upload(w, w.operator, { fileName: "a\r\nSet-Cookie: x=1.png" })).status).toBe(400);
    expect((await upload(w, w.operator, { purpose: "outro" })).status).toBe(400);
    expect((await upload(w, w.volunteer)).status).toBe(403);
    expect((await db.selectFrom("files").select("id").execute()).length).toBe(before);
  });
});

describe("C. permissões e isolamento", () => {
  it("anexar: quem registrou (com o próprio arquivo) ou proprietário/administrador; outro operador e voluntário não; remover só proprietário/administrador", async () => {
    const w = await world();
    const d = await dest(w, w.operator);
    const f1 = await upload(w, w.operator2);
    expect((await proof(w, d, "anexar", f1.id, w.operator2)).status).toBe(403); // não registrou a destinação
    const mine = await upload(w, w.operator);
    expect((await proof(w, d, "anexar", mine.id, w.volunteer)).status).toBe(403);
    expect((await proof(w, d, "anexar", f1.id, w.operator)).status).toBe(403); // arquivo de outra pessoa
    expect((await proof(w, d, "anexar", mine.id, w.operator)).status).toBe(200);
    expect((await proof(w, d, "remover", mine.id, w.operator)).status).toBe(403);
    expect((await proof(w, d, "anexar", f1.id, w.admin)).status).toBe(200); // administrador pode
    expect((await proof(w, d, "remover", f1.id, w.owner)).status).toBe(200);
  });

  it("download: voluntário e membro sem permissão não leem; pendente só quem enviou ou gerente; vigente por quem tem inventario.lance; removido só gerente/autor", async () => {
    const w = await world();
    const d = await dest(w, w.operator);
    const up = await upload(w, w.operator);
    expect((await download(up.id, w.operator2)).status).toBe(404); // pendente: não é comprovante de ninguém
    expect((await download(up.id, w.operator)).status).toBe(200); // quem enviou
    expect((await download(up.id, w.admin)).status).toBe(200);
    expect((await download(up.id, w.volunteer)).status).toBe(403);
    await proof(w, d, "anexar", up.id, w.operator);
    expect((await download(up.id, w.operator2)).status).toBe(200);
    expect((await download(up.id, w.volunteer)).status).toBe(403);
    await proof(w, d, "remover", up.id, w.admin);
    expect((await download(up.id, w.operator2)).status).toBe(404);
    expect((await download(up.id, w.admin)).status).toBe(200);
  });

  it("outra organização: não baixa, não anexa arquivo/destinação alheios, não vê nada na lista", async () => {
    const a = await world();
    const b = await world();
    const d = await dest(a, a.operator);
    const up = await upload(a, a.operator);
    await proof(a, d, "anexar", up.id, a.operator);
    expect((await download(up.id, b.owner)).status).toBe(403);
    const bFile = await upload(b, b.owner);
    expect((await proof(a, d, "anexar", bFile.id, a.admin)).status).toBe(404); // arquivo de outra organização
    expect((await proof(b, d, "anexar", bFile.id, b.owner)).status).toBe(404); // destinação de outra organização
    expect((await proofHandle(post("stock-destination-proof", b.owner.cookie, { organizationId: a.org.id, destinationId: d, action: "anexar", fileId: bFile.id, reason: "Tentativa cruzada", idempotencyKey: key() }))).status).toBe(403);
    expect(await list(b, b.owner)).toHaveLength(0);
    expect((await events(d)).filter((e) => e.proofFileId === bFile.id)).toHaveLength(0);
  });

  it("arquivos de OUTRA finalidade nunca viram comprovante de destinação; e o download antigo (comprovante_entrega) segue por associação à organização", async () => {
    const w = await world();
    const d = await dest(w);
    const old = await upload(w, w.operator, { purpose: "comprovante_entrega" });
    const r = await proof(w, d, "anexar", old.id, w.admin);
    expect(r.status).toBe(422);
    expect(await code(r)).toBe("arquivo_invalido");
    expect((await download(old.id, w.volunteer)).status).toBe(200); // regra antiga preservada
    expect((await proof(w, d, "anexar", 999999, w.admin)).status).toBe(404);
    expect((await proof(w, "999999", "anexar", old.id, w.admin)).status).toBe(404);
  });
});

describe("D. idempotência, concorrência e regras", () => {
  it("mesma chave não duplica o vínculo; chave com outro conteúdo é 409; vínculo duplicado do mesmo arquivo é 409", async () => {
    const w = await world();
    const d = await dest(w);
    const up = await upload(w);
    const k = key();
    expect((await proof(w, d, "anexar", up.id, w.operator, { idempotencyKey: k })).status).toBe(200);
    const again = await proof(w, d, "anexar", up.id, w.operator, { idempotencyKey: k });
    expect(again.status).toBe(200);
    expect((await parseJson<{ replayed: boolean }>(again)).replayed).toBe(true);
    expect((await events(d)).filter((e) => e.proofFileId)).toHaveLength(1);
    const other = await proof(w, d, "anexar", up.id, w.operator, { idempotencyKey: k, reason: "Outro motivo qualquer" });
    expect(other.status).toBe(409);
    expect(await code(other)).toBe("chave_reutilizada");
    expect((await proof(w, d, "anexar", up.id, w.operator)).status).toBe(409);
  });

  it("anexos simultâneos do MESMO arquivo: exatamente um vence; remoções simultâneas: exatamente uma", async () => {
    const w = await world();
    const d1 = await dest(w);
    const d2 = await dest(w);
    const up = await upload(w);
    const rs = await Promise.all([proof(w, d1, "anexar", up.id, w.admin), proof(w, d2, "anexar", up.id, w.admin), proof(w, d1, "anexar", up.id, w.owner)]);
    for (const r of rs) expect(r.status).toBeLessThan(500);
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    const linked = await db.selectFrom("stockDestinations").select(["id", "reversesDestinationId"]).where("proofFileId", "=", up.id).execute();
    expect(linked).toHaveLength(1);
    const target = String(linked[0].reversesDestinationId);
    const rm = await Promise.all([proof(w, target, "remover", up.id, w.admin), proof(w, target, "remover", up.id, w.owner)]);
    expect(rm.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rm.filter((r) => r.status === 409)).toHaveLength(1);
  });

  it("remover quem não é o vigente é 409; validação de entrada é 400; campos extras são recusados", async () => {
    const w = await world();
    const d = await dest(w);
    const up = await upload(w);
    const other = await upload(w);
    await proof(w, d, "anexar", up.id, w.admin);
    expect((await proof(w, d, "remover", other.id, w.admin)).status).toBe(409);
    for (const bad of [{ action: "apagar" }, { reason: "abc" }, { idempotencyKey: "x" }, { fileId: -1 }, { quantity: 99 }, { destinationId: "x" }]) {
      expect((await proof(w, d, "anexar", other.id, w.admin, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("reversão da destinação não impede nem remove o comprovante; o atendimento segue só as regras da 99F/99G", async () => {
    const w = await world();
    const d = await dest(w);
    const up = await upload(w);
    await proof(w, d, "anexar", up.id, w.admin);
    expect((await reverseHandle(post("stock-destination-reversal", w.admin.cookie, { organizationId: w.org.id, destinationId: d, kind: "estorno_documental", quantity: 5, reason: "Registro por engano", idempotencyKey: key() }))).status).toBe(200);
    const view = (await list(w))[0];
    expect(view).toMatchObject({ state: "revertida" });
    expect(view.proof?.fileId).toBe(up.id);
  });
});

describe("E. atomicidade e garantias do banco", () => {
  async function install(table: string, condition: string) {
    await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_insert() RETURNS trigger AS $f$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
    await sql.raw(`CREATE TRIGGER test_fail_insert_trg BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail_insert()`).execute(db);
  }
  async function remove(table: string) {
    await sql.raw(`DROP TRIGGER IF EXISTS test_fail_insert_trg ON ${table}`).execute(db);
    await sql.raw("DROP FUNCTION IF EXISTS test_fail_insert()").execute(db);
  }

  it("falha na auditoria desfaz o vínculo (evento e pedido); o arquivo continua pendente e a mesma chave funciona depois", async () => {
    const w = await world();
    const d = await dest(w);
    const up = await upload(w);
    const k = key();
    await install("audit_log", "NEW.action = 'destinacao.comprovante_anexado'");
    try {
      expect((await proof(w, d, "anexar", up.id, w.admin, { idempotencyKey: k })).status).toBeGreaterThanOrEqual(500);
    } finally {
      await remove("audit_log");
    }
    expect((await events(d)).filter((e) => e.proofFileId)).toHaveLength(0);
    expect(await db.selectFrom("destinationCorrectionRequests").select("id").where("idempotencyKey", "=", k).execute()).toHaveLength(0);
    expect((await download(up.id, w.operator2)).status).toBe(404); // continua pendente
    expect((await proof(w, d, "anexar", up.id, w.admin, { idempotencyKey: k })).status).toBe(200);
  });

  it("falha no banco após o upload remove o objeto (nenhum registro nem blob órfão por esta tentativa)", async () => {
    const w = await world();
    const before = (await db.selectFrom("files").select("id").execute()).length;
    await install("audit_log", "NEW.action = 'arquivo.enviado'");
    try {
      expect((await upload(w)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await remove("audit_log");
    }
    expect((await db.selectFrom("files").select("id").execute()).length).toBe(before);
  });

  it("o banco recusa, por si só: arquivo de outra finalidade, de outra organização, evento com campos extras, vínculo duplicado e remoção do que não é vigente", async () => {
    const a = await world();
    const b = await world();
    const d = await dest(a);
    const mkFile = async (x: W, purpose: string) => (await db.insertInto("files").values({ organizationId: x.org.id, uploadedByUserId: x.owner.userId, storageProvider: "local", storageKey: `${x.org.id}/seed-${randomBytes(4).toString("hex")}`, originalFilename: "x.png", contentType: "image/png", sizeBytes: 10, purpose }).returning("id").execute())[0].id;
    const base = (fileId: number, over: Record<string, unknown> = {}) => ({ organizationId: a.org.id, entryType: "correction", itemId: a.item.id, reversesDestinationId: d, proofFileId: fileId, reason: "Motivo válido", createdByUserId: a.owner.userId, ...over });
    const ok = await mkFile(a, "comprovante_destinacao");
    await expect(db.insertInto("stockDestinations").values(base(await mkFile(a, "comprovante_entrega")) as never).execute()).rejects.toThrow(/propósito/);
    await expect(db.insertInto("stockDestinations").values(base(await mkFile(b, "comprovante_destinacao")) as never).execute()).rejects.toThrow();
    await expect(db.insertInto("stockDestinations").values(base(ok, { notes: "junto" }) as never).execute()).rejects.toThrow();
    await expect(db.insertInto("stockDestinations").values(base(ok, { proofRemoved: true }) as never).execute()).rejects.toThrow(/vigente/);
    await db.insertInto("stockDestinations").values(base(ok) as never).execute();
    await expect(db.insertInto("stockDestinations").values(base(ok) as never).execute()).rejects.toThrow(); // índice único
    await db.insertInto("stockDestinations").values(base(ok, { proofRemoved: true }) as never).execute();
    await expect(db.insertInto("stockDestinations").values(base(ok, { proofRemoved: true }) as never).execute()).rejects.toThrow(/vigente/);
    const [ev] = await events(d);
    await expect(db.updateTable("stockDestinations").set({ reason: "alterado" }).where("id", "=", ev.id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("stockDestinations").where("id", "=", ev.id).execute()).rejects.toThrow();
  });
});
