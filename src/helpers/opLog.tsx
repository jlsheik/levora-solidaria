/**
 * Log estruturado mínimo (M46): uma linha JSON por evento, em stdout/stderr, para um coletor futuro. Não é uma plataforma de monitoramento.
 *
 * Regras de minimização: só campos de uma lista permitida são gravados; valores de chaves com cara de segredo são removidos; strings são truncadas;
 * erros viram um CÓDIGO seguro (nome da classe / código SQLSTATE), nunca a mensagem (que pode carregar valores de coluna ou trechos de consulta).
 * Nunca recebe corpo de requisição, cabeçalhos, cookies, tokens, senhas, nomes de organização ou dados pessoais.
 */
import { randomUUID } from "node:crypto";

export type LogStatus = "ok" | "falha" | "ignorado" | "inicio";

export interface LogEvent {
  event: string;
  status: LogStatus;
  operationId?: string;
  correlationId?: string | null;
  durationMs?: number;
  errorCode?: string | null;
  /** Contexto mínimo: apenas chaves não sensíveis (ex.: rota, método, status HTTP, nome de tarefa, contagens). */
  context?: Record<string, string | number | boolean | null>;
}

const SENSITIVE_KEY = /pass|senha|secret|token|cookie|authorization|auth|key|chave|cpf|cnpj|email|e-mail|phone|telefone|document|hash|signature/i;
const MAX_STRING = 120;

export function newOperationId(): string {
  return randomUUID();
}

/** Código seguro de erro: nunca usa error.message. */
export function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; name?: unknown };
    if (typeof e.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(e.code)) return e.code;
    if (typeof e.name === "string" && /^[A-Za-z0-9_]{1,48}$/.test(e.name)) return e.name;
  }
  return "ERRO_DESCONHECIDO";
}

export function sanitizeContext(context: LogEvent["context"]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === "string") out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

export function buildLogLine(event: LogEvent, now: Date = new Date()): string {
  const line: Record<string, unknown> = {
    ts: now.toISOString(),
    level: event.status === "falha" ? "error" : "info",
    event: event.event,
    status: event.status,
    operationId: event.operationId ?? null,
    correlationId: event.correlationId ?? null,
  };
  if (event.durationMs !== undefined) line.durationMs = Math.round(event.durationMs);
  if (event.errorCode) line.errorCode = event.errorCode;
  const context = sanitizeContext(event.context);
  if (Object.keys(context).length > 0) line.context = context;
  return JSON.stringify(line);
}

export function logEvent(event: LogEvent): void {
  try {
    const text = buildLogLine(event);
    if (event.status === "falha") console.error(text);
    else console.log(text);
  } catch {
    // O log nunca pode alterar o resultado da operação.
  }
}

/** Executa `fn` registrando início/fim/duração/falha, e repassa o resultado ou o erro original (a instrumentação não altera o resultado de negócio). */
export async function withOperationLog<T>(
  event: string,
  context: LogEvent["context"],
  fn: () => Promise<T>
): Promise<T> {
  const operationId = newOperationId();
  const started = Date.now();
  try {
    const result = await fn();
    logEvent({ event, status: "ok", operationId, durationMs: Date.now() - started, context });
    return result;
  } catch (error) {
    logEvent({ event, status: "falha", operationId, durationMs: Date.now() - started, errorCode: safeErrorCode(error), context });
    throw error;
  }
}

/** Troca objetos de erro por um resumo seguro (nome/código), preservando strings e números do desenvolvedor. */
export function redactErrorArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (a instanceof Error || (a && typeof a === "object" && ("code" in (a as object) || "stack" in (a as object)))) return `[erro ${safeErrorCode(a)}]`;
    return a;
  });
}

let installed = false;
/**
 * M46: o código legado tem ~130 pontos `console.error("msg", error)`; mensagens de erro do PostgreSQL podem trazer valores de colunas (e-mail, documento) e detalhes de consulta.
 * Instalado SÓ no processo do servidor (server/index.ts main): objetos de erro passam a ser impressos como `[erro CÓDIGO]`. Idempotente.
 */
export function installSafeConsoleError(): void {
  if (installed) return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => original(...redactErrorArgs(args));
}
