// Copia para dist-server os arquivos não-TypeScript que o backend compilado
// lê em runtime via fs (não via `import`), já que o tsc não copia esses
// arquivos automaticamente. Hoje isso é só scheduled-jobs.json, lido por
// src/helpers/scheduler.tsx relativo ao próprio __dirname em produção.
const fs = require("node:fs");
const path = require("node:path");

const ASSETS = ["src/static/__dev/scheduled-jobs.json"];

for (const relPath of ASSETS) {
  const src = path.resolve(__dirname, "..", relPath);
  const dest = path.resolve(__dirname, "..", "dist-server", relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`copiado: ${relPath} -> dist-server/${relPath}`);
}
