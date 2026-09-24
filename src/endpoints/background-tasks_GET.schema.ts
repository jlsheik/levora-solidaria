import { z } from "zod";
import superjson from "superjson";
import type { BackgroundTaskStatus, Json } from "../helpers/schema";

export const schema = z.object({});

export type OutputType = {
  runs: Array<{
    id: string;
    taskName: string;
    status: BackgroundTaskStatus;
    attemptCount: number;
    maxAttempts: number;
    error: Json | null;
    result: Json | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  }>;
};

export const getBackgroundTasks = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/background-tasks`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as tarefas");
  }
  return superjson.parse<OutputType>(await result.text());
};
