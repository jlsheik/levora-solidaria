/**
 * Hardening pós-99K — análise antimalware. Três camadas, ROTULADAS (nenhuma é "o serviço real" a não ser a última, que só roda com CLAMD_HOST):
 *   A) funções puras (modo, liberação, interpretação da resposta do clamd);
 *   B) cliente `ClamdScanner` contra um servidor TCP local que fala o protocolo clamd (valida enquadramento INSTREAM, timeout, resposta inválida, conexão recusada) — NÃO é o ClamAV;
 *   C) máquina de estados (upload → análise → liberação / bloqueio) em PostgreSQL real com um scanner simulado injetado;
 *   D) scanner REAL (ClamAV) com o arquivo de teste EICAR — pulado quando CLAMD_HOST não está definido.
 */
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import net from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { storageAdapter } from "../src/helpers/storageAdapter";
import { ClamdScanner, UnconfiguredScanner, getScanMode, isReleasable, parseClamdReply, setFileScannerForTests, type FileScanner, type ScanOutcome } from "../src/helpers/fileScanner";
import { handle as uploadPost } from "../src/endpoints/files-upload_POST";
import { handle as downloadGet } from "../src/endpoints/files-download_GET";
import { handle as rescanPost } from "../src/endpoints/files-rescan_POST";
import { handle as proofPost } from "../src/endpoints/stock-destination-proof_POST";
import { handle as destPost } from "../src/endpoints/stock-destinations_POST";
import { handle as reconGet } from "../src/endpoints/destination-proofs-reconciliation_GET";
import { addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOrganization, parseJson } from "./helpers";
import { businessDateOf } from "../src/helpers/businessDate";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const TEST_STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");
afterAll(async () => rm(TEST_STORAGE_DIR, { recursive: true, force: true }));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
// Capture at module load: earlier tests deliberately delete CLAMD_HOST to verify fail-closed behavior.
const REAL_CLAMD_HOST = process.env.CLAMD_HOST;
const REAL_CLAMD_PORT = process.env.CLAMD_PORT;
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;

afterEach(() => {
  setFileScannerForTests(undefined);
  delete process.env.FILE_SCAN_MODE;
  vi.unstubAllEnvs();
});

const stub = (outcomes: ScanOutcome | ((n: number) => ScanOutcome | Promise<ScanOutcome>)): FileScanner & { calls: number } => {
  const s = {
    name: "simulado",
    calls: 0,
    async scan() {
      s.calls++;
      return typeof outcomes === "function" ? outcomes(s.calls) : outcomes;
    },
  };
  return s;
};
const CLEAN: ScanOutcome = { status: "limpo", engine: "ClamAV simulado" };

describe("A. funções puras", () => {
  it("modo: produção é SEMPRE obrigatório; fora dela só com FILE_SCAN_MODE=required; o padrão de teste/desenvolvimento é desligado", () => {
    expect(getScanMode({ NODE_ENV: "production" } as never)).toBe("required");
    expect(getScanMode({ NODE_ENV: "production", FILE_SCAN_MODE: "disabled" } as never)).toBe("required");
    expect(getScanMode({ NODE_ENV: "development" } as never)).toBe("disabled");
    expect(getScanMode({ NODE_ENV: "test", FILE_SCAN_MODE: "required" } as never)).toBe("required");
  });

  it("liberação: no modo obrigatório só 'aprovado' libera; fora dele 'dispensado' e legado também; 'infectado', 'pendente' e 'indisponivel' nunca", () => {
    for (const s of ["pendente", "indisponivel", "infectado", "dispensado", "legado_nao_analisado"]) expect(isReleasable(s, "required"), s).toBe(false);
    expect(isReleasable("aprovado", "required")).toBe(true);
    for (const s of ["pendente", "indisponivel", "infectado"]) expect(isReleasable(s, "disabled"), s).toBe(false);
    for (const s of ["aprovado", "dispensado", "legado_nao_analisado"]) expect(isReleasable(s, "disabled"), s).toBe(true);
  });

  it("resposta do clamd: só 'stream: OK' é limpo; FOUND é infectado; vazio, múltiplas linhas, ERROR e texto desconhecido nunca aprovam", () => {
    expect(parseClamdReply("stream: OK\0", "ClamAV 1.4")).toEqual({ status: "limpo", engine: "ClamAV 1.4" });
    expect(parseClamdReply("stream: Eicar-Test-Signature FOUND\0", null)).toMatchObject({ status: "infectado", signature: "Eicar-Test-Signature" });
    for (const bad of ["", "\0", "OK", "stream: OK\nstream: OK", "stream: INSTREAM size limit exceeded. ERROR", "stream: talvez", "UNKNOWN COMMAND", "stream: OKAY"]) {
      expect(parseClamdReply(bad, null).status, JSON.stringify(bad)).toBe("indisponivel");
    }
  });
});

/** Servidor TCP local que fala o protocolo clamd (INSTREAM/VERSION). */
function fakeClamd(onFile: (bytes: Buffer) => string | "silence" | "close") {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let mode: "cmd" | "stream" = "cmd";
    const file: Buffer[] = [];
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (mode === "cmd") {
          const i = buf.indexOf(0);
          if (i < 0) return;
          const cmd = buf.subarray(0, i).toString();
          buf = buf.subarray(i + 1);
          if (cmd === "zVERSION") { socket.end("ClamAV 1.4.0-fake\0"); return; }
          if (cmd === "zINSTREAM") mode = "stream";
        } else {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            const reply = onFile(Buffer.concat(file));
            if (reply === "close") socket.destroy();
            else if (reply !== "silence") socket.end(reply);
            return;
          }
          if (buf.length < 4 + len) return;
          file.push(buf.subarray(4, 4 + len));
          buf = buf.subarray(4 + len);
        }
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) })));
}

describe("B. ClamdScanner contra um servidor que fala o protocolo (NÃO é o ClamAV)", () => {
  const opts = (port: number, extra = {}) => ({ host: "127.0.0.1", port, timeoutMs: 800, maxBytes: 10_000_000, ...extra });
  it("envia os bytes exatos em blocos INSTREAM (inclusive > 64 KB) e interpreta OK / FOUND", async () => {
    const received: Buffer[] = [];
    const srv = await fakeClamd((bytes) => { received.push(bytes); return bytes.includes(Buffer.from("EICAR-STANDARD")) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"; });
    try {
      const scanner = new ClamdScanner(opts(srv.port));
      const big = Buffer.alloc(200_000, 7);
      expect(await scanner.scan(big)).toMatchObject({ status: "limpo", engine: "ClamAV 1.4.0-fake" });
      expect(received[0].equals(big)).toBe(true);
      expect(await scanner.scan(Buffer.from(EICAR))).toMatchObject({ status: "infectado", signature: "Eicar-Test-Signature" });
    } finally { await srv.close(); }
  });

  it("timeout, conexão encerrada, resposta inválida, conexão recusada e arquivo acima do limite NUNCA aprovam", async () => {
    const quiet = await fakeClamd(() => "silence");
    const dropper = await fakeClamd(() => "close");
    const garbage = await fakeClamd(() => "lixo qualquer\0");
    const errorReply = await fakeClamd(() => "stream: INSTREAM size limit exceeded. ERROR\0");
    try {
      expect(await new ClamdScanner(opts(quiet.port, { timeoutMs: 200 })).scan(Buffer.from("x"))).toEqual({ status: "indisponivel", reason: "timeout" });
      expect((await new ClamdScanner(opts(dropper.port)).scan(Buffer.from("x"))).status).toBe("indisponivel");
      expect((await new ClamdScanner(opts(garbage.port)).scan(Buffer.from("x"))).status).toBe("indisponivel");
      expect((await new ClamdScanner(opts(errorReply.port)).scan(Buffer.from("x"))).status).toBe("indisponivel");
      expect((await new ClamdScanner(opts(1)).scan(Buffer.from("x"))).status).toBe("indisponivel"); // porta fechada
      expect(await new ClamdScanner(opts(quiet.port, { maxBytes: 3 })).scan(Buffer.from("abcdef"))).toEqual({ status: "indisponivel", reason: "arquivo_grande_demais" });
    } finally { await Promise.all([quiet.close(), dropper.close(), garbage.close(), errorReply.close()]); }
  });

  it("sem CLAMD_HOST o scanner é o 'não configurado': sempre indisponível (falha fechada)", async () => {
    expect(await new UnconfiguredScanner().scan()).toEqual({ status: "indisponivel", reason: "scanner_nao_configurado" });
  });
});

async function world() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const operator2 = await createAuthenticatedUser();
  await addMembership(org.id, operator2.userId, "operador");
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
  await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "1000", reason: "saldo", createdByUserId: owner.userId }).execute();
  return { owner, admin, operator, operator2, orgId: org.id, itemId: item.id };
}
type W = Awaited<ReturnType<typeof world>>;
const required = () => { process.env.FILE_SCAN_MODE = "required"; };
const upload = async (w: W, user: Auth = w.operator, purpose = "comprovante_destinacao") => {
  const res = await uploadPost(post("files-upload", user.cookie, { organizationId: w.orgId, purpose, fileName: "recibo.png", contentType: "image/png", fileBase64: PNG }));
  const body = res.status === 200 ? await parseJson<{ file: { id: number; scanStatus: string; scanMessage: string } }>(res) : null;
  return { status: res.status, id: body?.file.id as number, scanStatus: body?.file.scanStatus as string, message: body?.file.scanMessage as string };
};
const dest = async (w: W) => (await parseJson<{ destination: { id: string } }>(await destPost(post("stock-destinations", w.operator.cookie, { organizationId: w.orgId, itemId: w.itemId, quantity: 5, destinationType: "distribuicao_familias", deliveredOn: businessDateOf(new Date()), idempotencyKey: key() })))).destination.id;
const attach = (w: W, destinationId: string, fileId: number, user: Auth = w.operator) => proofPost(post("stock-destination-proof", user.cookie, { organizationId: w.orgId, destinationId, action: "anexar", fileId, reason: "Comprovante da entrega", idempotencyKey: key() }));
const download = (fileId: number, user: Auth) => downloadGet(buildRequest(`files-download?fileId=${fileId}`, { method: "GET", cookie: user.cookie }));
const rescan = (w: W, fileId: number, user: Auth = w.operator) => rescanPost(post("files-rescan", user.cookie, { organizationId: w.orgId, fileId }));
const row = (id: number) => db.selectFrom("files").select(["scanStatus", "scanEngine", "scanSignature", "scanCheckedAt"]).where("id", "=", id).executeTakeFirstOrThrow();
const audits = (action: string) => db.selectFrom("auditLog").select("metadata").where("action", "=", action).execute();

describe("C. máquina de estados em PostgreSQL real (scanner simulado injetado)", () => {
  it("modo desligado (desenvolvimento/testes): arquivo nasce 'dispensado' — nunca 'aprovado' — e é liberado; sem scanner nenhum é chamado", async () => {
    const w = await world();
    const s = stub(CLEAN);
    setFileScannerForTests(s);
    const up = await upload(w);
    expect(up.scanStatus).toBe("dispensado");
    expect(s.calls).toBe(0);
    expect((await download(up.id, w.operator)).status).toBe(200);
  });

  it("modo obrigatório + limpo: nasce retido, o scanner aprova, o motor/data ficam registrados, o download e o vínculo passam", async () => {
    required();
    const w = await world();
    const s = stub(CLEAN);
    setFileScannerForTests(s);
    const up = await upload(w);
    expect(up).toMatchObject({ status: 200, scanStatus: "aprovado" });
    expect(await row(up.id)).toMatchObject({ scanStatus: "aprovado", scanEngine: "simulado ClamAV simulado" });
    expect((await row(up.id)).scanCheckedAt).not.toBeNull();
    expect((await audits("arquivo.analise_aprovada")).length).toBe(1);
    expect((await download(up.id, w.operator)).status).toBe(200);
    expect((await attach(w, await dest(w), up.id)).status).toBe(200);
  });

  it("infectado: fica ISOLADO (não apagado), não é servido a ninguém, não vincula (aplicação E banco) e não muda de estado", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub({ status: "infectado", signature: "Eicar-Test-Signature", engine: "ClamAV simulado" }));
    const up = await upload(w);
    expect(up.scanStatus).toBe("infectado");
    expect(up.message).toMatch(/bloqueado/);
    expect(await row(up.id)).toMatchObject({ scanStatus: "infectado", scanSignature: "Eicar-Test-Signature" });
    for (const u of [w.operator, w.admin, w.owner]) {
      const r = await download(up.id, u);
      expect(r.status).toBe(409);
      expect((await parseJson<{ code: string }>(r)).code).toBe("arquivo_nao_liberado");
    }
    const d = await dest(w);
    const r = await attach(w, d, up.id, w.admin);
    expect(r.status).toBe(409);
    expect((await parseJson<{ code: string }>(r)).code).toBe("arquivo_nao_aprovado");
    // o banco recusa por si só, sem passar pela aplicação
    await expect(db.insertInto("stockDestinations").values({ organizationId: w.orgId, entryType: "correction", itemId: w.itemId, reversesDestinationId: d, proofFileId: up.id, reason: "Tentativa direta", createdByUserId: w.owner.userId } as never).execute()).rejects.toThrow(/análise/);
    await expect(db.updateTable("files").set({ scanStatus: "aprovado" } as never).where("id", "=", up.id).execute()).rejects.toThrow(/final/);
    setFileScannerForTests(stub(CLEAN));
    expect((await parseJson<{ file: { scanStatus: string } }>(await rescan(w, up.id))).file.scanStatus).toBe("infectado"); // reanálise não "limpa" um infectado
    expect(await db.selectFrom("files").select("id").where("id", "=", up.id).executeTakeFirst()).toBeDefined();
    expect((await audits("arquivo.bloqueado_por_analise")).length).toBe(1);
  });

  it("scanner indisponível (não configurado, timeout, resposta inválida, erro inesperado): arquivo RETIDO, nunca aprovado; reanálise com o serviço de volta aprova", async () => {
    required();
    const w = await world();
    const reasons = ["scanner_nao_configurado", "timeout", "resposta_invalida", "erro_inesperado"] as const;
    for (const reason of reasons) {
      setFileScannerForTests(reason === "erro_inesperado" ? ({ name: "quebrado", scan: async () => { throw new Error("boom"); } } as FileScanner) : stub({ status: "indisponivel", reason }));
      const up = await upload(w);
      expect(up.scanStatus, reason).toBe("indisponivel");
      expect(up.message).toMatch(/indisponível/);
      expect((await download(up.id, w.operator)).status).toBe(409);
      expect((await attach(w, await dest(w), up.id)).status).toBe(409);
    }
    setFileScannerForTests(null); // nenhum scanner configurado em modo obrigatório = falha fechada
    const none = await upload(w);
    expect(none.scanStatus).toBe("indisponivel");
    setFileScannerForTests(stub(CLEAN));
    const body = await parseJson<{ file: { scanStatus: string; released: boolean } }>(await rescan(w, none.id));
    expect(body.file).toMatchObject({ scanStatus: "aprovado", released: true });
    expect((await download(none.id, w.operator)).status).toBe(200);
  });

  it("produção sem scanner configurado falha fechada (NODE_ENV=production, sem FILE_SCAN_MODE)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.FILE_SCAN_MODE;
    const w = await world();
    setFileScannerForTests(undefined);
    delete process.env.CLAMD_HOST;
    const up = await upload(w);
    expect(up.scanStatus).toBe("indisponivel");
    expect((await download(up.id, w.owner)).status).toBe(409);
  });

  it("outros propósitos NÃO contornam a análise: comprovante de entrega também fica retido e não é servido", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub({ status: "indisponivel", reason: "timeout" }));
    const up = await upload(w, w.operator, "comprovante_entrega");
    expect(up.scanStatus).toBe("indisponivel");
    expect((await download(up.id, w.admin)).status).toBe(409);
  });

  it("legado (anterior à análise): servido fora do modo obrigatório, BLOQUEADO no obrigatório até reanalisar", async () => {
    const w = await world();
    const [f] = await db.insertInto("files").values({ organizationId: w.orgId, uploadedByUserId: w.owner.userId, storageProvider: "local", storageKey: `${w.orgId}/00000000-0000-4000-8000-000000000000`, originalFilename: "antigo.png", contentType: "image/png", sizeBytes: 10, purpose: "comprovante_entrega", scanStatus: "legado_nao_analisado" } as never).returning("id").execute();
    await expect(download(f.id, w.owner)).resolves.toBeDefined();
    required();
    const r = await download(f.id, w.owner);
    expect(r.status).toBe(409);
    expect((await parseJson<{ scanStatus: string }>(r)).scanStatus).toBe("legado_nao_analisado");
  });

  it("concorrência: reanálises simultâneas gravam o estado final UMA vez e a auditoria não duplica; reanálise de aprovado não chama o scanner", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub({ status: "indisponivel", reason: "timeout" }));
    const up = await upload(w);
    const slow = stub(async () => { await new Promise((r) => setTimeout(r, 150)); return CLEAN; });
    setFileScannerForTests(slow);
    const rs = await Promise.all([rescan(w, up.id), rescan(w, up.id, w.admin), rescan(w, up.id), rescan(w, up.id, w.owner)]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    for (const r of rs) expect((await parseJson<{ file: { scanStatus: string } }>(r)).file.scanStatus).toBe("aprovado");
    expect((await audits("arquivo.analise_aprovada")).length).toBe(1);
    const before = slow.calls;
    await rescan(w, up.id);
    expect(slow.calls).toBe(before); // idempotente: sem nova análise
  });

  it("falha da auditoria durante a gravação da análise desfaz o resultado (continua retido) e a reanálise depois funciona; erro de armazenamento = indisponível", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub({ status: "indisponivel", reason: "timeout" }));
    const up = await upload(w);
    setFileScannerForTests(stub(CLEAN));
    await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_scan() RETURNS trigger AS $f$ BEGIN IF NEW.action = 'arquivo.analise_aprovada' THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
    await sql.raw(`CREATE TRIGGER test_fail_scan_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_scan()`).execute(db);
    try {
      expect((await rescan(w, up.id)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await sql.raw("DROP TRIGGER IF EXISTS test_fail_scan_trg ON audit_log").execute(db);
      await sql.raw("DROP FUNCTION IF EXISTS test_fail_scan()").execute(db);
    }
    expect((await row(up.id)).scanStatus).toBe("indisponivel");
    expect((await download(up.id, w.operator)).status).toBe(409);
    expect((await rescan(w, up.id)).status).toBe(200);
    expect((await row(up.id)).scanStatus).toBe("aprovado");
    // objeto sumiu do armazenamento: a análise não consegue ler → indisponível (nunca aprovado)
    setFileScannerForTests(stub({ status: "indisponivel", reason: "timeout" }));
    const lost = await upload(w);
    const k = (await db.selectFrom("files").select("storageKey").where("id", "=", lost.id).executeTakeFirstOrThrow()).storageKey;
    await storageAdapter.delete(k);
    setFileScannerForTests(stub(CLEAN));
    expect((await parseJson<{ file: { scanStatus: string } }>(await rescan(w, lost.id))).file.scanStatus).toBe("indisponivel");
  });

  it("falha do armazenamento no envio não deixa registro; autorização antes do estado: quem não pode ver recebe 403, não 409; outra organização não reanalisa", async () => {
    required();
    const a = await world();
    const b = await world();
    setFileScannerForTests(stub({ status: "indisponivel", reason: "timeout" }));
    const before = (await db.selectFrom("files").select("id").execute()).length;
    const spy = vi.spyOn(storageAdapter, "upload").mockRejectedValueOnce(new Error("indisponível"));
    expect((await upload(a)).status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();
    expect((await db.selectFrom("files").select("id").execute()).length).toBe(before);
    const up = await upload(a);
    expect((await download(up.id, b.owner)).status).toBe(403);
    expect((await rescan(b, up.id, b.owner)).status).toBe(404);
    expect((await rescanPost(post("files-rescan", b.owner.cookie, { organizationId: a.orgId, fileId: up.id }))).status).toBe(403);
    expect((await rescan(a, up.id, a.operator2)).status).toBe(403); // não é quem enviou nem gerente
  });

  it("reconciliação lista os arquivos retidos por análise (pendentes/indisponíveis/infectados) sem apagar nada e sem expor chave de armazenamento", async () => {
    required();
    const w = await world();
    setFileScannerForTests(stub({ status: "infectado", signature: "Eicar-Test-Signature", engine: "x" }));
    const bad = await upload(w);
    setFileScannerForTests(stub({ status: "indisponivel", reason: "timeout" }));
    const held = await upload(w);
    const before = (await db.selectFrom("files").select("id").execute()).length;
    const res = await reconGet(buildRequest(`destination-proofs-reconciliation?organizationId=${w.orgId}`, { method: "GET", cookie: w.admin.cookie }));
    const body = await parseJson<{ retidosPorAnalise: Array<{ id: number; scanStatus: string }> }>(res);
    expect(body.retidosPorAnalise.map((f) => [f.id, f.scanStatus]).sort()).toEqual([[bad.id, "infectado"], [held.id, "indisponivel"]].sort());
    expect(JSON.stringify(body)).not.toMatch(/storageKey|storage_key/);
    expect((await db.selectFrom("files").select("id").execute()).length).toBe(before);
  });
});

describe.skipIf(!REAL_CLAMD_HOST)("D. scanner REAL (ClamAV) - só roda com CLAMD_HOST/CLAMD_PORT apontando para um clamd em rede privada", () => {
  it("detecta EICAR, aprova arquivo limpo e valida upload/download real em modo fail-closed", async () => {
    const options = { host: REAL_CLAMD_HOST!, port: Number(REAL_CLAMD_PORT ?? 3310), timeoutMs: 15000, maxBytes: 25 * 1024 * 1024 };
    const scanner = new ClamdScanner(options);
    // a mensagem inclui o desfecho completo (motivo, se indisponível): um toMatchObject escondia a propriedade `reason` quando o scanner real não respondia
    const eicarResult = await scanner.scan(Buffer.from(EICAR));
    expect(eicarResult.status, JSON.stringify(eicarResult)).toBe("infectado");
    expect(eicarResult).toMatchObject({ signature: expect.stringMatching(/Eicar/i) });
    const cleanResult = await scanner.scan(Buffer.from(PNG, "base64"));
    expect(cleanResult.status, JSON.stringify(cleanResult)).toBe("limpo");

    const w = await world();
    required();
    setFileScannerForTests(scanner);

    const clean = await upload(w);
    expect(clean).toMatchObject({ status: 200, scanStatus: "aprovado" });
    expect(await row(clean.id)).toMatchObject({ scanStatus: "aprovado" });
    expect((await row(clean.id)).scanCheckedAt).not.toBeNull();
    expect((await download(clean.id, w.operator)).status).toBe(200);

    // EICAR dentro de um PDF de teste para percorrer o mesmo validador de arquivo do endpoint real.
    const eicarBytes = Buffer.from(EICAR, "utf8");
    const pdfPrefix = Buffer.from(
      "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>\nendobj\n" +
      "4 0 obj\n<< /Length " + eicarBytes.length + " >>\nstream\n",
      "utf8",
    );
    const eicarPdf = Buffer.concat([pdfPrefix, eicarBytes, Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8")]);
    expect((await scanner.scan(eicarPdf)).status).toBe("infectado");
    const infectedResponse = await uploadPost(post("files-upload", w.operator.cookie, {
      organizationId: w.orgId,
      purpose: "comprovante_destinacao",
      fileName: "eicar-validation.pdf",
      contentType: "application/pdf",
      fileBase64: eicarPdf.toString("base64"),
    }));
    expect(infectedResponse.status).toBe(200);
    const infectedBody = await parseJson<{ file: { id: number; scanStatus: string } }>(infectedResponse);
    const infectedId = infectedBody.file.id;
    expect(infectedBody.file.scanStatus).toBe("infectado");
    expect(await row(infectedId)).toMatchObject({ scanStatus: "infectado", scanSignature: expect.stringMatching(/Eicar/i) });
    for (const actor of [w.operator, w.admin, w.owner]) expect((await download(infectedId, actor)).status).toBe(409);

    const destinationId = await dest(w);
    expect((await attach(w, destinationId, infectedId, w.admin)).status).toBe(409);
    expect(await db.selectFrom("stockDestinations").select("id").where("proofFileId", "=", infectedId).execute()).toHaveLength(0);
    expect(JSON.stringify(await audits("arquivo.bloqueado_por_analise"))).not.toContain(EICAR);

    // Porta confirmadamente fechada no host de teste: falha real de conexao, nao scanner simulado.
    setFileScannerForTests(new ClamdScanner({ host: "127.0.0.1", port: 13311, timeoutMs: 1000, maxBytes: 25 * 1024 * 1024 }));
    const unavailable = await upload(w);
    expect(unavailable).toMatchObject({ status: 200, scanStatus: "indisponivel" });
    expect(await row(unavailable.id)).toMatchObject({ scanStatus: "indisponivel" });
    expect((await download(unavailable.id, w.operator)).status).toBe(409);
    expect((await attach(w, destinationId, unavailable.id, w.admin)).status).toBe(409);
    expect(await db.selectFrom("stockDestinations").select("id").where("proofFileId", "=", unavailable.id).execute()).toHaveLength(0);

    // recuperação: com o scanner real de volta, a NOVA análise válida libera o arquivo limpo; o EICAR continua infectado (reanálise não o libera) e nada foi aprovado retroativamente antes disso
    setFileScannerForTests(scanner);
    const recovered = await parseJson<{ file: { scanStatus: string } }>(await rescan(w, unavailable.id));
    expect(recovered.file.scanStatus).toBe("aprovado");
    expect((await download(unavailable.id, w.operator)).status).toBe(200);
    const again = await parseJson<{ file: { scanStatus: string } }>(await rescan(w, infectedId));
    expect(again.file.scanStatus).toBe("infectado");
    expect((await download(infectedId, w.owner)).status).toBe(409);
    expect((await row(infectedId)).scanStatus).toBe("infectado");
  });
});
