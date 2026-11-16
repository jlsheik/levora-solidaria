// @vitest-environment jsdom
/**
 * F1 — interface da recuperação de senha, em RUNTIME (jsdom + React) com `fetch` simulado, mais verificações estáticas de acessibilidade/tema/rotas.
 * Cobre: formulários, validação, carregamento, mensagens, teclado/foco (foco no título a cada estado), token só no fragmento (removido da URL/histórico),
 * estados do link (válido, expirado, já usado, inválido), falha temporária com nova tentativa, MFA (TOTP/código de recuperação), reenvio controlado.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import superjson from "superjson";
import { PasswordResetForm, takeTokenFromLocation } from "../src/components/PasswordResetForm";
import { PasswordResetRequestForm } from "../src/components/PasswordResetRequestForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "T".repeat(43);
const h = React.createElement;
let container: HTMLElement;
let root: Root;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
type Reply = { status: number; body: Record<string, unknown> } | "network";
let replies: Record<string, Reply[]> = {};

const respond = (r: Exclude<Reply, "network">) => new Response(superjson.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  replies = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = String(url).replace("/_api/v1/auth/", "");
      const body = init?.body ? (superjson.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: key, body });
      const next = (replies[key] ?? []).shift();
      if (!next) throw new Error(`resposta simulada ausente para ${key}`);
      if (next === "network") throw new TypeError("Failed to fetch");
      return respond(next);
    })
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
};
const mount = async (node: React.ReactElement) => {
  await act(async () => root.render(h(MemoryRouter, null, node)));
  await flush();
};
const text = () => container.textContent ?? "";
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const setValue = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async () => {
  await act(async () => q<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
};
const buttonByText = (t: string) => [...container.querySelectorAll("button, a")].find((b) => b.textContent?.trim().startsWith(t)) as HTMLElement | undefined;
const openWith = (hash: string) => window.history.replaceState(null, "", `/redefinir-senha${hash}`);

describe("redefinir-senha: token só no fragmento e removido da URL", () => {
  it("lê #token= e limpa a barra de endereço/histórico; o token nunca vai para a query nem para outro armazenamento", async () => {
    openWith(`#token=${TOKEN}`);
    expect(takeTokenFromLocation()).toBe(TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.history.state).toBeNull();
    openWith(`#token=${TOKEN}`);
    replies["password-reset-validate"] = [{ status: 200, body: { state: "valido", mfaRequired: false } }];
    await mount(h(PasswordResetForm));
    expect(window.location.href).not.toContain(TOKEN);
    expect(calls[0]).toEqual({ url: "password-reset-validate", body: { token: TOKEN } }); // no corpo, nunca na URL
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN);
  });

  it("sem token na URL: 'Link inválido' sem chamar a API", async () => {
    openWith("");
    await mount(h(PasswordResetForm));
    expect(q("h1")!.textContent).toBe("Link inválido");
    expect(calls).toHaveLength(0);
    expect(buttonByText("Pedir um novo link")).toBeTruthy();
  });
});

describe("redefinir-senha: estados do link", () => {
  for (const [state, title] of [["expirado", "Este link expirou"], ["utilizado", "Este link já foi usado"], ["invalido", "Link inválido"]] as const) {
    it(`link ${state}: título "${title}", orientação para pedir novo link e foco no título`, async () => {
      openWith(`#token=${TOKEN}`);
      replies["password-reset-validate"] = [{ status: 200, body: { state } }];
      await mount(h(PasswordResetForm));
      const h1 = q("h1")!;
      expect(h1.textContent).toBe(title);
      expect(document.activeElement).toBe(h1);
      expect(q('[role="status"]')).toBeTruthy();
      expect(container.querySelector('a[href="/recuperar-senha"]')).toBeTruthy();
      expect(container.querySelector('a[href="/login"]')).toBeTruthy();
    });
  }

  it("falha temporária na verificação: mensagem em role=alert, o link continua valendo e 'Tentar novamente' recupera", async () => {
    openWith(`#token=${TOKEN}`);
    replies["password-reset-validate"] = ["network", { status: 200, body: { state: "valido", mfaRequired: false } }];
    await mount(h(PasswordResetForm));
    expect(q("h1")!.textContent).toBe("Serviço temporariamente indisponível");
    expect(q('[role="alert"]')!.textContent).toMatch(/continua valendo/);
    await act(async () => buttonByText("Tentar novamente")!.click());
    await flush();
    expect(q("h1")!.textContent).toBe("Escolha uma nova senha");
  });
});

describe("redefinir-senha: formulário", () => {
  async function openForm(mfaRequired = false) {
    openWith(`#token=${TOKEN}`);
    replies["password-reset-validate"] = [{ status: 200, body: { state: "valido", mfaRequired } }];
    await mount(h(PasswordResetForm));
  }
  const fill = async (password: string, confirmation = password) => {
    await setValue(q<HTMLInputElement>("#reset-password")!, password);
    await setValue(q<HTMLInputElement>("#reset-password-confirm")!, confirmation);
  };

  it("campos rotulados (label/for), autocomplete new-password, foco no título; botão desabilitado até preencher", async () => {
    await openForm();
    expect(document.activeElement).toBe(q("h1"));
    for (const id of ["reset-password", "reset-password-confirm"]) {
      const input = q<HTMLInputElement>(`#${id}`)!;
      expect(input.type).toBe("password");
      expect(input.autocomplete).toBe("new-password");
      expect(container.querySelector(`label[for="${id}"]`)).toBeTruthy();
    }
    expect(buttonByText("Redefinir senha")!.hasAttribute("disabled")).toBe(true);
    expect(q("form")!.getAttribute("aria-labelledby")).toBe("reset-title");
  });

  it("validação local: senha curta, confirmação diferente e acima de 72 bytes — mensagem em role=alert, aria-invalid e sem chamar a API", async () => {
    await openForm();
    await fill("curta", "curta");
    await submit();
    expect(q('#reset-field-error[role="alert"]')!.textContent).toMatch(/pelo menos 8/);
    expect(q("#reset-password")!.getAttribute("aria-invalid")).toBe("true");
    expect(q("#reset-password")!.getAttribute("aria-describedby")).toBe("reset-field-error");
    await fill("senha-comprida-ok-123", "senha-diferente-456");
    await submit();
    expect(q("#reset-field-error")!.textContent).toBe("As senhas não são iguais.");
    await fill("ç".repeat(40));
    await submit();
    expect(q("#reset-field-error")!.textContent).toMatch(/72 bytes/);
    expect(calls.filter((c) => c.url === "password-reset-confirm")).toHaveLength(0);
  });

  it("sucesso: envia token + senha (sem campos de MFA), mostra 'Senha redefinida', limpa os campos e oferece 'Ir para o login'", async () => {
    await openForm();
    replies["password-reset-confirm"] = [{ status: 200, body: { message: "ok" } }];
    await fill("uma-senha-nova-segura-456");
    await submit();
    expect(calls.at(-1)).toEqual({ url: "password-reset-confirm", body: { token: TOKEN, newPassword: "uma-senha-nova-segura-456" } });
    expect(q("h1")!.textContent).toBe("Senha redefinida");
    expect(document.activeElement).toBe(q("h1"));
    expect(text()).toMatch(/verificação em duas etapas, ela continua sendo exigida/);
    expect(container.querySelector('a[href="/login"]')!.textContent).toBe("Ir para o login");
    expect(container.querySelector("input")).toBeNull();
  });

  it("carregando: botão com 'Salvando…' e campos desabilitados enquanto a requisição está pendente (sem envio duplo)", async () => {
    await openForm();
    let release!: (r: Response) => void;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<Response>((res) => (release = res)));
    await fill("uma-senha-nova-segura-456");
    await submit();
    expect(text()).toMatch(/Salvando…/);
    expect(q<HTMLInputElement>("#reset-password")!.disabled).toBe(true);
    await submit(); // segundo envio ignorado
    const confirmCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("password-reset-confirm"));
    expect(confirmCalls).toHaveLength(1);
    await act(async () => release(respond({ status: 200, body: { message: "ok" } })));
    await flush();
    expect(q("h1")!.textContent).toBe("Senha redefinida");
  });

  it("erros do servidor: senha igual (campo), link já usado/expirado/inválido (muda de estado), falha de rede e erro genérico (alert) — o formulário continua utilizável", async () => {
    await openForm();
    replies["password-reset-confirm"] = [
      { status: 422, body: { code: "senha_igual", message: "x" } },
      "network",
      { status: 500, body: { message: "interno" } },
      { status: 400, body: { code: "link_utilizado", message: "x" } },
    ];
    await fill("uma-senha-nova-segura-456");
    await submit();
    expect(q("#reset-field-error")!.textContent).toMatch(/diferente da atual/);
    await submit();
    expect(q("#reset-error")!.textContent).toMatch(/conexão/);
    await submit();
    expect(q("#reset-error")!.textContent).toMatch(/Tente novamente em instantes/);
    expect(text()).not.toMatch(/interno/); // a mensagem crua do servidor não vaza
    await submit();
    expect(q("h1")!.textContent).toBe("Este link já foi usado");
  });

  it("MFA: o campo do segundo fator aparece, é obrigatório, alterna TOTP ↔ código de recuperação e envia o campo certo", async () => {
    await openForm(true);
    expect(q("#reset-mfa")).toBeTruthy();
    expect(container.querySelector('label[for="reset-mfa"]')!.textContent).toBe("Código do autenticador");
    expect(q<HTMLInputElement>("#reset-mfa")!.autocomplete).toBe("one-time-code");
    await fill("uma-senha-nova-segura-456");
    await submit();
    expect(q("#reset-error")!.textContent).toMatch(/duas etapas/);
    expect(calls.filter((c) => c.url === "password-reset-confirm")).toHaveLength(0);

    replies["password-reset-confirm"] = [{ status: 401, body: { code: "mfa_invalido", message: "x" } }, { status: 200, body: { message: "ok" } }];
    await setValue(q<HTMLInputElement>("#reset-mfa")!, "123 456");
    await submit();
    expect(calls.at(-1)!.body).toEqual({ token: TOKEN, newPassword: "uma-senha-nova-segura-456", totpCode: "123456" });
    expect(q("#reset-error")!.textContent).toMatch(/Código incorreto/);
    expect(q<HTMLInputElement>("#reset-mfa")!.value).toBe("");

    await act(async () => buttonByText("Usar um código de recuperação")!.click());
    expect(container.querySelector('label[for="reset-mfa"]')!.textContent).toBe("Código de recuperação");
    await setValue(q<HTMLInputElement>("#reset-mfa")!, "abcd-efgh-ijkl-mnop");
    await submit();
    expect(calls.at(-1)!.body).toEqual({ token: TOKEN, newPassword: "uma-senha-nova-segura-456", recoveryCode: "ABCD-EFGH-IJKL-MNOP" });
    expect(q("h1")!.textContent).toBe("Senha redefinida");
  });

  it("MFA esgotado (link_invalido) leva ao estado 'Link inválido'; bloqueio (429) mostra orientação sem revelar detalhes", async () => {
    await openForm(true);
    await fill("uma-senha-nova-segura-456");
    replies["password-reset-confirm"] = [{ status: 429, body: { code: "mfa_bloqueado", message: "x" } }, { status: 401, body: { code: "link_invalido", message: "x" } }];
    await setValue(q<HTMLInputElement>("#reset-mfa")!, "111111");
    await submit();
    expect(q("#reset-error")!.textContent).toMatch(/Aguarde um pouco ou use um código de recuperação/);
    await submit();
    expect(q("h1")!.textContent).toBe("Link inválido");
  });
});

describe("recuperar-senha: pedido", () => {
  it("e-mail inválido: erro em role=alert, aria-invalid e nenhuma chamada; botão desabilitado com campo vazio", async () => {
    await mount(h(PasswordResetRequestForm));
    expect(q("h1")!.textContent).toBe("Esqueci minha senha");
    expect(buttonByText("Enviar link")!.hasAttribute("disabled")).toBe(true);
    await setValue(q<HTMLInputElement>("#reset-email")!, "isto-nao-e-email");
    await submit();
    expect(q('[role="alert"]')!.textContent).toMatch(/e-mail válido/);
    expect(q("#reset-email")!.getAttribute("aria-invalid")).toBe("true");
    expect(calls).toHaveLength(0);
    expect(q<HTMLInputElement>("#reset-email")!.autocomplete).toBe("email");
  });

  it("sucesso: SEMPRE a mensagem genérica do servidor em role=status, foco no título, reenvio bloqueado por contagem regressiva (reenvio controlado)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const generic = "Se existir uma conta com este e-mail, enviaremos as instruções.";
    replies["password-reset-request"] = [{ status: 202, body: { message: generic } }, { status: 202, body: { message: generic } }];
    await mount(h(PasswordResetRequestForm));
    await setValue(q<HTMLInputElement>("#reset-email")!, "  Pessoa@Example.com ");
    await submit();
    expect(calls[0]).toEqual({ url: "password-reset-request", body: { email: "Pessoa@Example.com" } });
    expect(q("h1")!.textContent).toBe("Confira seu e-mail");
    expect(document.activeElement).toBe(q("h1"));
    expect(q('[role="status"]')!.textContent).toBe(generic);
    const resend = buttonByText("Reenviar em")!;
    expect(resend.hasAttribute("disabled")).toBe(true);
    for (let i = 0; i < 61; i += 1) await act(async () => void vi.advanceTimersByTime(1000)); // a contagem re-agenda a cada renderização
    expect(buttonByText("Reenviar e-mail")!.hasAttribute("disabled")).toBe(false);
    await act(async () => buttonByText("Reenviar e-mail")!.click());
    await flush();
    expect(calls).toHaveLength(2);
    expect(buttonByText("Reenviar em")).toBeTruthy(); // novo ciclo de espera
  });

  it("limite de pedidos (429) e falha temporária têm mensagens próprias e a pessoa continua no formulário", async () => {
    replies["password-reset-request"] = [{ status: 429, body: { message: "x" } }, "network"];
    await mount(h(PasswordResetRequestForm));
    await setValue(q<HTMLInputElement>("#reset-email")!, "a@b.co");
    await submit();
    expect(q('[role="alert"]')!.textContent).toMatch(/Muitos pedidos/);
    expect(q("h1")!.textContent).toBe("Esqueci minha senha");
    await submit();
    expect(q('[role="alert"]')!.textContent).toMatch(/Não foi possível enviar o pedido agora/);
    expect(text()).not.toMatch(/Failed to fetch/);
  });
});

describe("rotas, link no login e tema (estático)", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf-8");
  it("as duas telas são rotas públicas e o login tem a ação 'Esqueci minha senha'", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/path:\s*"\/recuperar-senha"/);
    expect(app).toMatch(/path:\s*"\/redefinir-senha"/);
    const login = read("src/components/PasswordLoginForm.tsx");
    expect(login).toMatch(/to="\/recuperar-senha"/);
    expect(login).toMatch(/Esqueci minha senha/);
  });
  it("CSS novo usa só tokens do tema (claro/escuro): sem cores literais", () => {
    const css = read("src/components/passwordReset.module.css");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).toMatch(/var\(--primary\)/);
    expect(css).toMatch(/focus-visible/); // foco visível por teclado
  });
  it("o token não é registrado em console nem guardado em storage nos componentes", () => {
    for (const f of ["src/components/PasswordResetForm.tsx", "src/components/PasswordResetRequestForm.tsx", "src/pages/redefinir-senha.tsx"]) {
      const src = read(f);
      expect(src).not.toMatch(/console\.(log|error|warn)/);
      expect(src).not.toMatch(/localStorage|sessionStorage/);
    }
    expect(read("src/components/PasswordResetForm.tsx")).toMatch(/history\.replaceState/);
  });
});
