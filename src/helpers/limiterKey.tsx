/**
 * Identificador de IP para os limites em memória da recuperação de senha (F2). IPv4: o endereço exato (agrupar em /24 puniria usuários legítimos atrás do mesmo NAT/CGNAT).
 * IPv6: o prefixo /64 (um atacante com um /64 controla 2^64 endereços; sem agrupar, cada requisição criaria um contador novo e a memória cresceria sem limite).
 * `::ffff:a.b.c.d` (IPv4 mapeado) volta a ser IPv4. Valores desconhecidos/não-IP passam como estão ("desconhecido", usado quando não há IP confiável).
 */
export function limiterKeyForIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
