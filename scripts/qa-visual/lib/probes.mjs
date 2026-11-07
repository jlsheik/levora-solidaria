// M10: SONDAS de geometria/estilo executadas na página real, imediatamente antes da captura (nunca leem o VALOR de campos de formulário). O resultado entra em `preconditions.probe`
// do relatório de cada célula: geometria do toast × controles do diálogo, medida do campo de link (R12), cadeia de opacidade/cor do título da dropzone (R11), viewport/DPR/barra de rolagem.
// Servem para DIAGNOSTICAR e para PROVAR correções; não fazem parte do critério de estabilidade e não alteram a página.

export const DROPZONE_PROBE = `(() => {
  const R = (r) => r ? { x: +r.x.toFixed(3), y: +r.y.toFixed(3), w: +r.width.toFixed(3), h: +r.height.toFixed(3), r: +r.right.toFixed(3), b: +r.bottom.toFixed(3) } : null;
  const dlg = document.querySelector('[role="dialog"]');
  const footer = dlg && (dlg.querySelector('[data-dialog-footer]') || dlg.querySelector('[class*="_footer_"]'));
  const desc = (el) => !el ? null : (el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '') + ':' + (el.textContent || '').trim().slice(0, 28));
  const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const toasts = [...document.querySelectorAll('[data-sonner-toast]')];
  const toaster = document.querySelector('[data-sonner-toaster]');
  const buttons = footer ? [...footer.querySelectorAll('button')] : [];
  const toastInfo = toasts.map((t) => { const r = t.getBoundingClientRect(); return { rect: R(r), type: t.getAttribute('data-type'), mounted: t.getAttribute('data-mounted'), visible: t.getAttribute('data-visible'), removed: t.getAttribute('data-removed'), chars: (t.textContent || '').length, transform: getComputedStyle(t).transform, position: getComputedStyle(t).position, zIndex: toaster ? getComputedStyle(toaster).zIndex : null }; });
  const btnInfo = buttons.map((b) => { const r = b.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2; const top = document.elementFromPoint(cx, cy);
    const covered = toasts.reduce((s, t) => s + inter(r, t.getBoundingClientRect()), 0); return { label: (b.textContent || '').trim().slice(0, 30), rect: R(r), coveredArea: +covered.toFixed(1), coveredRatio: +(covered / Math.max(1, r.width * r.height)).toFixed(3), centerReceivesPointer: !!top && (top === b || b.contains(top)), topElementAtCenter: desc(top) }; });
  const link = dlg && dlg.querySelector('input[placeholder^="https"]');
  let linkInfo = null;
  if (link) { const cs = getComputedStyle(link); const chain = []; for (let e = link.parentElement; e && e !== document.body; e = e.parentElement) { const s = getComputedStyle(e); chain.push({ el: e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0].slice(0, 24), x: +e.getBoundingClientRect().x.toFixed(3), r: +e.getBoundingClientRect().right.toFixed(3), w: +e.getBoundingClientRect().width.toFixed(3), clientW: e.clientWidth, offsetW: e.offsetWidth, scrollW: e.scrollWidth, overflowY: s.overflowY, gutter: s.scrollbarGutter }); if (e === dlg) break; }
    linkInfo = { rect: R(link.getBoundingClientRect()), width: cs.width, borderRight: cs.borderRightWidth, borderLeft: cs.borderLeftWidth, boxSizing: cs.boxSizing, offsetW: link.offsetWidth, clientW: link.clientWidth, ancestors: chain }; }
  const zone = dlg && dlg.querySelector('label[class*="_dropzone_"]'); const title = zone && zone.querySelector('[class*="_title_"]'); let titleInfo = null;
  if (title) { const cs = getComputedStyle(title); const chain = []; let op = 1; for (let e = title; e; e = e.parentElement) { const o = parseFloat(getComputedStyle(e).opacity); op *= o; if (o !== 1) chain.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0].slice(0, 24) + '=' + o); }
    let bg = null; for (let e = title; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') { bg = { kind: 'image', value: s.backgroundImage.slice(0, 120) }; break; } if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') { bg = { kind: 'color', value: s.backgroundColor }; break; } }
    const sub = zone.querySelector('[class*="_subtitle_"]'); const subInfo = sub ? { rect: R(sub.getBoundingClientRect()), color: getComputedStyle(sub).color, text: (sub.textContent || '').slice(0, 20) } : null;
    titleInfo = { rect: R(title.getBoundingClientRect()), zoneRect: R(zone.getBoundingClientRect()), subtitle: subInfo, text: (title.textContent || '').slice(0, 40), color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, ownOpacity: cs.opacity, opacityProductFromRoot: +op.toFixed(4), opacityChain: chain, background: bg, zoneClasses: String(zone.className).slice(0, 80), ariaLive: title.getAttribute('aria-live'), zoneAriaBusy: zone.getAttribute('aria-busy') }; }
  const scroller = dlg ? [dlg, ...dlg.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) : null;
  // M11: cobertura do CONTEÚDO do diálogo (texto, campos, dicas, botões) pelos toasts — medida em pixels sobre a parte visível (recortada pela caixa do diálogo).
  const isLeaf = (e) => { if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A|IMG|SVG)$/i.test(e.tagName)) return true; for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true; return false; };
  const clip = dlg ? dlg.getBoundingClientRect() : null;
  const toastRects = toasts.map((t) => t.getBoundingClientRect());
  const contentCover = []; let contentArea = 0, contentCovered = 0;
  if (dlg) for (const e of dlg.querySelectorAll('*')) { if (!isLeaf(e)) continue; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r0 = e.getBoundingClientRect(); const r = { left: Math.max(r0.left, clip.left), top: Math.max(r0.top, clip.top), right: Math.min(r0.right, clip.right), bottom: Math.min(r0.bottom, clip.bottom) };
    if (r.right <= r.left || r.bottom <= r.top) continue; const area = (r.right - r.left) * (r.bottom - r.top); const cov = toastRects.reduce((s, q) => s + inter(r, q), 0);
    contentArea += area; contentCovered += cov; if (cov > 0) contentCover.push({ el: desc(e), coveredPx2: +cov.toFixed(1), ratio: +(cov / area).toFixed(3) }); }
  const dialogOverlap = dlg ? toastRects.reduce((s, q) => s + inter(dlg.getBoundingClientRect(), q), 0) : 0;
  const vv = window.visualViewport;
  return JSON.stringify({ t: +performance.now().toFixed(1), viewport: { innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio, clientW: document.documentElement.clientWidth, docScrollW: document.documentElement.scrollWidth, vvW: vv ? vv.width : null, vvH: vv ? vv.height : null, vvScale: vv ? vv.scale : null }, fonts: document.fonts.status,
    dialog: dlg ? { rect: R(dlg.getBoundingClientRect()), scrollerClientW: scroller ? scroller.clientWidth : null, scrollerOffsetW: scroller ? scroller.offsetWidth : null, scrollbarW: scroller ? scroller.offsetWidth - scroller.clientWidth : null } : null,
    contentCoverage: { dialogOverlapPx2: +dialogOverlap.toFixed(1), contentAreaPx2: +contentArea.toFixed(1), contentCoveredPx2: +contentCovered.toFixed(1), covered: contentCover.slice(0, 12), toastCount: toasts.length, dialogInViewport: dlg ? (clip.top >= 0 && clip.bottom <= innerHeight && clip.left >= 0 && clip.right <= innerWidth) : null, reserve: document.documentElement.style.getPropertyValue('--toast-reserve') || null },
    footerRect: footer ? R(footer.getBoundingClientRect()) : null, footerHasDataAttr: !!(footer && footer.hasAttribute('data-dialog-footer')), toasterStyle: toaster ? { offsetBottom: toaster.style.getPropertyValue('--offset-bottom') || null, mobileOffsetBottom: toaster.style.getPropertyValue('--mobile-offset-bottom') || null, rect: R(toaster.getBoundingClientRect()) } : null,
    toasts: toastInfo, buttons: btnInfo, link: linkInfo, title: titleInfo });
})()`;

export const PROBES = Object.freeze({ dropzone: DROPZONE_PROBE });

/**
 * Sonda de INTERAÇÃO REAL (R10): com o toast visível, faz um clique REAL do navegador (CDP) no centro do botão principal do rodapé e outro no centro do toast, e registra quem recebeu cada clique.
 * Um ouvinte em fase de captura registra o alvo e cancela o evento (preventDefault + stopPropagation), então NENHUMA ação do produto é disparada (o formulário não é enviado).
 */
export async function runInteractionProbe(cdp) {
  const center = `(() => { const dlg = document.querySelector('[role="dialog"]'); const btns = dlg ? [...dlg.querySelectorAll('[data-dialog-footer] button, [class*="_footer_"] button')] : []; const b = btns[btns.length - 1]; const t = document.querySelector('[data-sonner-toast]');
    const c = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; };
    return JSON.stringify({ button: c(b), toast: c(t), buttonLabel: b ? (b.textContent || '').trim().slice(0, 30) : null }); })()`;
  const install = `(() => { window.__qaClicks = []; window.__qaClickHandler = (e) => { const t = e.target; window.__qaClicks.push({ tag: t.tagName.toLowerCase(), label: ((t.getAttribute && t.getAttribute('aria-label')) || (t.textContent || '').trim()).slice(0, 30), insideToast: !!(t.closest && t.closest('[data-sonner-toast]')), insideFooter: !!(t.closest && t.closest('[data-dialog-footer], [class*="_footer_"]')), isButton: !!(t.closest && t.closest('button')) }); e.preventDefault(); e.stopPropagation(); }; window.addEventListener('click', window.__qaClickHandler, true); })()`;
  const read = `(() => { const o = window.__qaClicks.slice(); window.removeEventListener('click', window.__qaClickHandler, true); delete window.__qaClickHandler; return JSON.stringify(o); })()`;
  try {
    const c = JSON.parse(await cdp.eval(center)); if (!c.button) return { erro: "sem botão no rodapé do diálogo" };
    await cdp.eval(install);
    await cdp.click(c.button.x, c.button.y); await new Promise((r) => setTimeout(r, 120));
    const afterBtn = JSON.parse(await cdp.eval("JSON.stringify(window.__qaClicks)"));
    let toastClick = null;
    if (c.toast && c.toast.inView) { await cdp.click(c.toast.x, c.toast.y); await new Promise((r) => setTimeout(r, 120)); const all = JSON.parse(await cdp.eval("JSON.stringify(window.__qaClicks)")); toastClick = all[all.length - 1] ?? null; }
    await cdp.eval(read); await cdp.mouseMove(1, 1);
    const btn = afterBtn[0] ?? null;
    return { botao: { rotulo: c.buttonLabel, centro: c.button, clique: btn, recebidoPeloBotao: !!btn && btn.isButton && !btn.insideToast, interceptadoPeloToast: !!btn && btn.insideToast }, toast: c.toast ? { centro: c.toast, cliqueNoToast: toastClick } : null };
  } catch (e) { return { erro: String(e.message).slice(0, 160) }; }
}

/** Executa a sonda `n` vezes (intervalo `gapMs`) para registrar se a geometria VARIA com o tempo (layout shift real × rasterização). Nunca lança: erro de sonda vira registro. */
export async function runProbe(cdp, name, { n = 3, gapMs = 150 } = {}) {
  if (name === "dropzone-interact") { const base = await runProbe(cdp, "dropzone", { n, gapMs }); return { ...base, interacao: await runInteractionProbe(cdp) }; }
  let src = PROBES[name];
  if (!src && typeof name === "string" && name.startsWith("r14:")) { const [x, y, w, h] = name.slice(4).split(",").map(Number); src = r14ProbeSource({ x, y, w, h }); }
  if (!src) return { erro: "sonda desconhecida: " + name };
  const samples = [];
  for (let i = 0; i < n; i++) {
    try { samples.push(JSON.parse(await cdp.eval(src))); } catch (e) { samples.push({ erro: String(e.message).slice(0, 160) }); }
    if (i < n - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  const strip = (s) => JSON.stringify({ ...s, t: undefined });
  return { nome: name, amostras: samples, geometriaEstavelEntreAmostras: samples.every((s) => strip(s) === strip(samples[0])) };
}

/**
 * M11 / R14: sonda de DIAGNÓSTICO de rasterização. `r14:x,y,w,h` (coordenadas CSS da página, na região em que as capturas divergiram entre rodadas) lista os elementos pintados
 * (borda, sombra, fundo ou contorno) cujas bordas caem nessa região, com a geometria fracionária (3 casas), e a geometria dos ancestrais que não está em pixel inteiro.
 * Não altera a página nem lê valores de campos.
 */
export function r14ProbeSource(box) {
  return `((box) => {
  const fr = (v) => Math.abs(v - Math.round(v)) > 0.005;
  const sx = window.scrollX, sy = window.scrollY; const X0 = box.x - 1, X1 = box.x + box.w + 1, Y0 = box.y - 1, Y1 = box.y + box.h + 1;
  const out = []; const q = (n) => +n.toFixed(3);
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect(); if (r.width === 0 && r.height === 0) continue;
    const L = r.left + sx, R = r.right + sx, T = r.top + sy, B = r.bottom + sy;
    const edgeIn = (L >= X0 && L <= X1 && T <= Y1 && B >= Y0) || (R >= X0 && R <= X1 && T <= Y1 && B >= Y0) || (T >= Y0 && T <= Y1 && L <= X1 && R >= X0) || (B >= Y0 && B <= Y1 && L <= X1 && R >= X0);
    if (!edgeIn) continue;
    const cs = getComputedStyle(e); const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth];
    const painted = bw.some((w) => parseFloat(w) > 0) || cs.boxShadow !== 'none' || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || cs.outlineStyle !== 'none';
    if (!painted) continue;
    const chain = []; for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const pr = p.getBoundingClientRect(); if (fr(pr.left + sx) || fr(pr.right + sx) || fr(pr.top + sy) || fr(pr.bottom + sy)) chain.push(p.tagName.toLowerCase() + '.' + String(p.className).split(' ')[0].slice(0, 26) + '@' + q(pr.left + sx) + ',' + q(pr.right + sx)); if (chain.length >= 4) break; }
    out.push({ el: e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0].slice(0, 30), L: q(L), R: q(R), T: q(T), B: q(B), w: q(r.width), h: q(r.height), fracX: fr(L) || fr(R), fracY: fr(T) || fr(B), border: bw.join('/'), shadow: cs.boxShadow === 'none' ? null : cs.boxShadow.slice(0, 60), transform: cs.transform === 'none' ? null : cs.transform, radius: cs.borderRadius, bg: cs.backgroundColor, fracAncestors: chain });
  }
  return JSON.stringify({ t: +performance.now().toFixed(1), box, dpr: devicePixelRatio, innerW: innerWidth, docW: document.documentElement.clientWidth, scrollbarW: innerWidth - document.documentElement.clientWidth, fonts: document.fonts.status, anims: document.getAnimations().length, elementos: out.slice(0, 40), total: out.length });
})(${JSON.stringify(box)})`;
}
