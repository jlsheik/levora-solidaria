// Análise de cabeçalhos de segurança (módulo puro, testado). Nada aqui toca rede ou navegador: recebe valores já coletados.

/** "a 'self'; b x y" → Map(a → ["'self'"], b → ["x","y"]). Diretivas repetidas: vale a primeira (regra do CSP). */
export function parseCsp(value) {
  const map = new Map();
  for (const part of String(value ?? "").split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (!map.has(name)) map.set(name, tokens.slice(1));
  }
  return map;
}

/** Fontes efetivas de uma diretiva de busca (cai em `default-src` quando ausente). */
export const effectiveSources = (csp, directive) => csp.get(directive) ?? csp.get("default-src") ?? null;

/**
 * Problemas de uma CSP DE DOCUMENTO que impõe bloqueio. Critérios (todos justificados em docs/SECURITY.md):
 *  - script-src sem 'unsafe-inline', 'unsafe-eval', curinga, data:, blob: ou http: genérico (o app não precisa de nada disso);
 *  - object-src 'none', base-uri e form-action restritos, frame-ancestors 'none' (só vale como cabeçalho HTTP);
 *  - nenhuma diretiva com curinga `*` ou esquema solto (https:, http:, data: em script/default/connect);
 *  - `style-src 'unsafe-inline'` é uma exceção DOCUMENTADA (Radix UI posiciona por style inline) → reportada como nota, não como problema.
 */
export function analyzeDocumentCsp(value) {
  const problems = []; const notes = [];
  if (!value) return { problems: ["sem Content-Security-Policy"], notes, csp: new Map() };
  const csp = parseCsp(value);
  const script = effectiveSources(csp, "script-src") ?? [];
  const has = (list, t) => list.some((x) => x.toLowerCase() === t);
  if (!csp.has("script-src") && !csp.has("default-src")) problems.push("nem script-src nem default-src: scripts livres");
  if (has(script, "'unsafe-inline'")) problems.push("script-src permite 'unsafe-inline'");
  if (has(script, "'unsafe-eval'")) problems.push("script-src permite 'unsafe-eval'");
  for (const [dir, src] of csp) {
    if (src.some((s) => s === "*" || /^\*\./.test(s))) problems.push(`${dir} com curinga`);
    if (["script-src", "default-src", "connect-src", "script-src-elem"].includes(dir) && src.some((s) => /^(https?|data|blob|ws|wss):$/i.test(s))) problems.push(`${dir} com esquema solto (${src.find((s) => /:$/.test(s))})`);
  }
  const oneOf = (dir, expected) => { const v = csp.get(dir); if (!v) problems.push(`sem ${dir}`); else if (v.join(" ") !== expected) problems.push(`${dir} esperado '${expected}', veio '${v.join(" ")}'`); };
  oneOf("object-src", "'none'"); oneOf("frame-ancestors", "'none'"); oneOf("base-uri", "'self'"); oneOf("form-action", "'self'");
  if (has(csp.get("style-src") ?? [], "'unsafe-inline'")) notes.push("style-src com 'unsafe-inline' (exceção documentada: estilos inline calculados pelo Radix UI)");
  return { problems, notes, csp };
}

/** CSP de uma API JSON: nada pode ser carregado. */
export function analyzeApiCsp(value) {
  const csp = parseCsp(value); const problems = [];
  if ((csp.get("default-src") ?? []).join(" ") !== "'none'") problems.push(`default-src deveria ser 'none' (veio '${(csp.get("default-src") ?? ["ausente"]).join(" ")}')`);
  if ((csp.get("frame-ancestors") ?? []).join(" ") !== "'none'") problems.push("sem frame-ancestors 'none'");
  return { problems, csp };
}

/** Quantas vezes um cabeçalho aparece nos cabeçalhos CRUS ([nome, valor, nome, valor...] do Node). */
export function headerCount(rawHeaders, name) {
  let n = 0; for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name.toLowerCase()) n++;
  return n;
}

/** Cabeçalhos exigidos por tipo de resposta. Retorna a lista de problemas (vazia = conforme). */
export function checkHeaders(kind, { status, headers, rawHeaders }) {
  const problems = []; const get = (n) => headers[n.toLowerCase()];
  const must = (n, expected) => { const v = get(n); if (v === undefined) problems.push(`falta ${n}`); else if (expected && (expected instanceof RegExp ? !expected.test(v) : v !== expected)) problems.push(`${n}: '${String(v).slice(0, 60)}' fora do esperado`); };
  const forbid = (n, why) => { if (get(n) !== undefined) problems.push(`${n} presente (${why})`); };
  const single = (names) => { for (const n of names) if (headerCount(rawHeaders, n) > 1) problems.push(`${n} DUPLICADO (${headerCount(rawHeaders, n)}x)`); };
  const hsts = /^max-age=\d{7,}(; includeSubDomains)?(; preload)?$/;
  if (get("content-security-policy-report-only") !== undefined && !get("content-security-policy")) problems.push("só Report-Only: não bloqueia nada");
  single(["content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "cache-control"]);
  if (kind === "document") {
    const a = analyzeDocumentCsp(get("content-security-policy")); problems.push(...a.problems.map((p) => `CSP: ${p}`));
    must("x-frame-options", "DENY"); must("x-content-type-options", "nosniff"); must("referrer-policy", "strict-origin-when-cross-origin"); must("permissions-policy"); must("strict-transport-security", hsts);
    must("cache-control", "no-cache");
  } else if (kind === "asset") {
    must("x-content-type-options", "nosniff"); must("strict-transport-security", hsts);
    if (status === 200) must("cache-control", /immutable/); else forbid("cache-control", "erro não pode ser cacheado como imutável");
  } else if (kind === "api") {
    const a = analyzeApiCsp(get("content-security-policy")); problems.push(...a.problems.map((p) => `CSP da API: ${p}`));
    must("x-content-type-options", "nosniff"); must("x-frame-options", "DENY"); must("strict-transport-security", hsts);
  } else throw new Error(`tipo de resposta desconhecido: ${kind}`);
  return problems;
}
