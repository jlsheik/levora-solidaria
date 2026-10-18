import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { parseLevoraPgOptions, pgConnectionFromEnv } from "../db/connectionOptions";

describe("db/connectionOptions: ponte de PGOPTIONS (namespace levora.) para as ferramentas de migração", () => {
  it("sem PGOPTIONS não acrescenta nada", () => {
    expect(parseLevoraPgOptions(undefined)).toEqual({});
    expect(parseLevoraPgOptions("   ")).toEqual({});
    expect(pgConnectionFromEnv({})).toEqual({});
  });

  it("aceita -c, -cNOME=VALOR e --NOME=VALOR do namespace levora.", () => {
    expect(parseLevoraPgOptions("-c levora.platform_owner_user_id=4")).toEqual({ "levora.platform_owner_user_id": "4" });
    expect(parseLevoraPgOptions("-clevora.a=1 --levora.b=x_y")).toEqual({ "levora.a": "1", "levora.b": "x_y" });
    expect(pgConnectionFromEnv({ PGOPTIONS: "-c levora.platform_owner_user_id=4" } as NodeJS.ProcessEnv)).toEqual({ connection: { "levora.platform_owner_user_id": "4" } });
  });

  it("recusa em vez de aplicar em silêncio: outros parâmetros, valores com caracteres perigosos e opções desconhecidas", () => {
    for (const bad of ["-c statement_timeout=1", "-c search_path=public", "-c levora.x=1;DROP", "-c levora.x='1'", "-c levora.x", "-x levora.x=1", "levora.x=1"]) {
      expect(() => parseLevoraPgOptions(bad), bad).toThrow(/PGOPTIONS/);
    }
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
