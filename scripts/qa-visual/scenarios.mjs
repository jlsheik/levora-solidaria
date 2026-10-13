// Cenários da verificação visual: DADOS (o que renderizar, como chegar, o que medir). Os critérios numéricos estão em lib/contrast.mjs.
//
// Campos de um cenário:
//   id        identificador estável (aparece no relatório; os testes exigem a cobertura mínima abaixo)
//   user      guest | owner | volunteer   (guest = sem login)
//   path      rota real da aplicação
//   steps     ações reais antes de medir: { click: { css, text?, within? } }  (o passo precisa achar o elemento, senão MISSING)
//   target    { css, text?, within?, index? }  elemento medido (texto = regex sobre o texto/aria-label)
//   measure   button | switch | field | errorText
//   variant   rótulo da variante/componente avaliado (relatório)
//   states    (button) normal | hover | active | focus ;  (switch) off | off-focus | on | on-focus | disabled
//   info      true = componente desabilitado: mede e registra, sem aplicar limite (WCAG 1.4.3 isenta componentes inativos)
//   expect    (field) { height?: número exato (px) , minHeight?: número }

export const THEMES = ["light", "dark"];

export const USERS = {
  owner: { email: "dono@qa.example" },
  volunteer: { email: "voluntario@qa.example" },
};
/** Senha dos usuários sintéticos do banco descartável de QA (a semente usa a mesma, via variável de ambiente). */
export const QA_PASSWORD = "senha-de-qa-123";

const ALL4 = ["normal", "hover", "active", "focus"];
const NEEDS = "/organizacoes/1/necessidades";
const MATCHING = "/organizacoes/1/matching";
const editNeed = { click: { css: 'button[class*="_ghost_"]', text: "^Editar a necessidade" } };

export const SCENARIOS = [
  // ---- sem login: tokens de campo e de erro renderizados de verdade
  { id: "login-field-border-sizing", user: "guest", path: "/login", steps: [], target: { css: 'input[type="email"]' }, measure: "field", variant: "Input", expect: { height: 40 } },
  { id: "login-password-field", user: "guest", path: "/login", steps: [], target: { css: 'input[type="password"]' }, measure: "field", variant: "Input", expect: { height: 40 } },
  { id: "login-primary-submit", user: "guest", path: "/login", steps: [], target: { css: 'button[type="submit"][class*="_primary_"]' }, measure: "button", variant: "primary", states: ALL4 },
  { id: "login-error-text", user: "guest", path: "/login", steps: [{ click: { css: 'button[type="submit"]' } }], target: { css: '[class*="_formMessage_"]' }, measure: "errorText", variant: "--error-text (mensagem)" },
  { id: "login-error-label", user: "guest", path: "/login", steps: [{ click: { css: 'button[type="submit"]' } }], target: { css: '[class*="_formLabel_"][class*="_error_"]' }, measure: "errorText", variant: "--error-text (rótulo)" },

  // ---- dono: botões (ghost, primary, outline, destructive, secondary) e campos
  { id: "needs-primary-new", user: "owner", path: NEEDS, steps: [], target: { css: 'button[class*="_primary_"]', text: "^Nova necessidade" }, measure: "button", variant: "primary", states: ALL4 },
  { id: "needs-ghost-edit-icon", user: "owner", path: NEEDS, steps: [], target: { css: 'button[class*="_ghost_"]', text: "^Editar a necessidade" }, measure: "button", variant: "ghost (ícone)", states: ALL4 },
  { id: "needs-edit-dialog-cancel", user: "owner", path: NEEDS, steps: [editNeed], target: { css: 'button[class*="_outline_"]', text: "^Cancelar", within: '[role="dialog"]' }, measure: "button", variant: "outline", states: ALL4 },
  { id: "needs-edit-dialog-title", user: "owner", path: NEEDS, steps: [editNeed], target: { css: "input", within: '[role="dialog"]' }, measure: "field", variant: "Input", expect: { height: 40 } },
  { id: "needs-edit-dialog-description", user: "owner", path: NEEDS, steps: [editNeed], target: { css: "textarea", within: '[role="dialog"]' }, measure: "field", variant: "Textarea", expect: { minHeight: 96 } },
  { id: "needs-edit-dialog-priority", user: "owner", path: NEEDS, steps: [editNeed], target: { css: 'button[role="combobox"]', within: '[role="dialog"]' }, measure: "field", variant: "Select (gatilho)", expect: { height: 40 } },
  { id: "org-outline-rename", user: "owner", path: "/organizacoes/1", steps: [], target: { css: 'button[class*="_outline_"]', text: "^Renomear organização" }, measure: "button", variant: "outline", states: ALL4 },
  { id: "org-outline-leave-disabled", user: "owner", path: "/organizacoes/1", steps: [], target: { css: 'button[class*="_outline_"]', text: "^Sair da organização" }, measure: "button", variant: "outline (desabilitado)", states: ["normal"], info: true },
  { id: "matching-ghost-delete-icon", user: "owner", path: MATCHING, steps: [], target: { css: 'button[class*="_ghost_"]', text: "^Excluir capacidade" }, measure: "button", variant: "ghost (ícone)", states: ALL4 },
  { id: "matching-destructive-confirm", user: "owner", path: MATCHING, steps: [{ click: { css: 'button[class*="_ghost_"]', text: "^Excluir capacidade" } }], target: { css: 'button[class*="_destructive_"]', text: "^Excluir", within: '[role="dialog"]' }, measure: "button", variant: "destructive", states: ALL4 },
  { id: "matching-switch", user: "owner", path: MATCHING, steps: [], target: { css: '[role="switch"]' }, measure: "switch", variant: "Switch", states: ["off", "off-focus", "on", "on-focus"] },
  { id: "inventory-secondary-movement", user: "owner", path: "/organizacoes/1/inventario", steps: [], target: { css: 'button[class*="_secondary_"]', text: "^Lançar movimentação" }, measure: "button", variant: "secondary", states: ALL4 },

  // ---- voluntário: Switch desabilitado
  { id: "matching-switch-disabled", user: "volunteer", path: MATCHING, steps: [], target: { css: '[role="switch"]' }, measure: "switch", variant: "Switch (desabilitado)", states: ["disabled"], info: true },
];

/** Cobertura mínima que os testes exigem (variantes e tokens protegidos). */
export const REQUIRED_COVERAGE = ["ghost (ícone)", "primary", "destructive", "outline", "Switch", "--error-text (mensagem)", "--error-text (rótulo)", "Input", "Textarea", "Select (gatilho)"];
