// @vitest-environment jsdom
/**
 * M09 / R9 — mensagens de erro de envio em português do Brasil. Sem banco: monta o FileDropzone REAL (react-dom + jsdom) e exercita o cliente `postFilesUpload` com `fetch` simulado.
 * Cobre: tipo inválido, tamanho acima do limite, mais arquivos que o permitido, falha de rede, erro HTTP (4xx com mensagem pública, 5xx, corpo que não é JSON), cancelamento,
 * acessibilidade (role="alert" + botão rotulado), recuperação (nova seleção válida limpa o erro) e ausência de inglês residual. Limite e tipos aceitos NÃO mudam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import superjson from "superjson";
import { FileDropzone } from "../src/components/FileDropzone";
import { postFilesUpload, UPLOAD_NETWORK_ERROR_MESSAGE, UPLOAD_SERVER_ERROR_MESSAGE, FILE_MAX_SIZE_BYTES, ALLOWED_CONTENT_TYPES } from "../src/endpoints/files-upload_POST.schema";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const INGLES = /Invalid file type|File size exceeds|Failed to fetch|Maximum \d|Click to upload|Accepted types|Clear error|File upload|Up to \d/i;

let host: HTMLDivElement; let root: Root; let picked: File[][];
const mount = (props: Partial<React.ComponentProps<typeof FileDropzone>> = {}) => {
  act(() => { root.render(React.createElement(FileDropzone, { accept: ALLOWED_CONTENT_TYPES.join(","), maxSize: FILE_MAX_SIZE_BYTES, onFilesSelected: (f: File[]) => picked.push(f), ...props })); });
};
const choose = (...files: File[]) => {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
};
const alertText = () => host.querySelector('[role="alert"] span')?.textContent ?? null;
const png = (name = "ok.png", size = 10) => { const f = new File([new Uint8Array(size)], name, { type: "image/png" }); return f; };

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); picked = []; });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("FileDropzone — validações locais em pt-BR (R9)", () => {
  it("tipo não aceito: mensagem em português; nada é enviado", () => {
    mount();
    choose(new File(["x"], "nota.txt", { type: "text/plain" }));
    expect(alertText()).toBe("Tipo de arquivo não permitido. Selecione um formato aceito.");
    expect(picked).toHaveLength(0);
  });
  it("tamanho acima do limite real (8 MB): mensagem em português com o limite vindo do contrato", () => {
    expect(FILE_MAX_SIZE_BYTES).toBe(8 * 1024 * 1024);
    mount();
    choose(png("grande.png", FILE_MAX_SIZE_BYTES + 1));
    expect(alertText()).toBe("O arquivo excede o limite de 8 MB.");
    expect(picked).toHaveLength(0);
  });
  it("exatamente no limite é aceito (o limite não foi alterado)", () => {
    mount();
    choose(png("limite.png", FILE_MAX_SIZE_BYTES));
    expect(alertText()).toBeNull();
    expect(picked).toHaveLength(1);
  });
  it("mais arquivos que o permitido (um): mensagem em português (singular e plural)", () => {
    mount({ maxFiles: 1 }); choose(png("a.png"), png("b.png"));
    expect(alertText()).toBe("Selecione apenas um arquivo.");
    mount({ maxFiles: 3 }); choose(png("a.png"), png("b.png"), png("c.png"), png("d.png"));
    expect(alertText()).toBe("Selecione no máximo 3 arquivos.");
  });
  it("tipos aceitos NÃO mudaram (jpeg, png, webp, pdf)", () => {
    expect([...ALLOWED_CONTENT_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
    mount();
    for (const t of ALLOWED_CONTENT_TYPES) { choose(new File(["x"], `f.${t.split("/")[1]}`, { type: t })); expect(alertText()).toBeNull(); }
    expect(picked).toHaveLength(4);
  });
  it("recuperação: depois do erro, uma nova seleção válida limpa o aviso e envia o arquivo", () => {
    mount();
    choose(new File(["x"], "nota.txt", { type: "text/plain" })); expect(alertText()).not.toBeNull();
    choose(png("ok.png")); expect(alertText()).toBeNull(); expect(picked).toHaveLength(1);
  });
  it("o botão de fechar o aviso fecha (rotulado em português) e o aviso é role=alert", () => {
    mount(); choose(new File(["x"], "nota.txt", { type: "text/plain" }));
    const alert = host.querySelector('[role="alert"]')!; expect(alert).toBeTruthy();
    const btn = alert.querySelector("button")!; expect(btn.getAttribute("aria-label")).toBe("Fechar aviso de erro");
    act(() => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("nenhum texto em inglês na interface do componente (título, rótulo do campo, erros)", () => {
    mount({ maxFiles: 2 });
    expect(host.textContent).not.toMatch(INGLES);
    expect(host.querySelector("input")!.getAttribute("aria-label")).toBe("Enviar arquivo");
    choose(png("a.png"), png("b.png"), png("c.png")); expect(host.textContent).not.toMatch(INGLES);
    choose(new File(["x"], "n.txt", { type: "text/plain" })); expect(host.textContent).not.toMatch(INGLES);
    choose(png("g.png", FILE_MAX_SIZE_BYTES + 1)); expect(host.textContent).not.toMatch(INGLES);
  });
  it("arrastar: dragenter marca o estado e dragleave o desfaz (comportamento preservado)", () => {
    mount();
    const label = host.querySelector("label")!; const dragging = () => /dragging/.test(label.className);
    expect(dragging()).toBe(false);
    act(() => { label.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true })); }); expect(dragging()).toBe(true);
    act(() => { label.dispatchEvent(new Event("dragleave", { bubbles: true, cancelable: true })); }); expect(dragging()).toBe(false);
  });
  it("desabilitado (enviando): a dropzone ignora seleção e arrasto", () => {
    mount({ disabled: true, title: "Enviando..." });
    const label = host.querySelector("label")!;
    act(() => { label.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true })); });
    expect(/dragging/.test(label.className)).toBe(false);
    expect(host.querySelector("input")!.disabled).toBe(true);
    expect(host.textContent).toContain("Enviando...");
  });
});

describe("postFilesUpload — falhas de rede e de HTTP em pt-BR (R9)", () => {
  const body = { organizationId: 1, purpose: "comprovante_entrega" as const, fileName: "a.png", contentType: "image/png" as const, fileBase64: "AAAA" };
  const resp = (status: number, text: string) => ({ ok: status >= 200 && status < 300, status, text: async () => text }) as unknown as Response;

  it("falha de rede (TypeError do fetch): texto de conexão em português, sem 'Failed to fetch'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await postFilesUpload(body).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Não foi possível enviar o arquivo. Verifique sua conexão e tente novamente.");
    expect((err as Error).message).toBe(UPLOAD_NETWORK_ERROR_MESSAGE);
    expect((err as Error).message).not.toMatch(INGLES);
  });
  it("cancelamento deliberado (AbortError) NÃO é reescrito como falha de conexão", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
    const err = await postFilesUpload(body).catch((e) => e);
    expect(err.name).toBe("AbortError");
  });
  it("erro do servidor (5xx): mensagem genérica em português; o texto técnico do corpo não vaza", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(500, superjson.stringify({ message: "ECONNREFUSED 10.0.0.1:5432 select * from files" }))));
    const err = await postFilesUpload(body).catch((e) => e as Error);
    expect((err as Error).message).toBe("Não foi possível concluir o envio. Tente novamente mais tarde.");
    expect((err as Error).message).toBe(UPLOAD_SERVER_ERROR_MESSAGE);
    expect((err as Error).message).not.toMatch(/ECONNREFUSED|select/i);
  });
  it("recusa do servidor (4xx): preserva a mensagem pública em português escolhida pelo endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(400, superjson.stringify({ message: "O conteúdo do arquivo não corresponde ao tipo informado" }))));
    const err = await postFilesUpload(body).catch((e) => e as Error);
    expect((err as Error).message).toBe("O conteúdo do arquivo não corresponde ao tipo informado");
  });
  it("corpo de erro que não é JSON (proxy/HTML): mensagem genérica em português, sem SyntaxError bruto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(502, "<html>Bad Gateway</html>")));
    const err = await postFilesUpload(body).catch((e) => e as Error);
    expect((err as Error).message).toBe(UPLOAD_SERVER_ERROR_MESSAGE);
    vi.stubGlobal("fetch", vi.fn(async () => resp(400, "")));
    const err2 = await postFilesUpload(body).catch((e) => e as Error);
    expect((err2 as Error).message).toBe(UPLOAD_SERVER_ERROR_MESSAGE);
  });
  it("sucesso continua sendo sucesso (contrato de saída intacto) e a requisição mantém método, credenciais e cabeçalho", async () => {
    const out = { file: { id: 7, originalFilename: "a.png" } };
    const f = vi.fn(async () => resp(200, superjson.stringify(out)));
    vi.stubGlobal("fetch", f);
    const r = await postFilesUpload(body);
    expect((r as unknown as typeof out).file.id).toBe(7);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/_api/v1/files-upload"); expect(init.method).toBe("POST"); expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
