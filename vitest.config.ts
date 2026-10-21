import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env.test aponta para um banco de dados separado do de desenvolvimento —
// nunca reaproveitar DATABASE_URL do .env aqui, os testes de integração
// truncam tabelas entre cada teste (ver test/setup.ts).
dotenv.config({ path: path.resolve(__dirname, ".env.test") });

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup-identity-env.ts", "./test/setup.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    // Testes de integração compartilham o mesmo banco Postgres de teste;
    // rodar em paralelo com truncamento entre testes causaria corrida entre
    // arquivos de teste distintos.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/helpers/**/*.tsx", "src/helpers/**/*.ts", "src/endpoints/**/*.ts"],
      exclude: ["src/**/*.schema.ts", "src/helpers/schema.tsx"],
    },
  },
});
