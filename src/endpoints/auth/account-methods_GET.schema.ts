import { authRequest } from "../../helpers/authClient.js";

/** Métodos de acesso da conta autenticada (para a interface escolher a forma de confirmar uma ação crítica). Nunca devolve segredos. */
export type OutputType = { hasPassword: boolean; providers: string[]; mfaActive: boolean };

export const getAccountMethods = () => authRequest<OutputType>("GET", "account-methods");
