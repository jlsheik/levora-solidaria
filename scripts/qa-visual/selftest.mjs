// Autoteste do detector: cada MUTAÇÃO injeta, SÓ NO NAVEGADOR (nunca no CSS de produção), uma regressão conhecida e exige que o cenário
// correspondente falhe. As SENTINELAS exigem que o detector diferencie "elemento ausente" (MISSING) e "estado impossível" (UNMEASURABLE).
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
];

const base = SCENARIOS.find((s) => s.id === "needs-primary-new");
export const SENTINELS = [
  { id: "elemento-ausente", describe: "seletor que não existe deve ser MISSING (não PASS nem erro)", expect: "MISSING", scenario: { ...base, id: "__sentinela-ausente", target: { css: "#nao-existe-qa-visual" }, states: ["normal"] } },
  { id: "estado-impossivel", describe: "hover num botão desabilitado (pointer-events: none) deve ser UNMEASURABLE", expect: "UNMEASURABLE", scenario: { id: "__sentinela-estado", user: "owner", path: "/organizacoes/1", steps: [], target: { css: 'button[class*="_outline_"]', text: "^Sair da organização" }, measure: "button", variant: "sentinela", states: ["hover"] } },
];
