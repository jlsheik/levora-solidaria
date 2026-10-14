/**
 * Lógica pura e servidores de fixture de `npm run qa:security` (scripts/qa-visual/security.mjs). Estes testes NÃO provam que o app é seguro:
 * provam que a ferramenta monta ataques válidos, classifica corretamente e não deixa um ataque que não rodou passar por "aprovado".
 * Quem prova o comportamento do app é a execução em navegador real (docs/QA_VISUAL.md).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error módulos .mjs sem tipos
import { ATTACKER_ORIGINS, ATTACK_KINDS, attackPage, classifyAttempt, summarizeNetwork, describeNetwork, needBody } from "../scripts/qa-visual/security/attacks.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { payloadSet, combined, javascriptUrl, FIELDS, allIds, parseHitId, hitCode } from "../scripts/qa-visual/security/payloads.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { startCollector, startFixtureVictim } from "../scripts/qa-visual/security/server.mjs";

const COLL = "http://127.0.0.1:9";

describe("origens e tipos de ataque", () => {
  it("cobre origem cruzada de SITE diferente e de MESMO SITE (localhost × 127.0.0.1) e seis tipos de requisição, com e sem preflight", () => {
    expect(Object.keys(ATTACKER_ORIGINS).sort()).toEqual(["cross-site", "same-site"]);
    expect(ATTACKER_ORIGINS["same-site"]).toBe("127.0.0.1");
    expect(ATTACKER_ORIGINS["cross-site"]).toBe("localhost");
    expect(ATTACK_KINDS.map((k: { id: string }) => k.id)).toEqual(["fetch-text-plain", "xhr-text-plain", "beacon-text-plain", "form-text-plain", "fetch-json", "form-urlencoded"]);
    expect(ATTACK_KINDS.some((k: { simple: boolean }) => !k.simple)).toBe(true);
  });

  it("cada tipo gera uma página com o alvo, o aviso de fim e nenhum segredo", () => {
    for (const kind of ATTACK_KINDS) {
      const html = attackPage({ kind: kind.id, target: "http://127.0.0.1:1/_api/v1/needs", organizationId: 7, marker: "m-1", doneUrl: "http://x/done", attackId: "a-1" });
      expect(html, kind.id).toContain("/_api/v1/needs");
      expect(html, kind.id).toContain("a=a-1");
      expect(html, kind.id).not.toMatch(/cookie|password|senha/i);
    }
    expect(() => attackPage({ kind: "inexistente", target: "x", organizationId: 1, marker: "m", doneUrl: "x", attackId: "a" })).toThrow();
  });

  it("o formulário text/plain monta, como o navegador, um corpo JSON VÁLIDO (nome=valor) com o marcador", () => {
    const html = attackPage({ kind: "form-text-plain", target: "http://127.0.0.1:1/x", organizationId: 7, marker: "m-1", doneUrl: "http://x/done", attackId: "a" });
    const name = /name="([^"]*)"/.exec(html)![1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
    const value = /value="([^"]*)"/.exec(html)![1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
    const body = JSON.parse(`${name}=${value}`);
    expect(body.json).toMatchObject({ organizationId: 7, title: "m-1", unit: "kg" });
    expect(needBody(7, "m-1").json.title).toBe("m-1");
  });
});

describe("classifyAttempt", () => {
  it("bloqueado: criou = FAIL, não criou = PASS", () => {
    expect(classifyAttempt({ expected: "blocked", created: true, fired: true }).status).toBe("FAIL");
    expect(classifyAttempt({ expected: "blocked", created: false, fired: true }).status).toBe("PASS");
  });
  it("ataque que não rodou NUNCA é aprovado (UNMEASURABLE), nem como controle", () => {
    expect(classifyAttempt({ expected: "blocked", created: false, fired: false }).status).toBe("UNMEASURABLE");
    expect(classifyAttempt({ expected: "created", created: true, fired: false }).status).toBe("UNMEASURABLE");
  });
  it("controle positivo que não cria o registro invalida a sonda", () => {
    expect(classifyAttempt({ expected: "created", created: true, fired: true }).status).toBe("PASS");
    expect(classifyAttempt({ expected: "created", created: false, fired: true }).status).toBe("UNMEASURABLE");
  });
});

describe("summarizeNetwork", () => {
  const ev = [
    { method: "Network.requestWillBeSent", params: { requestId: "1", type: "Fetch", request: { url: "http://h/_api/v1/needs", method: "POST", headers: { "Content-Type": "text/plain" } } } },
    { method: "Network.requestWillBeSentExtraInfo", params: { requestId: "1", headers: { "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:5", Cookie: "segredo=1" }, associatedCookies: [] } },
    { method: "Network.responseReceived", params: { requestId: "1", response: { status: 415 } } },
    { method: "Network.requestWillBeSent", params: { requestId: "2", type: "Other", request: { url: "http://h/outra", method: "POST", headers: {} } } },
  ];
  it("mostra metadados da requisição forjada e NUNCA o valor do cookie", () => {
    const n = summarizeNetwork(ev, "/_api/v1/needs");
    expect(n.requests).toHaveLength(1);
    expect(n.requests[0]).toMatchObject({ secFetchSite: "same-site", cookieSent: true, status: 415 });
    const text = describeNetwork(n);
    expect(text).toContain("Sec-Fetch-Site=same-site");
    expect(text).not.toContain("segredo");
  });
  it("sem requisição, diz que nada saiu (e isso é diferente de 'bloqueado pelo servidor')", () => {
    expect(describeNetwork(summarizeNetwork([], "/x"))).toMatch(/nenhuma requisição/);
  });
});

describe("cargas de XSS", () => {
  const set = payloadSet(COLL, "need-title");
  it("são 8 contextos, com ids únicos por campo e cada carga carrega o próprio id", () => {
    expect(set).toHaveLength(8);
    expect(new Set(set.map((p: { id: string }) => p.id)).size).toBe(8);
    for (const p of set) expect(p.text, p.key).toContain(p.id);
    expect(new Set(allIds(COLL)).size).toBe(FIELDS.length * 8);
    expect(parseHitId("P3@need-title")).toEqual({ payload: "P3", field: "need-title" });
  });
  it("são inofensivas: o único efeito é uma imagem de 1 pixel ao coletor local informado", () => {
    expect(hitCode(COLL, "X")).toBe(`void((new Image).src='${COLL}/h?id=X')`);
    for (const p of set) {
      expect(p.text, p.key).not.toMatch(/document\.cookie|localStorage|fetch\(|XMLHttpRequest|eval\(|location\s*=|window\.open/);
      const hosts = [...p.text.matchAll(/https?:\/\/[^/'"\s)]+/g)].map((m: RegExpMatchArray) => m[0]);
      for (const h of hosts) expect(h).toBe(COLL);
    }
    expect(combined(COLL, "a")).toContain("P8@a");
    expect(javascriptUrl(COLL, "P9@x")).toMatch(/^javascript:void\(/);
  });
});

describe("servidores de fixture (só 127.0.0.1)", () => {
  it("o coletor registra avisos e fins de ataque, serve as páginas registradas e 404 para o resto", async () => {
    const c = await startCollector();
    try {
      c.pages.set("a1", "<p>oi</p>");
      expect((await fetch(`${c.url()}/attack/a1`)).status).toBe(200);
      expect((await fetch(`${c.url()}/attack/zz`)).status).toBe(404);
      await fetch(`${c.url()}/h?id=P1@x`); await fetch(`${c.url()}/done?a=a1`);
      expect(c.hits.map((h: { id: string }) => h.id)).toEqual(["P1@x"]);
      expect(await c.waitDone("a1", 500)).toBe(true);
      expect(await c.waitDone("nunca", 200)).toBe(false);
    } finally { await c.stop(); }
  });

  it("a vítima de fixture exige o cookie, cria no endpoint vulnerável e o guardado barra Sec-Fetch-Site cruzado", async () => {
    const v = await startFixtureVictim();
    try {
      const post = (p: string, h: Record<string, string> = {}) => fetch(`${v.url}${p}`, { method: "POST", headers: { "Content-Type": "text/plain", ...h }, body: "m-1" });
      expect((await post("/vuln/create")).status).toBe(401);
      const cookie = { Cookie: "fx_session=1" };
      expect((await post("/vuln/create", { ...cookie, "Sec-Fetch-Site": "same-site" })).status).toBe(200);
      expect((await post("/guarded/create", { ...cookie, "Sec-Fetch-Site": "same-site" })).status).toBe(403);
      expect((await post("/guarded/create", { ...cookie, "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
      expect(await v.count("m-1")).toBe(2);
    } finally { await v.stop(); }
  });
});

describe("orquestrador (contrato estático)", () => {
  const src = readFileSync("scripts/qa-visual/security.mjs", "utf8");
  it("só roda em banco descartável, só em 127.0.0.1 e a calibração barra a conclusão quando falha", () => {
    expect(src).toContain("assertDisposableDatabase");
    expect(src).toContain("calibrationFailed");
    expect(src).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i);
  });
  it("tenta um comprovante javascript: pelo endpoint real e exige a recusa (400)", () => {
    expect(src).toContain("allocations-receive");
    expect(src).toMatch(/r === 400/);
  });
});
