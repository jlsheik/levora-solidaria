// Viewports de teste e conferência das dimensões ÚTEIS da página. São tamanhos de viewport emulados, NÃO dispositivos reais.

/** Largura × altura (CSS px). `mobile` liga a emulação de celular do navegador (barras de rolagem sobrepostas) só nas larguras de telefone. */
export const VIEWPORTS = Object.freeze([
  { w: 375, h: 812, mobile: true },
  { w: 390, h: 844, mobile: true },
  { w: 768, h: 1024, mobile: false },
  { w: 1280, h: 900, mobile: false },
]);

export const viewportKey = (vp) => `${vp.w}x${vp.h}`;

/** Parâmetros de `Emulation.setDeviceMetricsOverride` (fator de escala 1 para medir em CSS px). */
export const emulationParams = (vp) => ({ width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile });

/**
 * Confere as dimensões úteis lidas DENTRO da página contra o viewport pedido (tolerância de 1px). `actual` = { innerWidth, innerHeight }.
 * Redimensionar a janela externa não basta: o que vale é o que a página enxerga.
 */
export function viewportMatches(vp, actual, tolerance = 1) {
  return Math.abs(actual.innerWidth - vp.w) <= tolerance && Math.abs(actual.innerHeight - vp.h) <= tolerance;
}

/** `--viewports 375,1280` ou `375x812,1280x900` → lista de VIEWPORTS (erro se algum não existir). */
export function parseViewportsOption(text, all = VIEWPORTS) {
  if (!text) return [...all];
  const out = [];
  for (const raw of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const hit = all.find((v) => String(v.w) === raw || viewportKey(v) === raw);
    if (!hit) throw new Error(`viewport desconhecido: ${raw} (use ${all.map(viewportKey).join(", ")} ou só a largura)`);
    if (!out.includes(hit)) out.push(hit);
  }
  if (!out.length) throw new Error("--viewports vazio");
  return out;
}
