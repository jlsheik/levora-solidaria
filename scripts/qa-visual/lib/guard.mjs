// Guarda de segurança do banco da verificação visual: a rotina SÓ roda contra um banco local e descartável cujo nome termina em `_qa`
// (ela dropa e recria o schema "public"). Mesmo padrão de `test/global-setup.ts` (que exige `_test`). Módulo puro, testado em `test/qaVisual.test.ts`.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Lança se a URL não for de um banco local descartável. Retorna { host, port, database } (sem usuário/senha) para log seguro. */
export function assertDisposableDatabase(connectionString) {
  if (!connectionString || typeof connectionString !== "string") throw new Error("URL do banco da verificação visual ausente (defina QA_DATABASE_URL ou .env.test)");
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("URL do banco da verificação visual inválida");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error(`protocolo inesperado para o banco: ${url.protocol}`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`o banco da verificação visual precisa ser LOCAL (host recebido: ${url.hostname})`);
  if (!/^[a-z0-9_]+_qa$/.test(database)) throw new Error(`o banco da verificação visual ("${database}") precisa ter nome terminando em "_qa" (a rotina recria o schema); nunca use o banco de desenvolvimento`);
  return { host: url.hostname, port: url.port || "5432", database };
}

/** Deriva a URL do banco de QA a partir da URL do banco de teste (`..._test` → `..._qa`), sem expor credenciais. */
export function deriveQaUrlFromTestUrl(testUrl) {
  const url = new URL(testUrl);
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error('não foi possível derivar o banco de QA: o banco de teste não termina em "_test"');
  url.pathname = "/" + name.replace(/_test$/, "_qa");
  return url.toString();
}

/** Lê DATABASE_URL de um conteúdo de .env (sem dotenv e sem imprimir nada). */
export function readEnvValue(content, key) {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    return line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

/** M19 (A8): marca de propriedade gravada no COMENTÁRIO do banco quando o QA o cria. Um nome `*_qa` sozinho não prova que o banco é descartável. */
export const QA_DB_OWNER_MARK = "levora-qa-owned";

/**
 * Decide, de forma pura, o que fazer com o banco alvo antes de recriar o schema:
 *  - "create": não existe (o QA cria e marca);  - "reuse": existe e tem a marca do QA;
 *  - "adopt": existe, SEM marca, mas está vazio (nenhuma tabela em public) — pode ser marcado e usado;
 *  - "refuse": existe, sem marca e com tabelas (pode ser um banco de outro uso): nunca apagar.
 */
export function decideDatabaseOwnership({ exists, comment, publicTableCount, otherSessions = 0, runId = null }) {
  if (!exists) return "create";
  // M23: banco com sessões de OUTRA execução viva nunca é recriado/reutilizado, mesmo marcado ("é do QA" ≠ "é desta execução"): falha segura.
  if (Number(otherSessions) > 0) return "busy";
  if (typeof comment === "string" && comment.startsWith(QA_DB_OWNER_MARK)) {
    // M24: marca com runId de OUTRA execução (viva ou morta) nunca é reutilizada em silêncio; marca antiga (sem runId) continua aceita; a mesma execução reutiliza.
    const owner = markRunId(comment);
    return owner && owner !== runId ? "foreign" : "reuse";
  }
  return Number(publicTableCount) === 0 ? "adopt" : "refuse";
}


/** M23: texto da marca com o identificador da execução que criou/adotou o banco. */
export const dbOwnerComment = (runId) => (runId ? `${QA_DB_OWNER_MARK} run=${runId}` : QA_DB_OWNER_MARK);
/** M23: runId gravado na marca (ou null para marca antiga sem runId). */
export const markRunId = (comment) => { const m = /^levora-qa-owned run=([A-Za-z0-9-]+)$/.exec(String(comment ?? "")); return m ? m[1] : null; };
/** M23: decide a limpeza: "drop" | "refuse-unmarked" | "refuse-other-run". Sem runId informado ou marca antiga, mantém o comportamento anterior (só exige a marca). */
export function decideDrop({ comment, runId }) {
  if (typeof comment !== "string" || !comment.startsWith(QA_DB_OWNER_MARK)) return "refuse-unmarked";
  const owner = markRunId(comment);
  if (runId && owner && owner !== runId) return "refuse-other-run";
  return "drop";
}
