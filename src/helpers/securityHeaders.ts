/**
 * Fase 50 — fecha o achado SEC-05 da auditoria de segurança (Fase 47):
 * ausência de security headers HTTP.
 *
 * Headers compartilhados entre a API Express (server/index.ts) e a
 * documentação de referência para a camada estática de produção
 * (docs/DEPLOYMENT.md) — um único lugar para os valores, nunca duas cópias
 * divergentes.
 *
 * Por que a API usa `default-src 'none'`, bem mais restritivo que o do
 * documento HTML: server/index.ts só devolve JSON (nunca HTML renderizável
 * por este processo — ver docs/DEPLOYMENT.md, "server/index.ts não serve
 * os arquivos estáticos do cliente"), então não há script/estilo/imagem
 * nenhum para permitir aqui.
 */
export const API_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Lista explícita do que esta aplicação NÃO usa (câmera, microfone,
  // geolocalização, pagamento, USB, bluetooth, sensores de movimento,
  // MIDI, picture-in-picture, captura de tela, autoplay de mídia,
  // fullscreen — nenhum grep encontrou uso real de nenhuma dessas APIs em
  // src/, ver inventário da Fase 50) — exceto `clipboard-write`, usada de
  // verdade em organizacoes.$organizationId.tsx (botão "Copiar link de
  // convite", navigator.clipboard.writeText), por isso explicitamente
  // permitida só para a própria origem.
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), bluetooth=(), midi=(), picture-in-picture=(), display-capture=(), fullscreen=(), autoplay=(), clipboard-write=(self)",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/**
 * Permissions-Policy compartilhada com o documento HTML do front-end — ver
 * `vite.config.ts` (dev/preview) e docs/DEPLOYMENT.md (produção real).
 * Mesma lista de capacidades desabilitadas que `API_SECURITY_HEADERS`,
 * pelo mesmo motivo (nenhum uso real encontrado em src/, exceto
 * clipboard-write).
 */
export const PERMISSIONS_POLICY = API_SECURITY_HEADERS["Permissions-Policy"];

/**
 * CSP do DOCUMENTO HTML (não da API) — baseada no inventário real de
 * recursos externos da Fase 50:
 * - style-src precisa de 'unsafe-inline': Radix UI (usado em todo o
 *   front-end: Dialog, Select, Popover, Tooltip etc.) posiciona seus
 *   elementos via `style` inline calculado em JS, e uma dependência
 *   transitiva do Dialog (react-style-singleton, via
 *   react-remove-scroll-bar) injeta uma tag `<style>` para compensar a
 *   largura da scrollbar ao travar o scroll do body — confirmado via
 *   `npm ls` e uso real do Dialog em várias páginas. Sem 'unsafe-inline'
 *   aqui, esses componentes quebrariam. Nenhuma evidência equivalente
 *   para script-src: zero <script> inline no HTML de produção (confirmado
 *   lendo dist/index.html após `npm run build`), zero eval/Function.
 * - style-src e font-src incluem o Google Fonts (fonts.googleapis.com +
 *   fonts.gstatic.com) — único recurso de terceiros carregado pelo
 *   navegador, via @import em src/base.css. api.anthropic.com NÃO entra
 *   aqui: usado só no backend (src/helpers/aiClient.tsx, importado
 *   exclusivamente por src/helpers/opportunityMatching.tsx, nunca por
 *   nenhuma página/componente — confirmado por busca, zero import em
 *   src/pages ou src/components), nunca chamado pelo navegador.
 * - frame-ancestors e sandbox não são suportados em CSP via <meta> (a
 *   spec explicitamente os ignora nesse contexto) — por isso não entram
 *   aqui; frame-ancestors 'none' (equivalente a X-Frame-Options: DENY)
 *   precisa vir como header HTTP real da camada que serve o HTML em
 *   produção (ver docs/DEPLOYMENT.md).
 */
export const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

/**
 * Versão do CSP acima com `frame-ancestors` incluído — só funciona como
 * header HTTP real (nunca via <meta>), por isso é uma constante separada:
 * usada em `vite.config.ts` (preview, que serve dist/ com um servidor
 * HTTP real) e documentada em docs/DEPLOYMENT.md para a camada estática
 * de produção (nginx/CDN — ainda não decidida, ver esse documento).
 */
export const DOCUMENT_CSP_WITH_FRAME_ANCESTORS = `${DOCUMENT_CSP}; frame-ancestors 'none'`;
