// Upload e download de arquivos em navegador real, com a sessão real, contra o endpoint real (`files-upload` / `files-download`) e dados sintéticos.
// Para cada cenário o veredito vem de TRÊS fontes independentes: a resposta HTTP, o que ficou persistido (linhas em `files` + arquivos no disco de
// teste) e o que o navegador faz com o conteúdo (nada de executar; nenhum aviso chega ao coletor). Rótulos usados nas linhas:
//   ACEITO E SERVIDO COM SEGURANÇA · REJEITADO CORRETAMENTE (sem rastro) · VIOLAÇÃO (FAIL) · não medido (UNMEASURABLE) · ausente (MISSING).
import { readdirSync } from "node:fs";
import path from "node:path";
import { FILE_HIT_IDS } from "./payloads.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from("JFIF\0"), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const beacon = (collector, id) => `void((new Image).src='${collector}/h?id=${id}')`;
const svgActive = (c) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="${beacon(c, "UP@svg")}"><script>${beacon(c, "UP@svg-script")}</script></svg>`);
const htmlActive = (c) => Buffer.from(`<!doctype html><title>x</title><script>${beacon(c, "UP@html")}</script>`);

/** Casos de envio. `expect`: accepted (200 + download seguro) | rejected (400 + nenhum rastro). */
export function uploadCases(collectorUrl) {
  return [
    { id: "png-valido", fileName: "comprovante.png", contentType: "image/png", bytes: PNG, expect: "accepted", navigate: true },
    { id: "jpeg-valido", fileName: "foto.jpg", contentType: "image/jpeg", bytes: JPEG, expect: "accepted", navigate: true },
    { id: "webp-valido", fileName: "foto.webp", contentType: "image/webp", bytes: WEBP, expect: "accepted", navigate: true },
    { id: "pdf-valido", fileName: "recibo.pdf", contentType: "application/pdf", bytes: PDF, expect: "accepted" },
    { id: "svg-ativo-declarado-png", fileName: "logo.png", contentType: "image/png", bytes: svgActive(collectorUrl), expect: "rejected" },
    { id: "html-ativo-declarado-pdf", fileName: "recibo.pdf", contentType: "application/pdf", bytes: htmlActive(collectorUrl), expect: "rejected" },
    { id: "html-ativo-declarado-jpeg", fileName: "foto.jpg", contentType: "image/jpeg", bytes: htmlActive(collectorUrl), expect: "rejected" },
    { id: "png-declarado-jpeg", fileName: "foto.jpg", contentType: "image/jpeg", bytes: PNG, expect: "rejected" },
    { id: "tipo-svg", fileName: "logo.svg", contentType: "image/svg+xml", bytes: svgActive(collectorUrl), expect: "rejected" },
    { id: "tipo-html", fileName: "pagina.html", contentType: "text/html", bytes: htmlActive(collectorUrl), expect: "rejected" },
    { id: "base64-invalido", fileName: "x.png", contentType: "image/png", rawBase64: "@@@@", expect: "rejected" },
    { id: "nome-traversal", fileName: "../../etc/passwd.png", contentType: "image/png", bytes: PNG, expect: "accepted", hostileName: true },
    { id: "nome-unicode", fileName: "日本語のファイル.png", contentType: "image/png", bytes: PNG, expect: "accepted", hostileName: true },
    { id: "nome-com-html", fileName: "<img src=x onerror=alert(1)>.png", contentType: "image/png", bytes: PNG, expect: "accepted", hostileName: true },
  ];
}

const countDisk = (dir) => { let n = 0; for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countDisk(path.join(dir, e.name)) : 1; return n; };

export async function uploadChecks(kit, b, { cdp, collector, sql, storageDir, user, outsiderLogin, baseUrl, orgId }) {
  const { add, STATUS, navigate, login, sleep } = kit;
  const row = (scenario, target, status, detail, state) => add(b.name, b.version, scenario, target, "upload", status, detail, { state });
  const snap = async () => ({ rows: Number((await sql`SELECT count(*)::int AS n FROM files`)[0].n), disk: countDisk(storageDir) });
  const same = (a, c) => a.rows === c.rows && a.disk === c.disk;
  const fileHits = () => collector.hits.filter((h) => h.id.startsWith("UP@") || FILE_HIT_IDS.includes(h.id));

  await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  if (!(await login(cdp, baseUrl, user))) { row("upload:login", "login", STATUS.UNMEASURABLE, `login como ${user} não concluiu; envios não avaliados`, "-"); return; }
  await navigate(cdp, `${baseUrl}/organizacoes/${orgId}`); await sleep(800);

  const pageFetch = (url, init = "{}") => cdp.eval(`(async () => { const r = await fetch(${JSON.stringify(url)}, ${init}); const buf = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); return JSON.stringify({ status: r.status, headers: Object.fromEntries(r.headers), b64: btoa(s) }); })()`).then((s) => JSON.parse(s));
  const sendUpload = (c) => pageFetch("/_api/v1/files-upload", `{ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { organizationId: ${orgId}, purpose: 'comprovante_entrega', fileName: ${JSON.stringify(c.fileName)}, contentType: ${JSON.stringify(c.contentType)}, fileBase64: ${JSON.stringify(c.rawBase64 ?? c.bytes.toString("base64"))} } }) }`);
  const text = (r) => Buffer.from(r.b64, "base64").toString("utf8");
  const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

  for (const c of uploadCases(collector.url())) {
    const before = await snap(); const hitsBefore = fileHits().length;
    const up = await sendUpload(c); const after = await snap(); const body = json(up);
    if (c.expect === "rejected") {
      const clean = up.status === 400 && same(before, after) && /json/.test(up.headers["content-type"] ?? "") && typeof body?.json?.message === "string";
      const bad = up.status === 200 || !same(before, after);
      row(`upload:${c.id}`, `files-upload (${c.contentType})`, clean ? STATUS.PASS : bad ? STATUS.FAIL : STATUS.UNMEASURABLE,
        clean ? `REJEITADO CORRETAMENTE (400 em JSON; nenhuma linha nem arquivo novo: linhas ${before.rows}→${after.rows}, disco ${before.disk}→${after.disk})`
          : bad ? `VIOLAÇÃO: ${up.status === 200 ? "o servidor ACEITOU conteúdo que não é do tipo declarado" : "rejeitou mas deixou rastro"} (status ${up.status}; linhas ${before.rows}→${after.rows}, disco ${before.disk}→${after.disk})`
            : `resposta inesperada ${up.status} sem rastro; não classificado`, "rejeitado");
      continue;
    }
    // aceito: precisa ser servido de volta com segurança
    const file = body?.json?.file;
    if (up.status !== 200 || !file) { row(`upload:${c.id}`, `files-upload (${c.contentType})`, STATUS.UNMEASURABLE, `um envio legítimo não foi aceito (status ${up.status}: ${text(up).slice(0, 80)}); sem como avaliar o download`, "aceito"); continue; }
    const down = await pageFetch(file.downloadUrl); const problems = [];
    if (down.status !== 200) problems.push(`download ${down.status}`);
    if (down.headers["content-type"] !== c.contentType) problems.push(`Content-Type '${down.headers["content-type"]}' ≠ '${c.contentType}'`);
    if (down.headers["x-content-type-options"] !== "nosniff") problems.push("sem nosniff");
    if (!/no-store/.test(down.headers["cache-control"] ?? "")) problems.push("sem Cache-Control no-store");
    const disp = down.headers["content-disposition"] ?? "";
    if (!disp.startsWith("inline;") || !/^[\x20-\x7e]*$/.test(disp) || /filename="[^"]*[\\;/][^"]*"/.test(disp)) problems.push(`Content-Disposition inseguro: ${disp.slice(0, 80)}`);
    if (down.b64 !== c.bytes.toString("base64")) problems.push("os bytes devolvidos diferem dos enviados");
    if (c.hostileName) {
      const stored = (await sql`SELECT storage_key, original_filename FROM files WHERE id = ${file.id}`)[0];
      if (!/^\d+\/[0-9a-f-]{36}$/.test(stored.storage_key)) problems.push(`storage_key fora do padrão (${stored.storage_key})`);
      if (stored.original_filename !== c.fileName) problems.push("o nome original não foi preservado como dado");
    }
    let shown = "";
    if (c.navigate) { // o navegador abre o arquivo servido: tem de ser a imagem, nunca um documento ativo
      await navigate(cdp, `${baseUrl}${file.downloadUrl}`); await sleep(500);
      const info = JSON.parse(await cdp.eval(`JSON.stringify({ type: document.contentType, img: !!document.querySelector('img') })`));
      if (info.type !== c.contentType) problems.push(`o navegador tratou como '${info.type}'`);
      shown = `; o navegador exibiu como ${info.type}`;
      await navigate(cdp, `${baseUrl}/organizacoes/${orgId}`);
    }
    if (fileHits().length > hitsBefore) problems.push("o coletor recebeu um aviso de execução");
    row(`upload:${c.id}`, `files-upload (${c.contentType})${c.hostileName ? " · nome hostil" : ""}`, problems.length ? STATUS.FAIL : STATUS.PASS,
      problems.length ? `VIOLAÇÃO: ${problems.join("; ")}` : `ACEITO E SERVIDO COM SEGURANÇA (200; Content-Type exato, nosniff, no-store, disposição inline só ASCII, bytes idênticos${shown})`, "aceito");
  }

  // limites: 8 MB decodificados e 16 MB brutos
  { const before = await snap(); const r = await sendUpload({ fileName: "grande.png", contentType: "image/png", rawBase64: "AAAA".repeat(2796203) }); const after = await snap();
    row("upload:acima de 8 MB", "files-upload", r.status === 400 && same(before, after) ? STATUS.PASS : STATUS.FAIL, r.status === 400 && same(before, after) ? "REJEITADO CORRETAMENTE (400; sem rastro)" : `VIOLAÇÃO: status ${r.status}; linhas ${before.rows}→${after.rows}`, "rejeitado"); }
  { const before = await snap(); const r = await pageFetch("/_api/v1/files-upload", `{ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(17 * 1024 * 1024) }`); const after = await snap();
    const html = /<html|<pre>/i.test(text(r)); const csp = r.headers["content-security-policy"] === "default-src 'none'; frame-ancestors 'none'";
    row("upload:acima de 16 MB", "files-upload", r.status === 413 && !html && csp && same(before, after) ? STATUS.PASS : STATUS.FAIL,
      r.status === 413 && !html && csp && same(before, after) ? "REJEITADO CORRETAMENTE (413 em JSON, CSP da API preservada, sem rastro)" : `VIOLAÇÃO: status ${r.status}, HTML=${html}, CSP da API preservada=${csp}, linhas ${before.rows}→${after.rows}`, "rejeitado"); }

  // arquivos ANTIGOS com tipo ativo (gravados direto na semente): o download nunca pode renderizá-los na origem autenticada
  const legacy = await sql`SELECT id, original_filename, content_type FROM files WHERE content_type NOT IN ('image/png','image/jpeg','image/webp','application/pdf') ORDER BY id`;
  if (legacy.length === 0) row("upload:legado ativo", "files-download", STATUS.MISSING, "a semente não trouxe arquivos antigos de tipo ativo", "legado");
  for (const f of legacy) {
    const hitsBefore = fileHits().length; const r = await pageFetch(`/_api/v1/files-download?fileId=${f.id}`);
    const problems = [];
    if (r.status !== 200) problems.push(`download ${r.status}`);
    if (r.headers["content-type"] !== "application/octet-stream") problems.push(`Content-Type '${r.headers["content-type"]}' é renderizável`);
    if (!/^attachment;/.test(r.headers["content-disposition"] ?? "")) problems.push("não é attachment");
    if (r.headers["x-content-type-options"] !== "nosniff") problems.push("sem nosniff");
    await navigate(cdp, `${baseUrl}/_api/v1/files-download?fileId=${f.id}`).catch(() => {}); await sleep(1500);
    const executed = fileHits().slice(hitsBefore).map((h) => h.id);
    if (executed.length) problems.push(`EXECUTOU na origem autenticada (avisos: ${executed.join(", ")})`);
    row(`upload:legado ${f.content_type}`, `files-download (${f.original_filename})`, problems.length ? STATUS.FAIL : STATUS.PASS,
      problems.length ? `VIOLAÇÃO: ${problems.join("; ")}` : "SERVIDO COM SEGURANÇA (octet-stream + attachment + nosniff; abrir no navegador não executou nada)", "legado");
    await navigate(cdp, `${baseUrl}/organizacoes/${orgId}`);
  }

  // autorização
  const some = (await sql`SELECT id FROM files WHERE content_type = 'image/png' ORDER BY id LIMIT 1`)[0];
  if (!some) { row("upload:autorização", "files-download", STATUS.MISSING, "não há arquivo PNG enviado para testar o acesso", "autorização"); }
  else {
    const anon = await pageFetch(`/_api/v1/files-download?fileId=${some.id}`, `{ credentials: 'omit' }`);
    const missing = await pageFetch(`/_api/v1/files-download?fileId=999999999`);
    const bad = await pageFetch(`/_api/v1/files-download?fileId=1%20OR%201%3D1`);
    row("upload:autorização (sem sessão / inexistente / id inválido)", "files-download", anon.status === 401 && missing.status === 404 && bad.status === 400 ? STATUS.PASS : STATUS.FAIL,
      anon.status === 401 && missing.status === 404 && bad.status === 400 ? "NEGADO CORRETAMENTE (401 sem sessão, 404 inexistente, 400 id inválido; nenhum corpo de arquivo)" : `VIOLAÇÃO: sem sessão ${anon.status}, inexistente ${missing.status}, id inválido ${bad.status}`, "autorização");
    if (await outsiderLogin()) {
      const before = await snap();
      const dl = await pageFetch(`/_api/v1/files-download?fileId=${some.id}`);
      const upx = await sendUpload({ fileName: "intruso.png", contentType: "image/png", bytes: PNG }); const after = await snap();
      const leaked = dl.status === 200; const wrote = upx.status === 200 || !same(before, after);
      row("upload:autorização (outra organização)", "files-download / files-upload", leaked || wrote ? STATUS.FAIL : dl.status === 403 && upx.status === 403 ? STATUS.PASS : STATUS.UNMEASURABLE,
        leaked || wrote ? `VIOLAÇÃO: usuário de OUTRA organização ${leaked ? "baixou o arquivo" : "gravou um arquivo na organização alheia"}` : dl.status === 403 && upx.status === 403 ? "NEGADO CORRETAMENTE (403 no download e no envio; sem rastro)" : `negado, mas com status inesperado (download ${dl.status}, envio ${upx.status})`, "autorização");
    } else row("upload:autorização (outra organização)", "login do usuário de outra organização", STATUS.UNMEASURABLE, "login do usuário de outra organização não concluiu", "autorização");
  }
}
