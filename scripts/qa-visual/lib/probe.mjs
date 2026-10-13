// Código injetado NA PÁGINA (como texto, via CDP). Só coleta valores BRUTOS calculados pelo navegador (cores normalizadas para RGBA por um
// canvas, pilha de fundos, sombras, retângulos). A razão de contraste e o PASS/FAIL são calculados no Node (lib/contrast.mjs, testado).

export const PROBE_SOURCE = String.raw`
(() => {
  if (window.__qa) return;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const p = ctx.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2], Math.round((p[3] / 255) * 1000) / 1000]; };
  // fundo EFETIVO de um elemento: compõe, de baixo para cima, as camadas com cor de fundo até achar uma opaca (partindo do próprio elemento)
  const stack = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 0.999) break; }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) { const [r, g, b, a] = layers[i]; base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]; }
    return base.map((v) => Math.round(v * 100) / 100);
  };
  const shadowColors = (s) => [...s.matchAll(/(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|hsla?\([^)]*\))/g)].map((m) => rgba(m[1]));
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const label = (el) => norm(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '');
  // acha um elemento por CSS + (opcional) texto/aria-label por regex, dentro de um escopo; marca com data-qa-target para reencontrar
  const find = (spec) => {
    const scope = spec.within ? document.querySelector(spec.within) : document;
    if (!scope) return null;
    const re = spec.text ? new RegExp(spec.text) : null;
    const list = [...scope.querySelectorAll(spec.css)].filter((el) => visible(el) && (!spec.within && spec.notWithin ? !el.closest(spec.notWithin) : true) && (!re || re.test(label(el))));
    const el = list[spec.index || 0];
    document.querySelectorAll('[data-qa-target]').forEach((n) => n.removeAttribute('data-qa-target'));
    if (!el) return null;
    el.setAttribute('data-qa-target', '1');
    return el;
  };
  const target = () => document.querySelector('[data-qa-target]');
  const center = () => { const el = target(); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  const hitsTarget = (x, y) => { const el = target(); const top = document.elementFromPoint(x, y); return !!(el && top && (top === el || el.contains(top))); };
  const describe = () => {
    const el = target(); if (!el) return null;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const par = el.parentElement; const pcs = getComputedStyle(par); const pr = par.getBoundingClientRect();
    const own = stack(el); const outside = stack(par);
    const shadows = shadowColors(cs.boxShadow === 'none' ? '' : cs.boxShadow);
    let outline = null; if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) outline = { width: cs.outlineWidth, color: rgba(cs.outlineColor) };
    const first = el.firstElementChild; const thumb = first ? { bg: stack(first), rect: [first.getBoundingClientRect().x, first.getBoundingClientRect().width] } : null;
    return {
      tag: el.tagName.toLowerCase(), label: label(el).slice(0, 60), iconOnly: !norm(el.textContent), disabled: !!(el.disabled || el.hasAttribute('data-disabled') || el.getAttribute('aria-disabled') === 'true'),
      fg: rgba(cs.color), bg: own, outsideBg: outside, border: rgba(cs.borderTopColor), borderWidth: parseFloat(cs.borderTopWidth),
      ring: shadows.length ? { kind: 'shadow', color: shadows[shadows.length - 1], layers: shadows.length } : outline ? { kind: 'outline', color: outline.color, layers: 1 } : null,
      fontSizePx: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, opacity: parseFloat(cs.opacity), boxSizing: cs.boxSizing,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }, parentContentRight: pr.right - parseFloat(pcs.paddingRight) - parseFloat(pcs.borderRightWidth || 0), viewport: innerWidth,
      hover: el.matches(':hover'), active: el.matches(':active'), focusVisible: el.matches(':focus-visible'), focusWithin: el.matches(':focus-within'), checked: el.getAttribute('aria-checked'), state: el.getAttribute('data-state'),
      dark: document.body.classList.contains('dark'), thumb, ariaInvalid: el.getAttribute('aria-invalid'),
    };
  };
  // dimensões ÚTEIS da página (o que a página enxerga, não o tamanho da janela externa) e contenção horizontal da página/diálogo
  const pageMetrics = () => {
    const d = document.querySelector('[role=dialog]'); const dr = d ? d.getBoundingClientRect() : null;
    return { innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, dpr: devicePixelRatio, dialog: d ? { left: dr.left, right: dr.right, top: dr.top, bottom: dr.bottom, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth } : null };
  };
  const focusInner = (css) => { const el = target(); const inner = el && el.querySelector(css); if (!inner) return false; inner.focus(); return document.activeElement === inner; };
  // cor opaca de um token CSS (ex.: --surface), para fundos que são gradiente (o backgroundColor não os representa)
  const tokenColor = (name) => { const v = getComputedStyle(document.body).getPropertyValue(name).trim(); if (!v) return null; const c = rgba(v); return [c[0], c[1], c[2]]; };
  window.__qa = { rgba, stack, find, target, center, hitsTarget, describe, pageMetrics, focusInner, tokenColor };
})();
`;
