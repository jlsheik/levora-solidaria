import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  email: z.string().email("Informe um e-mail válido"),
  // Não faz sentido convidar alguém direto como "proprietário" por e-mail —
  // esse papel só existe hoje por ter criado a organização; convite cria
  // administrador, operador ou voluntário.
  role: z.enum(["administrador", "operador", "voluntario"]),
});

export type OutputType = {
  invite: {
    id: number;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
    createdAt: string;
  };
  // Só vem preenchido nesta resposta (criação) — nunca mais depois, mesmo
  // que o convite seja consultado de novo.
  acceptUrl: string;
  emailSent: boolean;
};

export const postOrganizationInvites = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organization-invites`, {
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
    throw new Error(errorData.message || "Não foi possível criar o convite");
  }

  return superjson.parse<OutputType>(await result.text());
};
