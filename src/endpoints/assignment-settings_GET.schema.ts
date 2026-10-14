import superjson from "superjson";

export type OutputType = {
  responseDeadlineHours: number;
  isDefault: boolean;
  updatedAt: string | null;
  updatedByUserId: number | null;
  reassignmentPauseDays: number;
  minHours: number;
  maxHours: number;
};

export const getAssignmentSettings = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/assignment-settings`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a configuração do prazo");
  }
  return superjson.parse<OutputType>(await result.text());
};
