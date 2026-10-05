/**
 * Fase 90 — achado real descoberto no preview: `server/index.ts` repassava as headers de resposta uma a uma com
 * `res.setHeader`, e `Set-Cookie` repetido SOBRESCREVIA o anterior. Resposta de mfa-verify tem DOIS cookies (sessão + limpeza do
 * challenge): a sessão se perdia e o login com MFA "funcionava" só na memória da SPA. Testado contra o Express real.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import superjson from "superjson";
import { buildApp } from "../server/index";
import { createTestUser, enrollTestMfa } from "./helpers";
import { totp, PASSWORD, codeForManualKey } from "./mfaHarness";
import { issueBootstrapToken } from "../src/helpers/platformBootstrap";
import { db } from "../src/helpers/db";

describe("Express real — múltiplos Set-Cookie chegam ao cliente", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = await buildApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${baseUrl}/_api/v1/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: superjson.stringify(body) });

  it("login com MFA → challenge; verificação → cookie de SESSÃO e limpeza do challenge (dois Set-Cookie); a sessão autentica", async () => {
    const u = await createTestUser();
    await enrollTestMfa(u.id);
    const first = await post("login_with_password", { email: u.email, password: PASSWORD });
    expect(first.status).toBe(200);
    const challenge = first.headers.getSetCookie().find((c) => c.startsWith("levora_challenge="))!.split(";")[0];
    expect(challenge).toBeTruthy();

    const done = await post("mfa-verify", { code: totp() }, challenge);
    expect(done.status).toBe(200);
    const cookies = done.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith("floot_built_app_session=") && /Max-Age=\d+/.test(c) && !/Max-Age=0/.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith("levora_challenge=;") && /Max-Age=0/.test(c))).toBe(true);

    const session = cookies.find((c) => c.startsWith("floot_built_app_session="))!.split(";")[0];
    const me = await fetch(`${baseUrl}/_api/v1/auth/session`, { headers: { cookie: session } });
    expect(me.status).toBe(200);
  });

  it("bootstrap pelo Express REAL: ativação entrega o cookie de challenge com os atributos certos; a conclusão entrega sessão + limpeza (dois Set-Cookie) e a sessão é aceita", async () => {
    const t = await issueBootstrapToken({ purpose: "owner", email: "http-owner@example.com", issuedBy: "teste@ci" });
    const act = await post("bootstrap-activate", { token: t.token });
    expect(act.status).toBe(200);
    expect(act.headers.get("cache-control")).toBe("no-store");
    const actCookies = act.headers.getSetCookie();
    expect(actCookies).toHaveLength(1);
    expect(actCookies[0]).toMatch(/^levora_challenge=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/_api\/v1\/auth; Max-Age=\d+$/);
    const challenge = actCookies[0].split(";")[0];

    expect((await post("bootstrap-credentials", { displayName: "Owner HTTP", password: "senha-forte-http-123" }, challenge)).status).toBe(200);
    const begin = await post("mfa-setup-begin", {}, challenge);
    expect(begin.status).toBe(200);
    const { manualKey } = superjson.parse<{ manualKey: string }>(await begin.text());
    const done = await post("mfa-setup-confirm", { code: codeForManualKey(manualKey) }, challenge);
    expect(done.status).toBe(200);
    const cookies = done.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const sess = cookies.find((c) => c.startsWith("floot_built_app_session="))!;
    expect(sess).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=\d+$/);
    expect(cookies.some((c) => c.startsWith("levora_challenge=;") && /Max-Age=0/.test(c))).toBe(true);
    const me = await fetch(`${baseUrl}/_api/v1/auth/session`, { headers: { cookie: sess.split(";")[0] } });
    expect(me.status).toBe(200);
    expect((await db.selectFrom("platformAccess").select("level").executeTakeFirstOrThrow()).level).toBe("owner");
  });
});
