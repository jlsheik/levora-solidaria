import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({});

export type PlatformLimitView = {
  key: string;
  kind: "number" | "list";
  defaultValue: number | string[];
  /** Valor global em vigor (padrão em código, ou ajuste gravado). */
  globalValue: number | string[];
  /** Quantas organizações restringiram este limite (só o número; sem identificar organizações). */
  organizationsRestricting: number;
};

/** `globalWriteEnabled: false` — a edição do limite global pela interface NÃO existe: faltam regras de negócio definidas (quem autoriza, faixas aceitáveis, dupla confirmação). */
export type OutputType = { limits: PlatformLimitView[]; globalWriteEnabled: false; pendingDecisions: string[] };

export const getPlatformPolicyLimits = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/platform-policy-limits`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os limites globais");
  }
  return superjson.parse<OutputType>(await result.text());
};
