// M09 (R9/R5): matriz FUNCIONAL da dropzone — mesmos mecanismos de captura (app real, navegador real, CDP), mas a evidência é o RESULTADO FUNCIONAL (asserções de texto/elementos
// avaliadas com a interface estável). As imagens desta matriz NÃO são candidatas a baseline (ficam só como prova de apoio, em pasta separada). Cobre o que as páginas visuais não cobrem:
// recuperação depois de erro, nova seleção depois de falha, saída do arrasto, arrasto de arquivo inválido e SOLTAR (drop) de arquivo inválido pelo gesto real do navegador.
// Uso: node scripts/qa-visual/run.mjs --visual capture --visual-only --visual-matrix scripts/qa-visual/visual-matrix-dropzone-func.mjs --visual-dir <dir> --visual-out <dir>
import { SCENARIOS } from "./scenarios.mjs";
import { VISUAL_THEMES, VISUAL_VIEWPORTS } from "./visual-matrix.mjs";
import { VIEWPORTS } from "./lib/viewport.mjs";
export { VISUAL_THEMES, VISUAL_VIEWPORTS };
export { selectPages } from "./visual-matrix.mjs";

const base = SCENARIOS.find((s) => s.id === "dropzone-title");
if (!base) throw new Error("cenário-base dropzone-title inexistente");
const DIALOG = '[role="dialog"]';
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const EN = ["Invalid file type", "File size exceeds", "Failed to fetch", "Click to upload", "Clear error", "Maximum [0-9]+ file", "Accepted types", "Up to [0-9]+ files"];
const open = { click: { css: "button", text: "^Registrar recebimento direto" } };
const bottom = { scrollEnd: { css: DIALOG } };
const input = { css: 'input[type="file"]', within: DIALOG };
const txt = { setFile: { ...input, fileName: "arquivo-invalido-qa.txt", content: "conteúdo sintético que não é imagem" } };
const png = { setFile: { ...input, fileName: "comprovante-sintetico-qa.png", contentBase64: PNG_1X1 } };
const ZONE = 'label[class*="_dropzone_"]';
const drag = (phase, fileName = "arrasto-sintetico-qa.png", extra = { contentBase64: PNG_1X1 }) => ({ dragFile: { css: ZONE, within: DIALOG, fileName, phase, ...extra } });
const page = (id, steps, a, extra = {}) => ({ id, path: base.path, user: base.user, steps, target: { css: DIALOG }, capture: { fullPage: false }, assert: { ...a, excludes: [...(a.excludes ?? []), ...EN] }, funcional: true, ...extra });

const NO_OVERLAP = { name: "nenhum toast sobrepõe o diálogo (conteúdo, dica, campo de link e rodapé) e o diálogo cabe na janela", js: `(() => { const d = document.querySelector('[role="dialog"]'); const toasts = [...document.querySelectorAll('[data-sonner-toast]')]; if (!d || !toasts.length) return false; const r = d.getBoundingClientRect(); const inView = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; return inView && toasts.every((t) => { const q = t.getBoundingClientRect(); return Math.min(r.right, q.right) <= Math.max(r.left, q.left) || Math.min(r.bottom, q.bottom) <= Math.max(r.top, q.top); }); })()` };
const LONG = "Não foi possível anexar o comprovante porque o arquivo enviado não pôde ser validado pelo servidor neste momento; confira o formato do documento, o tamanho do arquivo e a sua conexão e tente novamente em alguns instantes.";
function r10Pages() {
  const common = { viewports: VIEWPORTS, probe: "dropzone-interact" };
  const j = (message) => JSON.stringify({ json: { message } });
  return [
    page("func-r10-toast-sucesso", [open, png, { waitFor: { css: '[class*="_uploadedProof_"]', within: DIALOG } }, { waitFor: { css: "[data-sonner-toast]" } }, bottom], { includes: ["Comprovante enviado"], present: ["[data-sonner-toast]"], evalTrue: [NO_OVERLAP] }, common),
    page("func-r10-toast-erro-curto", [open, { block: ["*files-upload*"] }, png, { waitFor: { css: "[data-sonner-toast]" } }, bottom], { includes: ["Não foi possível enviar o arquivo. Verifique sua conexão e tente novamente."], evalTrue: [NO_OVERLAP] }, common),
    page("func-r10-toast-erro-longo", [open, { holdRequest: { urlPattern: "*files-upload*" } }, png, { fulfillHeld: { status: 422, body: j(LONG) } }, { waitFor: { css: "[data-sonner-toast]" } }, bottom], { includes: [LONG.slice(0, 60)], evalTrue: [NO_OVERLAP] }, common),
    page("func-r10-dois-toasts", [open, { holdRequest: { urlPattern: "*files-upload*" } }, png, { fulfillHeld: { status: 500, body: j("x") } }, { waitFor: { css: "[data-sonner-toast]" } }, png, { fulfillHeld: { status: 422, body: j("Segundo aviso: arquivo recusado pelo servidor.") } }, bottom], { includes: ["Segundo aviso"], evalTrue: [NO_OVERLAP, { name: "há 2 toasts visíveis", js: "document.querySelectorAll('[data-sonner-toast]').length >= 2" }] }, common),
  ];
}

export const VISUAL_PAGES = Object.freeze([
  // recuperação: erro de tipo → seleção válida → o aviso some e o envio conclui (chip + toast)
  page("func-recuperacao-apos-erro", [open, txt, { waitFor: { css: '[role="alert"]', within: DIALOG } }, png, { waitFor: { css: '[class*="_uploadedProof_"]', within: DIALOG } }, bottom],
    { includes: ["comprovante-sintetico-qa.png"], present: ['[class*="_uploadedProof_"]'], absent: ['[role="alert"]'], excludes: ["Tipo de arquivo não permitido"] }),
  // nova seleção depois de falha do servidor: 500 simulado → toast; volta ao backend real → mesma dropzone aceita nova seleção e conclui
  page("func-nova-selecao-apos-falha", [open, { holdRequest: { urlPattern: "*files-upload*" } }, png, { fulfillHeld: { status: 500, body: JSON.stringify({ json: { message: "falha tecnica interna" } }) } }, { waitFor: { css: "[data-sonner-toast]" } }, { releaseHold: true }, png, { waitFor: { css: '[class*="_uploadedProof_"]', within: DIALOG } }, bottom],
    { includes: ["comprovante-sintetico-qa.png"], present: ['[class*="_uploadedProof_"]'] }),
  // arrastar e SAIR da área: o destaque volta ao normal
  page("func-arrasto-sair", [open, bottom, drag("enter"), { waitFor: { css: '[class*="_dragging_"]', within: DIALOG } }, drag("leave"), { scrollEnd: { css: DIALOG } }],
    { includes: ["Clique ou arraste uma foto/PDF"], absent: ['[class*="_dragging_"]'] }, { capture: { fullPage: false, keepPointer: true }, viewports: [VISUAL_VIEWPORTS.find((v) => v.w === 1280)] }),
  // o produto NÃO diferencia arquivo aceito de inválido durante o arrasto (não lê os tipos antes do drop): o destaque é o mesmo — registrado, não inventado
  page("func-arrasto-invalido-mesmo-destaque", [open, bottom, drag("enter", "arrasto-invalido-qa.txt", { content: "texto sintético" }), { waitFor: { css: '[class*="_dragging_"]', within: DIALOG } }],
    { present: ['[class*="_dragging_"]'], absent: ['[role="alert"]'] }, { capture: { fullPage: false, keepPointer: true }, viewports: [VISUAL_VIEWPORTS.find((v) => v.w === 1280)] }),
  // SOLTAR (drop) um arquivo inválido com o gesto real: a validação do caminho de arrasto mostra o aviso em português e nada é enviado
  page("func-soltar-invalido", [open, bottom, drag("drop", "solto-invalido-qa.txt", { content: "texto sintético" }), { waitFor: { css: '[role="alert"]', within: DIALOG } }, bottom],
    { includes: ["Tipo de arquivo não permitido. Selecione um formato aceito."], present: ['[role="alert"]'], absent: ['[class*="_dragging_"]', '[class*="_uploadedProof_"]'] }, { capture: { fullPage: false }, viewports: [VISUAL_VIEWPORTS.find((v) => v.w === 1280)] }),
  // SOLTAR um PNG válido com o gesto real: envia ao backend real e conclui
  page("func-soltar-valido", [open, bottom, drag("drop", "solto-valido-qa.png"), { waitFor: { css: '[class*="_uploadedProof_"]', within: DIALOG } }, bottom],
    { includes: ["solto-valido-qa.png"], present: ['[class*="_uploadedProof_"]'], absent: ['[role="alert"]'] }, { capture: { fullPage: false }, viewports: [VISUAL_VIEWPORTS.find((v) => v.w === 1280)] }),
  // ---- M10 / R10: o toast NUNCA cobre os controles do rodapé do diálogo (geometria real) e o botão principal recebe o clique real com o toast visível ----
  // Cobre toast de sucesso, de erro curto, de erro com texto LONGO e DOIS toasts empilhados, em 375/390/768/1280 px, claro/escuro, Chrome/Edge.
  ...r10Pages(),
]);
