import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  API_SECURITY_HEADERS,
  DOCUMENT_CSP,
  DOCUMENT_CSP_WITH_FRAME_ANCESTORS,
} from "./src/helpers/securityHeaders";

// Fase 50 (SEC-05): headers de segurança do DOCUMENTO HTML (diferente dos
// da API em server/index.ts — ver src/helpers/securityHeaders.ts). Nunca
// inclui Content-Security-Policy aqui: o servidor de dev do Vite injeta um
// <script type="module"> INLINE em todo request (preâmbulo do React
// Fast Refresh, confirmado lendo a resposta real de `curl localhost:5173/`
// — não é hipotético), o que exigiria 'unsafe-inline' em script-src só
// para não quebrar o HMR. Isso enfraqueceria a política real sem motivo —
// a Fase 50 trata CSP só na build de produção (ver o plugin abaixo), onde
// o HTML final não tem nenhum script inline (confirmado lendo
// dist/index.html depois de `npm run build`).
const DEV_DOCUMENT_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": API_SECURITY_HEADERS["X-Content-Type-Options"],
  "Referrer-Policy": API_SECURITY_HEADERS["Referrer-Policy"],
  "Permissions-Policy": API_SECURITY_HEADERS["Permissions-Policy"],
  "X-Frame-Options": API_SECURITY_HEADERS["X-Frame-Options"],
};

// `vite preview` serve a build real de produção (dist/) com um servidor
// HTTP de verdade — ao contrário do dev server, aqui já é seguro aplicar a
// CSP completa (sem nenhum script inline para quebrar), incluindo
// frame-ancestors (só possível como header HTTP real, nunca via <meta> —
// ver DOCUMENT_CSP_WITH_FRAME_ANCESTORS). Serve de referência viva do que
// a camada estática de produção (nginx/CDN, ainda não decidida — ver
// docs/DEPLOYMENT.md) precisa replicar.
const PREVIEW_DOCUMENT_HEADERS: Record<string, string> = {
  ...DEV_DOCUMENT_HEADERS,
  "Content-Security-Policy": DOCUMENT_CSP_WITH_FRAME_ANCESTORS,
};

// Injeta a CSP como <meta> SÓ na build de produção (ctx.server é undefined
// em `vite build`, presente em `vite dev`) — index.html é o mesmo arquivo
// nos dois modos, então sem essa checagem a mesma tag quebraria o preâmbulo
// inline do React Refresh no dev. <meta> não suporta frame-ancestors nem
// sandbox (a spec do CSP os ignora nesse contexto) — por isso a build usa
// DOCUMENT_CSP (sem frame-ancestors), não a variante com frame-ancestors.
function cspMetaTagForProduction(): Plugin {
  return {
    name: "levora-csp-meta-production-only",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.server) return html; // dev server: não injeta
        return html.replace(
          "</head>",
          `  <meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}" />\n  </head>`
        );
      },
    },
  };
}

// Configuração do Vite para o cliente da Levora Solidária.
//
// Os arquivos já portados do Floot em src/pages, src/components e
// src/helpers usam *.module.css (CSS Modules), suportado nativamente pelo
// Vite sem configuração adicional.
//
// O proxy de /_api abaixo encaminha para o servidor Express real
// (server/index.ts, iniciado com `npm run dev`), preservando exatamente as
// URLs que os arquivos *_GET.schema.ts / *_POST.schema.ts já portados usam
// (ex: fetch("/_api/v1/needs?...")) — o proxy casa por prefixo, então
// funciona igual independente da versão da API depois do "/_api/".
export default defineConfig({
  plugins: [react(), cspMetaTagForProduction()],
  server: {
    port: 5173,
    headers: DEV_DOCUMENT_HEADERS,
    proxy: {
      "/_api": {
        // Permite previews isolados em outra porta sem mudar o destino padrão local.
        target: process.env.LEVORA_API_PROXY_TARGET || "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: PREVIEW_DOCUMENT_HEADERS,
  },
});
