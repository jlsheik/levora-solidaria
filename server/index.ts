/**
 * Servidor real da Levora Solidária, fora do Floot.
 *
 * Os endpoints em src/endpoints/**​/*_GET.ts e *_POST.ts foram portados
 * verbatim do Floot: cada um exporta `handle(request: Request): Promise<Response>`
 * usando a Web Fetch API padrão (não um handler específico do Express).
 * Este servidor descobre esses arquivos automaticamente e os expõe em
 * /_api/v1/<rota>, convertendo entre Request/Response (Web API) e Express.
 *
 * Versionamento (master prompt, seção 86: "API versionada `/api/v1/...`"):
 * o prefixo de transporte desta API sempre foi `/_api` (convenção herdada
 * do Floot, mantida na migração — é só o que o proxy do Vite encaminha
 * para este servidor, ver vite.config.ts; não tem relação com o cliente
 * sendo servido). "v1" é a versão do CONTRATO da API, adicionada como
 * segmento de rota logo depois: `/_api/v1/<rota>`. Uma v2 no futuro
 * conviveria lado a lado (`/_api/v2/<rota>`) sem quebrar clientes ainda
 * presos ao contrato v1 — é essa a garantia que versionar a API existe
 * para dar, não a string exata "/api/" vs "/_api/".
 */
import "dotenv/config";
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINTS_DIR = path.resolve(__dirname, "../src/endpoints");
const PORT = Number(process.env.PORT ?? 3001);
const API_VERSION_PREFIX = "/_api/v1";

type HttpMethod = "GET" | "POST";

interface DiscoveredEndpoint {
  route: string; // e.g. "auth/login_with_password"
  method: HttpMethod;
  absPath: string;
}

function discoverEndpoints(dir: string, baseDir: string = dir): DiscoveredEndpoint[] {
  const found: DiscoveredEndpoint[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...discoverEndpoints(full, baseDir));
      continue;
    }
    const match = entry.name.match(/^(.*)_(GET|POST)\.ts$/);
    if (!match) continue; // skip *.schema.ts and anything else
    const [, name, method] = match;
    const relDir = path.relative(baseDir, dir);
    const route = (relDir ? `${relDir}/${name}` : name).replace(/\\/g, "/");
    found.push({ route, method: method as HttpMethod, absPath: full });
  }
  return found;
}

async function buildExpressHandler(absPath: string) {
  const mod = await import(pathToFileURL(absPath).href);
  const handle = mod.handle as (request: Request) => Promise<Response>;
  if (typeof handle !== "function") {
    throw new Error(`${absPath} não exporta uma função "handle" — verifique a portagem do arquivo`);
  }
  return async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      const url = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      // Sobrescreve qualquer x-client-ip-verified que o próprio cliente
      // tenha mandado (não confiável) pelo IP real que o Express calculou
      // (req.ip — respeita "trust proxy" quando configurado atrás de um
      // proxy reverso de verdade). É este header, nunca um header
      // client-controlado como X-Forwarded-For puro, que
      // src/helpers/rateLimit.tsx usa para identificar quem está fazendo a
      // requisição quando não há sessão autenticada.
      headers.set("x-client-ip-verified", req.ip ?? req.socket.remoteAddress ?? "desconhecido");
      const init: RequestInit = {
        method: req.method,
        headers,
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body !== undefined && req.body !== null && Object.keys(req.body ?? {}).length > 0
          ? JSON.stringify(req.body)
          : (req as any).rawBody ?? undefined;
      }
      const webRequest = new Request(url.toString(), init);
      const webResponse = await handle(webRequest);

      res.status(webResponse.status);
      webResponse.headers.forEach((value, key) => {
        // content-length/transfer-encoding: deixa o Express recalcular a
        // partir do buffer que ele realmente vai enviar (ver abaixo) —
        // repassar o valor do Response original pode não bater,
        // especialmente para corpos binários.
        if (key === "content-length" || key === "transfer-encoding") return;
        res.setHeader(key, value);
      });
      // arrayBuffer(), não text(): texto (JSON) sobrevive ao round-trip
      // por Buffer normalmente, mas corpo binário (ex.: arquivo baixado em
      // files-download_GET.ts) seria corrompido se decodificado como UTF-8
      // via .text() e reserializado como string.
      const bodyBuffer = Buffer.from(await webResponse.arrayBuffer());
      res.send(bodyBuffer);
    } catch (error) {
      console.error(`Erro no endpoint ${req.method} ${req.originalUrl}:`, error);
      res.status(500).json({ message: "Erro interno do servidor" });
    }
  };
}

async function main() {
  const app = express();

  // Em produção atrás de um proxy reverso/load balancer de verdade
  // (nginx, Cloudflare, etc.), configure TRUST_PROXY=1 (ou o número de
  // saltos de proxy confiáveis) para que req.ip leia o IP real do cliente
  // a partir de X-Forwarded-For em vez do IP do próprio proxy — sem isso,
  // rate limiting por IP (ver src/helpers/rateLimit.tsx) trataria todo
  // tráfego como vindo de um único IP (o do proxy).
  if (process.env.TRUST_PROXY) {
    app.set("trust proxy", isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY));
  }

  // Endpoints portados esperam o corpo bruto (superjson.stringify de volta em JSON
  // já serializado) — capturamos o raw body em vez de deixar o Express fazer parse,
  // porque os handlers fazem seu próprio JSON.parse/superjson.parse do corpo.
  // 16mb: cobre o upload de arquivo em base64 dentro do corpo JSON
  // (src/endpoints/files-upload_POST.ts) — um arquivo de até 8MB vira
  // ~10.9MB em base64; o limite de tamanho do arquivo em si é aplicado no
  // endpoint (FILE_MAX_SIZE_BYTES), este limite aqui é só a margem bruta
  // do corpo da requisição.
  app.use(
    express.raw({ type: "*/*", limit: "16mb" })
  );

  const endpoints = discoverEndpoints(ENDPOINTS_DIR);
  console.log(`Descobertos ${endpoints.length} endpoints em src/endpoints/`);

  for (const ep of endpoints) {
    const handler = await buildExpressHandler(ep.absPath);
    const routePath = `${API_VERSION_PREFIX}/${ep.route}`;
    if (ep.method === "GET") {
      app.get(routePath, wrapRawBody(handler));
    } else {
      app.post(routePath, wrapRawBody(handler));
    }
  }

  // Health check fica fora do versionamento de propósito — infraestrutura
  // de monitoramento (load balancer, orquestrador de containers) não deve
  // precisar acompanhar a versão do contrato da API só para saber se o
  // processo está de pé.
  app.get("/_api/__health", (_req, res) => {
    res.json({ status: "ok", endpoints: endpoints.length, apiVersion: "v1" });
  });

  app.listen(PORT, () => {
    console.log(`Levora Solidária — servidor de API rodando em http://localhost:${PORT}`);
    console.log(`Rotas montadas: ${endpoints.map((e) => `${e.method} ${API_VERSION_PREFIX}/${e.route}`).join(", ")}`);
  });

  const { startScheduler } = await import("../src/helpers/scheduler");
  startScheduler();
}

// express.raw() puts the Buffer on req.body; downstream handlers were written
// to read a plain JSON body via request.json()/request.text() (Web API), so we
// stash the raw buffer separately and let buildExpressHandler forward it as-is.
function wrapRawBody(handler: (req: ExpressRequest, res: ExpressResponse) => Promise<void>) {
  return (req: ExpressRequest, res: ExpressResponse) => {
    if (Buffer.isBuffer(req.body)) {
      (req as any).rawBody = req.body;
      (req as any).body = undefined;
    }
    return handler(req, res);
  };
}

main().catch((error) => {
  console.error("Falha ao iniciar o servidor:", error);
  process.exit(1);
});
