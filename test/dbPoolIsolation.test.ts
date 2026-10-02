import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db, reserveDedicatedConnection } from "../src/helpers/db";

// Fase 62 encontrou um deadlock real: reserveDedicatedConnection() (usada
// pelo scheduler, src/helpers/scheduledTaskLock.tsx) tirava a conexão do
// MESMO pool pequeno (max: 3) usado por toda query comum via `db` — uma
// sobreposição real de tarefas agendadas esgotava o pool inteiro e
// travava a aplicação para sempre. A Fase 63 separou os pools; este teste
// prova que uma query comum nunca fica presa atrás de reservas do
// scheduler, mesmo quando o pool do scheduler está totalmente saturado.
describe("isolamento entre o pool da aplicação e o pool do scheduler", () => {
  it("uma query comum via `db` não espera conexões reservadas pelo scheduler ficarem livres", async () => {
    // Satura o pool do scheduler (max: 5) com reservas de longa duração —
    // se ainda compartilhasse pool com `db`, a query abaixo ficaria presa
    // atrás delas.
    const reservations = Promise.all(
      Array.from({ length: 6 }, async () => {
        const reserved = await reserveDedicatedConnection();
        try {
          await reserved`SELECT pg_sleep(2)`;
        } finally {
          reserved.release();
        }
      })
    );

    const start = Date.now();
    await sql`SELECT 1`.execute(db);
    const elapsedMs = Date.now() - start;

    // Generoso o bastante para não ser frágil sob CI lento, mas bem abaixo
    // dos ~2s que a query levaria se estivesse presa atrás das reservas.
    expect(elapsedMs).toBeLessThan(1000);

    await reservations;
  });

  it("reservas do scheduler continuam funcionando mesmo com o pool de `db` saturado", async () => {
    const saturating = Promise.all(
      Array.from({ length: 4 }, () => sql`SELECT pg_sleep(2)`.execute(db))
    );

    const start = Date.now();
    const reserved = await reserveDedicatedConnection();
    try {
      await reserved`SELECT 1`;
    } finally {
      reserved.release();
    }
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);

    await saturating;
  });
});
