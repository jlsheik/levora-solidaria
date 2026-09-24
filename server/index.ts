/**
 * Servidor real da Levora Solidária, fora do Floot.
 *
 * Os endpoints em src/endpoints/**​/*_GET.ts e *_POST.ts foram portados
 * verbatim do Floot: cada um exporta `handle(request: Request): Promise<Response>`
 * usando a Web Fetch API padrão (não um handler específico do Express).
 * Este servidor descobre esses arquivos automaticamente e os expõe em
 * /_api/<rota>, convertendo entre Request/Response (Web API) e Express —
 * exatamente a mesma convenção de URL que o Floot usava
 * (ver src/endpoints/needs_GET.schema.ts: fetch(`/_api/needs?...`)),
 * então nenhum arquivo de cliente (páginas/schemas) precisou ser alterado.
 */
import "dotenv/config";
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINTS_DIR = path.resolve(__dirname, "../src/endpoints");
const PORT = Number(process.env.PORT ?? 3001);

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
        // Express/Node sets its own; letting the endpoint's Set-Cookie through is what matters.
        res.setHeader(key, value);
      });
      const text = await webResponse.text();
      res.send(text);
    } catch (error) {
      console.error(`Erro no endpoint ${req.method} ${req.originalUrl}:`, error);
      res.status(500).json({ message: "Erro interno do servidor" });
    }
  };
}

async function main() {
  const app = express();

  // Endpoints portados esperam o corpo bruto (superjson.stringify de volta em JSON
  // já serializado) — capturamos o raw body em vez de deixar o Express fazer parse,
  // porque os handlers fazem seu próprio JSON.parse/superjson.parse do corpo.
  app.use(
    express.raw({ type: "*/*", limit: "10mb" })
  );

  const endpoints = discoverEndpoints(ENDPOINTS_DIR);
  console.log(`Descobertos ${endpoints.length} endpoints em src/endpoints/`);

  for (const ep of endpoints) {
    const handler = await buildExpressHandler(ep.absPath);
    const routePath = `/_api/${ep.route}`;
    if (ep.method === "GET") {
      app.get(routePath, wrapRawBody(handler));
    } else {
      app.post(routePath, wrapRawBody(handler));
    }
  }

  app.get("/_api/__health", (_req, res) => {
    res.json({ status: "ok", endpoints: endpoints.length });
  });

  app.listen(PORT, () => {
    console.log(`Levora Solidária — servidor de API rodando em http://localhost:${PORT}`);
    console.log(`Rotas montadas: ${endpoints.map((e) => `${e.method} /_api/${e.route}`).join(", ")}`);
  });
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
