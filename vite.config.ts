import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configuração do Vite para o cliente da Levora Solidária.
//
// Os arquivos já portados do Floot em src/pages, src/components e
// src/helpers usam *.module.css (CSS Modules), suportado nativamente pelo
// Vite sem configuração adicional.
//
// O proxy de /_api abaixo encaminha para o servidor Express real
// (server/index.ts, iniciado com `npm run dev`), preservando exatamente as
// URLs que os arquivos *_GET.schema.ts / *_POST.schema.ts já portados usam
// (ex: fetch("/_api/needs?...")) — nenhum código de cliente precisou mudar.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/_api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
