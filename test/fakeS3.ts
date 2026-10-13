/**
 * Servidor HTTP local que fala o suficiente do protocolo S3 (modo path-style, o que o adaptador usa quando há `S3_ENDPOINT`) para o SDK REAL
 * (`@aws-sdk/client-s3`) conversar com ele pela rede de verdade: PutObject, GetObject e DeleteObject, erros em XML (NoSuchKey, AccessDenied,
 * InternalError) e falhas de transporte (resposta que nunca chega, corpo truncado, corpo que trava no meio). Só escuta em 127.0.0.1, numa porta do SO,
 * guarda tudo em memória e é encerrado pelo teste. Credenciais são SINTÉTICAS: o servidor só confere que a requisição veio assinada (SigV4) e nunca
 * valida a assinatura — não é um S3 de verdade, é um contrato HTTP controlado.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FaultMode = "none" | "access-denied" | "no-such-key" | "internal-error" | "hang" | "truncate" | "stall";

export interface FakeS3Request { method: string; path: string; authorization: string | null; headers: http.IncomingHttpHeaders; bodyBytes: number }

export class FakeS3 {
  readonly objects = new Map<string, { body: Buffer; contentType: string | undefined }>();
  readonly requests: FakeS3Request[] = [];
  /** Falha aplicada a GetObject (e opcionalmente a PutObject/Delete) — por padrão nenhuma. */
  fault: FaultMode = "none";
  faultOnPut = false;
  /** DeleteObject responde 500 (armazenamento indisponível na hora da compensação). */
  faultOnDelete = false;
  private server: http.Server;
  private sockets = new Set<import("node:net").Socket>();
  endpoint = "";
  port = 0;

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    this.endpoint = `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private xml(res: http.ServerResponse, status: number, code: string, message: string) {
    res.writeHead(status, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>fake-request-id</RequestId></Error>`);
  }

  /** Remove o enquadramento `aws-chunked` (o SDK novo envia assim, com checksum em trailer) e devolve só os bytes do objeto. */
  private static decodeAwsChunked(raw: Buffer): Buffer {
    const parts: Buffer[] = []; let i = 0;
    while (i < raw.length) {
      const eol = raw.indexOf("\r\n", i); if (eol < 0) break;
      const size = parseInt(raw.subarray(i, eol).toString().split(";")[0], 16);
      if (!Number.isFinite(size) || size === 0) break;
      parts.push(raw.subarray(eol + 2, eol + 2 + size)); i = eol + 2 + size + 2;
    }
    return Buffer.concat(parts);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    let body: Buffer = Buffer.concat(chunks);
    if (String(req.headers["content-encoding"] ?? "").includes("aws-chunked") || String(req.headers["x-amz-content-sha256"] ?? "").startsWith("STREAMING")) body = FakeS3.decodeAwsChunked(body);
    const path = decodeURIComponent((req.url ?? "").split("?")[0]);
    this.requests.push({ method: req.method ?? "", path, authorization: (req.headers.authorization as string) ?? null, headers: req.headers, bodyBytes: body.length });
    // modelo S3: sempre assinado (SigV4); sem Authorization é AccessDenied
    if (!String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256 ")) return this.xml(res, 403, "AccessDenied", "Request is not signed");
    const key = path.replace(/^\//, ""); // bucket/chave
    if (req.method === "PUT") {
      if (this.faultOnPut && this.fault === "internal-error") return this.xml(res, 500, "InternalError", "We encountered an internal error");
      if (this.faultOnPut && this.fault === "access-denied") return this.xml(res, 403, "AccessDenied", "Access Denied");
      this.objects.set(key, { body, contentType: req.headers["content-type"] as string | undefined });
      res.writeHead(200, { ETag: '"fake-etag"' }); return res.end();
    }
    if (req.method === "DELETE") {
      if (this.faultOnDelete) return this.xml(res, 500, "InternalError", "We encountered an internal error");
      this.objects.delete(key); res.writeHead(204); return res.end(); }
    if (req.method === "GET") {
      if (this.fault === "hang") return; // nunca responde
      if (this.fault === "access-denied") return this.xml(res, 403, "AccessDenied", "Access Denied");
      if (this.fault === "internal-error") return this.xml(res, 500, "InternalError", "We encountered an internal error");
      const obj = this.objects.get(key);
      if (this.fault === "no-such-key" || !obj) return this.xml(res, 404, "NoSuchKey", "The specified key does not exist.");
      res.writeHead(200, { "Content-Type": obj.contentType ?? "application/octet-stream", "Content-Length": String(obj.body.length), ETag: '"fake-etag"' });
      if (this.fault === "truncate") { res.write(obj.body.subarray(0, Math.floor(obj.body.length / 2))); setTimeout(() => res.socket?.destroy(), 20); return; }
      if (this.fault === "stall") { res.write(obj.body.subarray(0, Math.floor(obj.body.length / 2))); return; } // promete mais bytes e não envia
      return res.end(obj.body);
    }
    res.writeHead(405); res.end();
  }
}
