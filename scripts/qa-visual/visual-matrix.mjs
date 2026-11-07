// Matriz VISUAL explícita e reproduzível (M02): páginas críticas × {375x812 mobile, 1280x900 desktop} × {claro, escuro} × navegador (Chrome, Edge).
// Cada página reutiliza rota, usuário, passos e elemento-âncora de um cenário FUNCIONAL existente (não duplica nem substitui os 80 cenários / 1.280 células do qa:visual):
// a âncora prova que a página montou antes de capturar. 14 páginas × 2 viewports × 2 temas × 2 navegadores = 112 imagens: cobertura de layout sem milhares de capturas redundantes.
//
// Tolerância: padrão 0/0 (ver lib/imagediff.mjs). Qualquer folga ou máscara por página exige JUSTIFICATIVA aqui (campo `why`). Hoje não há nenhuma: as páginas são determinísticas
// com os dados semeados; se um dado dinâmico aparecer, a máscara entra AQUI, com motivo, e não como tolerância global.
import { SCENARIOS } from "./scenarios.mjs";
import { VIEWPORTS } from "./lib/viewport.mjs";
import { withNoiseRegions } from "./visual-noise-regions.mjs";

export const VISUAL_VIEWPORTS = Object.freeze([VIEWPORTS.find((v) => v.w === 375), VIEWPORTS.find((v) => v.w === 1280)]);

function fromScenario(pageId, scenarioId, extra = {}) {
  const s = SCENARIOS.find((x) => x.id === scenarioId);
  if (!s) throw new Error(`matriz visual cita um cenário inexistente: ${scenarioId}`);
  return { id: pageId, path: s.path, user: s.user, steps: s.steps ?? [], target: s.target, fromScenario: scenarioId, ...extra };
}

export const VISUAL_PAGES = Object.freeze([
  fromScenario("login", "login-primary-submit"),
  fromScenario("login-erro", "login-error-text"),
  fromScenario("org-inicio", "org-outline-rename"),
  fromScenario("necessidades", "needs-primary-new"),
  // diálogo: o fundo escurecido é `100vh`; numa captura de página inteira ele cobriria só os primeiros 900px e não representaria o que a pessoa vê → captura do VIEWPORT
  fromScenario("necessidades-dialogo-editar", "needs-edit-dialog-title", { capture: { fullPage: false }, captureNote: "diálogo modal: captura só do viewport (o backdrop é 100vh)" }),
  fromScenario("inventario", "inventory-secondary-movement"),
  fromScenario("matching", "matching-switch"),
  fromScenario("unidades", "units-badge-canonical"),
  fromScenario("unidades-vazio", "units-empty"),
  fromScenario("regularizacao", "regularization-status-open"),
  fromScenario("destinacoes", "destinations-filter-basis"),
  fromScenario("destinacoes-erro-periodo", "destinations-range-error"),
  fromScenario("prestacao-contas", "report-destination-basis"),
  fromScenario("atribuicoes-dropzone", "dropzone-title", { capture: { fullPage: false }, captureNote: "diálogo modal (F08 da M03): captura só do viewport; em página inteira o overlay fixed cobria só os primeiros 100vh no mobile" }),
].map(withNoiseRegions));

export const VISUAL_THEMES = Object.freeze(["light", "dark"]);

/** Seleção por --pages a,b,c (erro se alguma não existir). */
export function selectPages(list, text) {
  if (!text) return [...list];
  const ids = text.split(",").map((s) => s.trim()).filter(Boolean); const out = [];
  for (const id of ids) { const p = list.find((x) => x.id === id); if (!p) throw new Error(`página visual desconhecida: ${id} (use ${list.map((x) => x.id).join(", ")})`); out.push(p); }
  return out;
}
