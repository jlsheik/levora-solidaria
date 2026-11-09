// M06: config SEM banco para os testes puros do QA que envolvem registro/recuperação de processos (usada também pelos mutantes de segurança de processos).
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/qaProcessSafety.test.ts", "test/qaVisual.test.ts", "test/qaSecurityHeaders.test.ts", "test/qaOwnRun.test.ts"], environment: "node", testTimeout: 60000 } });
