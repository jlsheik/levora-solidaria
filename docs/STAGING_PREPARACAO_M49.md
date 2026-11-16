# Preparação de staging — runbook consolidado (M49)

**Escopo:** guia único para uma pessoa técnica **autorizada** instalar, verificar, recuperar e desligar um staging do Levora Solidária. **Não é homologação**: foi ensaiado apenas localmente, com PostgreSQL descartável e dados sintéticos (ver "Evidência do ensaio"). Nenhum fornecedor foi escolhido; nenhum serviço foi contratado.

**Não há uma segunda arquitetura.** A arquitetura de staging já existente é a de `docker-compose.staging.yml` + `deploy/` + `Dockerfile` (staging zero-custo: `docs/STAGING_ZERO_COST.md`, `docs/STAGING_OPERATIONS.md`) e a instalação em servidor Linux de `docs/DEPLOYMENT_RUNBOOK.md`. Este documento só reúne os passos, acrescenta o que a M46–M49 mudou e aponta onde cada detalhe mora.

## 1. Dependências

| Item | Requisito | Fonte |
|---|---|---|
| Node.js | **22.x** (`engines`; CI e `Dockerfile` usam 22). **Validado na M50 com Node 22.23.5 (suíte integral, `release:validate` + `db-check`)**; a M49 havia rodado em Node 24 e isso **não** vale como prova. Sem módulos nativos (só o binário do `esbuild` em devDependencies) | `package.json`, `Dockerfile`, `.github/workflows/ci.yml` |
| PostgreSQL | 16 (versão ensaiada: 16.15); **`lc_messages='C'` recomendado**; `sslmode=require` fora de rede privada | `docs/RELEASE_VALIDACAO_LOCAL.md`, `docs/DEPLOYMENT_RUNBOOK.md` §5 |
| Proxy/TLS | nginx (`deploy/nginx*.conf`) ou equivalente; `TRUST_PROXY` = nº de saltos; a API escuta em todas as interfaces (`app.listen(PORT)`): **só deve ser alcançável pelo proxy** (firewall/rede privada) | `docs/DEPLOYMENT_RUNBOOK.md` §8 |
| Armazenamento de arquivos | disco local (`STORAGE_LOCAL_DIR`) ou S3-compatível | `.env.example`, `docs/BACKUP_RESTAURACAO_ARQUIVOS.md` |
| ClamAV (`clamd`) | **obrigatório em produção**; opcional em staging (`FILE_SCAN_MODE=required` + `CLAMD_HOST`) | `docs/ANTIMALWARE_ARQUIVOS.md`, `docs/PLANO_IMPLANTACAO_SCANNER.md` |
| SMTP | convites funcionam sem ele (mostram o link); **a recuperação de senha por e-mail (F1) só funciona com SMTP configurado e `APP_PUBLIC_URL` https** — sem SMTP o pedido não cria token e o log traz `smtp_nao_configurado` | `docs/RECUPERACAO_DE_ACESSO_ESPECIFICACAO.md` §7 |
| Chaves de identidade | `IDENTITY_CODE_PEPPER_V1` (≥ 32 bytes) e `MFA_ENCRYPTION_KEY_V1` (32 bytes em base64) + `_CURRENT`; **a prontidão passa a falhar em produção se faltarem (M49)** | `src/helpers/identityKeys.tsx` |

## 2. Matriz de configuração (nomes e comportamento; **sem valores**)

| Variável | Obrigatória | Padrão / efeito | Observação de segurança |
|---|---|---|---|
| `DATABASE_URL` | sim | — | segredo; TLS fora de rede privada |
| `JWT_SECRET` | sim | — | segredo longo e aleatório |
| `NODE_ENV` | sim em produção | `production` torna o antimalware **sempre** obrigatório | — |
| `PORT` | não | 3001 | — |
| `APP_PUBLIC_URL` | sim | link de convite/OAuth | HTTPS no staging público |
| `TRUST_PROXY` | sim atrás de proxy | nº de saltos | afeta rate limiting por IP |
| `IDENTITY_CODE_PEPPER_V<n>`, `IDENTITY_CODE_PEPPER_CURRENT` | sim | — | segredo; ≥ 32 bytes; versionado |
| `MFA_ENCRYPTION_KEY_V<n>`, `MFA_ENCRYPTION_KEY_CURRENT` | sim | — | segredo; 32 bytes base64; perder a chave invalida os TOTP cadastrados |
| `PLATFORM_MFA_REQUIRED` | não | `true` | `false` só vale com `LEVORA_ENVIRONMENT=staging` + banco `*_staging/_demo/_qa/_test` em host local |
| `LEVORA_ENVIRONMENT` | só para o seed | `staging` habilita o seed sintético | **nunca** em produção |
| `PASSWORD_RESET_TTL_MINUTES` | não | 30 (10–120) | validade do link de redefinição de senha (F1) |
| `EMAIL_TRANSPORT`, `SYNTHETIC_EMAIL_DIR` | não | só `synthetic` em testes/dev; **recusado em produção** | transporte sintético: nenhuma rede, nenhum e-mail real |
| `AGENT_EVENTS_SCHEDULER_ENABLED` | não | **ausente = desligado**; só `true` exato liga o processamento automático de eventos de agentes | manter desligado no primeiro deploy |
| `FILE_SCAN_MODE`, `CLAMD_HOST`, `CLAMD_PORT`, `CLAMD_TIMEOUT_MS`, `CLAMD_MAX_BYTES` | `CLAMD_HOST` obrigatório em produção | sem `CLAMD_HOST` nada é liberado (falha fechada) | `clamd` não autentica: rede privada |
| `FILE_SCAN_RETRY_*`, `FILE_SCAN_LEASE_SECONDS`, `FILE_SCAN_PENDING_GRACE_SECONDS` | não | padrões de engenharia, não política | — |
| `CLAMD_SIGNATURE_MAX_AGE_HOURS`, `FILE_SCAN_ALERT_*` | não | sem valor = "não definido" | decisão operacional pendente |
| `STORAGE_LOCAL_DIR` / `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REQUEST_TIMEOUT_MS` | um dos dois | disco local por padrão | segredos S3 |
| `SMTP_HOST/PORT/USER/PASS/FROM` | não | sem SMTP nenhum e-mail é enviado; o log registra só `smtp_nao_configurado` | segredos |
| `GOOGLE_*`, `MICROSOFT_*` | não | sem as três variáveis o botão responde "indisponível"; Microsoft: novo cadastro desabilitado | segredos; Microsoft não qualificada |
| `ANTHROPIC_API_KEY`, `LEVORA_AI_MODEL` | não | sem chave, escore determinístico | segredo |
| `APPROVAL_REQUEST_EXPIRATION_DAYS` | não | 7 | — |
| `LEVORA_MIGRATIONS_DIR`, `LEVORA_SKIP_PREFLIGHT`, `PGOPTIONS` | não | uso do runner de migrations | `LEVORA_SKIP_PREFLIGHT` só por decisão explícita |

## 3. Instalação (resumo; detalhes no runbook de deploy)

1. Provisionar PostgreSQL vazio (`lc_messages='C'`; usuário da aplicação sem privilégio de superusuário em produção — decisão de infraestrutura pendente).
2. Node 22 instalado no servidor/imagem (não substituir o Node de outros projetos). `npm ci` (ou, no artefato de produção, `npm ci --omit=dev`) · `npm run build` · `npm run build:server`.
3. **Use sempre `npm run db:*` (via `tsx`, que é dependência de produção) — os arquivos `dist-server/db/migrate.js` e `run-migrations.js` NÃO são autônomos** (procuram `schema.sql`/`migrations` ao lado do código compilado e falham; verificado na M50). O artefato de produção precisa conter a pasta `db/` (como o `Dockerfile` faz). **Banco novo:** `DATABASE_URL=… npm run db:migrate` (aplica `db/schema.sql` + marca as migrations 0001–0040). **Banco existente:** backup **antes**, depois `npm run db:migrate:incremental` (idempotente; use `npm run db:preflight` antes se houver legado). Nunca `psql -f` manual.
4. Definir as variáveis (§2) por mecanismo de segredos do ambiente (nunca no repositório).
5. Iniciar: `node dist-server/server/index.js` (nunca `npm start` sob systemd — `deploy/levora-api.service`).
6. Verificar (§5). Só então liberar tráfego pelo proxy.
7. Primeira conta de plataforma: `npm run platform:bootstrap-owner` (CLI no servidor; MFA obrigatório). Recuperação do owner: `npm run platform:owner-recovery`.
8. **Seed sintético (apenas staging):** `LEVORA_ENVIRONMENT=staging` e banco `*_staging`/`*_demo` → `node dist-server/db/seed-staging.js` (`--reset-passwords` gera novas senhas; exibidas só no terminal). Recusa-se fora de staging.

## 4. Operações automáticas

A aplicação registra, ao iniciar, as tarefas de `src/static/__dev/scheduled-jobs.json`. **"Agendador desligado" significa apenas `processAgentEvents`.** As demais rodam por padrão:

| Tarefa | Frequência (UTC) | Efeito |
|---|---|---|
| `runMatchingSweep` | */15 min | avalia correspondências (matching) |
| `expireReservations`, `expireAssignmentDeadlines` | */10 min | expira reservas e prazos |
| `expireOpportunities`, `expireApprovalRequests` | de hora em hora | expira ofertas e pedidos de dupla autorização |
| `verifyAuditChain` | a cada 6 h | verifica a cadeia de auditoria |
| `retryFileScans` | */5 min | reanalisa arquivos retidos (sem `CLAMD_HOST`, nada é aprovado) |
| `processAgentEvents` | opt-in | **desligada**: só com `AGENT_EVENTS_SCHEDULER_ENABLED=true` |

**Desabilitar operações automáticas** (sem mudar código): (a) `processAgentEvents` já está desligada; (b) pausa global e controles por agente em `automation-controls` / `platform-automation-controls` (interface "Automação"); (c) para parar *todo* o agendador num incidente, **interrompa o processo da API** (§6) — não existe hoje um interruptor de ambiente para as tarefas não opt-in (editar `scheduled-jobs.json` exige novo build; decisão de produto se for desejado). Ação manual (`agent-engine-run`) e reprocessamento operacional continuam protegidos por permissão; ver `docs/AGENTES_PLATAFORMA.md`.

## 5. Verificação (smoke de staging)

1. `GET /_api/__health` → 200 (liveness; não consulta banco).
2. `GET /_api/__ready` → **200** com `database`, `schema`, `identityKeys` = `ok` e `agentEventsScheduler` = `desabilitado`. **503** se o banco cair, houver migration não aplicada ou (em produção) faltarem as chaves de identidade. O corpo é grosseiro; detalhes só nos logs.
3. `scripts/staging-smoke.mjs` (login com conta sintética, cookie HttpOnly/Secure/SameSite, logout invalida a sessão, `x-request-id` do cliente ignorado, área de plataforma recusada a usuário comum, retry de tarefa de fundo recusado):
   `BASE=https://<staging> SEED_RAW=<arquivo com a saída do seed> node scripts/staging-smoke.mjs`
4. Jornadas de interface: `npm run qa:visual` (gate visual **desabilitado**; as 180 baselines não foram aprovadas) e as jornadas de navegador descritas em `docs/QA_VISUAL.md`.

## 6. Parar, observar, diagnosticar

- **Parar:** `SIGTERM` ao processo (encerramento gracioso de até 10 s); no systemd `systemctl stop levora-api`; no compose `docker compose -f docker-compose.staging.yml stop app`. O proxy deve responder 503 estático enquanto parado.
- **Observar:** uma linha JSON por evento (`http_request`, `scheduled_task`, `scheduler_task_disabled`, `readiness_check`, `server_start`, `startup_readiness`, `email_send`). Campos: `operationId` (devolvido em `x-request-id`), `errorCode`, rota registrada, status. Nunca corpo, cabeçalhos, cookies, e-mail ou mensagem de erro. Não há retenção/rotação nem alertas externos: dependem da plataforma escolhida.
- **Diagnosticar falha de inicialização:** `startup_readiness` no log mostra qual verificação falhou (`database`, `schema`, `identityKeys`); `GET /_api/__ready` repete o estado. Versão implantada: `git rev-parse HEAD` do artefato (ou `GITHUB_SHA` na imagem); migrations aplicadas: `select id from schema_migrations order by id` (somente leitura).

## 7. Migration, backup, restauração e rollback

- **Antes de qualquer migration** em ambiente com dados: `pg_dump -Fc` (ver `docs/DATABASE_RECOVERY.md`), e arquivar o log do runner.
- **Migrations não são todas reversíveis:** não existe "down". O retorno seguro é **restaurar o backup anterior à migration** num banco novo e apontar a aplicação para ele; nunca reverter à mão em produção.
- **Procedimento de rollback ensaiado (M49, local/sintético):** (1) parar tráfego/aplicação; (2) preservar evidência (logs, `pg_dump` do estado quebrado, saída de `__ready`); (3) `createdb` novo; (4) `pg_restore --no-owner` do backup anterior; (5) conferir contagens e a cadeia de auditoria; (6) iniciar a versão anterior do artefato apontando para o banco restaurado; (7) `__ready` = 200 e smoke; (8) só então reabrir tráfego. `git reset` não é procedimento de recuperação.
- Arquivos enviados têm backup próprio: `docs/BACKUP_RESTAURACAO_ARQUIVOS.md`. Backup de banco **não** inclui os objetos de upload.

## 8. Checklist de prontidão para iniciar a homologação em staging

- [ ] PostgreSQL provisionado (16, `lc_messages=C`, TLS, backup agendado e **restauração testada no próprio provedor**).
- [ ] Segredos no mecanismo do ambiente; nenhum no repositório; chaves de identidade geradas e **guardadas com cópia segura** (perder `MFA_ENCRYPTION_KEY` invalida TOTP).
- [ ] Proxy com TLS; API inacessível diretamente da Internet.
- [ ] `__ready` = 200; `agentEventsScheduler=desabilitado`.
- [ ] ClamAV conectado **ou** decisão explícita de que comprovantes ficam retidos no staging.
- [ ] Owner de plataforma criado pelo CLI; MFA inscrito.
- [ ] Smoke (§5) verde; evidência arquivada.
- [ ] Decisão sobre recuperação de acesso de usuários (ver `docs/LANCAMENTO_MATRIZ_FINAL.md`).

## 9. Diagnóstico por sintoma

| Sintoma | Causa provável | Onde confirmar | Ação |
|---|---|---|---|
| `__ready` 503, `schema=desatualizado` | migration não aplicada ou `schema_migrations` ausente | `select id from schema_migrations` | `npm run db:migrate:incremental` (após backup) |
| `__ready` 503, `database=falha` | banco inacessível, TLS/credencial, rede | log `readiness_check` `errorCode` | corrigir conectividade; a app não reinicia sozinha |
| `__ready` 503, `identityKeys=ausente` (produção) | `IDENTITY_CODE_PEPPER_V*` ou `MFA_ENCRYPTION_KEY_V*` ausente/curta | log `CHAVES_IDENTIDADE_AUSENTES` | definir as chaves (guardar cópia segura) |
| Login de conta de plataforma/MFA → HTTP 500 | mesmas chaves | log `IdentityKeyConfigError` | idem |
| Cookie de sessão não persiste | cookie `Secure` em HTTP, ou `TRUST_PROXY`/TLS errados | cabeçalhos da resposta | servir por HTTPS; ajustar `TRUST_PROXY` |
| Comprovante fica retido | sem `CLAMD_HOST` (falha fechada) ou `clamd` indisponível | auditoria `arquivo.analise_indisponivel`; `GET /_api/v1/destination-proofs-reconciliation` | conectar o ClamAV; `files-rescan` |
| Limites de taxa "estranhos" | contadores em memória por processo | — | uma instância, ou contadores compartilhados |
| Testes/`release:validate` com timeout no cleanup de banco | `DROP/CREATE DATABASE` espera um checkpoint forçado do PostgreSQL (lento em disco local sob a carga da suíte) | `log_checkpoints` do PostgreSQL | ver `docs/RELEASE_VALIDACAO_LOCAL.md` |

## 10. Segredos, TLS, isolamento e encerramento

- **Segredos:** nunca no repositório nem na imagem. Entregar como variáveis de ambiente por um mecanismo do ambiente (arquivo `EnvironmentFile` com permissão `0600` e dono `levora` no systemd, secrets do orquestrador ou cofre do provedor — **escolha pendente do fornecedor**). Gerar pepper (≥ 32 bytes) e chave AES (32 bytes base64) **por ambiente** (nunca reutilizar os de produção em staging); guardar cópia fora do servidor; rotação por versão (`_V2` + `_CURRENT`) sem apagar a anterior enquanto houver dado cifrado.
- **TLS:** terminar no proxy (`deploy/nginx*.conf` + `docs/DEPLOYMENT_RUNBOOK.md` §11); o cookie de sessão é `Secure`, então **o staging precisa de HTTPS** (exceto `localhost`). Conferir após a instalação: `curl -I https://<staging>/_api/__health` com cabeçalhos de segurança, redirecionamento 80→443, certificado válido e API inacessível diretamente na porta 3001.
- **Isolamento do staging:** banco **dedicado** (nome `*_staging`), segredos próprios, nenhum dado real, e-mails de domínio reservado (`@…invalid`/caixa de captura), `LEVORA_ENVIRONMENT=staging` só neste ambiente (habilita o seed sintético e, opcionalmente, `PLATFORM_MFA_REQUIRED=false` — **não use** em staging que valide MFA), sem credenciais de OAuth/SMTP de produção.
- **Encerrar com segurança:** (1) parar o tráfego no proxy; (2) `SIGTERM` na API e aguardar o encerramento gracioso; (3) backup final se houver evidência a preservar (`pg_dump -Fc`), guardado fora do host; (4) `drop database` do banco de staging; (5) remover o diretório de uploads sintéticos; (6) revogar/rotacionar os segredos do staging; (7) registrar data, responsável e destino das evidências. Nenhuma etapa toca em produção.

## 11. Requisitos mínimos de infraestrutura de staging (a consultar com o fornecedor)

**Não há preços nem dimensionamento medido em carga.** Os números abaixo são o que está **comprovado** ou **estimado (marcado)**.

| Recurso | Requisito | Base |
|---|---|---|
| Node | 22.x LTS (versão exata fixa e registrada) | `engines`; M50 validou 22.23.5 |
| API | 1 instância; pools de conexão pequenos (`max: 3` por pool; ver `docs/STAGING_OPERATIONS.md` §19) | código |
| CPU/RAM da API | **estimado** 1 vCPU / 512 MB–1 GB para uso piloto; confirmar medindo | sem teste de carga |
| PostgreSQL | 16, `lc_messages='C'` recomendado, TLS, rede privada, backup agendado com restauração testada no provedor, extensões: nenhuma além das padrão | ensaios M47–M50 |
| Banco: papéis | usuário da aplicação **sem** superusuário; usuário separado para migrations (decisão de infraestrutura pendente) | `docs/DEPLOYMENT_RUNBOOK.md` |
| Armazenamento | disco persistente para `STORAGE_LOCAL_DIR` **ou** S3-compatível; backup dos objetos é separado do `pg_dump` | `docs/BACKUP_RESTAURACAO_ARQUIVOS.md` |
| Proxy/TLS | nginx (ou equivalente) com certificado válido; API só acessível pelo proxy | `deploy/` |
| ClamAV (se comprovantes) | serviço `clamd` em rede privada; memória na ordem de alguns GB (a validação local usou limite de 5 GiB / 4 CPUs); `StreamMaxLength` ≥ `CLAMD_MAX_BYTES` | `docs/ANTIMALWARE_ARQUIVOS.md` |
| Logs | coleta do stdout JSON com retenção definida (política pendente) | `docs/RELEASE_VALIDACAO_LOCAL.md` |
| Monitoramento | sonda em `/_api/__ready` (200/503) e alerta de reinício | sem alertas externos hoje |
| Acesso | SSH/painel restrito; apenas pessoas autorizadas; nenhum banco exposto à Internet | — |
| Custos | **a consultar**: hospedagem, PostgreSQL gerenciado, armazenamento, backup, domínio/TLS, ClamAV, SMTP (se aprovado), GitHub Actions | nenhum autorizado |

## 12. Evidência do ensaio local (M49)

Banco descartável PostgreSQL 16.15 (`lc_messages=C`), build compilado em `NODE_ENV=production`: instalação do zero (`db:migrate`; incremental = "nenhuma pendente"); seed sintético; `__ready` 200 com agendador desligado; produção **sem** chaves de identidade → 503 (novo); smoke 13/13; "release ruim" simulada (migration removida de `schema_migrations` + tabela apagada) → `__ready` 503; `pg_dump`/`pg_restore` para banco novo com contagens idênticas; aplicação apontada para o banco restaurado com smoke 13/13 e escritas posteriores; cadeia de auditoria 93/93 íntegra. Evidências em `C:\Users\JL\levora-ensaio-ciclo1-20261018\m49-evidence\rehearsal\`. **Não** cobre: infraestrutura real, TLS real, ClamAV real nesta rodada, SMTP, carga, Firefox/Safari, leitor de tela.
