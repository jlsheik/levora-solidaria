# Validação local de release e prontidão operacional (M46)

**Escopo:** medida PROVISÓRIA, local e reproduzível, enquanto o CI remoto estiver indisponível. Não substitui CI independente, revisão humana nem homologação em ambiente representativo.

## Comandos
- `npm run release:validate` — executa, em ordem e em processos separados, os gates que existem: `git diff --check`, arquivos inesperados (segredos/dumps/logs), typecheck cliente e servidor, build cliente e servidor, suíte de backend (exige PostgreSQL **local** com banco terminado em `_test` e `JWT_SECRET` sintético), suíte de interface. Opcionais: `--with-db-check`, `--with-audit` (rede). Cada etapa tem log e resultado próprios; qualquer falha dá exit code 1 e nomeia a etapa; etapas não executadas aparecem como `NAO_EXECUTADA` (o veredito vira `PASSOU_PARCIAL`). **Não há script de lint no repositório; nenhuma verificação de lint é feita.**
- `npm run release:db-check` — em PostgreSQL local descartável (`RELEASE_CHECK_ADMIN_URL`, `PG_BIN`): banco novo; atualização incremental a partir do schema da master de referência com dados sintéticos preservados e schema final idêntico ao do banco novo; falha controlada de uma migration (nada parcial persiste e a aplicação NÃO fica “pronta”); reexecução sem efeito; `pg_dump`/`pg_restore` com contagens, checksums, restrições e cadeia de auditoria. Recusa host que não seja local. Cria e remove seus próprios bancos.

## Prontidão e vivacidade
- `GET /_api/__health` — **liveness**: o processo responde; não consulta o banco.
- `GET /_api/__ready` — **readiness**: 200 só se o banco responde **e** todas as migrations do código estão em `schema_migrations`; 503 caso contrário. Corpo grosseiro (`database`, `schema`, `scheduler`, `agentEventsScheduler`, `identityKeys`), sem nomes de migration, erros, URLs ou dados de organizações. **M49:** `identityKeys` = `ausente` (pepper ≥ 32 bytes ou chave de cifra do TOTP ausente/inválida) torna a aplicação **não pronta (503) quando `NODE_ENV=production`**; fora de produção apenas sinaliza. Antes, a falta das chaves só aparecia como HTTP 500 no primeiro login de conta protegida por MFA. Sinal para um orquestrador/monitor futuro; nenhum alerta externo é enviado.

## Logs estruturados
Uma linha JSON por evento (`http_request`, `scheduled_task`, `scheduler_task_disabled`, `readiness_check`, `server_start`, `startup_readiness`, `email_send`): `ts`, `level`, `event`, `status`, `operationId` (também devolvido em `x-request-id`), `durationMs`, `errorCode` seguro e contexto mínimo (rota registrada, método, status HTTP). Nunca corpo, cabeçalhos, cookies, usuário, organização ou mensagem de erro. No processo do servidor, objetos de erro impressos por `console.error` viram `[erro CÓDIGO]`. Sem retenção automática (depende de política).

## Agendador
`processAgentEvents` fica desabilitado por padrão; ver `docs/AGENTES_PLATAFORMA.md`.

## Idioma do PostgreSQL de teste (M47)
Alguns testes comparam mensagens de erro do servidor. Para o resultado não depender do idioma do Windows ou da instalação: (1) `test/global-setup.ts` executa `ALTER DATABASE <banco_test> SET lc_messages = 'C'` e **falha de forma explícita** se o idioma efetivo não for inglês/`C`; (2) recomenda-se iniciar o PostgreSQL de teste com `lc_messages = 'C'` (`initdb --lc-messages=C`). As três asserções que dependiam do texto (`check`, `null value`, `read-only`) agora verificam o SQLSTATE (`23514`, `23502`, `25006`). Provado com o servidor em `Portuguese_Brazil.1252`: sem a correção, 3 falhas; com ela, 0.

## Cleanup de bancos temporários e checkpoints do PostgreSQL (M50)
Em uma rodada integral (M49) o `afterAll` de `test/schemaMigrationsData.test.ts` excedeu os 30 s padrão. **Causa medida (não presumida):** `CREATE DATABASE` e `DROP DATABASE … WITH (FORCE)` fazem o PostgreSQL executar um **checkpoint imediato e esperar por ele** (`log_checkpoints`: 79 dos 86 checkpoints da rodada eram "immediate force wait"). Sob a escrita simultânea da suíte, no disco local do Windows, esses checkpoints levaram em média 12,2 s e até **290 s** (sync de ~183 mil arquivos), enquanto o arquivo isolado faz o cleanup em ~3 s (setup ~12 s, total ~33 s). Não há vazamento: ao fim da execução havia 0 conexões, 0 locks não concedidos, 0 transações preparadas e nenhum processo órfão.
**Mitigação para servidores de teste descartáveis:** `fsync=off` (apenas em PostgreSQL local descartável, nunca em banco com dado a preservar). Mesma suíte integral, mesma árvore de código: duração do backend 2609 s → 1658 s; checkpoints em média 6,5 s, máximo 157 s (4 acima de 60 s). **Reduz, mas não elimina**, a espera; por isso o cleanup mantém o orçamento de 240 s (o mesmo do `beforeAll`): com `fsync=off` o pior caso observado (157 s) cabe; com `fsync=on` o pior caso observado (290 s) pode exceder. Não é um travamento: a espera termina quando o checkpoint termina. Evidências: `m50-evidence/pg-checkpoints-fsync-*.log`, `cleanup-*.txt`.

## Limites
Resultados locais, com dados sintéticos. Backup/restauração aqui não equivalem a backup de produção homologado. Não foram testados: infraestrutura real, e-mail/SMTP, scanner antimalware real, Safari/Firefox, leitor de tela.
