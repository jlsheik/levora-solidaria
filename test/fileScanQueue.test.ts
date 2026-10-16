/**
 * Hardening pós-99K — operação confiável do scanner: política de novas tentativas, fila durável com lease, tarefa agendada, saúde do clamd (PING/VERSION/idade da base carregada) e
 * indicadores globais. PostgreSQL real; scanner SIMULADO (o scanner real continua coberto por test/fileScan.test.ts, bloco D). Nada aqui prova o serviço definitivo.
 */
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import net from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { ClamdScanner, evaluateFreshness, getScannerHealth, parseClamdVersion, setFileScannerForTests, type FileScanner, type ScanOutcome } from "../src/helpers/fileScanner";
import { getFileScanRetryConfig, nextDelaySeconds } from "../src/helpers/fileScanRetry";
import { claimFileScanBatch, exhaustSpentFiles, runFileScanRetries } from "../src/helpers/fileScanQueue";
import { retryFileScansScheduled } from "../src/helpers/retryFileScansTask";
import { buildFileScanOperations } from "../src/helpers/fileScanOperations";
import { TASK_HANDLERS } from "../src/helpers/taskHandlers";
import { handle as uploadPost } from "../src/endpoints/files-upload_POST";
import { handle as downloadGet } from "../src/endpoints/files-download_GET";
import { handle as rescanPost } from "../src/endpoints/files-rescan_POST";
import { handle as opsGet } from "../src/endpoints/file-scan-operations_GET";
import { handle as reconGet } from "../src/endpoints/destination-proofs-reconciliation_GET";
import { addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestOrganization, parseJson } from "./helpers";

const TEST_STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");
afterAll(async () => rm(TEST_STORAGE_DIR, { recursive: true, force: true }));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const get = (p: string, cookie: string) => buildRequest(p, { method: "GET", cookie });

afterEach(() => {
  setFileScannerForTests(undefined);
  vi.unstubAllEnvs();
});

const CLEAN: ScanOutcome = { status: "limpo", engine: "simulado" };
const DOWN: ScanOutcome = { status: "indisponivel", reason: "timeout" };
const stub = (outcome: ScanOutcome | (() => Promise<ScanOutcome>)): FileScanner & { calls: number } => {
  const s = { name: "simulado", calls: 0, async scan() { s.calls++; return typeof outcome === "function" ? outcome() : outcome; } };
  return s;
};
const required = () => vi.stubEnv("FILE_SCAN_MODE", "required");

async function world() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  return { owner, operator, orgId: org.id };
}
type W = Awaited<ReturnType<typeof world>>;
/** Envia um arquivo real (objeto no armazenamento) com o scanner atual; devolve o id. */
const upload = async (w: W, purpose = "comprovante_destinacao") => {
  const res = await uploadPost(post("files-upload", w.operator.cookie, { organizationId: w.orgId, purpose, fileName: "recibo.png", contentType: "image/png", fileBase64: PNG }));
  return (await parseJson<{ file: { id: number } }>(res)).file.id;
};
const row = (id: number) => db.selectFrom("files").select(["scanStatus", "scanAttempts", "scanNextAttemptAt", "scanLeaseUntil", "scanExhaustedAt", "scanLastReason"]).where("id", "=", id).executeTakeFirstOrThrow();
const audits = (action: string, fileId?: number) => db.selectFrom("auditLog").select("metadata").where("action", "=", action).$if(fileId !== undefined, (q) => q.where("entityId", "=", String(fileId))).execute();
const makeDue = (id: number) => db.updateTable("files").set({ scanNextAttemptAt: new Date(Date.now() - 1000) } as never).where("id", "=", id).execute();

describe("A. política de novas tentativas", () => {
  it("backoff exponencial limitado ao teto, com jitter entre 50% e 100%", () => {
    const cfg = getFileScanRetryConfig({ FILE_SCAN_RETRY_BASE_SECONDS: "60", FILE_SCAN_RETRY_MAX_SECONDS: "600" } as never);
    expect(nextDelaySeconds(1, cfg, () => 1)).toBe(60);
    expect(nextDelaySeconds(2, cfg, () => 1)).toBe(120);
    expect(nextDelaySeconds(3, cfg, () => 1)).toBe(240);
    expect(nextDelaySeconds(10, cfg, () => 1)).toBe(600); // teto
    expect(nextDelaySeconds(10, cfg, () => 0)).toBe(300); // jitter mínimo = 50%
    for (let a = 1; a < 12; a++) expect(nextDelaySeconds(a, cfg)).toBeGreaterThanOrEqual(1);
  });

  it("configuração: valores válidos são lidos; inválidos/ausentes voltam ao padrão (nunca 0 nem negativo)", () => {
    expect(getFileScanRetryConfig({ FILE_SCAN_RETRY_MAX_ATTEMPTS: "3", FILE_SCAN_RETRY_BATCH: "5" } as never)).toMatchObject({ maxAttempts: 3, batchSize: 5 });
    const bad = getFileScanRetryConfig({ FILE_SCAN_RETRY_MAX_ATTEMPTS: "0", FILE_SCAN_RETRY_BATCH: "-4", FILE_SCAN_RETRY_BASE_SECONDS: "abc", FILE_SCAN_LEASE_SECONDS: "1" } as never);
    expect(bad).toMatchObject({ maxAttempts: 8, batchSize: 10, baseSeconds: 60, leaseSeconds: 300 });
  });
});

/** Servidor local que fala PING/VERSION do clamd (NÃO é o ClamAV). */
function fakeClamd(handler: (cmd: string) => string | "silence" | "close") {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("latin1");
      const i = buf.indexOf("\0");
      if (i < 0) return;
      const cmd = buf.slice(0, i).replace(/^z/, "");
      buf = "";
      const r = handler(cmd);
      if (r === "close") socket.destroy();
      else if (r !== "silence") socket.end(r + "\0");
    });
    socket.on("error", () => undefined);
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) })));
}

describe("B. saúde do clamd e idade da base carregada", () => {
  it("interpreta VERSION: motor, versão e data; partes ausentes ou impossíveis viram nulo (nunca inventa data)", () => {
    const ok = parseClamdVersion("ClamAV 1.5.4/28155/Fri Oct 16 06:24:17 2026\0");
    expect(ok).toMatchObject({ engine: "ClamAV 1.5.4", signatureVersion: 28155 });
    expect(ok.signatureDate?.toISOString()).toBe("2026-10-16T06:24:17.000Z");
    expect(parseClamdVersion("ClamAV 1.5.4")).toEqual({ engine: "ClamAV 1.5.4", signatureVersion: null, signatureDate: null });
    expect(parseClamdVersion("ClamAV 1.5.4/28155")).toMatchObject({ signatureVersion: 28155, signatureDate: null });
    expect(parseClamdVersion("ClamAV 1.5.4/28155/data impossível").signatureDate).toBeNull();
    expect(parseClamdVersion("lixo")).toEqual({ engine: null, signatureVersion: null, signatureDate: null });
    expect(parseClamdVersion("")).toEqual({ engine: null, signatureVersion: null, signatureDate: null });
  });

  it("idade: sem limite configurado NUNCA é 'atual'; dentro/fora do limite; data ausente ou no futuro = desconhecido", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const d = (h: number) => new Date(now.getTime() - h * 3_600_000);
    expect(evaluateFreshness(d(5), now, null)).toEqual({ ageHours: 5, freshness: "desconhecido" });
    expect(evaluateFreshness(d(5), now, 24)).toEqual({ ageHours: 5, freshness: "atual" });
    expect(evaluateFreshness(d(30), now, 24)).toEqual({ ageHours: 30, freshness: "antigo" });
    expect(evaluateFreshness(null, now, 24)).toEqual({ ageHours: null, freshness: "desconhecido" });
    expect(evaluateFreshness(new Date(now.getTime() + 86_400_000), now, 24).freshness).toBe("desconhecido");
  });

  it("ClamdScanner.health: PONG + VERSION do daemon; PING sem resposta, conexão recusada, PING inválido e VERSION inválido nunca declaram prontidão", async () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const good = await fakeClamd((c) => (c === "PING" ? "PONG" : "ClamAV 1.5.4/28155/Fri Oct 16 06:24:17 2026"));
    const quiet = await fakeClamd(() => "silence");
    const badPing = await fakeClamd(() => "NAO");
    const badVersion = await fakeClamd((c) => (c === "PING" ? "PONG" : "versão??"));
    const mk = (port: number) => new ClamdScanner({ host: "127.0.0.1", port, timeoutMs: 300, maxBytes: 1000 });
    try {
      const h = await mk(good.port).health(now, 24);
      expect(h).toMatchObject({ configured: true, reachable: true, ping: "PONG", engine: "ClamAV 1.5.4", signatureVersion: 28155, freshness: "atual", error: null });
      expect(h.signatureAgeHours).toBe(5.6);
      expect((await mk(good.port).health(now, null)).freshness).toBe("desconhecido");
      expect(await mk(quiet.port).health(now, 24)).toMatchObject({ reachable: false, ping: "sem_resposta", error: "timeout", freshness: "desconhecido" });
      expect(await mk(1).health(now, 24)).toMatchObject({ reachable: false, ping: "sem_resposta", error: "erro_de_conexao" });
      expect(await mk(badPing.port).health(now, 24)).toMatchObject({ reachable: false, ping: "resposta_invalida" });
      expect(await mk(badVersion.port).health(now, 24)).toMatchObject({ reachable: true, signatureVersion: null, signatureDate: null, freshness: "desconhecido" });
    } finally { await Promise.all([good.close(), quiet.close(), badPing.close(), badVersion.close()]); }
  });

  it("getScannerHealth sem CLAMD_HOST: configured=false, nunca 'pronto'", async () => {
    const h = await getScannerHealth(new Date(), {} as never);
    expect(h).toMatchObject({ configured: false, reachable: false, ping: "nao_configurado", freshness: "desconhecido", error: "scanner_nao_configurado" });
  });
});

describe("C. fila durável, lease, backoff e esgotamento (PostgreSQL real)", () => {
  it("indisponível no envio: fica retido com 1 tentativa e próxima tentativa agendada; antes do prazo a fila não o reivindica; vencido o prazo, o scanner de volta o aprova uma vez", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w);
    const r1 = await row(id);
    expect(r1).toMatchObject({ scanStatus: "indisponivel", scanAttempts: 1, scanLastReason: "timeout", scanExhaustedAt: null, scanLeaseUntil: null });
    expect(r1.scanNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await claimFileScanBatch(10)).toEqual([]); // ainda dentro do backoff
    const s = stub(CLEAN);
    setFileScannerForTests(s);
    expect((await runFileScanRetries()).claimed).toBe(0);
    await makeDue(id);
    const summary = await runFileScanRetries();
    expect(summary).toMatchObject({ skipped: null, claimed: 1, approved: 1, stillUnavailable: 0, failed: 0 });
    expect(await row(id)).toMatchObject({ scanStatus: "aprovado", scanAttempts: 2, scanNextAttemptAt: null, scanLeaseUntil: null, scanLastReason: null });
    expect((await audits("arquivo.analise_aprovada", id)).length).toBe(1);
    expect((await downloadGet(get(`files-download?fileId=${id}`, w.owner.cookie))).status).toBe(200);
    await runFileScanRetries();
    expect(s.calls).toBe(1); // aprovado nunca volta à fila
  });

  it("tentativas intermediárias não repetem a auditoria; no esgotamento o arquivo CONTINUA bloqueado, sai da fila e só a reanálise manual autorizada o retoma", async () => {
    required();
    vi.stubEnv("FILE_SCAN_RETRY_MAX_ATTEMPTS", "3");
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w); // tentativa 1
    for (let i = 0; i < 2; i++) { await makeDue(id); await runFileScanRetries(); } // tentativas 2 e 3
    expect(await row(id)).toMatchObject({ scanStatus: "indisponivel", scanAttempts: 3, scanNextAttemptAt: null });
    expect((await row(id)).scanExhaustedAt).not.toBeNull();
    expect((await audits("arquivo.analise_indisponivel", id)).length).toBe(1);
    expect((await audits("arquivo.analise_esgotada", id)).length).toBe(1);
    expect((await downloadGet(get(`files-download?fileId=${id}`, w.owner.cookie))).status).toBe(409);
    setFileScannerForTests(stub(CLEAN));
    expect(await claimFileScanBatch(10)).toEqual([]); // esgotado não é reivindicado nem com o scanner de volta
    expect((await runFileScanRetries()).claimed).toBe(0);
    const res = await rescanPost(post("files-rescan", w.operator.cookie, { organizationId: w.orgId, fileId: id }));
    expect((await parseJson<{ file: { scanStatus: string } }>(res)).file.scanStatus).toBe("aprovado");
    expect(await row(id)).toMatchObject({ scanStatus: "aprovado", scanExhaustedAt: null });
    expect((await audits("arquivo.analise_retomada_manual", id)).length).toBe(1);
  });

  it("dois workers concorrentes recebem conjuntos DISJUNTOS; cada arquivo ganha exatamente uma tentativa", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(await upload(w));
    await db.updateTable("files").set({ scanNextAttemptAt: new Date(Date.now() - 1000), scanAttempts: 1 } as never).where("id", "in", ids).execute();
    const [a, b, c] = await Promise.all([claimFileScanBatch(8), claimFileScanBatch(8), claimFileScanBatch(8)]);
    const all = [...a, ...b, ...c].map((f) => f.id);
    expect(new Set(all).size).toBe(all.length); // ninguém repetido
    expect(all.length).toBe(12);
    for (const id of ids) expect((await row(id)).scanAttempts).toBe(2);
    expect((await row(ids[0])).scanLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("worker que morre: o lease vence, a tarefa aparece como abandonada nos indicadores, é reivindicada de novo e conta nova tentativa; repetidas mortes esgotam sem liberar", async () => {
    required();
    vi.stubEnv("FILE_SCAN_RETRY_MAX_ATTEMPTS", "2");
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w); // tentativa 1
    await makeDue(id);
    expect((await claimFileScanBatch(5)).map((f) => f.id)).toEqual([id]); // tentativa 2, o worker "morre" sem gravar
    expect(await claimFileScanBatch(5)).toEqual([]); // lease vigente: ninguém mais pega
    await db.updateTable("files").set({ scanLeaseUntil: new Date(Date.now() - 1000) } as never).where("id", "=", id).execute();
    expect((await buildFileScanOperations()).backlog.abandonadas).toBe(1);
    expect(await claimFileScanBatch(5)).toEqual([]); // tentativas consumidas (2 de 2)
    expect(await exhaustSpentFiles()).toBe(1);
    expect(await row(id)).toMatchObject({ scanStatus: "indisponivel", scanAttempts: 2 });
    expect((await row(id)).scanExhaustedAt).not.toBeNull();
    expect((await downloadGet(get(`files-download?fileId=${id}`, w.owner.cookie))).status).toBe(409);
  });

  it("infectado, aprovado, dispensado e legado NUNCA entram na fila automática; pendente recém-enviado respeita a carência", async () => {
    required();
    const w = await world();
    const mk = async (scanStatus: string, extra: Record<string, unknown> = {}) =>
      (await db.insertInto("files").values({ scanStatus, organizationId: w.orgId, uploadedByUserId: w.owner.userId, storageProvider: "local", storageKey: `${w.orgId}/00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`, originalFilename: "x.png", contentType: "image/png", sizeBytes: 10, purpose: "comprovante_destinacao", ...extra } as never).returning("id").execute())[0].id;
    await mk("infectado");
    await mk("aprovado");
    await mk("dispensado");
    await mk("legado_nao_analisado");
    const fresh = await mk("pendente"); // acabou de ser criado
    expect(await claimFileScanBatch(50)).toEqual([]);
    const old = await mk("pendente", { createdAt: new Date(Date.now() - 10 * 60_000) });
    expect((await claimFileScanBatch(50)).map((f) => f.id)).toEqual([old]);
    expect((await row(fresh)).scanAttempts).toBe(0);
  });

  it("falha de auditoria ao gravar o resultado desfaz tudo (continua retido, sem aprovação parcial) e a próxima execução conclui", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w);
    await makeDue(id);
    setFileScannerForTests(stub(CLEAN));
    await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_q() RETURNS trigger AS $f$ BEGIN IF NEW.action = 'arquivo.analise_aprovada' THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
    await sql.raw(`CREATE TRIGGER test_fail_q_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_q()`).execute(db);
    try {
      const r = await runFileScanRetries();
      expect(r.failed).toBe(1);
    } finally {
      await sql.raw("DROP TRIGGER IF EXISTS test_fail_q_trg ON audit_log").execute(db);
      await sql.raw("DROP FUNCTION IF EXISTS test_fail_q()").execute(db);
    }
    expect((await row(id)).scanStatus).toBe("indisponivel");
    expect((await downloadGet(get(`files-download?fileId=${id}`, w.owner.cookie))).status).toBe(409);
    await db.updateTable("files").set({ scanLeaseUntil: null, scanNextAttemptAt: null } as never).where("id", "=", id).execute(); // lease vence na prática
    expect((await runFileScanRetries()).approved).toBe(1);
  });

  it("análise desligada ou sem scanner configurado: a execução é 'pulada' e NÃO consome tentativas", async () => {
    const w = await world();
    const id = await upload(w); // modo desligado: nasce dispensado
    expect((await runFileScanRetries()).skipped).toBe("analise_desligada");
    required();
    setFileScannerForTests(stub(DOWN));
    const held = await upload(w);
    await makeDue(held);
    const before = (await row(held)).scanAttempts;
    setFileScannerForTests(null); // modo obrigatório sem scanner
    expect((await runFileScanRetries()).skipped).toBe("scanner_nao_configurado");
    expect((await row(held)).scanAttempts).toBe(before);
    expect((await row(id)).scanStatus).toBe("dispensado");
  });

  it("a fila não mexe em estoque, destinações nem necessidades", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w);
    await makeDue(id);
    setFileScannerForTests(stub(CLEAN));
    const snap = async () => [(await db.selectFrom("stockTransactions").select("id").execute()).length, (await db.selectFrom("stockDestinations").select("id").execute()).length, (await db.selectFrom("needs").select("id").execute()).length];
    const before = await snap();
    await runFileScanRetries();
    expect(await snap()).toEqual(before);
  });
});

describe("D. tarefa agendada", () => {
  it("está registrada no agendador e nos handlers; cada execução fica em background_task_runs com resumo agregado (sem nomes de arquivo)", async () => {
    expect(Object.keys(TASK_HANDLERS)).toContain("retryFileScans");
    required();
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w);
    await makeDue(id);
    setFileScannerForTests(stub(CLEAN));
    await retryFileScansScheduled();
    const run = await db.selectFrom("backgroundTaskRuns").select(["status", "result"]).where("taskName", "=", "retryFileScans").orderBy("createdAt", "desc").executeTakeFirstOrThrow();
    expect(run.status).toBe("concluida");
    expect(run.result).toMatchObject({ kind: "retry_run", claimed: 1, approved: 1 });
    expect(JSON.stringify(run.result)).not.toMatch(/recibo|storage/i);
  });

  it("execuções simultâneas da MESMA tarefa: uma roda e a outra é descartada pela trava", async () => {
    required();
    const slow = stub(async () => { await new Promise((r) => setTimeout(r, 200)); return CLEAN; });
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w);
    await makeDue(id);
    setFileScannerForTests(slow);
    await Promise.all([retryFileScansScheduled(), retryFileScansScheduled(), retryFileScansScheduled()]);
    expect(slow.calls).toBe(1);
    expect((await audits("arquivo.analise_aprovada", id)).length).toBe(1);
  });
});

describe("E. indicadores globais e conciliação", () => {
  it("contagens, idades, alertas com limiar 'nao_definido' quando não configurado, e nenhum nome/chave na resposta", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub(DOWN));
    const id = await upload(w);
    await db.updateTable("files").set({ createdAt: new Date(Date.now() - 90 * 60_000) } as never).where("id", "=", id).execute();
    const ops = await buildFileScanOperations(new Date(), {} as never);
    expect(ops.backlog).toMatchObject({ indisponivel: 1, esgotadas: 0, abandonadas: 0 });
    expect(ops.backlog.indisponivelMaisAntigoMinutos).toBeGreaterThanOrEqual(89);
    const alert = (code: string) => ops.alerts.find((a) => a.code === code)!;
    expect(alert("backlog_envelhecido").level).toBe("nao_definido");
    expect(alert("worker_sem_executar").level).toBe("nao_definido");
    expect(alert("assinaturas_desconhecidas").level).toBe("alerta"); // sem scanner e sem limite: nunca "ok"
    const withLimits = await buildFileScanOperations(new Date(), { FILE_SCAN_ALERT_BACKLOG_MINUTES: "30", FILE_SCAN_ALERT_WORKER_MINUTES: "15", FILE_SCAN_MODE: "required" } as never);
    expect(withLimits.alerts.find((a) => a.code === "backlog_envelhecido")!.level).toBe("alerta");
    expect(withLimits.alerts.find((a) => a.code === "worker_sem_executar")!.level).toBe("alerta"); // nunca executou
    expect(JSON.stringify(ops)).not.toMatch(/recibo|storage|png|\/uploads/i);
  });

  it("endpoint global: só administração da plataforma; proprietário de organização e anônimo não leem", async () => {
    required();
    const w = await world();
    const admin = await createPlatformAdmin();
    expect((await opsGet(get("file-scan-operations", admin.cookie))).status).toBe(200);
    expect((await opsGet(get("file-scan-operations", w.owner.cookie))).status).toBe(403);
    expect((await opsGet(buildRequest("file-scan-operations", { method: "GET" }))).status).toBeGreaterThanOrEqual(401);
  });

  it("conciliação da organização mostra a fila (tentativas, próxima tentativa, esgotado, abandonado) só da própria organização, sem chaves", async () => {
    required();
    const a = await world();
    const b = await world();
    setFileScannerForTests(stub(DOWN));
    const mine = await upload(a);
    await upload(b);
    const res = await reconGet(get(`destination-proofs-reconciliation?organizationId=${a.orgId}`, a.owner.cookie));
    const body = await parseJson<{ retidosPorAnalise: Array<{ id: number; retry: { attempts: number; nextAttemptAt: string | null; exhausted: boolean; abandoned: boolean; lastReason: string | null } }> }>(res);
    expect(body.retidosPorAnalise.map((f) => f.id)).toEqual([mine]);
    expect(body.retidosPorAnalise[0].retry).toMatchObject({ attempts: 1, exhausted: false, abandoned: false, lastReason: "timeout" });
    expect(body.retidosPorAnalise[0].retry.nextAttemptAt).not.toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/storageKey|storage_key/);
  });
});
