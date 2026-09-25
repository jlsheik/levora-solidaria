import { z } from "zod";
import superjson from "superjson";
import type { OrganizationType, OrganizationStatus } from "../helpers/schema";

export const schema = z.object({});

export type OutputType = {
  organizations: Array<{
    id: number;
    name: string;
    type: OrganizationType;
    status: OrganizationStatus;
    city: string;
    state: string;
  }>;
};

export const getPlatformOrganizations = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/platform-organizations`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as organizações");
  }
  return superjson.parse<OutputType>(await result.text());
};
