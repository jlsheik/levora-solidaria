import superjson from "superjson";
import { ZodError } from "zod";
import { NotAuthenticatedError } from "./getSetServerSession.js";
import { OrganizationAccessError } from "./organizationAccess.js";
import { PlatformAccessError } from "./platformAccess.js";

/**
 * Lançado deliberadamente por um endpoint para sinalizar um conflito de
 * estado/unicidade real (ex.: ação já executada, alocação já recebida) —
 * nunca para erros inesperados. Mensagem sempre segura para o público
 * (quem lança decide o texto, igual às outras classes tipadas abaixo).
 * Fase 65 — achado real de auditoria: antes desta classe existir, o único
 * lugar do projeto que precisava de 409
 * (`opportunities-status_POST.ts`, "oportunidade já recebida") lançava um
 * `Error` genérico, caindo no default (então 400) do `buildErrorResponse`
 * — nunca 409, apesar do comentário no topo deste arquivo já prever esse
 * caso desde a primeira versão.
 */
export class ConflictError extends Error {
  /** Código estável opcional de domínio (ex.: `plataforma_acesso_ativo`), devolvido ao cliente junto da mensagem. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
  }
}

/**
 * Lançado quando uma ação crítica exige reautenticação recente (step-up, Fase 90). Mensagem segura para o público;
 * o cliente reage ao `code: "reauth_required"` pedindo o código do segundo fator.
 */
export class ReauthRequiredError extends Error {
  readonly code = "reauth_required";
  constructor(message = "Confirme sua identidade com o código do autenticador para continuar.") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/**
 * Fase 92.1: a ação crítica de uma conta SEM senha exige reautenticação recente da identidade (hoje, Google). O cliente reage ao
 * `code: "reauth_social_required"` oferecendo "Confirmar com o Google". Nunca substitui o step-up do MFA (`reauth_required`).
 */
export class SocialReauthRequiredError extends Error {
  readonly code = "reauth_social_required";
  constructor(message = "Confirme sua identidade novamente com o provedor de login para continuar.") {
    super(message);
    this.name = "SocialReauthRequiredError";
  }
}

/**
 * Único ponto de verdade para transformar um erro lançado num endpoint em
 * status HTTP. Antes, ~40 endpoints repetiam a mesma lógica frágil de
 * `message.includes("acesso") || message.includes("papel") ? 403 : ...`,
 * cada um com sua própria cópia — comparando o TEXTO da mensagem de erro,
 * não o TIPO do erro. Isso é frágil de verdade: uma mensagem legítima de
 * erro de negócio que por coincidência contivesse a palavra "papel" (ex.
 * validação de um campo chamado "papel de parede") viraria 403 por
 * engano. `instanceof` não tem esse risco.
 */
function mapTypedErrorToStatus(error: unknown): number | null {
  if (error instanceof NotAuthenticatedError) return 401;
  if (error instanceof OrganizationAccessError) return 403;
  if (error instanceof PlatformAccessError) return 403;
  if (error instanceof ConflictError) return 409;
  if (error instanceof ReauthRequiredError) return 403;
  if (error instanceof SocialReauthRequiredError) return 403;
  if (error instanceof ZodError) return 400;
  // `superjson.parse(await request.text())` lança SyntaxError nativo
  // quando o corpo nem chega a ser JSON válido (ex.: corpo vazio, HTML de
  // um <form> cross-site, texto qualquer) — achado real de regressão
  // desta fase: ao mudar o default de "desconhecido" de 400 para 500
  // (ver getPublicMessage), a suíte de testes pegou isto de verdade
  // (test/securityHardening.test.ts, caso de CSRF com corpo não-superjson)
  // — corpo malformado é claramente erro do CLIENTE, nunca do servidor,
  // tem que continuar 400. Mesma classificação já aplicada isoladamente
  // em login_with_password_POST.ts na Fase 64; agora centralizada aqui
  // para todo endpoint que usa buildErrorResponse.
  if (error instanceof SyntaxError) return 400;
  return null;
}

/**
 * Fase 65 — achado real de auditoria, reproduzido de verdade contra o
 * Postgres: `error.message` de um erro NÃO tipado pode conter detalhes
 * internos de verdade — confirmado com um erro de conexão real
 * (`getaddrinfo ENOTFOUND <host>`, expõe o hostname do banco) e um erro
 * de query real (`relation "x" does not exist`, expõe nome de
 * tabela/schema). Os 49 endpoints que usam `buildErrorResponse` sempre
 * passaram `error.message` direto pro cliente para QUALQUER `Error`, não
 * só os tipos conhecidos abaixo — essa função é o único lugar que
 * precisa mudar para fechar isso em todos eles de uma vez. Para os tipos
 * conhecidos (autenticação/autorização/conflito/validação), a mensagem
 * sempre foi escrita a dedo por quem lançou o erro (nunca derivada de
 * uma biblioteca externa) — continua segura, sem alteração de
 * comportamento. Para qualquer outro erro, a mensagem pública nunca mais
 * é a do erro em si — sempre `fallbackMessage`, o texto específico e
 * seguro que cada endpoint já define.
 */
function getPublicMessage(error: unknown, fallbackMessage: string): string {
  if (
    error instanceof NotAuthenticatedError ||
    error instanceof OrganizationAccessError ||
    error instanceof PlatformAccessError ||
    error instanceof ConflictError ||
    error instanceof ReauthRequiredError ||
    error instanceof SocialReauthRequiredError ||
    error instanceof ZodError
  ) {
    return error.message;
  }
  // Mensagem fixa e genérica, não `fallbackMessage` (que descreve a AÇÃO
  // de negócio, ex. "Não foi possível criar a organização" — enganoso
  // aqui, já que a ação nem chegou a começar) nem `error.message` bruto
  // do SyntaxError nativo (textos tipo "Unexpected token..." não ajudam
  // quem chama a API e variam por engine).
  if (error instanceof SyntaxError) return "Corpo da requisição inválido";
  return fallbackMessage;
}

/**
 * Monta a Response de erro padrão dos endpoints. `extraStatus` cobre
 * casos específicos de um endpoint que precisem de um status diferente
 * do default — só é consultado quando o erro não é um dos tipos
 * conhecidos acima (nenhum consumidor usa isto hoje; preservado por
 * compatibilidade). Default agora é 500 (Fase 65) — um erro
 * verdadeiramente desconhecido é, por definição, inesperado do lado do
 * servidor, nunca um erro de entrada do cliente; ver achado de auditoria
 * acima sobre por que isto não afeta nenhum uso legítimo do 400 anterior
 * (nenhum dos 49 endpoints tinha nenhum outro caminho de erro além dos
 * tipos já cobertos por `mapTypedErrorToStatus` e validação Zod).
 */
export function buildErrorResponse(
  error: unknown,
  fallbackMessage: string,
  extraStatus?: (message: string) => number | undefined
): Response {
  const message = getPublicMessage(error, fallbackMessage);
  const status = mapTypedErrorToStatus(error) ?? extraStatus?.(message) ?? 500;
  const code = error instanceof ConflictError || error instanceof ReauthRequiredError || error instanceof SocialReauthRequiredError ? error.code : undefined;
  return new Response(superjson.stringify(code ? { message, code } : { message }), {
    status,
    // Erros nunca são cacheáveis (podem ecoar contexto de rotas que carregam segredos, ex.: códigos de acesso).
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
