// Sobe o nginx REAL (imagem Docker já existente na máquina) com a configuração de produção do repositório (deploy/nginx.conf), trocando só o
// que depende do ambiente: domínio, certificado (autoassinado, descartável, gerado na hora), porta da API (a pilha de QA) e a pasta do cliente
// (uma build temporária). Cada troca é conferida: se a configuração mudar de forma que a troca não se aplique, a rotina falha em vez de testar
// outra coisa. Tudo só em 127.0.0.1; o contêiner é removido ao final (e recuperado se a rotina for morta à força).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

export const NGINX_IMAGE = "nginx:1.27-alpine";
export const OPENSSL_IMAGE = "alpine/openssl";
const docker = (args, opt = {}) => spawnSync("docker", args, { encoding: "utf8", windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" }, timeout: 120000, ...opt });
const toDockerPath = (p) => p.replace(/\\/g, "/");

/** Docker + as duas imagens precisam existir localmente (nada é baixado: sem rede, sem versão nova inesperada). */
export function dockerStatus() {
  const info = docker(["info", "--format", "{{.ServerVersion}}"]);
  if (info.status !== 0) return { ok: false, reason: "o daemon do Docker não responde" };
  for (const image of [NGINX_IMAGE, OPENSSL_IMAGE]) {
    if (docker(["image", "inspect", image, "--format", "{{.Id}}"]).status !== 0) return { ok: false, reason: `a imagem ${image} não existe localmente (a rotina não baixa imagens)` };
  }
  return { ok: true, version: info.stdout.trim() };
}

/** Troca só o que depende do ambiente e CONFERE cada troca. Pura (testada). */
export function adaptProductionConf(text, { apiPort }) {
  const rules = [
    [/server_name app\.exemplo\.org\.br;/g, "server_name localhost;", 2],
    [/ssl_certificate\s+\/etc\/letsencrypt\/live\/app\.exemplo\.org\.br\/fullchain\.pem;/g, "ssl_certificate     /certs/c.pem;", 1],
    [/ssl_certificate_key \/etc\/letsencrypt\/live\/app\.exemplo\.org\.br\/privkey\.pem;/g, "ssl_certificate_key /certs/k.pem;", 1],
    [/proxy_pass http:\/\/127\.0\.0\.1:3001\/_api\/;/g, `proxy_pass http://host.docker.internal:${apiPort}/_api/;`, 1],
  ];
  let out = text;
  for (const [re, to, expected] of rules) {
    const n = (out.match(re) ?? []).length;
    if (n !== expected) throw new Error(`deploy/nginx.conf mudou: a troca ${re} aplicou ${n}x (esperado ${expected}x); revise nginx.mjs antes de confiar neste teste`);
    out = out.replace(re, to);
  }
  if (!out.includes("root /opt/levora-solidaria/dist;")) throw new Error("deploy/nginx.conf mudou: 'root /opt/levora-solidaria/dist;' não encontrado");
  return out;
}

/** Torna a pasta (e tudo dentro) legível pelo usuário `nginx` do contêiner. `mkdtemp` cria a pasta com modo 0700 e dono = usuário do runner; no Linux o processo
 * trabalhador do nginx (outro uid) não consegue atravessá-la, e o `try_files` trata o acesso negado como arquivo inexistente: tudo vira 404 (visto na primeira execução
 * do CI, run 38508085885). No Windows/Docker Desktop o problema não aparece, por isso só o runner Linux revelou. Idempotente. */
export function makeReadableByContainer(dir) {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) makeReadableByContainer(p); else if (e.isFile()) chmodSync(p, 0o644);
  }
}

/** Certificado autoassinado DESCARTÁVEL para localhost (gerado por um contêiner openssl; fica só no diretório temporário). */
function makeCert(dir) {
  mkdirSync(dir, { recursive: true });
  const r = docker(["run", "--rm", "-v", `${toDockerPath(dir)}:/c`, OPENSSL_IMAGE, "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", "/c/k.pem", "-out", "/c/c.pem"]);
  if (r.status !== 0) throw new Error(`não gerou o certificado de teste: ${(r.stderr || "").slice(0, 200)}`);
}

/** Inicia o nginx. Retorna { port, name, workDir, stop }. `onContainer(name)` registra o contêiner para recuperação de órfãos. */
export async function startNginx({ confPath, distDir, apiPort, onContainer, onWorkDir }) {
  const work = mkdtempSync(path.join(tmpdir(), "levora-qa-profile-nginx-"));
  onWorkDir?.(work); // registrado para a recuperação de órfãos (guarda o certificado descartável)
  const name = `levora-qa-nginx-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const certs = path.join(work, "certs");
  const stop = async () => { docker(["rm", "-f", name]); rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); };
  try {
    makeCert(certs);
    makeReadableByContainer(distDir);
    const conf = adaptProductionConf(readFileSync(confPath, "utf8"), { apiPort });
    writeFileSync(path.join(work, "site.conf"), conf);
    onContainer?.(name);
    const run = docker(["run", "-d", "--name", name, ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []), "-p", "127.0.0.1:0:443", "-v", `${toDockerPath(path.join(work, "site.conf"))}:/etc/nginx/conf.d/default.conf:ro`, "-v", `${toDockerPath(certs)}:/certs:ro`, "-v", `${toDockerPath(distDir)}:/opt/levora-solidaria/dist:ro`, NGINX_IMAGE]);
    if (run.status !== 0) throw new Error(`o nginx não subiu: ${(run.stderr || "").slice(0, 300)}`);
    const portOut = docker(["port", name, "443/tcp"]).stdout.trim().split("\n")[0] ?? "";
    const port = Number(portOut.split(":").pop());
    if (!port) throw new Error(`não descobri a porta do nginx (${portOut})`);
    for (let i = 0; i < 40; i++) { let last = "sem resposta"; try { const r = await httpsRequest(port, "/index.html"); if (r.status === 200) return { port, name, workDir: work, stop }; last = `GET /index.html respondeu ${r.status}`; } catch (e) { last = String(e?.message ?? e); } await new Promise((r) => setTimeout(r, 250)); }
    throw new Error(`o nginx não serviu /index.html com 200 (${last}): ${(docker(["logs", name]).stderr || "").slice(-300)}`);
  } catch (e) { await stop(); throw e; }
}

/** GET/POST por HTTPS sem validar o certificado (autoassinado, descartável). Devolve { status, headers, rawHeaders, body }. */
export function httpsRequest(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", servername: "localhost", port, path: pathname, method, headers: { Host: "localhost", ...headers }, rejectUnauthorized: false, timeout: 15000 }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("tempo esgotado"))); req.on("error", reject);
    if (body) req.write(body); req.end();
  });
}

/** Remove um contêiner pelo nome (recuperação de órfãos). Só aceita nomes da rotina. */
export function removeContainer(name) {
  if (!/^levora-qa-nginx-[a-z0-9-]+$/.test(name)) throw new Error("nome de contêiner fora do padrão da rotina");
  docker(["rm", "-f", name]);
}
