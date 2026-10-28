// @vitest-environment jsdom
/**
 * Componente `Form` (src/components/Form.tsx) em RUNTIME, num DOM real (jsdom) com React: erro → correção → submissão válida, caminho do campo,
 * mensagem pt-BR, estado visual inválido (aria-invalid) e acessibilidade (label/for, aria-describedby). Usa o schema REAL de `organizations_POST`.
 * Escrito contra o zod 3 e deve passar igual no zod 4; falha se `Form.tsx` voltar a depender de `ZodError.errors` (removido no zod 4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import { Form, FormControl, FormItem, FormLabel, FormMessage, useForm } from "../src/components/Form";
import { schema as organizationsSchema } from "../src/endpoints/organizations_POST.schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let latest: any;
let container: HTMLElement;
let root: Root;

type Values = Record<string, unknown>;
interface FieldForm { values: Values; setValues: (f: (v: Values) => Values) => void }

function Field({ name, form }: { name: string; form: FieldForm }) {
  const get = (o: unknown): unknown => name.split(".").reduce<unknown>((a, k) => (a == null ? a : (a as Values)[k]), o);
  const set = (value: string) => form.setValues((prev) => {
    const next = structuredClone(prev);
    const keys = name.split(".");
    let p = next as Values;
    for (const k of keys.slice(0, -1)) p = (p[k] ??= {}) as Values;
    p[keys[keys.length - 1]] = value;
    return next;
  });
  return h(FormItem, { name },
    h(FormLabel, null, `rótulo ${name}`),
    h(FormControl, null, h("input", { "data-name": name, value: (get(form.values) as string) ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value) })),
    h(FormMessage, { "data-msg": name } as React.HTMLAttributes<HTMLParagraphElement>),
  );
}

function Harness({ schema, fields, defaults, onSubmit }: { schema: z.ZodType; fields: string[]; defaults: Values; onSubmit: (d: unknown) => void }) {
  const form = useForm({ schema, defaultValues: defaults });
  latest = form;
  return h(Form, { ...form } as never,
    h("form", { onSubmit: form.handleSubmit(onSubmit), noValidate: true },
      ...fields.map((f) => h(Field, { key: f, name: f, form: form as unknown as FieldForm })),
      h("button", { type: "submit" }, "Enviar")));
}

const render = (props: React.ComponentProps<typeof Harness>) => act(() => { root.render(h(Harness, props)); });
const input = (name: string) => container.querySelector<HTMLInputElement>(`input[data-name="${name}"]`)!;
const msgOf = (name: string) => {
  const id = input(name).getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent ?? null : null;
};
const typeInto = (name: string, value: string) => act(() => {
  const el = input(name);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const blur = (name: string) => act(() => { input(name).focus(); input(name).blur(); });
const submit = () => act(() => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const allMessages = () => Array.from(container.querySelectorAll("p[data-msg]")).map((p) => p.textContent);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => undefined); // o hook registra "Form validation failed" de propósito
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const ORG_FIELDS = ["name", "type", "city", "state"];
const ORG_DEFAULTS = { name: "", city: "", state: "" }; // `type` começa ausente

describe("Form em runtime: schema real de organizations_POST", () => {
  it("formulário vazio: sem mensagens nem estado inválido antes de interagir", () => {
    render({ schema: organizationsSchema, fields: ORG_FIELDS, defaults: ORG_DEFAULTS, onSubmit: vi.fn() });
    expect(allMessages()).toEqual([]);
    for (const f of ORG_FIELDS) expect(input(f).getAttribute("aria-invalid")).toBe("false");
  });

  it("submissão vazia: NÃO envia; mostra as 4 mensagens pt-BR exatas, cada uma no campo certo, com aria-invalid/aria-describedby e label/for", () => {
    const onSubmit = vi.fn();
    render({ schema: organizationsSchema, fields: ORG_FIELDS, defaults: ORG_DEFAULTS, onSubmit });
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(msgOf("name")).toBe("Informe o nome da organização");
    expect(msgOf("type")).toBe("Selecione o tipo de organização");
    expect(msgOf("city")).toBe("Informe a cidade");
    expect(msgOf("state")).toBe("Use a sigla do estado, ex: MG");
    for (const f of ORG_FIELDS) {
      const el = input(f);
      expect(el.getAttribute("aria-invalid")).toBe("true");
      expect(container.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)?.textContent).toBe(`rótulo ${f}`);
      expect(el.getAttribute("aria-describedby")).toBe(`${el.id.replace(/-form-item$/, "")}-form-item-message`);
    }
    // nenhuma mensagem padrão em inglês do zod
    for (const m of allMessages()) expect(m).not.toMatch(/^(Expected|Required|Invalid|String must|Too (small|big))/);
  });

  it("erro único: só o campo com problema fica inválido", () => {
    render({ schema: organizationsSchema, fields: ORG_FIELDS, defaults: ORG_DEFAULTS, onSubmit: vi.fn() });
    typeInto("name", "Associação Teste"); typeInto("type", "igreja"); typeInto("city", "Contagem"); typeInto("state", "Minas");
    submit();
    expect(allMessages()).toEqual(["Use a sigla do estado, ex: MG"]);
    expect(input("state").getAttribute("aria-invalid")).toBe("true");
    expect(input("name").getAttribute("aria-invalid")).toBe("false");
    expect(input("name").hasAttribute("aria-describedby")).toBe(false);
  });

  it("correção: ao corrigir um campo e sair dele, só a mensagem DELE some; os outros erros permanecem", () => {
    render({ schema: organizationsSchema, fields: ORG_FIELDS, defaults: ORG_DEFAULTS, onSubmit: vi.fn() });
    submit();
    expect(allMessages()).toHaveLength(4);
    typeInto("name", "Associação Teste");
    blur("name");
    expect(msgOf("name")).toBeNull();
    expect(input("name").getAttribute("aria-invalid")).toBe("false");
    expect(input("name").hasAttribute("aria-describedby")).toBe(false);
    expect(msgOf("city")).toBe("Informe a cidade");
    expect(allMessages()).toHaveLength(3);
    // sair de um campo ainda inválido mantém a mensagem pt-BR
    blur("type");
    expect(msgOf("type")).toBe("Selecione o tipo de organização");
  });

  it("submissão válida depois de corrigir tudo: chama onSubmit uma vez com os valores digitados e limpa todas as mensagens", () => {
    const onSubmit = vi.fn();
    render({ schema: organizationsSchema, fields: ORG_FIELDS, defaults: ORG_DEFAULTS, onSubmit });
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    typeInto("name", "Associação Teste"); typeInto("type", "igreja"); typeInto("city", "Contagem"); typeInto("state", "mg");
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual({ name: "Associação Teste", type: "igreja", city: "Contagem", state: "mg" });
    expect(allMessages()).toEqual([]);
    for (const f of ORG_FIELDS) expect(input(f).getAttribute("aria-invalid")).toBe("false");
  });

  it("propriedade fora do schema: validateForm LANÇA Error (erro de programação), não vira mensagem de campo", () => {
    render({ schema: organizationsSchema, fields: ORG_FIELDS, defaults: { type: "igreja", name: "Aa", city: "Cc", state: "MG" }, onSubmit: vi.fn() });
    act(() => { latest.setValues((v: Values) => ({ ...v, campoQueNaoExiste: 1 })); });
    expect(() => act(() => { latest.validateForm(); })).toThrow(/Extra properties detected in form values:.*campoQueNaoExiste/);
  });
});

describe("Form em runtime: caminho aninhado e várias issues no mesmo campo", () => {
  it("caminho com ponto (a.b): a mensagem aparece no FormItem de nome 'a.b'", () => {
    const schema = z.object({ a: z.object({ b: z.string().min(1, "Campo obrigatório") }) });
    render({ schema, fields: ["a.b"], defaults: { a: { b: "" } }, onSubmit: vi.fn() });
    submit();
    expect(msgOf("a.b")).toBe("Campo obrigatório");
    typeInto("a.b", "ok"); blur("a.b");
    expect(msgOf("a.b")).toBeNull();
  });

  it("várias issues no MESMO campo: o formulário mostra uma só (a última); some quando o valor é válido", () => {
    const schema = z.object({ code: z.string().min(3, "muito curto").regex(/^\d+$/, "apenas dígitos") });
    render({ schema, fields: ["code"], defaults: { code: "a" }, onSubmit: vi.fn() });
    submit();
    expect(allMessages()).toEqual(["apenas dígitos"]);
    typeInto("code", "123"); blur("code");
    expect(msgOf("code")).toBeNull();
  });

  it("vários campos inválidos de uma vez aparecem juntos (múltiplas mensagens)", () => {
    const schema = z.object({ x: z.string().min(1, "X obrigatório"), y: z.string().min(1, "Y obrigatório") });
    render({ schema, fields: ["x", "y"], defaults: { x: "", y: "" }, onSubmit: vi.fn() });
    submit();
    expect(allMessages()).toEqual(["X obrigatório", "Y obrigatório"]);
  });
});
