import {type GeneratedAlways, Kysely, CamelCasePlugin} from 'kysely'
import {PostgresJSDialect} from 'kysely-postgres-js'
import {DB, kyselyIdentifierOverrides} from './schema'
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

export const db = new Kysely<DB>({
plugins: [new FlootCamelCasePlugin()],
dialect: new PostgresJSDialect({
postgres: postgres(connectionString, {
prepare: false,
idle_timeout: 10,
max: 3,
}),
}),
})
