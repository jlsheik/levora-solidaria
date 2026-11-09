// App-FIXTURE descartável para validar o QA visual com navegador REAL sem tocar no produto: páginas determinísticas (HTML/CSS próprios), regressões visuais
// controladas (variantes de CSS escolhidas por /__variant) e falhas de carregamento controladas para o D6 (/__d6). Servidor local em porta efêmera; nada é gravado em disco.
//
// Páginas: /painel (layout completo), /formulario (campos), /mod (monta via módulo /app.js, cujo comportamento é controlado), /vazio (nunca monta, sem erro),
//          /excecao (lança antes de montar), /redireciona (302 para /outra-pagina), /outra-pagina (monta), /negado (monta mostrando "Acesso negado").
import { createServer } from "node:http";

const BASE_CSS = `
:root{font-family:Arial,Helvetica,sans-serif;font-size:16px}
*{box-sizing:border-box}
body{margin:0;background:#ffffff;color:#111111}
body.dark{background:#111111;color:#eeeeee}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid #cccccc}
body.dark header{border-color:#444444}
nav a{color:#1d4ed8;text-decoration:none;margin-right:12px} body.dark nav a{color:#93c5fd}
main{padding:16px;max-width:960px}
h1{font-size:24px;margin:0 0 12px}
.card{border:1px solid #cccccc;border-radius:8px;padding:16px;margin-bottom:16px;background:#fafafa}
body.dark .card{background:#1b1b1b;border-color:#444444}
.card p{margin:0 0 12px;line-height:1.4}
label{display:block;font-weight:600;margin:8px 0 4px}
input,select{width:100%;max-width:360px;padding:8px;border:1px solid #888888;border-radius:6px;background:#ffffff;color:#111111;font-size:16px}
body.dark input,body.dark select{background:#222222;color:#eeeeee;border-color:#777777}
.btn{display:inline-block;padding:10px 16px;border-radius:6px;border:1px solid transparent;font-size:16px;cursor:pointer}
.btn-primary{background:#1d4ed8;color:#ffffff}
.btn-secondary{background:#ffffff;color:#1f2937;border-color:#6b7280;margin-left:8px}
body.dark .btn-secondary{background:#222222;color:#eeeeee}
table{border-collapse:collapse;width:100%;margin-top:8px}
th,td{border:1px solid #cccccc;padding:6px 8px;text-align:left} body.dark th,body.dark td{border-color:#444444}
footer{padding:16px;border-top:1px solid #cccccc;margin-top:24px;color:#555555} body.dark footer{border-color:#444444;color:#aaaaaa}
@media (max-width:600px){header{flex-direction:column;align-items:flex-start}.btn-secondary{margin-left:0;margin-top:8px}}
`;

/** Regressões visuais controladas (CSS adicional servido só pelo fixture). */
export const VARIANTS = Object.freeze({
  base: "",
  irrelevante: ".btn-primary{background:#1e4fd9}", // 1 nível por canal: imperceptível, abaixo do limiar perceptual
  cor: ".btn-primary{background:#b91c1c}", // só a cor muda (a forma é a mesma)
  deslocamento: ".card{margin-left:6px}", // elementos deslocados
  espacamento: ".card p{margin-bottom:28px}", // diferença de espaçamento
  oculto: "#secondary{display:none}", // elemento oculto
  cortado: ".card{overflow:hidden;max-width:170px;white-space:nowrap}", // conteúdo cortado
  sobreposicao: ".btn-secondary{position:relative;left:-70px}", // sobreposição
  tipografia: ".card p{font-weight:700;font-size:18px}", // tipografia
  altura: "footer{height:1000px}", // dimensões da página (passa do viewport: a imagem fica mais alta)
});

const PAGE = (title, body, extraCss = "", script = "") => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${BASE_CSS}${extraCss}</style></head><body><div id="root"></div><script>${script || `document.getElementById('root').innerHTML = ${JSON.stringify(body)};`}</script></body></html>`;

const PAINEL = `<header><strong>Fixture QA</strong><nav><a href="#">Início</a><a href="#">Necessidades</a><a href="#">Relatórios</a></nav></header>
<main><h1>Painel de teste</h1>
<section class="card"><p>Este cartão existe só para validar a comparação visual. O texto é longo o bastante para quebrar em mais de uma linha em telas estreitas.</p><p>Segundo parágrafo do cartão, com informação adicional.</p>
<button class="btn btn-primary" id="primary">Salvar</button><button class="btn btn-secondary" id="secondary">Cancelar</button></section>
<section class="card"><table><thead><tr><th>Item</th><th>Qtd</th><th>Unidade</th></tr></thead><tbody>
<tr><td>Arroz</td><td>12</td><td>kg</td></tr><tr><td>Feijão</td><td>8</td><td>kg</td></tr><tr><td>Óleo</td><td>5</td><td>L</td></tr><tr><td>Leite</td><td>20</td><td>L</td></tr></tbody></table></section></main>
<footer>Rodapé do fixture</footer>`;
const FORM = `<header><strong>Fixture QA</strong></header><main><h1>Formulário</h1><section class="card"><label for="email">E-mail</label><input id="email" type="email" value="pessoa@exemplo.org"><label for="tipo">Tipo</label><select id="tipo"><option>Doação</option><option>Retirada</option></select><p style="margin-top:12px"><button class="btn btn-primary">Enviar</button></p></section></main>`;

export async function startFixtureApp() {
  const state = { variant: "base", d6: "ok", hits: [], fontHold: false, held: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x"); const p = url.pathname; state.hits.push(p);
    const send = (code, type, body, h = {}) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...h }); res.end(body); };
    const html = (body) => send(200, "text/html; charset=utf-8", body);
    if (p === "/__variant") { const v = url.searchParams.get("name") ?? "base"; if (!(v in VARIANTS)) return send(400, "text/plain", "variante desconhecida"); state.variant = v; return send(200, "text/plain", v); }
    if (p === "/__d6") { state.d6 = url.searchParams.get("mode") ?? "ok"; return send(200, "text/plain", state.d6); }
    if (p === "/painel") return html(PAGE("Painel", PAINEL, VARIANTS[state.variant]));
    if (p === "/formulario") return html(PAGE("Formulário", FORM, VARIANTS[state.variant]));
    if (p === "/outra-pagina") return html(PAGE("Outra", `<main><h1>Outra página</h1><p id="outra">Conteúdo de outra rota</p></main>`));
    if (p === "/negado") return html(PAGE("Negado", `<main><h1>Acesso negado</h1><p>Você não tem permissão.</p></main>`));
    if (p === "/redireciona") return send(302, "text/plain", "", { Location: "/outra-pagina" });
    if (p === "/vazio") return html(`<!doctype html><html><head><meta charset="utf-8"><title>Vazio</title></head><body><div id="root"></div></body></html>`);
    if (p === "/excecao") return html(`<!doctype html><html><head><meta charset="utf-8"><title>Exceção</title></head><body><div id="root"></div><script>throw new Error('falha ao montar o app (fixture)');</script></body></html>`);
    if (p === "/mod") return html(`<!doctype html><html><head><meta charset="utf-8"><title>Módulo</title><style>${BASE_CSS}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
    if (p === "/app.js") { // o módulo que monta o app: o comportamento é o cenário do D6
      switch (state.d6) {
        case "404": return send(404, "text/plain", "não achei");
        case "500": return send(500, "text/plain", "erro de transformação");
        case "503": return send(503, "text/plain", "indisponível");
        case "reset": req.socket.destroy(); return; // ERR_EMPTY_RESPONSE / ERR_CONNECTION_RESET
        case "truncado": res.writeHead(200, { "Content-Type": "application/javascript", "Content-Length": "5000" }); res.write("export const x"); setTimeout(() => req.socket.destroy(), 20); return; // ERR_CONTENT_LENGTH_MISMATCH
        default: return send(200, "application/javascript", `document.getElementById('root').innerHTML = ${JSON.stringify(PAINEL)};`);
      }
    }
    if (p === "/fonte") return html(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fonte</title><style>@font-face{font-family:Lenta;src:url(/fonte.woff2) format('woff2')}</style></head><body><div id="root"></div><script>setTimeout(function () { document.getElementById('root').innerHTML = '<p id="texto" style="font-family:Lenta,Arial,sans-serif">Texto com fonte web</p>'; }, 60);</script></body></html>`); // o texto (e portanto o pedido da fonte) só entra DEPOIS do load: a fonte pendente não bloqueia a navegação, só a prontidão
    if (p === "/fonte.woff2") { if (state.fontHold) { state.held.push(res); return; } return send(404, "text/plain", ""); } // pendente até soltar; depois falha rápido (o carregamento termina)
    if (p === "/datas") { // conteúdo que muda a cada segundo (como a semente do produto): data/hora do SERVIDOR no momento do pedido, mais textos numéricos que NÃO podem ser normalizados
      const n = new Date(); const z = (x) => String(x).padStart(2, "0"); const d = `${z(n.getDate())}/${z(n.getMonth() + 1)}/${n.getFullYear()}`; const hm = `${z(n.getHours())}:${z(n.getMinutes())}`;
      return html(PAGE("Datas", `<main><h1>Datas</h1><p id="criado">Criado em ${d}, ${hm}:${z(n.getSeconds())}</p><p id="vence">Vence em ${d} ${hm}</p><p id="iso">ISO ${n.toISOString().slice(0, 10)}</p><p id="fixos">Qtd 12 · R$ 12,50 · 5 kg · v1.2.3 · (11) 91234-5678 · 2026 · Lote 2026-ABC</p></main>`));
    }
    if (p === "/relogio") { // M04: valores de tempo calculados NO NAVEGADOR (Date); com o relógio congelado saem iguais sempre; "Lote 10:30" parece hora mas não é: não pode ser alterado
      const body = `<main><h1>Relógio</h1><p id="agora"></p><p id="local"></p><p id="fuso"></p><p id="fixo">Lote 10:30 · Sala 12:45 · Ref 2031-09-09</p></main>`;
      const js = `document.getElementById('root').innerHTML = ${JSON.stringify(body)}; var d = new Date(); document.getElementById('agora').textContent = 'ISO ' + d.toISOString(); document.getElementById('local').textContent = 'Local ' + d.toLocaleString('pt-BR') + ' | ts ' + Date.now(); document.getElementById('fuso').textContent = 'Fuso ' + Intl.DateTimeFormat().resolvedOptions().timeZone;`;
      return html(PAGE("Relógio", body, "", js));
    }
    if (p === "/longa") { // M04: página de ~14.000 px, cada faixa de 100 px com conteúdo único + cabeçalho fixed (aparece uma vez, como na captura de página inteira)
      const rows = Array.from({ length: 140 }, (_, i) => `<div style="height:100px;box-sizing:border-box;padding:8px 16px;background:hsl(${(i * 37) % 360},55%,${i % 2 ? 88 : 78}%);font:16px Arial">Faixa ${i} — ${"x".repeat(i % 40)}</div>`).join("");
      return html(PAGE("Longa", `<header style="position:fixed;top:0;left:0;right:0;height:40px;background:#222;color:#fff;font:14px Arial;padding:10px">cabeçalho fixo</header><main id="topo" style="padding-top:40px">${rows}</main>`));
    }
    if (p === "/favicon.ico") return send(404, "text/plain", "");
    send(404, "text/plain", "rota desconhecida do fixture");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, state, setVariant: (v) => { if (!(v in VARIANTS)) throw new Error(`variante desconhecida: ${v}`); state.variant = v; }, setD6: (m) => { state.d6 = m; }, holdFont: (on) => { state.fontHold = on; if (!on) { for (const r of state.held.splice(0)) { try { r.writeHead(404); r.end(); } catch { /* conexão já fechada */ } } } }, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Matriz visual do fixture (mesmo formato de visual-matrix.mjs). */
export const FIXTURE_PAGES = Object.freeze([
  { id: "painel", path: "/painel", user: "guest", steps: [], target: { css: "button#primary" } },
  { id: "formulario", path: "/formulario", user: "guest", steps: [], target: { css: "input#email" } },
]);
