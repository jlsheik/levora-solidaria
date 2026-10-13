import type { Transaction } from "kysely";
import type { DB } from "./schema.js";

/**
 * ORDEM CANÔNICA DE LOCKS (Fase 89; docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §25.18). Toda transação que toca
 * identidade/credenciais/sessões/plataforma adquire locks SOMENTE nesta ordem, para que duas operações concorrentes
 * nunca formem um ciclo (deadlock):
 *
 *   1. organizations            (lockOrganization / lockOrganizationsInOrder — membershipAdmin.tsx)
 *   2. users                    (a linha do usuário; vários usuários SEMPRE em ordem crescente de id)
 *   3. platform_access          (a linha do usuário; várias em ordem crescente de user_id)
 *   4. credenciais              (user_passwords, user_identities, mfa_*; por id)
 *   5. sessions                 (por id)
 *   6. registration_access_codes / platform_bootstrap_tokens (futuros)
 *   7. audit_log                (SEMPRE por último: a hash-chain toma um advisory lock global)
 *
 * Regra adicional: nenhuma chamada externa (provedor OIDC, bcrypt de senha nova) dentro de transação com lock.
 */

/** Passo 2: trava as linhas de `users` em ordem crescente de id. Devolve os ids que existem. */
export async function lockUsersInOrder(trx: Transaction<DB>, userIds: number[]): Promise<number[]> {
  const unique = [...new Set(userIds)].sort((a, b) => a - b);
  if (unique.length === 0) return [];
  const rows = await trx.selectFrom("users").select("id").where("id", "in", unique).orderBy("id", "asc").forUpdate().execute();
  return rows.map((r) => r.id);
}

/** Passo 3: trava as linhas de `platform_access` dos usuários dados (ordem crescente de user_id). */
export async function lockPlatformAccessInOrder(trx: Transaction<DB>, userIds: number[]) {
  const unique = [...new Set(userIds)].sort((a, b) => a - b);
  if (unique.length === 0) return [];
  return trx.selectFrom("platformAccess").selectAll().where("userId", "in", unique).orderBy("userId", "asc").forUpdate().execute();
}
