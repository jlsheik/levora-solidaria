// Impressão digital de layout: lista dos elementos visíveis com retângulo e estilo calculado, coletada NA PÁGINA e comparada no Node (puro, testado).
// Ela NÃO substitui a comparação de pixels: explica o que mudou (deslocado, redimensionado, espaçamento, oculto, cortado, sobreposto, cor, tipografia)
// e acusa mudanças estruturais novas (elemento sumido, conteúdo cortado, sobreposição) mesmo que a tolerância de pixels as deixasse passar.

export const FINGERPRINT_SOURCE = String.raw`
(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE', 'BR', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'POLYGON', 'G', 'DEFS', 'USE']);
  const KEEP = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','IMG','SVG','LABEL','H1','H2','H3','H4','H5','H6','P','LI','TH','TD','TR','TABLE','THEAD','TBODY','FORM','DIALOG','NAV','MAIN','HEADER','FOOTER','ASIDE','SECTION','SPAN','DIV']);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').trim(); // e-mails mascarados: a impressão vai para disco e relatórios
  const ownText = (el) => norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')).slice(0, 40);
  window.__qaFingerprint = (limit) => {
    limit = limit || 600;
    const out = []; const seen = new Map(); const idx = new Map();
    const sx = window.scrollX, sy = window.scrollY;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode; el && out.length < limit; el = walker.nextNode()) {
      const tag = el.tagName; if (SKIP.has(tag) || !KEEP.has(tag)) continue;
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      const interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|IMG|SVG|LABEL|DIALOG|TABLE|FORM)$/.test(tag) || el.getAttribute('role');
      const text = ownText(el) || (interactive ? norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').slice(0, 40) : '');
      const hasBox = cs.borderTopWidth !== '0px' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
      if (!text && !interactive && !hasBox) continue;
      const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      const role = el.getAttribute('role') || '';
      const base = tag + '|' + role + '|' + text; const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      const par = el.parentElement; let pk = null; for (let p = par; p && !pk; p = p.parentElement) if (idx.has(p)) pk = idx.get(p);
      const key = base + '|' + n; idx.set(el, key);
      const clipped = (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') || (el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible' && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll');
      let hscroll = false; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const pc = getComputedStyle(p); if ((pc.overflowX === 'auto' || pc.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) { hscroll = true; break; } } // M05: dentro de contêiner com rolagem horizontal (barra de abas) estar fora da tela é o comportamento previsto
      out.push({ key, pk, tag, role, text, visible, hscroll,
        x: Math.round((r.x + sx) * 2) / 2, y: Math.round((r.y + sy) * 2) / 2, w: Math.round(r.width * 2) / 2, h: Math.round(r.height * 2) / 2,
        color: cs.color, bg: cs.backgroundColor, font: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(), size: cs.fontSize, weight: cs.fontWeight, lh: cs.lineHeight,
        display: cs.display, clipped, overflow: cs.overflowX + '/' + cs.overflowY });
    }
    return { count: out.length, truncated: out.length >= limit, doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }, elements: out };
  };
})()`;

export const FINGERPRINT_TOLERANCE = Object.freeze({ position: 1, size: 1, gap: 1 });

const overlaps = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

/** Sobreposições (retângulos visíveis que se cruzam sem um conter o outro) entre elementos irmãos com texto/interativos. */
export function overlapSet(els) {
  const out = new Set(); const vis = els.filter((e) => e.visible && e.w > 2 && e.h > 2 && (e.text || e.role || /^(BUTTON|INPUT|SELECT|A|IMG)$/.test(e.tag)));
  const byParent = new Map(); for (const e of vis) { const l = byParent.get(e.pk) ?? []; l.push(e); byParent.set(e.pk, l); }
  for (const list of byParent.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j]; if (!overlaps(a, b)) continue;
    const contains = (p, c) => p.x <= c.x + 1 && p.y <= c.y + 1 && p.x + p.w >= c.x + c.w - 1 && p.y + p.h >= c.y + c.h - 1;
    if (!contains(a, b) && !contains(b, a)) out.add([a.key, b.key].sort().join(" ⇄ "));
  }
  return out;
}

/**
 * Compara a impressão da referência com a atual. Retorna { findings[], summary } em que cada achado tem
 * { type: moved|resized|spacing|hidden|appeared|removed|clipped|overlap|color|typography|document-size, key, detail, severity: structural|style }.
 * `structural` (removido, oculto, cortado novo, sobreposição nova, documento maior) é acusado mesmo se os pixels estivessem dentro da tolerância.
 */
export function compareFingerprints(base, cur, tol = FINGERPRINT_TOLERANCE) {
  const findings = []; const add = (type, key, detail, severity = "style") => findings.push({ type, key, detail, severity });
  const B = new Map(base.elements.map((e) => [e.key, e])); const C = new Map(cur.elements.map((e) => [e.key, e]));
  for (const [k, b] of B) {
    const c = C.get(k);
    if (!c) { add("removed", k, "elemento da referência não existe na captura atual", "structural"); continue; }
    if (b.visible && !c.visible) { add("hidden", k, "visível na referência, oculto agora (display/visibility/opacity/tamanho zero)", "structural"); continue; }
    if (!b.visible && c.visible) { add("appeared", k, "oculto na referência, visível agora"); continue; }
    if (!b.visible) continue;
    const dx = c.x - b.x, dy = c.y - b.y;
    if (Math.abs(dx) > tol.position || Math.abs(dy) > tol.position) add("moved", k, `deslocado ${dx >= 0 ? "+" : ""}${dx}px em x, ${dy >= 0 ? "+" : ""}${dy}px em y`);
    const dw = c.w - b.w, dh = c.h - b.h;
    if (Math.abs(dw) > tol.size || Math.abs(dh) > tol.size) add("resized", k, `dimensões ${b.w}x${b.h} → ${c.w}x${c.h}`);
    if (c.clipped && !b.clipped) add("clipped", k, `conteúdo passou a ser cortado (overflow ${c.overflow})`, "structural");
    if (b.color !== c.color || b.bg !== c.bg) add("color", k, `cor ${b.color} → ${c.color}; fundo ${b.bg} → ${c.bg}`);
    if (b.font !== c.font || b.size !== c.size || b.weight !== c.weight || b.lh !== c.lh) add("typography", k, `fonte ${b.font} ${b.size}/${b.lh} peso ${b.weight} → ${c.font} ${c.size}/${c.lh} peso ${c.weight}`);
  }
  for (const [k, c] of C) if (!B.has(k)) add("appeared", k, "elemento novo (não existia na referência)");
  // espaçamento: distância vertical entre irmãos consecutivos que mudou além da tolerância (mesmo pai)
  const sib = (els) => { const by = new Map(); for (const e of els) if (e.visible) { const l = by.get(e.pk) ?? []; l.push(e); by.set(e.pk, l); } return by; };
  const cb = sib(cur.elements);
  for (const [pk, list] of sib(base.elements)) {
    const cl = cb.get(pk); if (!cl) continue; const cm = new Map(cl.map((e) => [e.key, e]));
    for (let i = 1; i < list.length; i++) { const a = list[i - 1], b = list[i]; const ca = cm.get(a.key), cbb = cm.get(b.key); if (!ca || !cbb) continue;
      const g0 = b.y - (a.y + a.h), g1 = cbb.y - (ca.y + ca.h); if (Math.abs(g1 - g0) > tol.gap && Math.abs(ca.y - a.y) <= tol.position) add("spacing", b.key, `espaço vertical até "${a.text || a.tag}" ${g0}px → ${g1}px`); }
  }
  const ob = overlapSet(base.elements); for (const o of overlapSet(cur.elements)) if (!ob.has(o)) add("overlap", o, "elementos passaram a se sobrepor", "structural");
  if (cur.doc.h > base.doc.h + tol.size || cur.doc.w > base.doc.w + tol.size) add("document-size", "documento", `área rolável ${base.doc.w}x${base.doc.h} → ${cur.doc.w}x${cur.doc.h}`, cur.doc.w > base.doc.w + tol.size ? "structural" : "style");
  const counts = {}; for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return { findings, summary: { total: findings.length, structural: findings.filter((f) => f.severity === "structural").length, byType: counts } };
}
