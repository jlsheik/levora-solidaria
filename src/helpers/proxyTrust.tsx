/**
 * Confiança no proxy (F2). Os limites por IP (login, recuperação de senha etc.) usam `req.ip` do Express. Atrás de um proxy reverso sem `TRUST_PROXY`,
 * `req.ip` é o IP do PROXY: todos os usuários passariam a dividir o mesmo contador (um único abusador esgotaria o limite de todos) e o IP real nunca
 * seria visto. Em produção a ausência de `TRUST_PROXY` é, portanto, sinalizada no log de inicialização (código seguro; nada impede o processo de subir).
 * Um `TRUST_PROXY` MAIOR que o número real de proxies é o erro oposto (o cliente forjaria `X-Forwarded-For`): o valor correto é a topologia real.
 */
export type ProxyTrustState = "ok" | "ausente_em_producao";

export function checkProxyTrust(env: NodeJS.ProcessEnv = process.env): ProxyTrustState {
  return env.NODE_ENV === "production" && !(env.TRUST_PROXY ?? "").trim() ? "ausente_em_producao" : "ok";
}
