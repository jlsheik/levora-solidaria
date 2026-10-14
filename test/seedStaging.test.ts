/**
 * Fase 68 — o seed sintético precisa ser (1) correto contra o domínio real
 * e (2) idempotente: um segundo run não duplica nada nem gera auditoria.
 * Roda no banco de teste (`*_test`), que a guarda só aceita com NODE_ENV=test.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { assertStagingEnvironment } from "../db/seedStagingGuard";
import { runStagingSeed, countTables, SEED_USERS, SEED_EMAIL_DOMAIN } from "../db/seedStaging";

beforeAll(() => {
  process.env.LEVORA_ENVIRONMENT = "staging";
  // O guard real precisa aceitar este ambiente antes de qualquer seed.
  expect(assertStagingEnvironment().mode).toBe("test");
});

describe("seed sintético de staging", () => {
  it("cria o dataset via domínio real e é idempotente no segundo run", async () => {
    const first = await runStagingSeed();

    // Todas as validações pós-seed (saldos derivados, progresso da need,
    // lifecycle, matching real, cadeia de auditoria) passam.
    const failed = first.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(first.credentials.every((c) => typeof c.password === "string" && c.password.length >= 12)).toBe(true);
    expect(first.counts.users).toBe(4);
    expect(first.counts.organizations).toBe(3);
    expect(first.endpointWrites).toBeGreaterThan(30);

    const before = await countTables();
    const second = await runStagingSeed();
    const after = await countTables();

    expect(after).toEqual(before); // nenhuma tabela mudou — inclusive audit_log
    expect(second.endpointWrites).toBe(0); // nenhum endpoint de escrita foi chamado
    expect(second.checks.filter((c) => !c.ok)).toEqual([]);
    expect(second.credentials.every((c) => c.password === undefined)).toBe(true); // senha nunca re-exibida
  });

  it("não deixa sessões residuais e só usa e-mails sintéticos reservados", async () => {
    await runStagingSeed();
    const sessions = await db.selectFrom("sessions").select("id").execute();
    expect(sessions).toHaveLength(0);

    const emails = (await db.selectFrom("users").select("email").execute()).map((u) => u.email);
    expect(emails.sort()).toEqual(Object.values(SEED_USERS).map((u) => u.email).sort());
    expect(emails.every((e) => e.endsWith(`@${SEED_EMAIL_DOMAIN}`))).toBe(true);
  });

  it("não duplica nenhuma entidade de negócio (chaves naturais únicas)", async () => {
    await runStagingSeed();
    await runStagingSeed();

    const dup = async (query: ReturnType<typeof sql>) => (await query.execute(db)).rows;
    expect(await dup(sql`select name from organizations group by name having count(*) > 1`)).toEqual([]);
    expect(await dup(sql`select organization_id, name from inventory_items group by 1,2 having count(*) > 1`)).toEqual([]);
    expect(await dup(sql`select organization_id, title from needs group by 1,2 having count(*) > 1`)).toEqual([]);
    expect(await dup(sql`select origin_reference from opportunity_registry group by 1 having count(*) > 1`)).toEqual([]);
    expect(await dup(sql`select item_id, reason from stock_transactions group by 1,2 having count(*) > 1`)).toEqual([]);
    expect(await dup(sql`select organization_id, user_id from memberships group by 1,2 having count(*) > 1`)).toEqual([]);
    expect(await dup(sql`select need_id from need_resolutions group by 1 having count(*) > 1`)).toEqual([]);
    expect(await dup(sql`select allocation_id from need_fulfillments where entry_type='original' group by 1 having count(*) > 1`)).toEqual([]);
  });

  it("estoque nasce só de movimentações e o saldo derivado bate com o esperado", async () => {
    await runStagingSeed();
    const rows = (await sql<{ name: string; saldo: string; movimentos: number }>`
      select i.name, coalesce(sum(t.delta),0)::text as saldo, count(t.id)::int as movimentos
      from inventory_items i left join stock_transactions t on t.item_id = i.id
      group by i.name order by i.name`.execute(db)).rows;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(Number(byName["Arroz branco 5kg (Demo)"].saldo)).toBe(80);
    expect(byName["Arroz branco 5kg (Demo)"].movimentos).toBe(4); // inicial, entrada, saída, recebimento
    expect(Number(byName["Leite em pó lata (Demo)"].saldo)).toBe(40); // 60 - 20 (baixa da need atendida)
    expect(Number(byName["Cobertor casal (Demo)"].saldo)).toBe(5);
    expect(Number(byName["Fralda infantil M (Demo)"].saldo)).toBe(100);
  });

  it("--reset-passwords gera senhas novas sem criar usuários nem duplicar dados", async () => {
    await runStagingSeed();
    const before = await countTables();
    const reset = await runStagingSeed({ resetPasswords: true });
    const after = await countTables();
    expect(reset.credentials.every((c) => typeof c.password === "string")).toBe(true);
    expect(after).toEqual(before);
  });
});
