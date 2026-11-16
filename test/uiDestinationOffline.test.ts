/**
 * M47 — achado no navegador real (Chrome): sem conexão, o TanStack Query PAUSA a mutação (networkMode "online") e o diálogo de destinação ficava em "Registrando..." sem explicar nada.
 * Regressão estática (mesmo estilo da suíte de interface): o diálogo precisa avisar, em região de status, que a saída ficou na fila e que não há duplicidade; a prova comportamental é a jornada J20 do navegador.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.resolve(__dirname, "../src/components/DestinationDialog.tsx"), "utf-8");

describe("DestinationDialog: mutação pausada por falta de conexão", () => {
  it("mostra aviso em role=status quando mutation.isPaused, sem prometer duplicidade e sem esconder o erro real (role=alert)", () => {
    expect(src).toMatch(/mutation\.isPaused\s*&&\s*<p[^>]*role="status"[^>]*>[^<]*Sem conexão com o servidor/);
    expect(src).toMatch(/nunca cria duas saídas/);
    expect(src).toMatch(/error\s*&&\s*<p[^>]*role="alert"/);
  });
  it("a mesma chave de idempotência é reaproveitada (a retomada automática não duplica a saída)", () => {
    expect(src).toMatch(/idempotencyKey:\s*key/);
  });
});
