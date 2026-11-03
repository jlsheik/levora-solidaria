// Autoteste do detector: cada MUTAÇÃO injeta, SÓ NO NAVEGADOR (nunca no CSS de produção), uma regressão conhecida e exige que o cenário
// correspondente falhe. As SENTINELAS exigem que o detector diferencie "elemento ausente" (MISSING) e "estado impossível" (UNMEASURABLE).
// `viewports` (larguras) padrão = [1280]; as mutações de layout responsivo usam larguras de telefone/tablet.
import { SCENARIOS } from "./scenarios.mjs";

export const MUTATIONS = [
  { id: "ghost-icone-preto-no-escuro", describe: "ícone ghost volta a herdar o preto do navegador no tema escuro", css: '.dark [class*="_ghost_"]{color:#000 !important}', scenarios: ["needs-ghost-edit-icon"], theme: "dark", state: "normal" },
  { id: "primary-hover-clareia-no-claro", describe: "hover do primary clareia o fundo (aproxima do texto claro)", css: '[class*="_primary_"]:hover{background-color:color-mix(in srgb,var(--primary) 55%,#fff) !important}', scenarios: ["needs-primary-new"], theme: "light", state: "hover" },
  { id: "destructive-hover-escurece-no-escuro", describe: "hover do destructive escurece o fundo no tema escuro", css: '.dark [class*="_destructive_"]:hover{background-color:color-mix(in srgb,var(--error) 70%,#000) !important}', scenarios: ["matching-destructive-confirm"], theme: "dark", state: "hover" },
  { id: "outline-hover-mistura-com-claro", describe: "hover do outline volta à mistura com cor clara sobre tinta forte", css: '[class*="_outline_"]:hover{color:color-mix(in srgb,var(--primary) 90%,#fff) !important;background-color:color-mix(in srgb,var(--primary) 20%,var(--background)) !important}', scenarios: ["needs-edit-dialog-cancel"], state: "hover" },
  { id: "switch-trilho-muted", describe: "trilho desligado do Switch volta ao --muted", css: '[role="switch"][data-state="unchecked"]{background-color:var(--muted) !important}', scenarios: ["matching-switch"], state: "off", target: "trilho" },
  { id: "campo-borda-subtil", describe: "borda do campo volta ao --border", css: "input,textarea{border-color:var(--border) !important}", scenarios: ["login-field-border-sizing"], target: "borda" },
  { id: "campo-content-box", describe: "campo volta a content-box (estoura o contêiner)", css: "input,textarea{box-sizing:content-box !important}", scenarios: ["login-field-border-sizing"], target: "largura" },
  { id: "erro-escuro-4-07", describe: "texto de erro volta ao --error no tema escuro", css: '.dark [class*="_formMessage_"]{color:hsl(4,68%,58%) !important}', scenarios: ["login-error-text"], theme: "dark" },
  // ---- responsivo / componentes acrescentados
  { id: "campo-estoura-o-contêiner-em-375", describe: "campo mais largo que o contêiner no telefone (375)", css: "input{width:130% !important}", scenarios: ["login-field-border-sizing"], viewports: [375], target: "mais largo" }, // no telefone o navegador móvel encolhe a página: vira "conteúdo mais largo que o viewport"
  { id: "pagina-com-rolagem-horizontal-em-375", describe: "página força rolagem horizontal no telefone (375)", css: "body{min-width:700px !important}", scenarios: ["login-field-border-sizing"], viewports: [375], target: "mais largo" },
  { id: "delta-negativo-preto-no-escuro", describe: "variação negativa do inventário perde a cor legível no escuro", css: '.dark [class*="_deltaNegative_"]{color:#000 !important}', scenarios: ["inventory-delta-negative"], theme: "dark", viewports: [390] },
  { id: "delta-negativo-sem-sinal", describe: "variação negativa sem o sinal (dependeria só da cor)", js: "document.querySelectorAll('[class*=_deltaNegative_]').forEach((e) => { if (e.textContent.startsWith('-')) e.textContent = e.textContent.slice(1); });", scenarios: ["inventory-delta-negative"], viewports: [390] },
  { id: "dropzone-sem-foco", describe: "contêiner do FileDropzone sem indicador de foco por teclado", css: 'label[class*="_dropzone_"]:focus-within{box-shadow:none !important;outline:none !important}', scenarios: ["dropzone-keyboard-focus"], viewports: [768] },
  { id: "dropzone-erro-no-escuro-ilegivel", describe: "texto de erro do FileDropzone volta a cor de baixo contraste no escuro", css: '.dark [class*="_error_"] span{color:#5a3b36 !important}', scenarios: ["dropzone-error-text"], theme: "dark", viewports: [375] },
];

const base = SCENARIOS.find((s) => s.id === "needs-primary-new");
export const SENTINELS = [
  { id: "elemento-ausente", describe: "seletor que não existe deve ser MISSING (não PASS nem erro)", expect: "MISSING", scenario: { ...base, id: "__sentinela-ausente", target: { css: "#nao-existe-qa-visual" }, states: ["normal"] } },
  { id: "estado-impossivel", describe: "hover num botão desabilitado (pointer-events: none) deve ser UNMEASURABLE", expect: "UNMEASURABLE", scenario: { id: "__sentinela-estado", user: "owner", path: "/organizacoes/1", steps: [], target: { css: 'button[class*="_outline_"]', text: "^Sair da organização" }, measure: "button", variant: "sentinela", states: ["hover"] } },
  { id: "sessao-indisponivel", describe: "consulta de sessão falhando: a rota protegida termina em /login e o resultado é UNMEASURABLE (não 'elemento ausente' na página sob teste)", expect: "UNMEASURABLE", scenario: { id: "__sentinela-sessao", user: "owner", path: "/organizacoes/1/unidades", steps: [], blockUrls: ["*/_api/v1/auth/session*"], target: { css: "select#filtro-classe" }, measure: "field", variant: "sentinela", expect: { height: 40 } } },
];
