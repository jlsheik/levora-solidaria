/**
 * M39 — comprovante LOCAL do estado da cadeia (garantia B) e seus limites, em PostgreSQL descartável.
 * G comprovante válido · H remoção do final · I recálculo privilegiado (a limitação da verificação interna) · J permissões · formatos malformados/não suportados.
 * Toda adulteração acontece SÓ neste banco de teste (os gatilhos append-only são desligados aqui e religados).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { recordAuditLogEntry, computeAuditEventHash, stableStringify } from "../src/helpers/auditLog";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { awaitVerification } from "../src/helpers/auditChainVerification";
import { digestOf, parseReceipt, type Receipt, type ReceiptBody } from "../src/helpers/auditChainReceipt";
import { handle as postVerify } from "../src/endpoints/audit-chain-verify_POST";
import { handle as postReceipt } from "../src/endpoints/audit-chain-receipt_POST";
import { handle as postCompare } from "../src/endpoints/audit-chain-receipt-compare_POST";
import { handle as getReceipts } from "../src/endpoints/audit-chain-receipts_GET";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }

type Created = { id: string; canonical: string; receipt: Receipt };
type Cmp = { id: string; status: string; reason: string | null; receiptId: string | null; comparedUpToEventId: string | null; eventsSinceReceipt: number | null };

describe("Comprovante local da cadeia (M39)", () => {
  let owner: AuthenticatedTestUser; let orgId: number; let platform: AuthenticatedTestUser;
  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; platform = await createPlatformAdmin(); });
  afterEach(async () => { await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`.execute(db); await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`.execute(db); });

  const seed = async (n: number, tag = "base") => { for (let i = 0; i < n; i++) await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "teste.registro", entityType: `teste_${tag}`, entityId: String(i), metadata: { i }, outcome: "concluida" }); };
  const verify = async () => { const r = await postVerify(post("audit-chain-verify", platform, {})); expect(r.status).toBe(202); await awaitVerification((await parseJson<{ id: string }>(r)).id); };
  const makeReceipt = async (): Promise<Created> => { const r = await postReceipt(post("audit-chain-receipt", platform, {})); expect(r.status, await r.clone().text()).toBe(201); return parseJson<Created>(r); };
  const compare = async (text: string, who: AuthenticatedTestUser = platform) => parseJson<Cmp>(await postCompare(post("audit-chain-receipt-compare", who, { receipt: text })));
  const rebuild = (patch: Partial<ReceiptBody>, base: Receipt): string => { const { receiptDigest: _d, ...body } = base; const b = { ...body, ...patch } as ReceiptBody; return stableStringify({ ...b, receiptDigest: digestOf(b) }); };
  const tamperOff = async () => { await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`.execute(db); await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`.execute(db); };

  describe("Jornada G — comprovante válido", () => {
    it("só nasce de verificação ÍNTEGRA; formato determinístico, só metadados; comparação posterior confere e informa registros novos", async () => {
      await seed(5);
      expect((await postReceipt(post("audit-chain-receipt", platform, {}))).status).toBe(409); // sem verificação: sem comprovante
      expect((await parseJson<{ code: string }>(await postReceipt(post("audit-chain-receipt", platform, {})))).code).toBe("sem_verificacao");
      await verify();
      const c = await makeReceipt(); const r = c.receipt;
      expect(r).toMatchObject({ format: "levora-audit-chain-receipt", formatVersion: 1, scope: "global_chain", algorithm: "sha256" });
      expect(Object.keys(r).sort()).toEqual(["algorithm", "capturedAt", "eventCount", "format", "formatVersion", "headHash", "lastEventId", "receiptDigest", "scope", "unhashedEvents", "verificationId", "verificationResult"]); // nada além de metadados
      expect(JSON.stringify(r)).not.toMatch(/teste_base|organization|metadata|senha|secret/i);
      // determinismo: o texto exportado é a serialização canônica; o digest se refaz a partir do corpo
      expect(c.canonical).toBe(stableStringify(JSON.parse(c.canonical))); const { receiptDigest, ...body } = r; expect(digestOf(body as ReceiptBody)).toBe(receiptDigest);
      const head = await db.selectFrom("auditLog").select(["id", "eventHash"]).where("id", "=", r.lastEventId).executeTakeFirstOrThrow(); expect(head.eventHash).toBe(r.headHash);
      expect(Number(r.eventCount)).toBe(Number((await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).where("id", "<=", r.lastEventId).executeTakeFirstOrThrow()).n));
      const ok = await compare(c.canonical);
      expect(ok).toMatchObject({ status: "conferido", reason: null, receiptId: c.id, comparedUpToEventId: r.lastEventId }); expect(ok.eventsSinceReceipt).toBeGreaterThanOrEqual(1); // o registro da própria geração é posterior
      await seed(3, "depois"); const later = await compare(c.canonical); expect(later.status).toBe("conferido"); expect(later.eventsSinceReceipt).toBe((ok.eventsSinceReceipt ?? 0) + 3); // só os 3 novos: comparar não grava na trilha
      expect(await db.selectFrom("auditChainReceiptComparisons").select("id").where("receiptId", "=", c.id).execute()).toHaveLength(2); // cada comparação fica registrada
      expect((await db.selectFrom("auditLog").select(["action", "outcome"]).where("action", "=", "auditoria.comprovante_gerado").executeTakeFirstOrThrow()).outcome).toBe("concluida");
      // o comprovante não muda nenhum registro da trilha
      expect((await verifyAuditLogChain()).integra).toBe(true);
      // append-only
      await expect(db.updateTable("auditChainReceipts").set({ eventCount: "1" }).where("id", "=", c.id).execute()).rejects.toThrow();
      await expect(sql`DELETE FROM audit_chain_receipts`.execute(db)).rejects.toThrow();
      await expect(sql`DELETE FROM audit_chain_receipt_comparisons`.execute(db)).rejects.toThrow();
    });

    it("recusa gerar quando a última verificação NÃO é íntegra ou quando o estado mudou depois dela", async () => {
      await seed(4); await verify(); await makeReceipt(); // ok
      await tamperOff();
      const target = (await db.selectFrom("auditLog").select("id").where("entityType", "=", "teste_base").orderBy("id", "asc").executeTakeFirstOrThrow()).id;
      await sql`UPDATE audit_log SET metadata = '{"x":1}'::jsonb WHERE id = ${target}`.execute(db);
      await verify(); // agora inconsistente
      const res = await postReceipt(post("audit-chain-receipt", platform, {})); expect(res.status).toBe(409); expect((await parseJson<{ code: string }>(res)).code).toBe("verificacao_nao_integra");
    });

    it("estado alterado ENTRE a verificação e o pedido: o registro final é removido → recusa 'estado_mudou_desde_a_verificacao'", async () => {
      await seed(4); await verify(); await tamperOff();
      const v = await db.selectFrom("auditChainVerifications").select("maxAuditIdAtStart").orderBy("id", "desc").executeTakeFirstOrThrow();
      await sql`DELETE FROM audit_log WHERE id >= ${v.maxAuditIdAtStart}`.execute(db);
      const res = await postReceipt(post("audit-chain-receipt", platform, {})); expect(res.status).toBe(409); expect((await parseJson<{ code: string }>(res)).code).toBe("estado_mudou_desde_a_verificacao");
    });
  });

  describe("Jornadas H e I — remoção do final e recálculo (o que cada garantia enxerga)", () => {
    it("H remoção dos registros FINAIS: a verificação interna segue 'íntegra' (limite); a comparação com o comprovante anterior DETECTA", async () => {
      await seed(6); await verify(); const c = await makeReceipt(); await seed(2, "pos");
      await tamperOff();
      await sql`DELETE FROM audit_log WHERE id >= ${Number(c.receipt.lastEventId) - 2}`.execute(db); // some o registro de referência e tudo depois
      expect((await verifyAuditLogChain()).integra).toBe(true); // garantia A NÃO vê truncamento do fim
      const r = await compare(c.canonical);
      expect(r).toMatchObject({ status: "divergencia", reason: "registro_final_ausente", receiptId: c.id });
    });

    it("remoção de registro INTERMEDIÁRIO e alteração de registro antigo são detectadas pela comparação (motivos distintos)", async () => {
      await seed(8); await verify(); const c = await makeReceipt(); await tamperOff();
      const ids = (await db.selectFrom("auditLog").select("id").where("entityType", "=", "teste_base").orderBy("id", "asc").execute()).map((r) => r.id);
      // alteração de conteúdo SEM recalcular: a verificação interna até o registro final acusa
      await sql`UPDATE audit_log SET metadata = '{"adulterado":true}'::jsonb WHERE id = ${ids[1]}`.execute(db);
      expect(await compare(c.canonical)).toMatchObject({ status: "divergencia", reason: "inconsistencia_interna" });
      await sql`UPDATE audit_log SET metadata = '{"i":1}'::jsonb WHERE id = ${ids[1]}`.execute(db);
      expect((await compare(c.canonical)).status).toBe("conferido"); // restaurado
      await sql`DELETE FROM audit_log WHERE id = ${ids[3]}`.execute(db);
      expect(await compare(c.canonical)).toMatchObject({ status: "divergencia", reason: "quantidade_menor" });
    });

    it("I recálculo privilegiado: quem recalcula a cadeia passa na verificação INTERNA; o comprovante anterior DIVERGE; e um comprovante forjado coerente também é aceito — sem independência não há prova", async () => {
      await seed(6); await verify(); const c = await makeReceipt(); await tamperOff();
      // ator privilegiado: altera um registro antigo e RECALCULA todos os hashes a partir dele (previous e event)
      const rows = await db.selectFrom("auditLog").selectAll().orderBy("id", "asc").execute();
      const k = rows.findIndex((r) => r.entityType === "teste_base" && r.entityId === "1");
      let prev = rows[k].previousEventHash;
      for (let i = k; i < rows.length; i++) {
        const r = rows[i];
        const metadata = i === k ? { i: 1, adulterado: true } : r.metadata;
        const eventHash = computeAuditEventHash({ organizationId: r.organizationId, actorUserId: r.actorUserId, actorType: r.actorType, actorAgentPrincipalId: r.actorAgentPrincipalId, action: r.action, entityType: r.entityType, entityId: r.entityId, metadata: metadata as never, createdAt: r.createdAt, previousEventHash: prev, recordVersion: r.recordVersion, outcome: r.outcome, correlationId: r.correlationId });
        await db.updateTable("auditLog").set({ metadata: metadata as never, previousEventHash: prev, eventHash }).where("id", "=", r.id).execute();
        prev = eventHash;
      }
      expect((await verifyAuditLogChain()).integra).toBe(true); // LIMITAÇÃO: a cadeia recalculada é internamente coerente
      expect(await compare(c.canonical)).toMatchObject({ status: "divergencia", reason: "hash_do_registro_diferente", receiptId: c.id }); // garantia B enxerga
      // o mesmo ator, controlando também o comprovante, forja um novo coerente com a cadeia adulterada
      const head = await db.selectFrom("auditLog").select(["id", "eventHash"]).where("id", "=", c.receipt.lastEventId).executeTakeFirstOrThrow();
      const forged = rebuild({ headHash: head.eventHash! }, c.receipt);
      expect((await compare(forged)).status).toBe("conferido"); // o sistema NÃO consegue distinguir: comprovante sob o mesmo controle não é âncora independente
      const list = await parseJson<{ independentAnchorConfigured: boolean }>(await getReceipts(get("audit-chain-receipts", platform)));
      expect(list.independentAnchorConfigured).toBe(false); // a API nunca afirma garantia C
    });
  });

  describe("formatos malformados, não suportados e de outro escopo", () => {
    it("nunca viram 'conferido': cada caso recebe status e motivo explícitos e fica registrado sem receipt_id", async () => {
      await seed(3); await verify(); const c = await makeReceipt(); const r = c.receipt;
      const cases: Array<[string, string, string, string]> = [
        ["não é JSON", "isto nao e json", "malformado", "comprovante_ilegivel"],
        ["array", "[1,2,3]", "malformado", "comprovante_ilegivel"],
        ["truncado", c.canonical.slice(0, c.canonical.length - 20), "malformado", "comprovante_ilegivel"],
        ["campo extra", stableStringify({ ...JSON.parse(c.canonical), extra: "x" }), "malformado", "campos_invalidos"],
        ["campo ausente", stableStringify((({ headHash: _h, ...rest }) => rest)(JSON.parse(c.canonical))), "malformado", "campos_invalidos"],
        ["hash do registro inválido", rebuild({ headHash: "xyz" }, r), "malformado", "campos_invalidos"],
        ["digest adulterado", stableStringify({ ...JSON.parse(c.canonical), eventCount: "999" }), "malformado", "digest_invalido"],
        ["versão não suportada", rebuild({ formatVersion: 2 }, r), "nao_suportado", "formato_nao_suportado"],
        ["algoritmo não suportado", rebuild({ algorithm: "sha512" as never }, r), "nao_suportado", "algoritmo_nao_suportado"],
        ["outro escopo", rebuild({ scope: "organization_1" as never }, r), "escopo_diferente", "outro_escopo"],
      ];
      for (const [name, text, status, reason] of cases) { const out = await compare(text); expect({ name, status: out.status, reason: out.reason, receiptId: out.receiptId }).toEqual({ name, status, reason, receiptId: null }); }
      expect(parseReceipt(c.canonical).ok).toBe(true);
      expect(await db.selectFrom("auditChainReceiptComparisons").select("status").where("receiptId", "is", null).execute()).toHaveLength(cases.length);
      expect((await postCompare(post("audit-chain-receipt-compare", platform, { receipt: "x".repeat(5000) }))).status).toBe(400); // tamanho limitado
      expect((await postCompare(post("audit-chain-receipt-compare", platform, { receipt: "{}", extra: 1 }))).status).toBe(400); // corpo estrito
    });
  });

  describe("Jornada J — permissões e isolamento", () => {
    it("só a equipe da plataforma gera e compara; organização lê estado sem hashes; outra organização, operador e voluntário não leem", async () => {
      await seed(3); await verify(); const c = await makeReceipt(); await compare(c.canonical);
      expect((await postReceipt(post("audit-chain-receipt", owner, {}))).status).toBe(403);
      expect((await postCompare(post("audit-chain-receipt-compare", owner, { receipt: c.canonical }))).status).toBe(403);
      expect((await postReceipt(post("audit-chain-receipt", undefined, {}))).status).toBe(401);
      const own = await parseJson<{ canManage: boolean; receipts: Array<{ headHash: string | null; receiptDigest: string | null; lastComparison: { status: string } | null; createdByName: string | null }> }>(await getReceipts(get(`audit-chain-receipts?organizationId=${orgId}`, owner)));
      expect(own.canManage).toBe(false); expect(own.receipts[0]).toMatchObject({ headHash: null, receiptDigest: null, createdByName: null }); expect(own.receipts[0].lastComparison?.status).toBe("conferido");
      expect(JSON.stringify(own)).not.toContain(c.receipt.headHash); expect(JSON.stringify(own)).not.toContain(c.receipt.receiptDigest);
      const asPlatform = await parseJson<{ receipts: Array<{ headHash: string | null; receiptDigest: string | null }> }>(await getReceipts(get("audit-chain-receipts", platform)));
      expect(asPlatform.receipts[0].headHash).toBe(c.receipt.headHash);
      const intruder = await createAuthenticatedUser(); await createTestOrganization(intruder.userId);
      expect((await getReceipts(get(`audit-chain-receipts?organizationId=${orgId}`, intruder))).status).toBe(403);
      expect((await getReceipts(get("audit-chain-receipts", owner))).status).toBe(403); // sem organização = consulta de plataforma
      for (const role of ["operador", "voluntario"] as const) expect((await getReceipts(get(`audit-chain-receipts?organizationId=${orgId}`, await member(orgId, role)))).status).toBe(403);
    });
  });
});
