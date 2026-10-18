import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { parseLevoraPgOptions, pgConnectionFromEnv } from "../db/connectionOptions";

describe("db/connectionOptions: ponte de PGOPTIONS (lista fechada de levora.*) para as ferramentas de migração", () => {
  it("sem PGOPTIONS não acrescenta nada", () => {
    expect(parseLevoraPgOptions(undefined)).toEqual({});
    expect(parseLevoraPgOptions("   ")).toEqual({});
    expect(pgConnectionFromEnv({})).toEqual({});
  });

  it("aceita -c, -cNOME=VALOR e --NOME=VALOR somente para levora.platform_owner_user_id", () => {
    expect(parseLevoraPgOptions("-c levora.platform_owner_user_id=4")).toEqual({ "levora.platform_owner_user_id": "4" });
    expect(parseLevoraPgOptions("-clevora.platform_owner_user_id=12")).toEqual({ "levora.platform_owner_user_id": "12" });
    expect(parseLevoraPgOptions("--levora.platform_owner_user_id=9")).toEqual({ "levora.platform_owner_user_id": "9" });
    expect(pgConnectionFromEnv({ PGOPTIONS: "-c levora.platform_owner_user_id=4" } as NodeJS.ProcessEnv)).toEqual({ connection: { "levora.platform_owner_user_id": "4" } });
  });

  it("recusa em vez de aplicar em silêncio: parâmetros do PostgreSQL, outros levora.*, valores fora do formato e opções desconhecidas", () => {
    const bad = [
      "-c statement_timeout=1", "-c search_path=public", "-c session_replication_role=replica", // parâmetros do servidor
      "-c levora.outro=1", "-c levora.platform_owner_user_id.x=1", "-c levora.bypass_guard=on", // namespace aberto não vale
      "-c levora.platform_owner_user_id=0", "-c levora.platform_owner_user_id=007", "-c levora.platform_owner_user_id=-1", "-c levora.platform_owner_user_id=1;DROP",
      "-c levora.platform_owner_user_id='1'", "-c levora.platform_owner_user_id=", "-c levora.platform_owner_user_id=12345678901", "-c levora.platform_owner_user_id",
      "-x levora.platform_owner_user_id=1", "levora.platform_owner_user_id=1",
    ];
    for (const b of bad) expect(() => parseLevoraPgOptions(b), b).toThrow(/PGOPTIONS/);
  });

  it("uma opção válida acompanhada de uma inválida recusa tudo (nada é aplicado pela metade)", () => {
    expect(() => parseLevoraPgOptions("-c levora.platform_owner_user_id=4 -c statement_timeout=1")).toThrow(/PGOPTIONS/);
  });

  it("a configuração chega à sessão do banco (o que a migração 0026 lê com current_setting)", async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ...pgConnectionFromEnv({ PGOPTIONS: "-c levora.platform_owner_user_id=7" } as NodeJS.ProcessEnv) });
    try {
      const [r] = await sql`SELECT current_setting('levora.platform_owner_user_id', true) AS v`;
      expect(r.v).toBe("7");
    } finally { await sql.end(); }
    const plain = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    try {
      const [r] = await plain`SELECT NULLIF(current_setting('levora.platform_owner_user_id', true), '') AS v`;
      expect(r.v).toBeNull();
    } finally { await plain.end(); }
  });
});
