// Smoke de staging (M49): roda contra uma API já iniciada, com as contas SINTÉTICAS do seed de staging (db/seed-staging). Uso:
//   BASE=http://127.0.0.1:3001 SEED_RAW=<arquivo com a saída do seed --reset-passwords> node scripts/staging-smoke.mjs
// As credenciais são lidas do arquivo e nunca impressas. Não é homologação: verifica o básico (saúde, prontidão, login, cookie, logout, isolamento de plataforma, x-request-id).
// Exit 0 = todos OK; 1 = alguma verificação falhou. Não grava dados além de sessões/auditoria de login.
import { readFileSync } from "node:fs";
const base = process.env.BASE, raw = readFileSync(process.env.SEED_RAW, "utf8");
const m = [...raw.matchAll(/^(.+)\n  e-mail: (\S+)\n  senha:  (\S+)/gm)];
const find = (label) => { const x = m.find((r) => r[1].startsWith(label)); if (!x) throw new Error("conta " + label); return { email: x[2], password: x[3] }; };
const out = []; const rec = (n, ok, d = "") => { out.push({ n, ok, d }); console.log(ok ? "OK  " : "FALHA", n, d); };
const un = (b) => (b && typeof b === "object" && "json" in b ? b.json : b);
const j = async (path, init = {}) => { const r = await fetch(base + path, init); let b = null; try { b = un(await r.json()); } catch {} return { s: r.status, h: r.headers, b }; };
const post = (p, body, cookie, extra = {}) => j(p, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify({ json: body ?? {} }) });
const login = async (acct) => { const r = await fetch(base + "/_api/v1/auth/login_with_password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: acct }) }); const sc = r.headers.getSetCookie?.() ?? []; return { s: r.status, cookie: sc.map((c) => c.split(";")[0]).join("; "), setCookie: sc.join("|"), b: un(await r.json().catch(() => null)) }; };
const h = await j("/_api/__health"); rec("health 200", h.s === 200);
const rd = await j("/_api/__ready"); rec("ready 200, agendador de agentes desabilitado", rd.s === 200 && rd.b?.checks?.agentEventsScheduler === "desabilitado", JSON.stringify(rd.b?.checks));
const anon = await j("/_api/v1/auth/session"); rec("sessão anônima não autenticada (401/vazia)", anon.s === 401 || !anon.b?.user, "status " + anon.s);
const bad = await login({ email: find("Proprietário - Esperança").email, password: "senha-errada-sintetica" }); rec("login com senha errada recusado", bad.s >= 400 && !bad.cookie, "status " + bad.s);
const owner = await login(find("Proprietário - Esperança")); rec("login do proprietário (demo) aceito", owner.s === 200 && !!owner.cookie, "status " + owner.s);
rec("cookie de sessão HttpOnly + SameSite", /httponly/i.test(owner.setCookie) && /samesite=/i.test(owner.setCookie), owner.setCookie.replace(/=[^;|]{12,}/g, "=[…]").slice(0, 160));
const s = await j("/_api/v1/auth/session", { headers: { cookie: owner.cookie } }); rec("sessão do proprietário válida", s.s === 200 && !!s.b?.user, "status " + s.s);
const forged = await j("/_api/v1/auth/session", { headers: { "x-request-id": "FORJADO-123" } }); rec("x-request-id forjado não é ecoado e o servidor devolve o seu", !!forged.h.get("x-request-id") && forged.h.get("x-request-id") !== "FORJADO-123", String(forged.h.get("x-request-id")).slice(0, 40));
const plat = await login(find("Administrador da plataforma")); rec("login do admin de plataforma exige segundo fator (sem sessão direta) ou entra", plat.s === 200, "status " + plat.s + " cookie=" + (plat.cookie ? "sim" : "nao") + " " + JSON.stringify(plat.b)?.slice(0, 90));
// Operação protegida: reprocessamento de tarefa com agendador desligado.
const retryOwner = await post("/_api/v1/background-tasks-retry", { runId: 1 }, owner.cookie); rec("retry de tarefa de fundo por usuário comum recusado (401/403)", [401, 403].includes(retryOwner.s), "status " + retryOwner.s);
const retryPlat = await post("/_api/v1/background-tasks-retry", { runId: 1 }, plat.cookie); rec("admin de plataforma sem MFA concluído não tem sessão: retry recusado (401); MFA obrigatório na plataforma", plat.b?.mfaRequired === true && retryPlat.s === 401, "status " + retryPlat.s + " " + JSON.stringify(retryPlat.b)?.slice(0, 120));
const logout = await post("/_api/v1/auth/logout", {}, owner.cookie); const after = await j("/_api/v1/auth/session", { headers: { cookie: owner.cookie } }); rec("logout invalida a sessão", logout.s === 200 && (after.s === 401 || !after.b?.user), `logout ${logout.s}, depois ${after.s}`);
const owner2 = await login(find("Proprietário - Esperança")); const nonpl = await j("/_api/v1/platform-organizations", { headers: { cookie: owner2.cookie } }); rec("proprietário de organização (sessão válida) não acessa a área da plataforma: 403", nonpl.s === 403, "status " + nonpl.s);
const fails = out.filter((x) => !x.ok); console.log(`\n${out.length - fails.length}/${out.length} OK`); process.exit(fails.length ? 1 : 0);
