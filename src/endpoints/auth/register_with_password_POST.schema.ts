import { z } from "zod";
import superjson from "superjson";
import { newPasswordSchema } from "../../helpers/passwordPolicy.js";

// Fase 51: regra canônica de normalização de e-mail adotada de forma
// consistente em todo endpoint que aceita e-mail como entrada (aqui,
// login_with_password_POST.schema.ts e organization-invites_POST.schema.ts)
// — trim() ANTES de validar o formato, nunca só num desses lugares. Antes
// desta fase, um e-mail com espaço externo (comum em copiar/colar) era
// REJEITADO (z.string().email() sozinho não aceita espaço), nunca
// corrigido silenciosamente — comportamento já consistente entre os três
// endpoints, mas desnecessariamente hostil a um erro de digitação trivial.
export const schema = z.object({
  email: z.string().trim().email("Informe um e-mail válido"),
  password: newPasswordSchema,
  displayName: z.string().min(1, "Nome é obrigatório"),
  // Fase 91: código de acesso emitido pela plataforma (provisionamento). A canonicalização/validação é SÓ no servidor; o cliente
  // apenas limita o tamanho. Nunca vira credencial de login.
  accessCode: z.string().trim().min(1, "Informe o código de acesso").max(64, "Código de acesso inválido"),
});

// Fase 51 (SEC-03): nunca `{ user: User }` — o endpoint não cria sessão
// nem devolve dado de usuário, exatamente para a resposta pública nunca
// distinguir "e-mail já cadastrado" de "conta nova criada agora" (ver
// docs/SECURITY.md). A mensagem é sempre a mesma, que o e-mail já
// existisse ou não.
export type OutputType = {
  message: string;
};

export const postRegister = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/auth/register_with_password`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include", // Important for cookies to be sent and received
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível criar a conta");
  }

  return superjson.parse<OutputType>(await result.text());
};
