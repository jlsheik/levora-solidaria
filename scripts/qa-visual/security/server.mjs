// Servidores LOCAIS e descartáveis da verificação de segurança (só 127.0.0.1, portas escolhidas pelo SO):
//  1) coletor/atacante — recebe os avisos das cargas XSS (`/h?id=`), os avisos de fim de ataque (`/done?a=`), serve as páginas do atacante
//     (`/attack/<id>`) e as páginas de FIXTURE de XSS usadas para calibrar o detector (uma vulnerável e uma segura);
//  2) vítima de fixture — um "aplicativo" mínimo com cookie de sessão SameSite=Lax, um endpoint propositalmente VULNERÁVEL e um GUARDADO,
//     que só existe para provar que o detector de CSRF acusa o que deve acusar. É código da ferramenta de teste, NUNCA do app de produção.
import http from "node:http";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const listen = (server) => new Promise((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res(server.address().port)); });
const close = (server) => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()); });
const fixtureHtml = (inner) => `<!doctype html><meta charset="utf-8"><title>fixture</title><body><div id="out"></div><script>${inner}</script>`;

export async function startCollector() {
  const hits = []; const dones = new Set(); const pages = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/h") { hits.push({ id: u.searchParams.get("id"), at: Date.now() }); res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" }); return res.end(GIF); }
    if (u.pathname === "/done") { dones.add(u.searchParams.get("a")); res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" }); return res.end(GIF); }
    if (u.pathname.startsWith("/attack/")) { const html = pages.get(decodeURIComponent(u.pathname.slice(8))); if (!html) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(html); }
    // fixtures de XSS (a carga vem na query; NUNCA vão para a aplicação real)
    if (u.pathname === "/fx/xss-vuln") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fixtureHtml(`document.getElementById('out').innerHTML = new URLSearchParams(location.search).get('p')`)); }
    if (u.pathname === "/fx/xss-safe") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fixtureHtml(`document.getElementById('out').textContent = new URLSearchParams(location.search).get('p')`)); }
    if (u.pathname === "/fx/href-vuln") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fixtureHtml(`const a=document.createElement('a');a.textContent='comprovante';a.href=new URLSearchParams(location.search).get('p');document.getElementById('out').append(a)`)); }
    if (u.pathname === "/fx/href-blank-vuln") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fixtureHtml(`const a=document.createElement('a');a.textContent='comprovante';a.target='_blank';a.rel='noopener noreferrer';a.href=new URLSearchParams(location.search).get('p');document.getElementById('out').append(a)`)); }
    if (u.pathname === "/fx/href-safe") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fixtureHtml(`const a=document.createElement('a');a.textContent='comprovante';const p=new URLSearchParams(location.search).get('p');if(/^(https?:|\\/(?!\\/))/i.test(p))a.href=p;document.getElementById('out').append(a)`)); }
    res.writeHead(404); res.end();
  });
  const port = await listen(server);
  return {
    port, hits, dones, pages,
    url: (host = "127.0.0.1") => `http://${host}:${port}`,
    hitsFor: (ids) => hits.filter((h) => ids.includes(h.id)),
    async waitDone(attackId, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { if (dones.has(attackId)) return true; await new Promise((r) => setTimeout(r, 80)); } return false; },
    stop: () => close(server),
  };
}

/** Vítima de fixture: /login coloca o cookie; /vuln/create e /guarded/create criam um registro; /count?m= conta os registros com o marcador. */
export async function startFixtureVictim() {
  const records = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const cookie = String(req.headers.cookie ?? "").includes("fx_session=1");
    if (u.pathname === "/login") { res.writeHead(200, { "Set-Cookie": "fx_session=1; Path=/; HttpOnly; SameSite=Lax", "Content-Type": "text/plain" }); return res.end("ok"); }
    if (u.pathname === "/count") { const m = u.searchParams.get("m") ?? ""; res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ n: records.filter((r) => r.includes(m)).length })); }
    if (req.method === "POST" && (u.pathname === "/vuln/create" || u.pathname === "/guarded/create")) {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (!cookie) { res.writeHead(401); return res.end(); }
        const site = req.headers["sec-fetch-site"];
        if (u.pathname === "/guarded/create" && site && site !== "same-origin" && site !== "none") { res.writeHead(403); return res.end(); }
        records.push(Buffer.concat(chunks).toString("utf8")); res.writeHead(200); res.end("created");
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(server);
  return { port, url: `http://127.0.0.1:${port}`, count: async (m) => (await (await fetch(`http://127.0.0.1:${port}/count?m=${encodeURIComponent(m)}`)).json()).n, stop: () => close(server) };
}
