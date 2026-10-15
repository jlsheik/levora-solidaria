// Cenários da verificação visual: DADOS (o que renderizar, como chegar, o que medir). Os critérios numéricos estão em lib/contrast.mjs.
//
// Campos de um cenário:
//   id        identificador estável (aparece no relatório; os testes exigem a cobertura mínima abaixo)
//   user      guest | owner | volunteer   (guest = sem login)
//   path      rota real da aplicação
//   steps     ações reais antes de medir:
//               { click: { css, text?, within? } }                       (o passo precisa achar o elemento, senão MISSING)
//               { setFile: { css, within?, fileName, content } }         (envia um arquivo SINTÉTICO ao <input type=file> pelo CDP)
//   target    { css, text?, within?, index? }  elemento medido (texto = regex sobre o texto/aria-label)
//   measure   button | switch | field | errorText | text | boundary | dropzoneFocus
//   variant   rótulo da variante/componente avaliado (relatório)
//   states    (button) normal | hover | active | focus ;  (switch) off | off-focus | on | on-focus | disabled
//   info      true = componente desabilitado: mede e registra, sem aplicar limite (WCAG 1.4.3 isenta componentes inativos)
//   kind      (text) text (padrão) | icon — critério aplicado ao par cor × fundo
//   sign      (text) regex que o TEXTO deve satisfazer (o indicador não pode depender só da cor)
//   bgToken   (text) variável CSS usada como fundo quando o fundo é um gradiente (ex.: "--surface" no FileDropzone)
//   expect    (field) { height?: número exato (px) , minHeight?: número }
//   blockUrls (opcional) padrões de URL que o navegador NÃO consegue buscar durante o cenário (produz o estado de erro de carregamento real)
//             passos { select: { css, value } } e { type: { css, text } } preenchem um <select>/<input> existente (filtros)
//   viewports (opcional) subconjunto de VIEWPORTS (padrão: todos)
//
// Toda combinação cenário × viewport × tema também recebe duas verificações de CONTENÇÃO: sem rolagem horizontal da página e, com diálogo
// aberto, diálogo dentro do viewport e sem rolagem horizontal interna.

export { VIEWPORTS } from "./lib/viewport.mjs";
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
const INVENTORY = "/organizacoes/1/inventario";
const ATTRIBUTIONS = "/organizacoes/1/atribuicoes";
// Fase 99B: diagnóstico de unidades. A organização 1 tem valores canônicos, alias, ambíguos, desconhecidos e ausentes; a 2 (do mesmo dono) não tem nenhum.
const UNITS = "/organizacoes/1/unidades";
const UNITS_EMPTY = "/organizacoes/2/unidades";
// Fase 99C: fila de pendências de unidade. A organização 1 tem um caso aberto (oferta em caixa × item em kg); a 2 não tem nenhum.
const REGULARIZATION = "/organizacoes/1/regularizacao";
const REGULARIZATION_EMPTY = "/organizacoes/2/regularizacao";
const openConfer = { click: { css: "button", text: "^Conferir quantidade" } };
// Fase 99E: diálogo de registro de saída com destinação (inventário). O saldo semeado do primeiro item é pequeno: 9999 é "saldo insuficiente".
const openDestination = { click: { css: "button", text: "^Registrar destinação" } };
const inDialog = (css) => ({ css, within: '[role="dialog"]' });
const editNeed = { click: { css: 'button[class*="_ghost_"]', text: "^Editar a necessidade" } };
const openReceive = { click: { css: "button", text: "^Registrar recebimento direto" } };
// arquivo sintético que o FileDropzone RECUSA (a lista aceita é image/jpeg, image/png, image/webp): provoca o estado de erro real
const badFile = { setFile: { css: 'input[type="file"]', within: '[role="dialog"]', fileName: "arquivo-invalido-qa.txt", content: "conteúdo sintético que não é imagem" } };
const dropzone = { css: 'label[class*="_dropzone_"]', within: '[role="dialog"]' };

/**
 * Perfil reduzido do CI (`--profile ci`): 18 dos 27 cenários, escolhidos por RISCO — uma ou mais variantes de cada família de componente em que já houve
 * regressão real (botões primary/outline/ghost/destructive/secondary e o desabilitado, Switch ligado/desligado/desabilitado, Input/Textarea/Select, texto e
 * borda de erro, FileDropzone borda/foco/erro, variação negativa do inventário). Omitidos (9): variantes redundantes da mesma família (campo de senha, "Nova
 * necessidade", título do diálogo, renomear, ícone de excluir, variação positiva, ícone de saída, título/subtítulo do dropzone, limpar erro). Cada cenário
 * escolhido roda nos 4 viewports e nos 2 temas. O que não está aqui NÃO é aprovado: aparece como omitido no relatório.
 */
export const CI_PROFILE_IDS = [
  "login-field-border-sizing", "login-primary-submit", "login-error-text", "login-error-label",
  "needs-ghost-edit-icon", "needs-edit-dialog-cancel", "needs-edit-dialog-description", "needs-edit-dialog-priority",
  "org-outline-leave-disabled", "matching-destructive-confirm", "matching-switch", "matching-switch-disabled",
  "inventory-secondary-movement", "inventory-delta-negative",
  "dropzone-border", "dropzone-keyboard-focus", "dropzone-error-text", "needs-primary-new",
  // Fase 99B: tela de diagnóstico de unidades (classificadas, desconhecidas/ambíguas, vazio, erro, filtros; os 4 viewports incluem o móvel)
  // Fase 99C: fila de pendências de unidade (caso aberto, vazio, erro, filtros, diálogo de conferência, aviso na atribuição)
  "regularization-status-open", "regularization-empty", "regularization-error", "regularization-filter-select", "regularization-filter-no-results", "regularization-confer-qty", "regularization-confer-reason", "regularization-allocation-notice",
  // Fase 99E: registro de saída com destinação (botão, campos, finalidades, saldo insuficiente, aprovação por risco, necessidade)
  "destination-primary-button", "destination-qty", "destination-type-select", "destination-notes", "destination-insufficient", "destination-approval-notice", "destination-need-select",
  "units-badge-canonical", "units-badge-unknown", "units-badge-ambiguous", "units-empty", "units-error", "units-filter-select", "units-filter-input", "units-filtered-unknown", "units-filter-no-results", "units-inventory-pending-marker",
];

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
  { id: "inventory-secondary-movement", user: "owner", path: INVENTORY, steps: [], target: { css: 'button[class*="_secondary_"]', text: "^Entrada ou ajuste" }, measure: "button", variant: "secondary", states: ALL4 },

  // ---- inventário: variação de estoque (saída de 1 kg semeada) — sinal, cor e contenção
  { id: "inventory-delta-negative", user: "owner", path: INVENTORY, steps: [], target: { css: '[class*="_deltaNegative_"]' }, measure: "text", variant: "Inventário: variação negativa", sign: "^[-−]\\s?\\d" },
  { id: "inventory-delta-positive", user: "owner", path: INVENTORY, steps: [], target: { css: '[class*="_deltaPositive_"]' }, measure: "text", variant: "Inventário: variação positiva", sign: "^\\+\\s?\\d" },
  { id: "inventory-delta-icon-out", user: "owner", path: INVENTORY, steps: [], target: { css: 'svg[class*="_iconOut_"]' }, measure: "text", kind: "icon", variant: "Inventário: ícone de saída" },

  // ---- FileDropzone (no diálogo "Registrar recebimento"): estado normal e erro real de arquivo inválido
  { id: "dropzone-title", user: "owner", path: ATTRIBUTIONS, steps: [openReceive], target: { css: '[class*="_title_"]', within: '[role="dialog"]' }, measure: "text", bgToken: "--surface", variant: "FileDropzone: título" },
  { id: "dropzone-subtitle", user: "owner", path: ATTRIBUTIONS, steps: [openReceive], target: { css: '[class*="_subtitle_"]', within: '[role="dialog"]' }, measure: "text", bgToken: "--surface", variant: "FileDropzone: subtítulo" },
  { id: "dropzone-border", user: "owner", path: ATTRIBUTIONS, steps: [openReceive], target: dropzone, measure: "boundary", variant: "FileDropzone: limite" },
  { id: "dropzone-keyboard-focus", user: "owner", path: ATTRIBUTIONS, steps: [openReceive], target: dropzone, measure: "dropzoneFocus", variant: "FileDropzone: foco por teclado" },
  { id: "dropzone-error-text", user: "owner", path: ATTRIBUTIONS, steps: [openReceive, badFile], target: { css: '[role="alert"] span', within: '[role="dialog"]' }, measure: "text", variant: "FileDropzone: erro" },
  { id: "dropzone-error-clear", user: "owner", path: ATTRIBUTIONS, steps: [openReceive, badFile], target: { css: 'button[aria-label="Clear error"]', within: '[role="dialog"]' }, measure: "button", variant: "ghost (ícone)", states: ALL4 },

  // ---- Fase 99B: diagnóstico de unidades (somente leitura). Cada estado exigido pela especificação tem seu cenário.
  { id: "units-badge-canonical", user: "owner", path: UNITS, steps: [], target: { css: 'td [data-kind="canonica"]', text: "^Canônica" }, measure: "text", variant: "Unidades: classificadas" },
  { id: "units-badge-unknown", user: "owner", path: UNITS, steps: [], target: { css: 'td [data-kind="desconhecida"]', text: "^Desconhecida" }, measure: "text", variant: "Unidades: desconhecidas" },
  { id: "units-badge-ambiguous", user: "owner", path: UNITS, steps: [], target: { css: 'td [data-kind="ambigua"]', text: "^Ambígua" }, measure: "text", variant: "Unidades: ambíguas" },
  { id: "units-empty", user: "owner", path: UNITS_EMPTY, steps: [], target: { css: 'p[role="status"]', text: "^Esta organização ainda não tem nenhum valor" }, measure: "text", variant: "Unidades: lista vazia" },
  { id: "units-error", user: "owner", path: UNITS, steps: [], blockUrls: ["*/_api/v1/unit-inventory*"], target: { css: '[role="alert"] p', text: "^Não foi possível carregar o diagnóstico" }, measure: "text", variant: "Unidades: erro de carregamento" },
  { id: "units-filter-select", user: "owner", path: UNITS, steps: [], target: { css: "select#filtro-classe" }, measure: "field", variant: "Unidades: filtro (select)", expect: { height: 40 } },
  { id: "units-filter-input", user: "owner", path: UNITS, steps: [], target: { css: "input#filtro-valor" }, measure: "field", variant: "Unidades: filtro (busca)", expect: { height: 40 } },
  { id: "units-filtered-unknown", user: "owner", path: UNITS, steps: [{ select: { css: "select#filtro-classe", value: "desconhecida" } }], target: { css: 'td [data-kind="desconhecida"]', text: "^Desconhecida" }, measure: "text", variant: "Unidades: filtros aplicados" },
  { id: "units-filter-no-results", user: "owner", path: UNITS, steps: [{ type: { css: "input#filtro-valor", text: "zzz-sem-resultado" } }], target: { css: 'p[role="status"]', text: "^Nenhum valor corresponde" }, measure: "text", variant: "Unidades: filtros sem resultado" },
  { id: "units-inventory-pending-marker", user: "owner", path: INVENTORY, steps: [], target: { css: 'span[class*="_pending_"]', text: "a classificar" }, measure: "text", variant: "Inventário: unidade a classificar" },

  // ---- Fase 99C: fila de pendências de unidade (regularização do recebimento). Estados: caso aberto, lista vazia, erro de carregamento, filtros, diálogo e aviso na atribuição.
  { id: "regularization-status-open", user: "owner", path: REGULARIZATION, steps: [], target: { css: '[data-status="aberto"]', text: "^Aberto" }, measure: "text", variant: "Regularização: caso aberto" },
  { id: "regularization-empty", user: "owner", path: REGULARIZATION_EMPTY, steps: [], target: { css: 'p[role="status"]', text: "^Nenhuma pendência de unidade em aberto" }, measure: "text", variant: "Regularização: lista vazia" },
  { id: "regularization-error", user: "owner", path: REGULARIZATION, steps: [], blockUrls: ["*/_api/v1/unit-regularization-cases*"], target: { css: '[role="alert"] p', text: "^Não foi possível carregar as pendências de unidade" }, measure: "text", variant: "Regularização: erro de carregamento" },
  { id: "regularization-filter-select", user: "owner", path: REGULARIZATION, steps: [], target: { css: "select#reg-status" }, measure: "field", variant: "Regularização: filtro (select)", expect: { height: 40 } },
  { id: "regularization-filter-no-results", user: "owner", path: REGULARIZATION, steps: [{ select: { css: "select#reg-status", value: "encerrado" } }], target: { css: 'p[role="status"]', text: "^Nenhum caso corresponde" }, measure: "text", variant: "Regularização: filtros sem resultado" },
  { id: "regularization-confer-qty", user: "owner", path: REGULARIZATION, steps: [openConfer], target: { css: "input#reg-qty", within: '[role="dialog"]' }, measure: "field", variant: "Regularização: diálogo (quantidade)", expect: { height: 40 } },
  { id: "regularization-confer-reason", user: "owner", path: REGULARIZATION, steps: [openConfer], target: { css: "textarea#reg-reason", within: '[role="dialog"]' }, measure: "field", variant: "Regularização: diálogo (motivo)", expect: { minHeight: 96 } },
  { id: "regularization-allocation-notice", user: "owner", path: ATTRIBUTIONS, steps: [], target: { css: 'p[role="status"]', text: "^Recebimento pendente de regularização" }, measure: "text", variant: "Regularização: aviso na atribuição" },

  // ---- Fase 99E: registro de saída com destinação (o servidor é a autoridade; aqui só a interface renderizada)
  { id: "destination-primary-button", user: "owner", path: INVENTORY, steps: [], target: { css: 'button[class*="_primary_"]', text: "^Registrar destinação" }, measure: "button", variant: "Destinação: botão primário", states: ALL4 },
  { id: "destination-qty", user: "owner", path: INVENTORY, steps: [openDestination], target: inDialog("input#dest-qty"), measure: "field", variant: "Destinação: quantidade", expect: { height: 40 } },
  { id: "destination-type-select", user: "owner", path: INVENTORY, steps: [openDestination], target: inDialog("select#dest-type"), measure: "field", variant: "Destinação: finalidade", expect: { height: 40 } },
  { id: "destination-notes", user: "owner", path: INVENTORY, steps: [openDestination], target: inDialog("textarea#dest-notes"), measure: "field", variant: "Destinação: observações", expect: { minHeight: 96 } },
  { id: "destination-insufficient", user: "owner", path: INVENTORY, steps: [openDestination, { type: { css: "input#dest-qty", text: "9999" } }], target: { css: "#dest-problems li", text: "^Saldo insuficiente", within: '[role="dialog"]' }, measure: "text", variant: "Destinação: saldo insuficiente" },
  { id: "destination-approval-notice", user: "owner", path: INVENTORY, steps: [openDestination, { type: { css: "input#dest-qty", text: "1" } }, { select: { css: "select#dest-type", value: "perda" } }], target: { css: 'p[role="status"]', text: "^Exige segunda aprovação", within: '[role="dialog"]' }, measure: "text", variant: "Destinação: aprovação pendente" },
  { id: "destination-need-select", user: "owner", path: INVENTORY, steps: [openDestination, { select: { css: "select#dest-type", value: "distribuicao_familias" } }], target: inDialog("select#dest-need"), measure: "field", variant: "Destinação: necessidade", expect: { height: 40 } },

  // ---- voluntário: Switch desabilitado
  { id: "matching-switch-disabled", user: "volunteer", path: MATCHING, steps: [], target: { css: '[role="switch"]' }, measure: "switch", variant: "Switch (desabilitado)", states: ["disabled"], info: true },
];

/** Cobertura mínima que os testes exigem (variantes e tokens protegidos). */
export const REQUIRED_COVERAGE = ["ghost (ícone)", "primary", "destructive", "outline", "Switch", "--error-text (mensagem)", "--error-text (rótulo)", "Input", "Textarea", "Select (gatilho)", "Inventário: variação negativa", "FileDropzone: erro", "FileDropzone: foco por teclado"];
