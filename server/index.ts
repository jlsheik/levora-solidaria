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
import express, { type Request as ExpressRequest, type Response as ExpressResponse, type NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API_SECURITY_HEADERS } from "../src/helpers/securityHeaders.js";
import { closeDbPool } from "../src/helpers/db.js";
import { checkWriteRequest } from "../src/helpers/csrfGuard.js";
import { installSafeConsoleError, logEvent, newOperationId, safeErrorCode } from "../src/helpers/opLog.js";
import { checkReadiness } from "../src/helpers/readiness.js";
import { flushPasswordResetWork } from "../src/helpers/passwordReset.js";
import { checkProxyTrust } from "../src/helpers/proxyTrust.js";

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
    // Em dev (tsx) os arquivos são .ts; em produção (dist-server, após
    // tsc) são .js — o descobridor precisa casar os dois para não ficar
    // com zero endpoints registrados quando roda a partir do build compilado.
    const match = entry.name.match(/^(.*)_(GET|POST)\.(ts|js)$/);
    if (!match) continue; // skip *.schema.ts/.js e qualquer outro arquivo
    const [, name, method] = match;
    const relDir = path.relative(baseDir, dir);
    const route = (relDir ? `${relDir}/${name}` : name).replace(/\\/g, "/");
    found.push({ route, method: method as HttpMethod, absPath: full });
  }
  return found;
}

async function buildExpressHandler(absPath: string, route: string) {
  const mod = await import(pathToFileURL(absPath).href);
  const handle = mod.handle as (request: Request) => Promise<Response>;
  if (typeof handle !== "function") {
    throw new Error(`${absPath} não exporta uma função "handle" — verifique a portagem do arquivo`);
  }
  return async (req: ExpressRequest, res: ExpressResponse) => {
    // M46: um ID por requisição (também devolvido ao cliente) e uma linha de log estruturada por chamada: rota registrada (nunca a URL com query/ids), método, status HTTP e duração.
    // Nunca registra corpo, cabeçalhos, cookies, usuário ou organização.
    const operationId = newOperationId();
    const startedAt = Date.now();
    res.setHeader("x-request-id", operationId);
    let errorCode: string | null = null;
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
        // Set-Cookie é a ÚNICA header que pode se repetir: cada setHeader() SOBRESCREVE o anterior, então respostas com mais de
        // um cookie (Fase 90: cookie de sessão + limpeza do cookie de challenge) perdiam todos menos o último — a sessão nunca
        // chegava ao navegador. Repassa o array completo (getSetCookie) em vez de uma header por vez.
        if (key === "set-cookie") return;
        res.setHeader(key, value);
      });
      const setCookies = webResponse.headers.getSetCookie();
      if (setCookies.length > 0) res.setHeader("Set-Cookie", setCookies);
      // arrayBuffer(), não text(): texto (JSON) sobrevive ao round-trip
      // por Buffer normalmente, mas corpo binário (ex.: arquivo baixado em
      // files-download_GET.ts) seria corrompido se decodificado como UTF-8
      // via .text() e reserializado como string.
      const bodyBuffer = Buffer.from(await webResponse.arrayBuffer());
      res.send(bodyBuffer);
    } catch (error) {
      errorCode = safeErrorCode(error);
      res.status(500).json({ message: "Erro interno do servidor" });
    } finally {
      const httpStatus = res.statusCode;
      logEvent({
        event: "http_request",
        status: httpStatus >= 500 ? "falha" : "ok",
        operationId,
        durationMs: Date.now() - startedAt,
        errorCode: httpStatus >= 500 ? (errorCode ?? "HTTP_5XX") : null,
        context: { route, method: req.method, httpStatus },
      });
    }
  };
}

// Fase 50 (SEC-05): aplicado em TODA resposta desta API, incluindo 404 de
// rota não encontrada e o catch de erro 500 dentro de buildExpressHandler
// — é o primeiro middleware do pipeline (app.use sem path = roda para
// qualquer requisição, antes de qualquer rota casar), e os endpoints
// portados nunca definem esses 5 nomes de header nos próprios Response,
// então não há conflito de sobrescrita. Ver src/helpers/securityHeaders.ts
// para os valores e a justificativa de cada um.
function securityHeadersMiddleware(_req: ExpressRequest, res: ExpressResponse, next: NextFunction) {
  for (const [key, value] of Object.entries(API_SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  next();
}

// Defesa contra CSRF nas rotas de escrita (ver src/helpers/csrfGuard.ts): roda antes de ler o corpo.
function csrfGuardMiddleware(req: ExpressRequest, res: ExpressResponse, next: NextFunction) {
  const verdict = checkWriteRequest(req.method, { get: (name) => req.get(name) });
  if (!verdict.ok) {
    res.status(verdict.status).json({ message: verdict.message });
    return;
  }
  next();
}

// Extraído de main() para ser testável sem abrir uma porta de verdade nem
// iniciar o agendador (test/securityHeaders.test.ts sobe isto numa porta
// efêmera com app.listen(0)).
export async function buildApp(): Promise<express.Express> {
  const app = express();

  app.use(securityHeadersMiddleware);

  // Em produção atrás de um proxy reverso/load balancer de verdade
  // (nginx, Cloudflare, etc.), configure TRUST_PROXY=1 (ou o número de
  // saltos de proxy confiáveis) para que req.ip leia o IP real do cliente
  // a partir de X-Forwarded-For em vez do IP do próprio proxy — sem isso,
  // rate limiting por IP (ver src/helpers/rateLimit.tsx) trataria todo
  // tráfego como vindo de um único IP (o do proxy).
  if (process.env.TRUST_PROXY) {
    app.set("trust proxy", isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY));
  }

  app.use(csrfGuardMiddleware);

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
    const handler = await buildExpressHandler(ep.absPath, ep.route);
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

  // M46 — prontidão: 200 só se o banco responde E o schema tem todas as migrations do código; 503 caso contrário. Saída grosseira (sem detalhes internos).
  app.get("/_api/__ready", async (_req, res) => {
    const result = await checkReadiness();
    res.status(result.ready ? 200 : 503).json({ status: result.ready ? "ready" : "not_ready", checks: result.checks });
  });

  // Fase 50: sem isto, uma rota não encontrada cairia no handler padrão do
  // Express (finalhandler), que define o PRÓPRIO Content-Security-Policy
  // ("default-src 'none'", sem frame-ancestors) na página HTML de erro —
  // sobrescrevendo o header mais completo que securityHeadersMiddleware já
  // tinha definido (confirmado reproduzindo um 404 real e comparando os
  // headers). Esta API é só JSON; um 404 em HTML nunca fez sentido aqui.
  app.use((_req, res) => {
    res.status(404).json({ message: "Rota não encontrada" });
  });

  // Erros do próprio Express (corpo acima de 16mb → 413, JSON malformado etc.) caíam no handler padrão, que responde uma PÁGINA HTML
  // (com stack trace fora de produção) e troca o Content-Security-Policy da API. Aqui viram JSON curto; os cabeçalhos de segurança já foram
  // definidos pelo primeiro middleware.
  app.use((err: unknown, _req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    const safe = status >= 400 && status < 500 ? status : 500;
    res.status(safe).json({ message: safe === 413 ? "Corpo da requisição maior que o limite permitido" : safe === 500 ? "Erro interno do servidor" : "Requisição inválida" });
  });

  return app;
}

// Fase 56 (arquitetura-alvo de produção): a topologia escolhida roda o
// processo atrás de um gerenciador (systemd/orquestrador de containers)
// que envia SIGTERM em todo deploy/restart — sem tratamento, uma
// requisição em andamento no exato momento do sinal era cortada sem
// resposta (achado da Fase 55, agora corrigido porque a arquitetura
// escolhida torna isso uma necessidade real, não hipotética).
// `server.close()` para de aceitar conexões NOVAS mas deixa as já abertas
// terminarem; `GRACEFUL_SHUTDOWN_TIMEOUT_MS` é o limite antes de forçar o
// encerramento (nunca travar o processo indefinidamente esperando um
// cliente lento). SIGINT coberto pelo mesmo motivo (Ctrl+C em dev/systemd
// também o usa).
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  installSafeConsoleError();
  const app = await buildApp();

  const server = app.listen(PORT, () => {
    console.log(`Levora Solidária — servidor de API rodando em http://localhost:${PORT}`);
  });

  const { startScheduler } = await import("../src/helpers/scheduler.js");
  startScheduler();
  logEvent({ event: "server_start", status: "ok", context: { port: PORT } });
  const proxyTrust = checkProxyTrust();
  if (proxyTrust !== "ok") logEvent({ event: "proxy_trust", status: "ignorado", context: { reason: proxyTrust } });
  // Apenas diagnóstico no log (não impede o processo de subir): um schema incompatível aparece aqui e em /_api/__ready.
  void checkReadiness().then((r) => logEvent({ event: "startup_readiness", status: r.ready ? "ok" : "falha", context: { ...r.checks } }));

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return; // um segundo SIGTERM durante o shutdown não reinicia o processo
    shuttingDown = true;
    console.log(`${signal} recebido — encerrando graciosamente (até ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms para requisições em andamento)...`);

    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown excedeu o tempo limite — encerrando à força.");
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    // F2: o envio da recuperação de senha roda DEPOIS da resposta HTTP; termina o que está em andamento (precisa do banco) antes de fechar o pool.
    // Limitado pelo temporizador de encerramento acima; se o processo cair antes, o token fica ativo sem e-mail e a pessoa pode pedir de novo após o cooldown.
    await flushPasswordResetWork();
    await closeDbPool();
    clearTimeout(forceExit);
    console.log("Encerrado graciosamente.");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
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

// Guarda de entrypoint ESM (equivalente a `if __name__ == "__main__"`):
// sem isso, test/securityHeaders.test.ts importar `buildApp` deste módulo
// também disparia main() — abrindo uma porta real e iniciando o
// agendador (src/helpers/scheduler.tsx) dentro da suíte de testes, o que
// nunca deveria acontecer.
const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    logEvent({ event: "server_start", status: "falha", errorCode: safeErrorCode(error) });
    process.exit(1);
  });
}
