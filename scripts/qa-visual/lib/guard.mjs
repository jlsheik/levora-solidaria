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
