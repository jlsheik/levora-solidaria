import {type GeneratedAlways, Kysely, CamelCasePlugin} from 'kysely'
import {PostgresJSDialect} from 'kysely-postgres-js'
import {DB, kyselyIdentifierOverrides} from './schema.js'
import postgres from 'postgres'

// kysely's CamelCasePlugin can't recover a snake_case name that has an
// underscore directly before a digit (reminder_48h_sent -> reminder48hSent ->
// reminder48h_sent). The generated schema exports the exact spelling for such
// identifiers; everything else falls through to the default mapping.
class FlootCamelCasePlugin extends CamelCasePlugin {
  protected override snakeCase(str: string): string {
    return kyselyIdentifierOverrides[str] ?? super.snakeCase(str)
  }
}

// Fora do Floot não existe mais a variável FLOOT_DATABASE_URL provisionada
// automaticamente pela plataforma — usamos a convenção padrão DATABASE_URL,
// mantendo FLOOT_DATABASE_URL como alias por compatibilidade caso algum
// ambiente antigo ainda a defina.
const connectionString = process.env.DATABASE_URL || process.env.FLOOT_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL não definida. Configure-a no .env (veja .env.example) apontando para o Postgres."
  );
}

const pgClient = postgres(connectionString, {
  prepare: false,
  idle_timeout: 10,
  max: 3,
});

export const db = new Kysely<DB>({
plugins: [new FlootCamelCasePlugin()],
dialect: new PostgresJSDialect({
postgres: pgClient,
}),
})

// Pool SEPARADO, só para src/helpers/scheduledTaskLock.tsx reservar uma
// conexão dedicada (`.reserve()`) e manter um advisory lock de sessão vivo
// durante toda a execução de uma tarefa agendada.
//
// Achado real (Fase 62, staging zero-custo): antes desta separação,
// `reserveDedicatedConnection()` tirava a conexão do MESMO pool `pgClient`
// (max: 3) usado por toda query comum da aplicação via Kysely. Reproduzido
// de verdade: após algumas horas rodando o staging, 3 tarefas agendadas
// tiveram sua janela de reserva sobreposta (não é preciso que colidam no
// mesmo advisory lock — cada tarefa usa objId diferente e todas podem
// reservar ao mesmo tempo), esgotando as 3 conexões do pool inteiro. Como
// o corpo de uma tarefa agendada (`fn()`, ex. expireReservations) também
// precisa do mesmo pool para suas próprias queries via `db`, e não sobrava
// nenhuma conexão livre, `fn()` ficava para sempre esperando uma conexão
// que nunca seria liberada — um deadlock total e permanente da aplicação
// inteira (toda rota que toca o banco, não só o scheduler, trava), só
// resolvido reiniciando o processo. Confirmado via `pg_stat_activity`: 3
// conexões "idle" penduradas, última query `pg_try_advisory_lock`, e
// `login_with_password` (e qualquer outra rota) travando indefinidamente
// até elas serem encerradas manualmente.
//
// Correção: pool próprio, nunca compartilhado com `pgClient`, dimensionado
// para o número de tarefas nomeadas em SCHEDULED_TASK_LOCK_IDS — mesmo que
// as 5 tarefas tentem reservar ao mesmo tempo (pior caso teórico), nenhuma
// delas pode mais roubar conexão da aplicação, e vice-versa.
const scheduledTaskLockClient = postgres(connectionString, {
  prepare: false,
  idle_timeout: 10,
  max: 5,
});

export async function reserveDedicatedConnection() {
  return scheduledTaskLockClient.reserve();
}

// Fase 56 — graceful shutdown: fecha os pools de conexões de verdade (espera
// as conexões ociosas, não mata uma query em andamento) em vez de deixar o
// processo encerrar com conexões TCP abertas penduradas. `timeout` em
// segundos é o limite de espera antes de forçar o fechamento — mesmo
// parâmetro que a biblioteca `postgres` já expõe nativamente.
export async function closeDbPool(timeoutSeconds = 5): Promise<void> {
  await Promise.all([
    pgClient.end({ timeout: timeoutSeconds }),
    scheduledTaskLockClient.end({ timeout: timeoutSeconds }),
  ]);
}
