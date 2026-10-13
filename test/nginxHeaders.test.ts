/**
 * Cabeçalhos de segurança na camada estática de produção (deploy/nginx.conf e deploy/nginx.staging.conf). Achados medidos num nginx REAL em
 * contêiner (`npm run qa:security`, parte "headers"): `add_header` dentro de um `location` SUBSTITUI os do nível do `server` (não soma), então o HSTS
 * declarado no `server` só chegava em /_api/ — nunca no HTML nem nos assets —, os assets saíam sem `nosniff`, e um 404 de /assets/ levava
 * "Cache-Control: public, immutable, 1 ano" (um asset ainda não publicado ficaria preso em navegador/CDN). Estes testes leem os arquivos e travam
 * a regra; quem prova o comportamento é a rotina com o nginx de verdade.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DOCUMENT_CSP, DOCUMENT_CSP_WITH_FRAME_ANCESTORS, PERMISSIONS_POLICY } from "../src/helpers/securityHeaders";

interface Block { path: string; body: string }

/** Extrai os blocos `location` (sem aninhamento neste projeto) e o texto fora deles. */
export function locationsOf(conf: string): Block[] {
  // só o bloco HTTPS (o bloco :80 apenas redireciona e tem a própria `location /`)
  const full = conf.replace(/^\s*#.*$/gm, "");
  const text = full.includes("listen 443") ? full.slice(full.indexOf("listen 443")) : full;
  const out: Block[] = [];
  for (const m of text.matchAll(/location\s+(=\s+)?(\S+)\s*\{([^}]*)\}/g)) out.push({ path: `${m[1] ? "= " : ""}${m[2]}`, body: m[3] });
  return out;
}
const headersIn = (b: Block) => [...b.body.matchAll(/add_header\s+(\S+)\s+("[^"]*"|\S+)\s*(always)?\s*;/g)].map((m) => ({ name: m[1].toLowerCase(), value: m[2].replace(/^"|"$/g, ""), always: !!m[3] }));

const prod = readFileSync("deploy/nginx.conf", "utf8").replace(/\r\n/g, "\n");
const staging = readFileSync("deploy/nginx.staging.conf", "utf8").replace(/\r\n/g, "\n");
const DOCUMENT_LOCATIONS = ["= /index.html", "/"];
const HSTS = /^max-age=\d{7,}/;

describe("deploy/nginx.conf (produção)", () => {
  const locs = locationsOf(prod);
  it("tem as quatro locations esperadas", () => { expect(locs.map((l) => l.path).sort()).toEqual(["/", "/_api/", "/assets/", "= /index.html"].sort()); });

  it("toda location que define add_header repete o HSTS e o nosniff (add_header de location substitui o do server)", () => {
    for (const l of locs.filter((x) => headersIn(x).length > 0)) {
      const h = headersIn(l);
      const hsts = h.find((x) => x.name === "strict-transport-security");
      expect(hsts?.value, `${l.path}: HSTS`).toMatch(HSTS);
      expect(hsts?.always, `${l.path}: HSTS com always`).toBe(true);
      expect(h.find((x) => x.name === "x-content-type-options")?.value, `${l.path}: nosniff`).toBe("nosniff");
    }
  });

  it("/_api/ não define add_header próprio: herda só o HSTS do server e não duplica nada do Express", () => {
    const api = locs.find((l) => l.path === "/_api/")!;
    expect(headersIn(api)).toEqual([]);
    const serverLevel = prod.replace(/^\s*#.*$/gm, "").replace(/location[^{]*\{[^}]*\}/g, "");
    const names = [...serverLevel.matchAll(/add_header\s+(\S+)/g)].map((m) => m[1].toLowerCase());
    expect(names).toEqual(["strict-transport-security"]);
  });

  it("as locations de documento levam a CSP IGUAL a DOCUMENT_CSP_WITH_FRAME_ANCESTORS e os demais cabeçalhos, sem Report-Only", () => {
    for (const path of DOCUMENT_LOCATIONS) {
      const h = headersIn(locs.find((l) => l.path === path)!);
      expect(h.find((x) => x.name === "content-security-policy")?.value, path).toBe(DOCUMENT_CSP_WITH_FRAME_ANCESTORS);
      expect(h.find((x) => x.name === "x-frame-options")?.value).toBe("DENY");
      expect(h.find((x) => x.name === "referrer-policy")?.value).toBe("strict-origin-when-cross-origin");
      expect(h.find((x) => x.name === "permissions-policy")?.value).toBe(PERMISSIONS_POLICY);
      expect(h.some((x) => x.name === "content-security-policy-report-only")).toBe(false);
    }
  });

  it("a CSP do documento não relaxa o script (sem unsafe-inline/unsafe-eval/curinga) e mantém object-src, base-uri, form-action e frame-ancestors", () => {
    const script = /script-src ([^;]*)/.exec(DOCUMENT_CSP)![1];
    expect(script).toBe("'self'");
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS).toContain("object-src 'none'");
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS).toContain("base-uri 'self'");
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS).toContain("form-action 'self'");
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS).toContain("frame-ancestors 'none'");
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS).not.toMatch(/unsafe-eval|\*/);
  });

  it("o cache imutável dos assets só vale para sucesso: vem de um map por $status, nunca de um valor fixo com always", () => {
    const assets = locs.find((l) => l.path === "/assets/")!;
    const cache = headersIn(assets).find((x) => x.name === "cache-control")!;
    expect(cache.value).toBe("$levora_assets_cache");
    expect(prod).toMatch(/map \$status \$levora_assets_cache \{\s*default "";\s*200 "public, max-age=31536000, immutable";\s*304 "public, max-age=31536000, immutable";\s*\}/);
    expect(prod).not.toMatch(/add_header Cache-Control "public, max-age=31536000, immutable"/);
  });
});

describe("limite de corpo do proxy acomoda o envio de comprovante (8 MB em base64 ~ 10,7 MB; Express aceita 16 MB)", () => {
  for (const [nome, conf] of [["produção", prod], ["staging", staging]] as const) {
    it(`${nome}: location /_api/ define client_max_body_size acima de 16 MB (o Express responde o 413 em JSON)`, () => {
      const api = locationsOf(conf).find((l) => l.path === "/_api/")!;
      const m = /client_max_body_size\s+(\d+)m;/.exec(api.body);
      expect(m, "sem client_max_body_size (padrão do nginx = 1 MB: foto acima de ~750 KB voltava 413 em HTML)").not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(17);
    });
  }
});

describe("deploy/nginx.staging.conf (HTTP atrás do túnel: sem HSTS, que é da borda)", () => {
  const locs = locationsOf(staging);
  it("os documentos têm a mesma CSP de produção; os assets têm nosniff e o cache só em sucesso", () => {
    for (const path of DOCUMENT_LOCATIONS) expect(headersIn(locs.find((l) => l.path === path)!).find((x) => x.name === "content-security-policy")?.value).toBe(DOCUMENT_CSP_WITH_FRAME_ANCESTORS);
    const assets = headersIn(locs.find((l) => l.path === "/assets/")!);
    expect(assets.find((x) => x.name === "x-content-type-options")?.value).toBe("nosniff");
    expect(assets.find((x) => x.name === "cache-control")?.value).toBe("$levora_assets_cache");
    expect(staging).toMatch(/map \$status \$levora_assets_cache/);
  });
});

describe("o verificador estático enxerga a configuração ANTIGA como defeituosa (controle)", () => {
  const old = `server { add_header Strict-Transport-Security "max-age=15552000" always;
    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable" always; try_files $uri =404; } }`;
  it("location com add_header sem HSTS/nosniff e cache fixo com always é reprovada pelas mesmas regras", () => {
    const assets = locationsOf(old).find((l) => l.path === "/assets/")!;
    const h = headersIn(assets);
    expect(h.find((x) => x.name === "strict-transport-security")).toBeUndefined();
    expect(h.find((x) => x.name === "x-content-type-options")).toBeUndefined();
    expect(h.find((x) => x.name === "cache-control")?.value).not.toBe("$levora_assets_cache");
  });
});
