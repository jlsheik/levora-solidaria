import superjson from "superjson";
import { NotAuthenticatedError } from "./getSetServerSession";
import { OrganizationAccessError } from "./organizationAccess";
import { PlatformAccessError } from "./platformAccess";

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
  return null;
}

/**
 * Monta a Response de erro padrão dos endpoints. `extraStatus` cobre os
 * poucos casos de status específico do endpoint (ex.: 409 para uma
 * atribuição já recebida) — só é consultado quando o erro não é um dos
 * tipos conhecidos acima, preservando a mesma prioridade que o código
 * duplicado tinha antes (acesso/autenticação sempre vence).
 */
export function buildErrorResponse(
  error: unknown,
  fallbackMessage: string,
  extraStatus?: (message: string) => number | undefined
): Response {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = mapTypedErrorToStatus(error) ?? extraStatus?.(message) ?? 400;
  return new Response(superjson.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
