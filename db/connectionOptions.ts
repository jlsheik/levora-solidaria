/**
 * Parâmetros de sessão que o operador passa às ferramentas de migração por PGOPTIONS (a mesma convenção do libpq/psql).
 * O driver `postgres.js` NÃO lê PGOPTIONS sozinho; sem esta ponte, `PGOPTIONS="-c levora.platform_owner_user_id=<id>" npm run db:migrate:incremental`
 * (procedimento documentado na migração 0026) seria ignorado e a designação do Platform Owner nunca chegaria ao banco.
 * Só aceita configurações do namespace `levora.` (`-c levora.x=y` ou `--levora.x=y`): qualquer outra coisa (statement_timeout, search_path...) é recusada
 * em vez de ser aplicada em silêncio a uma migração.
 */
export function parseLevoraPgOptions(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || !raw.trim()) return out;
  const tokens = raw.trim().split(/\s+/);
  const settings: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-c") { settings.push(tokens[++i] ?? ""); continue; }
    if (t.startsWith("-c") && t.length > 2) { settings.push(t.slice(2)); continue; }
    if (t.startsWith("--")) { settings.push(t.slice(2)); continue; }
    throw new Error(`PGOPTIONS: opção não suportada "${t}" (só -c levora.<nome>=<valor>)`);
  }
  for (const s of settings) {
    const m = /^(levora\.[a-z_][a-z0-9_]*)=([A-Za-z0-9_.:-]*)$/.exec(s);
    if (!m) throw new Error(`PGOPTIONS: configuração recusada "${s}" (só levora.<nome>=<valor> com caracteres simples)`);
    out[m[1]] = m[2];
  }
  return out;
}

/** Opções extras para `postgres(url, {...})`: `connection` com os parâmetros de sessão pedidos (vazio se PGOPTIONS não existe). */
export function pgConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): { connection?: Record<string, string> } {
  const params = parseLevoraPgOptions(env.PGOPTIONS);
  return Object.keys(params).length ? { connection: params } : {};
}
