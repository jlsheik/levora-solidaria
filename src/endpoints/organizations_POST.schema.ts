import { z } from "zod";
import superjson from "superjson";
import { OrganizationTypeArrayValues, type OrganizationType, type OrganizationStatus } from "../helpers/schema.js";

export const schema = z.object({
  name: z.string().min(2, "Informe o nome da organização"),
  type: z.enum(OrganizationTypeArrayValues, {
    errorMap: () => ({ message: "Selecione o tipo de organização" }),
  }),
  city: z.string().min(2, "Informe a cidade"),
  state: z
    .string()
    .length(2, "Use a sigla do estado, ex: MG")
    .transform((s) => s.toUpperCase()),
  documentId: z.string().optional(),
});

export type OutputType = {
  organization: {
    id: number;
    name: string;
    slug: string;
    type: OrganizationType;
    status: OrganizationStatus;
    city: string;
    state: string;
    createdAt: string;
  };
  role: "proprietario";
};

export const postOrganizations = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organizations`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível criar a organização");
  }

  return superjson.parse<OutputType>(await result.text());
};
