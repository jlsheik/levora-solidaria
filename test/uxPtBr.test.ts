// @vitest-environment jsdom
/**
 * Frente de UX (Ciclo 19) — comportamento REAL em DOM (jsdom + React 18), com a página e o componente reais:
 *  1) diálogo "Nova organização": o campo "Tipo" obrigatório mostra a mensagem pt-BR do sistema (não o texto padrão do zod 4, que expunha o enum);
 *  2) estado de carregamento da autenticação em pt-BR, só enquanto carrega (sem texto antigo depois que a sessão resolve);
 *  3) `<body>` sem margem padrão (a margem de 8px gerava 16px de rolagem vertical).
 * Endpoints e `useAuth` são simulados; nenhuma regra de autorização, sessão ou payload é alterada pelo patch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ state: { type: "loading" } as { type: string; user?: unknown } }));
const api = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("../src/helpers/useAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/helpers/useAuth")>()),
  useAuth: () => ({ authState: auth.state, logout: vi.fn(), isAuthenticated: auth.state.type === "authenticated" }),
}));
vi.mock("../src/endpoints/organizations_GET.schema", () => ({ getOrganizations: async () => ({ organizations: [] }) }));
vi.mock("../src/endpoints/organizations_POST.schema", () => ({ postOrganizations: (...a: unknown[]) => api.post(...a) }));

import DashboardPage from "../src/pages/_index";
import { UserRoute } from "../src/components/ProtectedRoute";

const h = React.createElement;
let container: HTMLElement;
let root: Root;
const USER = { id: 1, displayName: "Pessoa QA", email: "qa@example.org", role: "user" };

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const mount = async (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, el))); });
  await flush();
};
const buttonByText = (t: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().includes(t)) as HTMLButtonElement;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
const dialogMessages = () => Array.from(document.querySelectorAll('[role="dialog"] p')).map((p) => p.textContent ?? "").filter((t) => /Informe|Selecione|Use a sigla|Invalid|Required|Expected/.test(t));
const typeInto = (placeholder: string, value: string) => act(() => {
  const el = document.querySelector<HTMLInputElement>(`[role="dialog"] input[placeholder="${placeholder}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.post.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // jsdom não implementa APIs de ponteiro/scroll que o Radix Select usa
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe('diálogo "Nova organização": campo "Tipo"', () => {
  beforeEach(() => { auth.state = { type: "authenticated", user: USER }; });

  it("envio vazio: o Tipo mostra a mensagem pt-BR do sistema, sem texto padrão do zod nem valores internos do enum", async () => {
    await mount(h(DashboardPage));
    await click(buttonByText("Nova organização"));
    await click(buttonByText("Criar organização"));
    await flush();
    const msgs = dialogMessages();
    expect(msgs).toContain("Selecione o tipo de organização");
    // as mensagens dos outros campos não mudaram
    expect(msgs).toEqual(expect.arrayContaining(["Informe o nome da organização", "Informe a cidade", "Use a sigla do estado, ex: MG"]));
    for (const m of msgs) {
      expect(m).not.toMatch(/Invalid option|Required|expected one of|igreja|organizacao_social|ponto_distribuicao/);
    }
    expect(api.post).not.toHaveBeenCalled();
  });

  it("o campo Tipo é o único a mostrar essa mensagem e fica sob o rótulo Tipo", async () => {
    await mount(h(DashboardPage));
    await click(buttonByText("Nova organização"));
    await click(buttonByText("Criar organização"));
    await flush();
    const ps = Array.from(document.querySelectorAll('[role="dialog"] p')).filter((p) => p.textContent === "Selecione o tipo de organização");
    expect(ps).toHaveLength(1);
    const item = ps[0].parentElement!;
    expect(item.textContent).toMatch(/^Tipo/);
  });

  it("Tipo escolhido + demais campos válidos: sem mensagens e a API é chamada com o payload esperado", async () => {
    api.post.mockResolvedValue({ organization: { id: 9 } });
    await mount(h(DashboardPage));
    await click(buttonByText("Nova organização"));
    typeInto("Ex: Igreja Batista Central", "Associação Teste");
    typeInto("Belo Horizonte", "Contagem");
    typeInto("MG", "mg");
    // Radix Select: abre pelo teclado e escolhe a primeira opção
    const trigger = document.querySelector<HTMLButtonElement>('[role="dialog"] button[role="combobox"]')!;
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
    const opt = document.querySelector<HTMLElement>('[role="option"]');
    expect(opt, "a lista de tipos deve abrir").toBeTruthy();
    await act(async () => { opt!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
    await click(buttonByText("Criar organização"));
    await flush();
    expect(dialogMessages()).toEqual([]);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0][0]).toMatchObject({ name: "Associação Teste", city: "Contagem", state: "MG", type: "igreja" });
  });
});

describe("estado de carregamento da autenticação", () => {
  it("em pt-BR enquanto carrega; some quando a sessão resolve; sem o texto antigo em inglês", async () => {
    auth.state = { type: "loading" };
    await mount(h(UserRoute, null, h("p", null, "conteúdo protegido")));
    expect(document.body.textContent).toContain("Verificando sua sessão...");
    expect(document.body.textContent).not.toMatch(/Authenticating/);
    expect(document.body.textContent).not.toContain("conteúdo protegido");
    // a sessão resolve: o texto de carregamento NÃO fica para trás
    auth.state = { type: "authenticated", user: USER };
    await mount(h(UserRoute, null, h("p", null, "conteúdo protegido")));
    expect(document.body.textContent).toContain("conteúdo protegido");
    expect(document.body.textContent).not.toContain("Verificando sua sessão");
    expect(document.body.textContent).not.toMatch(/Authenticating/);
  });

  it("sessão ausente: redireciona sem exibir o texto de carregamento (comportamento de autorização preservado)", async () => {
    auth.state = { type: "unauthenticated" };
    await mount(h(UserRoute, null, h("p", null, "conteúdo protegido")));
    expect(document.body.textContent).not.toContain("conteúdo protegido");
    expect(document.body.textContent).not.toContain("Verificando sua sessão");
  });
});

describe("layout global", () => {
  it.each(["login", "convites.$token"])("%s: o container .page com min-height:100vh e padding usa border-box (sem rolagem vertical sem conteúdo)", (page) => {
    const css = readFileSync(`src/pages/${page}.module.css`, "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = css.match(/\.page\s*\{[^}]*\}/)![0];
    expect(rule).toMatch(/min-height:\s*100vh/);
    expect(rule).toMatch(/padding:/);
    expect(rule).toMatch(/box-sizing:\s*border-box/);
  });

  it("base.css zera a margem do body (e não esconde conteúdo com overflow:hidden)", () => {
    const css = readFileSync("src/base.css", "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/(^|\n)body\s*\{\s*margin:\s*0;/); // M11: o corpo agora também define fundo, cor e fonte do tema (M04/F01–F02); a margem zerada continua sendo a primeira declaração
    expect(css).not.toMatch(/overflow\s*:\s*hidden/);
  });
});
