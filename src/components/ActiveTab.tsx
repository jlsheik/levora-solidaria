import React from "react";

/**
 * M04 (F05): aba ATIVA da barra de abas da organização. A barra rola na horizontal no celular; a aba atual é centralizada na área visível
 * (sem mexer na rolagem vertical da página), para o usuário sempre ver onde está. Reposiciona depois que as fontes carregam, porque a largura
 * das abas muda quando a fonte web substitui a de reserva (medir só na montagem deixava a aba parcialmente fora da tela).
 */
export function ActiveTab({ className, children, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    let alive = true;
    const place = () => {
      const el = ref.current;
      const nav = el?.parentElement;
      if (!alive || !el || !nav || nav.scrollWidth <= nav.clientWidth) return;
      nav.scrollLeft = Math.max(0, el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2);
    };
    place();
    const raf = requestAnimationFrame(place);
    void document.fonts?.ready.then(place);
    // a largura da barra muda com a rotação/redimensionamento (e quando o viewport é aplicado depois da montagem): recentraliza a aba atual a cada mudança de LARGURA (não de rolagem do usuário)
    const nav = ref.current?.parentElement;
    const ro = nav && typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (nav && ro) ro.observe(nav);
    // as abas condicionadas ao papel (Unidades, Pendências) entram DEPOIS que a organização carrega e deslocam a aba atual: recentraliza quando a lista de abas muda
    const mo = nav && typeof MutationObserver !== "undefined" ? new MutationObserver(place) : null;
    if (nav && mo) mo.observe(nav, { childList: true });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);
  return (
    <span ref={ref} className={className} {...rest}>
      {children}
    </span>
  );
}
