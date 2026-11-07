// M08: suíte SEM banco para testes estáticos de interface (CSS/TSX). PR B (interface e acessibilidade).
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/ui*.test.ts"], environment: "node", testTimeout: 30000 } });
