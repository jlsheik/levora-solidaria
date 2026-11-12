import superjson from "superjson";
import type { ControlState } from "./automation-controls_GET.schema.js";

export type OutputType = { global: ControlState };

export const getPlatformAutomationControls = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/platform-automation-controls`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a automação da plataforma");
  }
  return superjson.parse<OutputType>(await result.text());
};
