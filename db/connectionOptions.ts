/**
 * Parâmetros de sessão que o operador passa às ferramentas de migração por PGOPTIONS (a mesma convenção do libpq/psql).
 * O driver `postgres.js` NÃO lê PGOPTIONS sozinho; sem esta ponte, `PGOPTIONS="-c levora.platform_owner_user_id=<id>" npm run db:migrate:incremental`
 * (procedimento documentado na migração 0026) seria ignorado e a designação do Platform Owner nunca chegaria ao banco.
 * Só aceita configurações do namespace `levora.` (`-c levora.x=y` ou `--levora.x=y`): qualquer outra coisa (statement_timeout, search_path...) é recusada
 * em vez de ser aplicada em silêncio a uma migração.
 */
/**
 * LISTA FECHADA: cada configuração aceita, com o formato exato do valor. Um namespace aberto (`levora.*`) deixaria uma migração futura ou um gatilho que leia
 * `current_setting('levora.…')` ser influenciado pelo ambiente do operador; hoje só a migração 0026 lê `levora.platform_owner_user_id`.
 */
const ALLOWED_SETTINGS: Record<string, RegExp> = {
  "levora.platform_owner_user_id": /^[1-9][0-9]{0,9}$/,
};

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
    const eq = s.indexOf("=");
    const name = eq < 0 ? s : s.slice(0, eq);
    const value = eq < 0 ? "" : s.slice(eq + 1);
    const rule = ALLOWED_SETTINGS[name];
    if (!rule) throw new Error(`PGOPTIONS: configuração recusada "${name}" (permitidas: ${Object.keys(ALLOWED_SETTINGS).join(", ")})`);
    if (!rule.test(value)) throw new Error(`PGOPTIONS: valor inválido para ${name}`);
    out[name] = value;
  }
  return out;
}

/** Opções extras para `postgres(url, {...})`: `connection` com os parâmetros de sessão pedidos (vazio se PGOPTIONS não existe). */
export function pgConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): { connection?: Record<string, string> } {
  const params = parseLevoraPgOptions(env.PGOPTIONS);
  return Object.keys(params).length ? { connection: params } : {};
}
