import superjson from "superjson";

export type OutputType = {
  cases: Array<{
    id: number;
    status: "aberto" | "conferido";
    organizationName: string;
    resourceTitle: string;
    offeredQuantity: number | null;
    offeredUnit: string | null;
    itemUnit: string;
    divergenceKind: "unidade_diferente" | "unidade_nao_classificada";
    openedAt: string;
  }>;
};

export const getUnitRegularizationPlatform = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/unit-regularization-platform`, {
    method: "GET",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as pendências de unidade das ofertas da rede");
  }
  return superjson.parse<OutputType>(await result.text());
};
