import superjson from "superjson";

/**
 * Rate limiting real (master prompt, seção 108: login, ativação, reset,
 * API pública, webhook, mensagens). Contador de janela fixa em memória —
 * funciona sem nenhuma infraestrutura externa, mas só é correto para um
 * único processo (o servidor real deste projeto é um único processo
 * Express). Se este app rodar em múltiplas instâncias atrás de um load
 * balancer, cada instância teria seu próprio contador independente — para
 * limite compartilhado entre instâncias, trocar o Map abaixo por um
 * backend compartilhado (Redis é a escolha padrão da indústria) sem mudar
 * a assinatura de `checkRateLimit`.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Evita crescimento sem limite do Map com identificadores que nunca mais
// aparecem (ex.: IPs que só fizeram uma requisição) — limpeza oportunista
// de baixa probabilidade, mesmo padrão já usado para sessões expiradas
// (getServerUserSession.tsx) e convites expirados (organization-invites_GET.ts).
const CLEANUP_PROBABILITY = 0.02;

function cleanupExpiredBuckets(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * `bucket` separa namespaces de limite (ex.: "login", "files-upload") —
 * o mesmo `identifier` pode estar dentro do limite em um bucket e fora em
 * outro. `identifier` é tipicamente um IP (ações anônimas) ou um user id
 * (ações autenticadas, ver getRequestIp/getServerUserSession).
 */
export function checkRateLimit(params: { bucket: string; identifier: string; limit: number; windowMs: number }): RateLimitResult {
  const now = Date.now();
  if (Math.random() < CLEANUP_PROBABILITY) cleanupExpiredBuckets(now);

  const key = `${params.bucket}:${params.identifier}`;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + params.windowMs });
    return { allowed: true, remaining: params.limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= params.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }

  existing.count += 1;
  return { allowed: true, remaining: params.limit - existing.count, retryAfterSeconds: 0 };
}

/**
 * IP do cliente, lido do header que o próprio servidor injeta a partir de
 * req.ip do Express (ver server/index.ts) — nunca de um header
 * client-controlado direto, que poderia ser forjado para burlar o limite.
 */
export function getClientIp(request: Request): string {
  return request.headers.get("x-client-ip-verified") ?? "desconhecido";
}

export function rateLimitResponse(retryAfterSeconds: number, message = "Muitas tentativas em pouco tempo. Aguarde antes de tentar de novo."): Response {
  return new Response(superjson.stringify({ message }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/** Só para os testes: limpa todos os contadores entre cenários. */
export function resetAllRateLimitsForTests(): void {
  buckets.clear();
}
