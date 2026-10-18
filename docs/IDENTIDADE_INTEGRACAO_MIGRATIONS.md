# Integração da identidade na `master`: renumeração e compatibilidade das migrations

> **Status:** integração em branch isolada (`integration/identity-master-20261018`), **não** mesclada. Nada aqui foi aplicado em staging ou produção. As verificações citadas foram feitas em bancos **locais de desenvolvimento/teste** e em bancos descartáveis; dados sintéticos não provam compatibilidade com dados históricos reais.

## 1. Por que renumerar

A cadeia de identidade (branches `fase-89` a `fase-93-3`, preservadas em `archive/preserve-20261018/*`) foi escrita sobre uma base que terminava na migration **0013** e usou os números 0015–0020. A `master` ocupou **0014–0025** com outras migrations. Os nomes de arquivo diferem, então o Git não acusou conflito, mas os **números** colidem, e a ordem alfabética do runner misturaria as duas sequências.

O runner (`db/run-migrations.ts`) registra em `schema_migrations` o **nome do arquivo** e aplica na ordem alfabética. Renomear uma migration **não** a torna "já aplicada" num banco que a aplicou com o nome antigo: ela seria reaplicada.

| Nome original | Nome nesta branch |
|---|---|
| `0015_identity_foundation.sql` | `0026_identity_foundation.sql` |
| `0016_mfa_foundation.sql` | `0027_mfa_foundation.sql` |
| `0017_registration_access_codes.sql` | `0028_registration_access_codes.sql` |
| `0018_google_identity.sql` | `0029_google_identity.sql` |
| `0019_social_reauth.sql` | `0030_social_reauth.sql` |
| `0020_microsoft_identity.sql` | `0031_microsoft_identity.sql` |

Os arquivos já integrados na `master` (0001–0025) **não foram alterados**. O conteúdo SQL das seis migrations é o original; só o nome (e um comentário no cabeçalho da 0026) mudou. A reserva `0014_agent_platform.sql` (plataforma de agentes) **não** faz parte desta integração e precisará de um número livre posterior (≥ 0032) quando for integrada.

## 2. Contrato de compatibilidade (`db/migrationCompat.ts`, `db/legacyPreflight.ts`)

O projeto exige que toda migration seja classificada. Esta integração acrescenta:

| Migration | Classe | Motivo resumido |
|---|---|---|
| 0026 identity_foundation | **precheck** | `ADD CONSTRAINT UNIQUE (user_id)` em `user_passwords` e aborto se houver mais de um `users.role = 'admin'` sem designação |
| 0027 mfa_foundation | safe (restrição satisfeita por construção) | tabelas novas e colunas anuláveis |
| 0028 registration_access_codes | safe (restrição satisfeita por construção) | coluna anulável `users.registered_via_code_id` (todas NULL) com UNIQUE e FK |
| 0029 google_identity | safe (tabela nova vazia) | só `CREATE TABLE` |
| 0030 social_reauth | safe (restrição satisfeita por construção) | coluna anulável e CHECKs satisfeitos pelas linhas existentes |
| 0031 microsoft_identity | safe (restrição satisfeita por construção) | CHECK de provider e coluna com DEFAULT `{}` |

A verificação nova da 0026 (`CHECKS`) lista **só ids** e é **somente leitura**. Ela bloqueia (`db:preflight` e início do `db:migrate:incremental`, código 2) quando:
- existe usuário com mais de uma linha em `user_passwords`; ou
- existe mais de um admin ativo e a variável `levora.platform_owner_user_id` não designa um deles.

Ensaio em banco de **desenvolvimento local** (`levora_solidaria`, 13 migrations aplicadas, leitura apenas): a verificação bloqueou com `admins:1,18,63`, ou seja, **três** admins sem designação. Isso confirma o comportamento, e mostra que aplicar a 0026 nesse banco exige uma decisão humana sobre quem é o Platform Owner.

## 3. Bancos locais que já registram os nomes antigos

Consulta somente-leitura de `schema_migrations` em todos os bancos locais de desenvolvimento/teste:

- **`levora_f933_test`** (qualificação Microsoft da Fase 93.3): registra **os seis nomes antigos** (`0015_…` a `0020_…`) e **não** tem as migrations 0014 a 0025 da `master`. Contém 0 usuários e 1 linha em `oauth_attempts`.
- **`levora_solidaria`** (desenvolvimento): 13 migrations (até a 0013); **nenhum** nome antigo.
- Os demais 33 bancos de teste foram criados só por `db/schema.sql` e **não têm** `schema_migrations`.

### Estratégia por situação (proposta; nada foi executado nesses bancos)

1. **Banco novo** (instalação nova): `db:migrate` aplica o `schema.sql` cumulativo e carimba todos os arquivos, inclusive 0026–0031. Sem risco de reaplicação.
2. **Banco existente sem os nomes antigos** (ex.: `levora_solidaria`): `db:migrate:incremental`, depois de `db:preflight` com código 0. Se houver mais de um admin, designar o owner: `PGOPTIONS="-c levora.platform_owner_user_id=<id>"`.
3. **Banco que aplicou os nomes antigos** (hoje só `levora_f933_test`): **não** rodar o runner. Opções: (a) descartar e recriar (é um banco de teste); (b) após comprovar que o schema é equivalente ao das seis migrations, renomear os registros numa única transação (`UPDATE schema_migrations SET id = '<novo>' WHERE id = '<antigo>'` para as seis), e só então aplicar as migrations da `master` que faltam (0014–0025). A opção (b) **exige** comparar `pg_dump --schema-only` com o esperado e **não foi feita**.
4. **Produção/staging:** **não foram consultados**. Antes de qualquer migração, é preciso verificar por leitura quais nomes `schema_migrations` registra; se algum ambiente aplicou os nomes antigos, vale a estratégia 3.

## 4. O que esta integração deliberadamente não inclui

- Plataforma de agentes (`0014_agent_platform.sql`), página Conta e os três arquivos de QA locais.
- O checkpoint `docs/CHECKPOINT_LOGIN_SOCIAL_PREVIEW_2026-10-13.md` e a edição do `docs/CHECKPOINT_MICROSOFT_OAUTH_FASE93_3.md` feitas no merge `bc8c544`: descrevem uma worktree local e numeração antiga. A única alteração funcional do merge, `LEVORA_API_PROXY_TARGET` em `vite.config.ts`, foi levada.
- Nenhuma credencial OAuth real. A autenticação Microsoft **continua não qualificada para produção** (ver `docs/CHECKPOINT_MICROSOFT_OAUTH_FASE93_3.md`).
