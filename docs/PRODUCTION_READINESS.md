# Prontidão para produção — Levora Solidária

Fase 55. Auditoria de arquitetura, não um deploy. Nenhuma infraestrutura
foi contratada, nenhum domínio alterado, nenhum dado real usado para
produzir este documento — tudo abaixo vem de ler o código real e, onde
indicado, de testes já executados em fases anteriores desta mesma sessão
(Fases 46–54).

Classificação usada em todo o documento:

- **PRONTO** — funciona hoje, sem depender de nada externo ainda não
  decidido.
- **PRONTO COM DEPENDÊNCIA OPERACIONAL** — o código está correto, mas o
  comportamento final depende de uma configuração de infraestrutura que
  ainda não foi escolhida (ex.: `TRUST_PROXY` precisa saber a topologia
  real de proxy).
- **PRECISA DE IMPLEMENTAÇÃO** — falta código.
- **PRECISA DE DECISÃO DE INFRAESTRUTURA** — o código não resolve isso
  sozinho; alguém precisa escolher um provedor/arquitetura primeiro.
- **NÃO NECESSÁRIO NO ESTADO ATUAL** — existe um motivo concreto para não
  precisar disso agora (volume, escala, ou já coberto de outra forma).

---

## 1. Arquitetura atual

```
Browser
  │
  ▼
Frontend estático (dist/, build do Vite)      ◄── PRECISA DE DECISÃO DE INFRAESTRUTURA
  │  (quem serve isto? nginx? CDN? ver seção 3)
  ▼
Proxy / CDN / TLS                              ◄── PRECISA DE DECISÃO DE INFRAESTRUTURA
  │  (termina HTTPS, encaminha /_api/* para o processo Node)
  ▼
Express API (server/index.ts, processo Node)   ◄── PRONTO (single-process)
  │
  ├──► PostgreSQL                              ◄── PRONTO (backup/restore testado, Fase 57)
  ├──► Scheduler (node-cron, mesmo processo)    ◄── PRONTO (single-process) / PRECISA DE DECISÃO (multi-processo)
  ├──► Storage de arquivos                      ◄── PRONTO (disco local) / PRECISA DE DECISÃO (múltiplas instâncias)
  ├──► E-mail (SMTP)                            ◄── IMPLEMENTADO SEM INFRAESTRUTURA (SMTP não configurado)
  └──► IA (Anthropic)                           ◄── IMPLEMENTADO SEM INFRAESTRUTURA (chave não configurada)
```

**Fato arquitetural central** (Fase 50, reconfirmado aqui): `server/index.ts`
só serve `/_api/*`. Ele **nunca** serve o HTML/JS/CSS do cliente. Isso não
é um bug — é uma separação deliberada entre API e frontend estático — mas
significa que "rodar a Levora Solidária" não é "subir um processo Node" e
pronto: são **duas peças** (frontend estático + API), e a peça que serve o
frontend ainda não foi escolhida.

### Distinção pedida pela fase

| Componente | Já implementado | Implementado mas sem infraestrutura | Só preparado no código | Ainda não implementado |
|---|---|---|---|---|
| API Express | ✅ | | | |
| Autenticação/sessão | ✅ | | | |
| RBAC multi-tenant | ✅ | | | |
| Rate limiting | ✅ (single-process) | | | |
| Security headers/CSP (API) | ✅ | | | |
| CSP do documento HTML | ✅ (via `<meta>` no build) | | header HTTP completo (`frame-ancestors`) depende da camada estática | |
| Audit hash-chain + verificação periódica | ✅ | | | |
| Scheduler (4+1 tarefas) | ✅ (single-process) | | | |
| Migrations incrementais | ✅ | | | |
| CI (typecheck/test/build/audit) | ✅ | | | |
| Storage de arquivos | ✅ (disco local) | | adapter S3 pronto, nunca testado contra um bucket real | |
| E-mail | | ✅ (código correto, SMTP nunca configurado) | | |
| IA de apoio ao matching | | ✅ (código correto, chave nunca configurada) | | |
| Frontend estático servido em produção | | arquitetura decidida (Fase 56, nginx) | falta configuração real do provedor | |
| TLS/HTTPS | | quem termina decidido (Fase 56, nginx) | falta certificado/domínio reais | |
| HSTS real | | | header documentado/pronto para a camada que ainda não existe | |
| Backup/restore do Postgres | ✅ (testado, Fase 57) | | | |
| CD (deploy automático) | | | | ❌ |
| Graceful shutdown | ✅ (Fase 56) | | | |
| Readiness check (verifica DB) | | | | ❌ (health check atual é só liveness) |
| Alertas externos (e-mail/webhook) | | | | ❌ |
| Rate limiter compartilhado entre processos | | | documentado como próximo passo | ❌ (não implementado — não necessário hoje) |

---

## 2. Frontend

`npm run build` = `tsc -p tsconfig.json && vite build` → `dist/` (HTML +
JS + CSS estáticos). **PRONTO** como processo de build — confirmado
localmente (Fase 54) que roda sem nenhuma variável de ambiente.

Roteamento: SPA real (`createBrowserRouter`, React Router 7.18.4) — rotas
como `/organizacoes/14/necessidades` só existem no lado do cliente.
**Qualquer servidor estático em produção precisa de fallback de SPA**
(toda rota desconhecida devolve `index.html`, não um 404 do servidor de
arquivos) — **PRECISA DE DECISÃO DE INFRAESTRUTURA**, nenhum código
resolve isso sozinho porque não existe um servidor de estáticos ainda.

CSP do documento: injetada como `<meta http-equiv>` **só na build de
produção** (Fase 50) — cobre `script-src`/`style-src`/`font-src`/
`img-src`/`connect-src`/`object-src`/`base-uri`/`form-action`. **Não**
cobre `frame-ancestors` (a spec do CSP ignora essa diretiva em `<meta>`) —
isso só pode vir como header HTTP real da camada que serve o HTML, que
ainda não existe. A política completa recomendada (incluindo
`frame-ancestors 'none'`) já está documentada em `docs/DEPLOYMENT.md` e
em `src/helpers/securityHeaders.ts` (`DOCUMENT_CSP_WITH_FRAME_ANCESTORS`),
pronta para ser copiada na configuração real do servidor de estáticos.

Fontes: Google Fonts (`fonts.googleapis.com`/`fonts.gstatic.com`), único
recurso de terceiros carregado pelo navegador — já liberado na CSP.

**Classificação**: build **PRONTO**; servir o resultado em produção
**PRECISA DE DECISÃO DE INFRAESTRUTURA**.

---

## 3. API

`server/index.ts`: descobre endpoints em `src/endpoints/**/*_GET.ts` e
`*_POST.ts`, monta `/_api/v1/<rota>`. Porta: `process.env.PORT` (default
3001). Health check: `GET /_api/__health` (fora do versionamento de
propósito) — devolve `{status:"ok", endpoints, apiVersion}`. **Isto é um
liveness check, não um readiness check**: não consulta o Postgres, só
confirma que o processo Node está de pé e as rotas foram montadas. Um
orquestrador que use isto para decidir "está pronto para receber tráfego"
pode achar que a aplicação está saudável mesmo com o banco inacessível
(toda requisição real falharia com 500 nesse cenário, mas o health check
continuaria respondendo 200). **PRECISA DE IMPLEMENTAÇÃO** se o
provedor/orquestrador escolhido exigir readiness separado de liveness
(nem todo provedor exige — PaaS mais simples só olham se a porta responde).

Opções de arquitetura (conforme pedido pela fase):

- **Opção A** — CDN/host estático para o frontend (Cloudflare Pages,
  Netlify, Vercel estático, S3+CloudFront) + API em outro serviço
  (Railway, Fly.io, um VPS com o processo Node). Frontend e API ficam em
  origens diferentes — precisaria de CORS (hoje **não configurado**, ver
  `docs/SECURITY.md`) OU de um domínio/subdomínio compartilhado com
  proxy de `/_api/*` para a API (equivalente ao que o Vite dev server já
  faz localmente).
- **Opção B** — nginx (ou equivalente) servindo `dist/` estaticamente +
  fazendo proxy reverso de `/_api/*` para o processo Node — replica
  exatamente o papel que o Vite dev server já cumpre em desenvolvimento
  (`vite.config.ts`, `server.proxy`). Mantém tudo same-origin (nenhuma
  mudança de CORS necessária, cookies `SameSite=Lax` continuam
  funcionando sem ajuste).
- **Opção C** — adicionar `express.static("dist")` + fallback de SPA
  dentro do próprio `server/index.ts`, unificando frontend e API num
  único processo. Já mencionado como alternativa em `docs/DEPLOYMENT.md`
  desde a Fase 41, nunca implementado porque não havia decisão de
  infraestrutura tomada — **continua sendo uma opção válida e a que
  menos exige infraestrutura nova** (um único processo, sem nginx).

Nenhuma das três foi escolhida. **Recomendação desta fase**: Opção B ou C
— ambas mantêm same-origin (evita abrir uma superfície de CORS nova) e
são compatíveis com tudo que já existe (cookies, CSP, rate limiting por
IP). A escolha final depende de orçamento/operação, não de limitação
técnica do código.

**Classificação**: API em si **PRONTO**; arquitetura de produção
completa **PRECISA DE DECISÃO DE INFRAESTRUTURA**.

---

## 4. PostgreSQL

Kysely + `postgres` (driver `postgres-js`), pool `max: 3`,
`idle_timeout: 10s`, `prepare: false`. Migrations: `db/schema.sql`
(schema completo, só para banco novo, `npm run db:migrate`) e
`db/migrations/*.sql` (13 arquivos, `0001`–`0013`, aplicação incremental
idempotente via `db/run-migrations.ts`, rastreada em `schema_migrations`
— roda só o que falta, nunca re-executa o que já rodou).

**Deploy de código novo → migration → rollback**: o fluxo direto é
`npm run db:migrate:incremental` antes de trocar o processo Node para o
código novo (migrations são aditivas — nenhuma delas até agora remove
coluna/tabela, todas adicionam). **Rollback não existe** — não há
migrations "down". Reverter um deploy problemático hoje significa reviver
o código antigo contra um schema já migrado à frente (só seguro porque
todas as 13 migrations até agora são estritamente aditivas: novas
colunas/tabelas/índices, nunca remoção — código antigo ignora colunas que
não conhece). Se uma migration futura precisar remover/renomear algo,
**isso vai exigir decisão explícita de estratégia de rollback**, não
coberta hoje.

Triggers append-only (Modelo B, `need_resolutions`, `audit_log`,
`stock_transactions`, `logistics_events`) e advisory locks (cadeia de
auditoria, tarefas agendadas) são propriedades do **schema**, não do
processo — sobrevivem a qualquer reinício/redeploy automaticamente, não
exigem nenhuma ação extra de infraestrutura.

**Classificação**: aplicação de migrations **PRONTO**; estratégia de
rollback para migrations futuras não-aditivas **PRECISA DE
IMPLEMENTAÇÃO** (quando/se surgir a necessidade); backup/restore — ver
seção 12.

---

## 5. Scheduler

`src/helpers/scheduler.tsx` (node-cron, dentro do próprio processo).

| Job | Frequência | Lock | Idempotência | Multi-processo? |
|---|---|---|---|---|
| `runMatchingSweep` | */15min | `withScheduledTaskLock` (advisory lock de sessão, objid 4) | `claimTaskRun` (sem `idempotencyKey`) | Seguro — lock impede dupla execução simultânea entre instâncias |
| `expireReservations` | */10min | objid 1 | idem | Seguro |
| `expireOpportunities` | hora em hora | objid 2 | idem | Seguro |
| `expireApprovalRequests` | hora em hora | objid 3 | idem | Seguro |
| `verifyAuditChain` | 6/6h (Fase 53) | objid 5 | idem | Seguro |

**O advisory lock de sessão (`pg_try_advisory_lock`, classid fixo 842013,
objid por tarefa) já é coordenado pelo Postgres, não pelo processo Node —
funciona identicamente com 1 ou N processos rodando o mesmo cron**
(provado empiricamente para o lock da audit chain na Fase 53, mesmo
mecanismo das outras 4 tarefas, testado com concorrência real desde a
auditoria que motivou `scheduledTaskLock.tsx`). A limitação real de
múltiplos processos está em **outro lugar**: se N processos rodam o
agendador, N crons disparam cada tarefa no mesmo horário — o lock
garante que só UM realmente executa o corpo, mas os outros N-1
"perderam" o tick (não há retry automático até o próximo tick natural).
Isso é aceitável para as 5 tarefas atuais (todas toleram esperar até o
próximo tick), mas é uma propriedade que precisa ser entendida antes de
escalar horizontalmente.

**Classificação**: **PRONTO** para single-process e também para
multi-processo (o lock já protege corretamente) — a única coisa que
**PRECISA DE DECISÃO DE INFRAESTRUTURA** é se múltiplos processos rodando
o scheduler é desejável (tipicamente não é — mais comum seria só uma
instância "worker" rodar o cron, e as demais só servirem API, decisão de
deployment, não de código).

---

## 6. Storage

`src/helpers/storageAdapter.tsx`: disco local por padrão
(`STORAGE_LOCAL_DIR`, fora de qualquer diretório servido estaticamente),
muda automaticamente para S3-compatível quando as 4 variáveis
(`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`)
existem.

**Hoje**: disco local, confirmado via `.env` (as 4 variáveis S3 ausentes).
Arquivos sobrevivem a um `restart` do mesmo processo (ficam no
filesystem), mas **não sobrevivem a um redeploy que troca o
container/instância** (filesystem efêmero, comum em PaaS) e **não
funcionam corretamente com múltiplas instâncias simultâneas** (cada
instância teria seu próprio disco — um upload na instância A não
apareceria num download servido pela instância B).

O adapter S3 existe e está completo no código
(`@aws-sdk/client-s3` instalado, classe `S3StorageAdapter` implementada),
mas **nunca foi testado contra um bucket real nesta sessão** (nenhuma
credencial configurada em nenhum ambiente observado).

**Classificação**: **PRONTO** para single-instância com disco persistente;
**PRECISA DE DECISÃO DE INFRAESTRUTURA** (configurar S3/R2/MinIO) assim
que o deployment tiver mais de uma instância ou um filesystem efêmero.

---

## 7. E-mail

`src/helpers/emailAdapter.tsx`: SMTP via `nodemailer`. Sem
`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`, o adapter
devolve `{sent: false, reason: "not_configured"}` de forma explícita —
**nunca finge que enviou**. Confirmado: ausente no `.env` atual.

**O que depende disso hoje**: só o e-mail de convite de organização
(`organization-invites_POST.ts`). Sem SMTP, o convite continua
funcionando integralmente — o link de aceite é devolvido na resposta da
API para quem convidou copiar e enviar manualmente (confirmado na Central
Visual da Fase 41/45/51, a UI já mostra "Copiar link" quando `emailSent:
false`). **Nenhum fluxo do sistema trava ou falha por falta de SMTP.**

**Classificação**: código **PRONTO**; envio real **PRECISA DE DECISÃO DE
INFRAESTRUTURA** (escolher um provedor SMTP) — mas **NÃO É um
bloqueador** para operar o sistema, é uma conveniência degradada
graciosamente.

---

## 8. IA

`src/helpers/aiClient.tsx`: chamada HTTP direta à API da Anthropic
(`https://api.anthropic.com/v1/messages`), **sempre do backend, nunca do
navegador** (confirmado por busca exaustiva na Fase 50: `aiClient.tsx` é
importado só por `opportunityMatching.tsx`, que nunca é importado por
nenhuma página/componente React). Sem `ANTHROPIC_API_KEY`, o motor de
matching usa só o escore determinístico por palavra-chave — o
`try/catch` em volta da chamada de IA garante que uma falha (ou ausência)
de IA nunca bloqueia uma decisão de matching, só reduz a precisão do
escore.

**Custo esperado**: só ocorre quando `runMatchingForOpportunity` roda
(disparado pelo sweep agendado ou por ações manuais de match/decisão) —
não é uma chamada por requisição HTTP comum, é limitada a eventos de
negócio reais. Modelo configurado via `LEVORA_AI_MODEL`
(`claude-haiku-4-5-20251001`, o mais barato disponível, escolha
deliberada para esse uso).

**Classificação**: código **PRONTO**; chave real **PRECISA DE DECISÃO DE
INFRAESTRUTURA** (orçamento) — também **NÃO É bloqueador**, degrada
graciosamente.

---

## 9. Secrets

| Variável | Build? | Runtime? | Sensível? | Onde deveria viver | Hoje (`.env` local) |
|---|---|---|---|---|---|
| `DATABASE_URL` | Não | **Sim (obrigatória)** | **Sim** | Secret manager do provedor/orquestrador | PRESENTE |
| `JWT_SECRET` | Não | **Sim (obrigatória)** | **Sim** | Secret manager — único por ambiente, nunca reaproveitado | PRESENTE |
| `PORT` | Não | Sim (opcional) | Não | Config comum | PRESENTE (3001) |
| `ANTHROPIC_API_KEY` | Não | Sim (opcional) | **Sim** | Secret manager | AUSENTE |
| `LEVORA_AI_MODEL` | Não | Sim (opcional) | Não | Config comum | PRESENTE |
| `SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM` | Não | Sim (opcional) | `SMTP_PASS` **sim**, resto não | Secret manager (`PASS`) | AUSENTES |
| `APP_PUBLIC_URL` | Não | Sim (opcional) | Não | Config comum | PRESENTE (localhost) |
| `STORAGE_LOCAL_DIR` | Não | Sim (opcional) | Não | Config comum | PRESENTE |
| `S3_BUCKET`/`REGION`/`ENDPOINT` | Não | Sim (opcional) | Não | Config comum | AUSENTES |
| `S3_ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` | Não | Sim (opcional) | **Sim** | Secret manager | AUSENTES |
| `APPROVAL_REQUEST_EXPIRATION_DAYS` | Não | Sim (opcional) | Não | Config comum | PRESENTE (7) |
| `TRUST_PROXY` | Não | Sim (opcional, crítico em produção) | Não | Config comum — depende da topologia real | AUSENTE |

Nenhum valor impresso aqui ou em qualquer fase anterior — só
presença/ausência, conforme a regra de segurança deste projeto.

**Build não exige NENHUMA destas variáveis** (confirmado na Fase 54 com
`env -i`). Runtime exige só `DATABASE_URL`+`JWT_SECRET` (o processo lança
erro explícito na inicialização se `DATABASE_URL` faltar — confirmado em
`db.tsx`).

**Classificação**: matriz **PRONTA** (mapeada); cofre de secrets real
(Vault/AWS Secrets Manager/variáveis do provedor) **PRECISA DE DECISÃO DE
INFRAESTRUTURA** — hoje é responsabilidade de quem faz o deploy, não
deste repositório (já documentado assim em `docs/SECURITY.md`).

---

## 10. TLS / Proxy

Quem termina TLS, quem gera `X-Forwarded-For`/`X-Forwarded-Proto`, onde
HSTS/CSP HTTP (`frame-ancestors`) são aplicados — **tudo isso depende da
camada de infraestrutura que ainda não foi escolhida** (seção 3). O
código está preparado para qualquer uma das topologias comuns, mas não
decide sozinho:

- Se o Express ficar **diretamente exposto à internet** (sem proxy na
  frente): `TRUST_PROXY` deve continuar **AUSENTE/false** (padrão atual)
  — `req.ip` já lê corretamente o IP real do socket TCP. Esta topologia
  não é recomendada para produção real (sem terminação TLS própria, sem
  cache de estáticos, sem WAF), mas o código funcionaria.
- Se houver **um único proxy reverso confiável** na frente (nginx, um
  load balancer gerenciado): `TRUST_PROXY=1` — confirmado por teste real
  na Fase 52 que isso faz `req.ip` passar a ler corretamente de
  `X-Forwarded-For`, com spoofing continuando impossível (o proxy
  sobrescreve qualquer XFF que o cliente tentou forjar antes de
  repassar).
- Se houver **uma cadeia de proxies** (CDN → load balancer → nginx):
  `TRUST_PROXY` precisa do número exato de saltos confiáveis — **errar
  esse número é o próprio risco que a Fase 52 investigou** (confiar
  demais reabre spoofing; confiar de menos quebra rate limiting por IP
  real).

**`trust proxy: true` (confiar em qualquer proxy) nunca deve ser usado**
— já documentado como proibido desde a Fase 52.

HSTS: deliberadamente **não implementado em nenhum processo deste
repositório** (nem API, nem build do cliente) — decisão da Fase 50,
reconfirmada aqui. Só pode ser aplicado de verdade pela camada que
termina TLS, porque só ela sabe que a conexão é HTTPS.

**Classificação**: `TRUST_PROXY` e HSTS — **PRONTO COM DEPENDÊNCIA
OPERACIONAL** (o código reage corretamente a qualquer valor correto, mas
alguém precisa saber a topologia real para escolher o valor).

---

## 11. Rate limiting

Resumo da Fase 52 (não re-testado aqui, só consolidado): `Map` em
memória, correto e sem race condition dentro de **um único processo**
(provado com 50 requisições concorrentes reais, nenhum excedente).
**Contadores NÃO são compartilhados entre processos** (provado com dois
processos Node reais em portas diferentes — um bloqueou, o outro não
percebeu nada).

**Requisito arquitetural explícito desta fase**: a topologia suportada
hoje é **exatamente 1 processo Node por ambiente**. Se o deployment
escolhido rodar múltiplas instâncias do processo Node (réplicas, cluster
PM2, múltiplos containers), o limite efetivo de cada rota vira
`limite configurado × número de instâncias` — ainda funciona como
proteção (não quebra), só fica proporcionalmente mais permissivo. Isso é
aceitável para um volume pequeno/médio de tráfego, mas deixa de ser uma
garantia de segurança rígida acima de um certo número de instâncias.

**Quando migrar**: no momento em que o deployment definir mais de uma
instância rodando simultaneamente — trocar o `Map` por Redis ou um UPSERT
atômico em Postgres (ambos avaliados na Fase 52, nenhum implementado por
falta de necessidade comprovada hoje). **Não implementado nesta fase**
— continua sendo um requisito futuro documentado, não um bloqueador
atual.

**Classificação**: **PRONTO** para 1 processo (a topologia real de hoje);
**PRECISA DE DECISÃO DE INFRAESTRUTURA + IMPLEMENTAÇÃO FUTURA** se/quando
o número de instâncias crescer.

---

## 12. Backup / Restore

**RESOLVIDO na Fase 57** — procedimento real definido, testado e
documentado em [`docs/DATABASE_RECOVERY.md`](DATABASE_RECOVERY.md).
Resumo dos resultados reais (não estimados):

- **Backup real executado** contra o banco de desenvolvimento (`pg_dump
  -Fc -Z 6`): 142.386 bytes, 279ms, checksum SHA-256 calculado.
- **Restore real** num banco separado (`levora_solidaria_restore_test`,
  descartado ao final): 599ms. Estrutura idêntica ao original em todos os
  itens verificados (26 tabelas, 22 triggers, 71 índices, 276
  constraints, 23 sequences — contagem exata, não estimativa).
- **Validação funcional real**: trigger append-only testado (rejeitou um
  `DELETE` real contra o banco restaurado), `verifyAuditLogChain()` (o
  verificador canônico, não uma reimplementação) confirmou
  `integra: true` contra o banco restaurado, e a aplicação real (servidor
  + cliente) apontada temporariamente para o banco restaurado passou por
  login, dashboard, rota de organização e o painel de tarefas de fundo
  via Central Visual — desktop e mobile.
- **Tempo técnico medido** (banco + restore + validação estrutural +
  aplicação pronta): **≈ 3,4 segundos**, para o volume atual de dados
  (~139 KB). Este número não inclui o tempo de provisionar um Postgres
  novo do zero (varia por provedor, não exercido nesta fase — nenhuma
  infraestrutura real foi contratada).
- **Achado real corrigido durante a investigação**: `schema_migrations`
  estava com a migration `0013` (Fase 48) sem registro de rastreamento,
  apesar de seus efeitos estarem corretamente aplicados — corrigido no
  banco de desenvolvimento (inserção da linha faltante), evitando que uma
  futura `db:migrate:incremental` tentasse reaplicá-la e falhasse.

**RPO**: ≤24h no pior caso (backup diário) — PITR avaliado e
conscientemente não adotado ainda (ver `docs/DATABASE_RECOVERY.md`,
seção 13). **RTO**: meta de ≤4h permanece alcançável com folga, informada
pela medição técnica real acima, mas não testada ponta a ponta contra
provisionamento real de infraestrutura.

**Classificação**: **FECHADO** (procedimento definido, testado e
documentado) **COM CONFIGURAÇÃO DO PROVEDOR** (a execução real em
produção depende do provedor de Postgres escolhido cumprir os requisitos
listados em `docs/DATABASE_RECOVERY.md`, seção 20).

---

## 13. Observabilidade

| Sinal | Estado |
|---|---|
| Logs de processo (console.log/error) | **Existe** — todo erro de endpoint, falha de tarefa agendada, erro de e-mail/IA não configurado |
| `background_task_runs` (histórico de tarefas) | **Existe** — status/erro/resultado estruturado, consultável via `GET /background-tasks`, visível em `/plataforma` |
| Audit log (ações de negócio) | **Existe** — hash-chain verificada periodicamente desde a Fase 53 |
| Falhas de autenticação | **Existe parcialmente** — `login_attempts` grava cada tentativa (sucesso/falha), mas não há agregação/dashboard, só consulta direta ao banco |
| Erros de banco | **Existe parcialmente** — aparecem como exceção não tratada → log de console + resposta 500 genérica; nenhuma captura estruturada separada |
| Métricas (latência, taxa de erro, throughput) | **Ausente** — sem Prometheus/Grafana/equivalente |
| Tracing distribuído | **Ausente** — não aplicável à escala atual (processo único) |
| Dashboards | **Ausente** — exceto o painel admin de `background_task_runs` já existente |

**Requisitos mínimos para produção** (conforme pedido pela fase, não
implementados aqui):

- Erro de API (5xx repetido) — hoje só visível lendo logs do processo.
- Falha de scheduler — já visível em `background_task_runs`
  (`status='falhou'`), mas sem alerta automático (ver seção 15).
- Corrupção da audit chain — já visível (Fase 53), mesma limitação de
  alerta.
- Falha de banco — aparece como 500 em toda rota, sem sinal dedicado.
- Restart do processo — nenhum sinal específico (dependeria do
  orquestrador registrar isso).

**Classificação**: **PRONTO PARCIALMENTE** para o essencial de auditoria
de negócio; **PRECISA DE IMPLEMENTAÇÃO** para métricas/dashboards reais
quando o volume justificar.

---

## 14. Alertas

Já sabido desde SEC-06 (Fase 47/53): **nenhum canal externo de alerta
existe** (sem e-mail de alerta, sem webhook, sem SMS/PagerDuty). Decisão
deliberada em todas as fases anteriores: nunca fabricar um canal de
alerta que não existe de verdade.

Requisitos que um canal de alerta futuro precisaria cobrir, em ordem de
severidade real:

1. **Audit chain inválida** (`background_task_runs.error.kind ===
   "integrity_invalid"`) — o mais crítico, indica adulteração real.
2. **Database unavailable** — hoje só visível como onda de 500s.
3. **Application down** — depende do orquestrador escolhido ter seu
   próprio healthcheck externo.
4. **5xx repetido** — sem agregação hoje.
5. **Storage failure** (upload falhando) — já logado individualmente, sem
   agregação.
6. **Scheduler failure** — já em `background_task_runs`, sem alerta.

**Classificação**: requisitos **MAPEADOS**; implementação **PRECISA DE
DECISÃO DE INFRAESTRUTURA** (nenhum serviço de alerta escolhido) — fora
de escopo desta fase, deliberadamente não implementado.

---

## 15. CI / CD

**CI** (Fase 54, fechado): `npm ci` → typecheck → testes → build →
`npm audit --audit-level=moderate`, gate em cada etapa,
`permissions: contents: read`.

**CD não existe e não foi tratado nesta fase.** Quando o provedor for
escolhido, vai precisar de:

- **Deploy**: como o código novo chega ao servidor (build+push de imagem,
  git push para um PaaS, etc. — depende do provedor).
- **Migrations**: `npm run db:migrate:incremental` precisa rodar ANTES do
  processo novo começar a receber tráfego (ou coordenado com um
  deploy de duas fases, já que as migrations são aditivas e seguras
  contra código antigo ainda rodando brevemente).
- **Secrets**: injetados pelo provedor (variáveis de ambiente do
  serviço), nunca commitados.
- **Health check de deploy**: `GET /_api/__health` pode servir de sinal
  básico ("o processo subiu"), mas não verifica o banco (ver seção 3) —
  um orquestrador mais rigoroso vai precisar de um endpoint que também
  confirme conexão com Postgres antes de considerar a instância pronta.
- **Rollback**: reverter para a imagem/commit anterior é seguro enquanto
  as migrations continuarem aditivas (ver seção 4); não há mecanismo
  automatizado de rollback de deploy.

**Classificação**: CI **PRONTO**; CD **PRECISA DE DECISÃO DE
INFRAESTRUTURA + IMPLEMENTAÇÃO** completa, não iniciada nesta fase.

---

## 16. Health checks

Só `GET /_api/__health` (liveness: processo de pé + rotas montadas).
**Não verifica conexão com Postgres** — uma instância com banco
inacessível responderia 200 aqui enquanto toda rota real falharia com
500. Não há endpoint de readiness separado.

Isto não significa necessariamente que falta implementar um padrão
completo de Kubernetes (liveness+readiness+startup probes) — a fase pede
explicitamente para não presumir isso. O que falta é mais simples:
**determinar, quando o orquestrador for escolhido, se ele precisa de um
sinal que verifique o banco** — PaaS mais simples (Railway, Fly.io sem
healthcheck customizado) podem se contentar com "a porta responde";
orquestradores mais rigorosos (Kubernetes de verdade) vão exigir mais.

**Classificação**: liveness **PRONTO**; readiness **PRECISA DE
IMPLEMENTAÇÃO**, condicional à escolha de orquestrador (pode não ser
necessário).

---

## 17. Graceful shutdown

**Não implementado.** Busca exaustiva em `server/index.ts` e em todo
`src/helpers/`: zero `process.on("SIGTERM"/"SIGINT")`. O processo encerra
abruptamente quando recebe um sinal de término — qualquer requisição em
andamento é cortada, qualquer tarefa agendada no meio de uma transação é
interrompida (a transação em si não corrompe nada — o Postgres faz
rollback de uma conexão cortada no meio —, mas o CLIENTE daquela
requisição recebe uma conexão fechada sem resposta, e um advisory lock de
sessão preso pela tarefa interrompida é liberado automaticamente pelo
Postgres quando a conexão TCP cai, como já documentado em
`scheduledTaskLock.tsx`).

**Impacto prático**: em deployments de rolling-update (a nova instância
sobe, a antiga é encerrada), sem graceful shutdown a instância antiga
pode cortar requisições genuinamente em andamento no momento exato do
deploy — uma janela pequena, mas real, de respostas de erro para o
usuário final durante deploys.

**Classificação**: **PRECISA DE IMPLEMENTAÇÃO** — não implementado nesta
fase (fora de escopo: "não implementar um sistema complexo de shutdown
apenas para esta auditoria"), registrado como lacuna real.

---

## 18. Escalabilidade

| Nível suportado | Componentes |
|---|---|
| **Suportado hoje (1 processo)** | API, rate limiting, storage local, tudo |
| **Suportado parcialmente (N processos)** | Scheduler (lock via Postgres já protege corretamente — seção 5); banco (Postgres já é multi-conexão por natureza) |
| **Não garantido sem mudança (N processos)** | Rate limiter (contadores por processo — seção 11); storage local (disco por instância — seção 6) |

**Modelo de processo suportado hoje, explicitamente**: **1 processo
Node**. Escalar para N processos é possível sem quebrar nada
(confirmado: scheduler já seguro), mas **degrada** duas garantias
(rate limiting vira proporcionalmente mais permissivo; upload em disco
local vira inconsistente entre instâncias) até que as migrações
correspondentes (storage compartilhado + rate limiter compartilhado)
sejam feitas.

---

## 19. Dependências operacionais (resumo)

1. Escolha de hospedagem para o frontend estático (seção 2/3).
2. Escolha de hospedagem para a API (seção 3).
3. Escolha de topologia de proxy/TLS → valor de `TRUST_PROXY` (seção 10).
4. Provedor de Postgres gerenciado com backup real e testado (seção 12).
5. Provedor de storage (S3/R2/MinIO) se houver mais de uma instância
   (seção 6).
6. Provedor de SMTP, se e-mail de convite automático for desejado (seção 7).
7. `ANTHROPIC_API_KEY`, se o apoio de IA ao matching for desejado (seção 8).
8. Secret manager do provedor escolhido (seção 9).
9. Canal de alerta, se monitoramento ativo for desejado (seção 14).

---

## 20. Bloqueadores reais para produção

Estado original (Fase 55) e estado atual (depois das Fases 56/57):

1. ~~Nenhuma camada estática definida para o frontend~~ — **RESOLVIDO na
   Fase 56**: arquitetura decidida (nginx same-origin, Alternativa B, ver
   seção "Arquitetura-alvo de produção" abaixo). Falta só a configuração
   real do provedor quando for contratado — não é mais uma ambiguidade
   arquitetural.
2. ~~Backup/restore nunca testado~~ — **RESOLVIDO na Fase 57**:
   procedimento definido, testado (restore real num banco separado,
   validação estrutural e funcional, tempo medido) e documentado em
   `docs/DATABASE_RECOVERY.md` (ver seção 12 acima).
3. **TLS/HTTPS — parcialmente resolvido**: a Fase 56 decidiu QUEM
   termina TLS (o nginx, na arquitetura escolhida), mas a configuração
   real (certificado, domínio) continua dependendo do provedor/domínio
   que ainda não foram contratados — autenticação por cookie `Secure`
   continua exigindo HTTPS real para funcionar fora de localhost.

**Nenhum bloqueador restante impede a arquitetura de ser implementada** —
o único item que ainda depende inteiramente de uma decisão de
infraestrutura externa (não resolvível só com código/documentação) é a
contratação real de domínio+certificado+provedor de Postgres.

---

## 21. Decisões que ainda precisam ser tomadas

- Onde hospedar o frontend estático e a API (Opção A/B/C, seção 3).
- Topologia de proxy/TLS exata → valor de `TRUST_PROXY`.
- Provedor de Postgres gerenciado (com backup).
- Se/quando escalar para múltiplas instâncias (dispara a necessidade de
  storage compartilhado + rate limiter compartilhado).
- Se e-mail/IA serão configurados no lançamento ou deixados para depois
  (ambos degradam graciosamente — não bloqueiam).
- Canal de alerta, se houver.
- Estratégia de CD (deploy automático) uma vez que o provedor for
  escolhido.

---

## 22. Itens que podem permanecer para pós-MVP

- Rate limiter compartilhado (Redis/Postgres) — só necessário acima de 1
  instância.
- Storage S3 — só necessário acima de 1 instância ou filesystem efêmero.
- SMTP real — convites continuam funcionando via link manual sem isso.
- `ANTHROPIC_API_KEY` — matching continua funcionando com escore
  determinístico sem isso.
- Observabilidade completa (métricas/dashboards/tracing) — logs +
  `background_task_runs` + audit log já cobrem o essencial de auditoria
  para um volume inicial pequeno.
- Canal de alerta externo — revisão manual periódica de
  `background_task_runs` (já documentada em `docs/OPERATIONS.md`) cobre
  o mínimo até que o volume justifique automação.
- Readiness check separado de liveness — só necessário se o orquestrador
  escolhido exigir.
- ~~Graceful shutdown~~ — **implementado na Fase 56** (ver seção
  "Arquitetura-alvo de produção" abaixo), porque a arquitetura escolhida
  (processo gerenciado por systemd/orquestrador, reiniciado a cada
  deploy) torna isso uma necessidade real, não hipotética.

---

# Arquitetura-alvo de produção (Fase 56)

Esta seção fecha a ambiguidade que a Fase 55 deixou em aberto: não só
"o que falta", mas **onde cada peça vai rodar**. Nenhum deploy real foi
feito para produzir isto — é uma decisão de arquitetura documentada e,
onde possível, validada localmente (ex.: o graceful shutdown implementado
nesta mesma fase).

## Matriz consolidada (extraída da Fase 55, sem reescrever a análise)

| Componente | Requisito | Estado atual | Dependência externa | Decisão necessária | Impacto no código |
|---|---|---|---|---|---|
| Frontend | Servir `dist/` com fallback de SPA | Build pronto, camada de serving indefinida | Servidor estático/CDN | Qual camada (ver comparação abaixo) | Nenhum (ou mínimo — ver "Frontend" abaixo) |
| API | Processo Node acessível | Pronto | Host do processo | Onde rodar | Nenhum |
| TLS | HTTPS real | Ausente | Certificado (Let's Encrypt ou do provedor) | Quem termina TLS | Nenhum |
| Proxy | Encaminhar `/_api/*` | Ausente em produção (só no Vite dev) | nginx ou equivalente | Config de proxy | Nenhum |
| PostgreSQL | Managed, com backup | Código pronto; backup/restore **testado (Fase 57)** | Provedor gerenciado | Qual provedor | Nenhum |
| Storage | Persistente | Disco local | S3 só se multi-instância | Disco com volume persistente vs. S3 | Nenhum (adapter já existe) |
| Scheduler | Coordenado entre processos | Já seguro (advisory lock) | Nenhuma nova | Nenhuma | Nenhum |
| Rate limiting | Compatível com a topologia | Em memória, single-process | Nenhuma (nesta arquitetura) | Confirmar single-process no lançamento | Nenhum |
| Secrets | Fora do git | `.env` local | Secret manager do provedor | Qual mecanismo | Nenhum |
| Backup | Testado, com RPO/RTO | **Testado (Fase 57)** — ver `docs/DATABASE_RECOVERY.md` | Provedor de Postgres | Política concreta (requisitos já definidos) | Nenhum (operacional) |
| Observabilidade | Sinais mínimos definidos | Parcial (logs + `background_task_runs`) | Nenhuma obrigatória no lançamento | Canal de alerta futuro | Nenhum |
| Shutdown | Gracioso sob SIGTERM | **Implementado nesta fase** | Nenhuma | — | `server/index.ts`, `db.tsx` |

## Alternativas comparadas

| Critério | Alternativa A — origens separadas (CDN/estático + API em host próprio) | Alternativa B — nginx same-origin (escolhida) |
|---|---|---|
| HTTPS | TLS terminado em dois lugares (CDN + host da API) | TLS terminado uma vez, no nginx |
| SPA fallback | Configuração do CDN (varia por provedor) | `try_files` do nginx, padrão bem conhecido |
| API routing | Precisa de domínio/subdomínio dedicado para a API | `/_api/*` já é o prefixo que o código já usa — proxy direto |
| Cookies | Mesmo "site" (mesmo domínio raiz) ainda funciona com `SameSite=Lax`, mas é origem diferente | Mesma origem — nenhuma mudança de comportamento |
| CSP `connect-src` | Precisa listar o domínio da API explicitamente | `'self'` já cobre tudo (nenhuma mudança na CSP da Fase 50) |
| CORS | **Necessário** — origem do frontend precisa ser liberada explicitamente para requisições com credenciais | **Não necessário** — zero CORS, como hoje |
| CSRF | A análise de `docs/SECURITY.md` (4 justificativas independentes) inclui "sem CORS com credenciais" — precisaria ser revisada, não necessariamente quebrada, mas é uma mudança num invariante de segurança já documentado | Análise de CSRF existente permanece válida sem nenhuma revisão |
| Custo operacional | Dois serviços para monitorar/atualizar | Um host (nginx + Node + Postgres pode até ser o mesmo servidor) |
| Complexidade | Maior — duas origens, uma configuração de CORS para manter correta | Menor — replica exatamente o que o Vite dev server já faz localmente |
| Escalabilidade | CDN escala o frontend independente da API | Frontend escala junto com o host do nginx (geralmente não é o gargalo) |
| Rollback | Dois deploys independentes para coordenar | Um host, mais simples de reverter |
| Observabilidade | Logs em dois lugares diferentes | Logs do nginx + logs do processo Node, mesmo host |

**Decisão: Alternativa B.** Critério decisivo: este projeto já opera
same-origin em desenvolvimento (o próprio `vite.config.ts` faz
exatamente este proxy de `/_api/*`) e toda a análise de segurança
existente (CSRF, CSP, cookies) foi desenhada e testada em cima dessa
premissa. Trocar para origens separadas introduziria CORS — uma
superfície nova que hoje é zero (confirmado por busca exaustiva em
`server/index.ts`, Fases 46/50) — sem nenhum ganho técnico que compense
isso no estágio atual do projeto. Não foi escolhida por preferência
pessoal: é a opção que preserva, sem nenhuma mudança de código, tudo que
já foi construído e testado nas Fases 47-55.

## Same-origin vs. origens separadas (detalhamento)

```
Escolhido:
https://app.levorasolidaria.org.br/           → nginx → arquivos estáticos (dist/)
https://app.levorasolidaria.org.br/_api/*     → nginx → proxy_pass → Express (127.0.0.1:3001)
```

Cookies (`HttpOnly`+`Secure`+`SameSite=Lax`, definidos pela API) e o
frontend compartilham origem — nenhuma mudança de `Domain`/`Path` de
cookie é necessária, nenhuma configuração de CORS é necessária, a defesa
de CSRF já documentada permanece válida sem revisão.

## Frontend

Servido por **nginx** (ou qualquer servidor de arquivos estáticos
equivalente) a partir de `dist/` (saída de `npm run build`). Regra de
fallback de SPA obrigatória:

```nginx
location / {
    try_files $uri /index.html;
}
location /_api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Qualquer rota desconhecida pelo nginx (`/organizacoes/14/necessidades`,
`/convites/<token>`, etc.) devolve `index.html` — o React Router assume
a partir daí, exatamente como já acontece com o Vite dev server
localmente.

Headers HTTP reais (não só a `<meta>` da build) devem ser adicionados
pelo nginx, reaproveitando a política já definida na Fase 50
(`DOCUMENT_CSP_WITH_FRAME_ANCESTORS` em
`src/helpers/securityHeaders.ts`) — a versão com `frame-ancestors`, que
`<meta>` não suporta:

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Content-Security-Policy "<DOCUMENT_CSP_WITH_FRAME_ANCESTORS>" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "<mesma lista de securityHeaders.ts>" always;
```

Cache de assets: arquivos em `dist/assets/*` têm hash no nome
(`index-BnK38n39.js`) — seguro usar `Cache-Control: max-age=31536000,
immutable` para eles; `index.html` deve ser `no-cache` (sempre revalidar,
para que uma nova versão do app seja detectada no próximo load).

**Classificação: FECHADO COM CONFIGURAÇÃO DO PROVEDOR** (a arquitetura
está decidida; falta só a configuração real do nginx quando o host for
contratado).

## API

Express (`server/index.ts`), porta interna via `PORT` (padrão 3001).
**Nunca exposto diretamente à internet** — só acessível via
`127.0.0.1`/rede interna, alcançável apenas pelo nginx. Isso é tanto uma
decisão de topologia quanto uma camada de defesa: mesmo que `TRUST_PROXY`
fosse configurado incorretamente, um Express inacessível de fora não
pode receber um `X-Forwarded-For` forjado diretamente de um cliente
externo.

Graceful shutdown **implementado nesta fase** (`server/index.ts` +
`closeDbPool` em `db.tsx`): `SIGTERM`/`SIGINT` param de aceitar conexões
novas, esperam até 10s pelas requisições em andamento, fecham o pool do
Postgres, e só então encerram o processo — necessário porque systemd (ou
o orquestrador escolhido) envia `SIGTERM` a cada deploy/restart.
Verificado nesta fase com o processo real: o handler dispara, `server.close()`
e `closeDbPool()` completam sem erro (ver seção de testes do relatório).
**Nota de ambiente**: a entrega de `SIGTERM` entre processos diferentes
não é testável de forma confiável no Windows (libuv não suporta SIGTERM
nativo nessa plataforma — só `TerminateProcess`, que nunca aciona um
listener) — o destino real de produção é Linux, onde `SIGTERM` é nativo e
este é o padrão universal do ecossistema Node/Express.

**Classificação: FECHADO.**

## PostgreSQL

Requisitos (não um provedor específico):

- Postgres 16+ (versão usada em CI e em todas as migrations testadas).
- Conexão com SSL (`sslmode=require` na `DATABASE_URL`).
- Backup automático diário com teste de restauração real (ver seção
  Backup).
- Rede privada quando o provedor oferecer (banco não exposto
  publicamente — só alcançável pela API).
- `pg_advisory_lock`/`pg_try_advisory_lock` disponíveis (padrão em
  qualquer Postgres gerenciado real — recurso nativo, não uma extensão).
- Pool da aplicação já é pequeno (`max: 3`, `db.tsx`) — compatível com os
  limites de conexão que planos de entrada de provedores gerenciados
  costumam impor.

**Classificação: FECHADO COM CONFIGURAÇÃO DO PROVEDOR.**

## Storage

Para o lançamento inicial (single-instance, Alternativa B): **disco
local com volume persistente** é aceitável — o host escolhido precisa
garantir que `STORAGE_LOCAL_DIR` sobrevive a um restart do processo (não
necessariamente a uma troca de servidor inteiro). Gatilho explícito para
migrar: no momento em que houver mais de uma instância do processo
Express rodando simultaneamente, migrar para S3/R2/MinIO (adapter já
implementado em `storageAdapter.tsx`, só precisa das 4 variáveis de
ambiente — nenhuma mudança de código).

**Classificação: FECHADO para o lançamento inicial; IMPLEMENTAÇÃO
NECESSÁRIA ANTES DO DEPLOY se o lançamento já começar com mais de uma
instância** (não é o caso da Alternativa B escolhida).

## Scheduler

Roda dentro do mesmo processo Express (nenhuma mudança). Confirmado
(Fases 53/55): os 5 jobs já usam `pg_try_advisory_lock` de sessão,
coordenado pelo **Postgres**, não pelo processo — funciona corretamente
mesmo que a arquitetura evolua para múltiplos processos no futuro, desde
que todos apontem para o mesmo Postgres. Nenhum lock distribuído
adicional necessário.

**Classificação: FECHADO.**

## Rate limiting

A arquitetura escolhida (Alternativa B, 1 host, 1 processo Express no
lançamento) é **compatível com o limiter em memória atual, sem
nenhuma mudança**. Decisão explícita: não migrar para Redis/Postgres
agora — não há necessidade comprovada na topologia escolhida. Gatilho de
migração: o momento em que o processo Express passar a rodar em mais de
uma instância simultânea (réplicas, cluster).

**Classificação: FECHADO para a arquitetura escolhida; IMPLEMENTAÇÃO
NECESSÁRIA ANTES DO DEPLOY apenas se a arquitetura mudar para
multi-processo.**

## Secrets

| Secret | Backend/Frontend | Build/Runtime |
|---|---|---|
| `DATABASE_URL` | backend | runtime |
| `JWT_SECRET` | backend | runtime |
| `PORT` | backend | runtime |
| `ANTHROPIC_API_KEY` | backend | runtime |
| `LEVORA_AI_MODEL` | backend | runtime |
| `SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM` | backend | runtime |
| `APP_PUBLIC_URL` | backend (usada para montar link de convite) | runtime |
| `STORAGE_LOCAL_DIR` | backend | runtime |
| `S3_BUCKET`/`REGION`/`ENDPOINT`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` | backend | runtime |
| `APPROVAL_REQUEST_EXPIRATION_DAYS` | backend | runtime |
| `TRUST_PROXY` | backend | runtime |

**Nenhum secret pertence ao frontend** — o cliente (`dist/`) nunca lê
variável de ambiente alguma em tempo de execução (confirmado: build do
Vite não injeta nenhuma `import.meta.env.VITE_*` neste projeto, busca
por esse padrão não encontrou nenhuma ocorrência). Todos os secrets
vivem só no processo Express, nunca em Git/Dockerfile/`package.json`/
workflow público — já garantido pelo `.gitignore` do `.env` e pelo CI
usando só valores dummy (Fase 54).

**Classificação: FECHADO** (matriz definida); **FECHADO COM CONFIGURAÇÃO
DO PROVEDOR** para o mecanismo de secret manager real.

## HSTS / Security headers

| Header | Quem envia |
|---|---|
| `Content-Security-Policy` (API) | Express (`securityHeadersMiddleware`, já implementado, Fase 50) |
| `Content-Security-Policy` (documento) | `<meta>` na build (sem `frame-ancestors`) **+** nginx deveria reforçar com o header HTTP completo (com `frame-ancestors`) |
| `Strict-Transport-Security` | **Só o nginx** — nunca o processo Node (decisão da Fase 50, mantida) |
| `X-Frame-Options` | Express (API) + nginx (documento) |
| `X-Content-Type-Options` | Express (API) + nginx (documento) |
| `Referrer-Policy` | Express (API) + nginx (documento) |
| `Permissions-Policy` | Express (API) + nginx (documento) |

Nenhuma política nova — só definição de onde cada uma é entregue no
ambiente real, reaproveitando a CSP já fechada na Fase 50.

**Classificação: FECHADO** (política); **FECHADO COM CONFIGURAÇÃO DO
PROVEDOR** (aplicação real no nginx).

## TRUST_PROXY

Topologia da Alternativa B:

```
browser → nginx (1 proxy) → Express
```

**`TRUST_PROXY=1`** — confia exatamente 1 salto de proxy (o nginx),
consistente com o teste real da Fase 52 (XFF passa a ser lido
corretamente de `req.ip` com esse valor, sem abrir espaço para spoofing,
porque o nginx sobrescreve qualquer XFF que o cliente tentasse forjar
antes de repassar).

**Se um cliente tentasse acessar o Express diretamente** (contornando o
nginx): como o Express está vinculado só a `127.0.0.1`/rede interna
(seção "API" acima), essa conexão nem chegaria a existir — a mitigação
real não é `TRUST_PROXY`, é a rede não expor a porta do Express.

**Classificação: FECHADO** para a topologia escolhida (valor exato
determinado: `1`).

## Cookies

`HttpOnly`+`Secure`+`SameSite=Lax` (já testado, `test/auth.test.ts`) —
**nenhuma mudança necessária** na Alternativa B: mesma origem, HTTPS
real via nginx (`Secure` passa a ter efeito, diferente do `localhost`
em desenvolvimento, onde navegadores modernos toleram `Secure` sobre
`http://localhost` como exceção), `Domain` do cookie nunca definido
explicitamente no código (usa o padrão: só o host exato que setou o
cookie) — compatível com um domínio único servindo tudo.

**Classificação: FECHADO.**

## E-mail

SMTP continua opcional no lançamento — confirmado (Fase 55) que nenhum
fluxo trava sem ele. Quando configurado, melhora exatamente um fluxo:
envio automático do e-mail de convite de organização (hoje, sem SMTP, o
link é copiado manualmente). Secrets necessários:
`SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM`, vivem só no backend. Nenhum
provedor escolhido nesta fase.

**Classificação: OPCIONAL PÓS-MVP.**

## IA

`ANTHROPIC_API_KEY` só no backend (confirmado, Fase 55: nunca chamado do
navegador). Sem a chave, matching usa só o escore determinístico —
nenhuma funcionalidade quebra. Custo: só ocorre por evento de matching
real (sweep agendado ou ação manual), não por requisição HTTP. Rate
limiting futuro do uso de IA (ex.: limitar chamadas por hora) não existe
hoje e não é necessário no volume atual — registrado como possível
necessidade se o volume de oportunidades crescer muito.

**Classificação: OPCIONAL PÓS-MVP.**

## Health

`GET /_api/__health` continua sendo **liveness** (processo de pé).
Decisão desta fase: **não implementar um endpoint de readiness
separado agora** — a Alternativa B (nginx + systemd num host simples) não
exige isso; um orquestrador mais rigoroso (Kubernetes real) exigiria,
mas essa não é a arquitetura escolhida. Se a arquitetura mudar no
futuro, esse é o gatilho para reavaliar.

**Classificação: FECHADO para a arquitetura escolhida.**

## Shutdown

**Implementado nesta fase** — ver seção "API" acima para o detalhamento
técnico. Comportamento esperado: `systemctl restart`/deploy envia
`SIGTERM`, o processo para de aceitar conexões novas, finaliza as em
andamento (até 10s), fecha o pool do Postgres, encerra limpo.

**Classificação: FECHADO.**

## Backup / Restore

**Procedimento definido, testado e documentado na Fase 57** — ver
[`docs/DATABASE_RECOVERY.md`](DATABASE_RECOVERY.md) para o detalhamento
completo (inventário, formato escolhido e por quê, backup/restore reais
com evidência, validação estrutural e funcional, tempo medido, RPO/RTO,
retenção, criptografia, PITR avaliado, disaster recovery, failure modes,
requisitos do provedor, checklist repetível).

Resumo:

- **Frequência-alvo**: diária, automática (requisito para o provedor).
- **Retenção-alvo**: mínimo 30 dias (requisito para o provedor).
- **Local**: fora do host primário do banco (requisito para o provedor).
- **Criptografia**: em trânsito (`sslmode=require`) + em repouso (padrão
  do provedor).
- **RPO**: ≤24h no pior caso (backup diário) — PITR avaliado e
  conscientemente adiado (sem necessidade comprovada no volume atual).
- **RTO**: ≤4h permanece a meta — tempo técnico de restore medido
  (~3,4s para o volume atual), não inclui provisionamento de
  infraestrutura nova do zero (não exercido, por regra desta fase).
- **Teste de restauração real**: **executado nesta fase** — banco
  separado criado, backup restaurado, estrutura idêntica confirmada
  (contagem exata, não estimativa), `verifyAuditLogChain()` real
  confirmou integridade, aplicação real validada via Central Visual
  (desktop + mobile).
- **Achado real corrigido**: `schema_migrations` estava com uma migration
  (Fase 48) sem rastreamento — corrigido no banco de desenvolvimento.

**Classificação: FECHADO** (procedimento definido e testado) **COM
CONFIGURAÇÃO DO PROVEDOR** (execução real em produção depende do
provedor escolhido cumprir os requisitos de `docs/DATABASE_RECOVERY.md`,
seção 20).

## CI / CD

CI: fechado (Fase 54). CD: **não implementado nesta fase**, requisitos
mapeados na Fase 55 (deploy, migrations antes do tráfego novo, secrets
do provedor, rollback seguro enquanto migrations forem aditivas) —
permanecem válidos, nenhuma mudança.

**Classificação: CI FECHADO; CD IMPLEMENTAÇÃO NECESSÁRIA ANTES DO
DEPLOY.**

## Deploy order

```
1. build (npm run build)
2. backup do Postgres (antes de qualquer migration)
3. npm run db:migrate:incremental
4. deploy do processo Express novo
   — graceful shutdown do processo antigo (Fase 56) reduz a janela
     de erro durante a troca
5. deploy dos arquivos estáticos novos (dist/) no nginx
6. GET /_api/__health (liveness) — confirma que o processo subiu
7. liberar tráfego
```

Compatibilidade migration↔código: **vantagem operacional real e já
comprovada** — todas as 13 migrations até agora são estritamente
aditivas (nunca removem coluna/tabela), então a ordem acima tolera um
breve período em que código antigo ainda está rodando contra um schema
já migrado à frente, sem quebrar.

## Rollback

- **Rollback de código**: reverter para o build/commit anterior —
  seguro, pelo motivo acima (migrations aditivas).
- **Rollback de banco**: **não existe mecanismo automatizado** — não há
  migrations "down". Se uma migration futura precisar remover ou
  renomear algo (não aconteceu até agora), isso vai exigir uma
  estratégia explícita de rollback antes de ser aplicada em produção —
  registrado como requisito futuro, não resolvido aqui.

**Classificação: rollback de código FECHADO; rollback de banco
IMPLEMENTAÇÃO NECESSÁRIA caso surja uma migration não-aditiva.**

## Observabilidade

Requisitos mínimos (não implementados nesta fase, já mapeados na Fase
55): 5xx da API, processo indisponível, banco indisponível, scheduler
falhando (`background_task_runs.status='falhou'`, já existe), audit
chain inválida (`error.kind='integrity_invalid'`, já existe), storage
falhando (já logado individualmente), rate limit excedido (já responde
429, sem agregação), deploy falhando (depende do orquestrador escolhido).

**Classificação: PARCIALMENTE FECHADO** (os sinais de negócio já
existem); **OPCIONAL PÓS-MVP** para métricas/dashboards/alertas
automatizados.

## Ambientes

| | Development | Test/CI | Production |
|---|---|---|---|
| `DATABASE_URL` | Postgres local (Docker) | Postgres efêmero do GitHub Actions | Postgres gerenciado |
| `JWT_SECRET` | valor de dev | `ci-only-secret-...` (Fase 54) | secret real do provedor |
| `TRUST_PROXY` | ausente | ausente | `1` |
| `ANTHROPIC_API_KEY` | ausente (fallback) | ausente | opcional |
| `SMTP_*` | ausente (fallback) | ausente | opcional |
| `S3_*` | ausente (disco local) | ausente | opcional (ver Storage) |
| Scheduler | roda (mesmo processo) | não roda (testes chamam handlers diretamente) | roda |
| CSP/headers | dev: sem CSP; preview: CSP completa | n/a | CSP completa + headers do nginx |
| HTTPS | não (http://localhost) | n/a | sim, obrigatório |

Nenhum ambiente de staging completo criado — não há necessidade
comprovada no volume atual (consistente com a instrução da fase).

## Diagrama final

```
                         ┌───────────────┐
                         │    Browser    │
                         └───────┬───────┘
                                 │ HTTPS (TLS terminado aqui)
                                 ▼
                    ┌─────────────────────────┐
                    │   nginx                 │
                    │   - serve dist/ (SPA)   │
                    │   - fallback→index.html │
                    │   - headers (CSP/HSTS/  │
                    │     X-Frame-Options/…)  │
                    └───────────┬─────────────┘
                                │ /_api/* (proxy_pass, same-origin)
                                │ X-Forwarded-For/-Proto
                                ▼
                    ┌─────────────────────────┐
                    │ Express API              │
                    │ 127.0.0.1:3001 (interno) │
                    │ TRUST_PROXY=1             │
                    │ + Scheduler (node-cron)   │
                    │ + graceful shutdown       │
                    │   (SIGTERM/SIGINT)        │
                    └────────────┬──────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌───────────┐    ┌──────────────┐   ┌───────────────┐
        │ PostgreSQL │    │ File storage │   │ Anthropic API  │
        │ (gerenciado,│   │ disco local  │   │ (opcional,     │
        │  SSL,       │   │ volume       │   │  server→server │
        │  backup     │   │ persistente  │   │  only)         │
        │  diário)    │   └──────────────┘   └───────────────┘
        └───────────┘
              │
              ▼ (opcional)
        ┌───────────┐
        │   SMTP     │
        └───────────┘
```

---

# Pacote de deploy reprodutível (Fase 58)

A Fase 58 transformou a arquitetura acima num procedimento de instalação
concreto e **validado de verdade** — não só documentado — contra um
servidor Linux limpo (container Docker real, não suposição). Ver
`docs/DEPLOYMENT_RUNBOOK.md` para o procedimento completo.

## Estado do pacote de deploy

| Item | Estado | Evidência |
|---|---|---|
| Build do backend (`npm run build:server`) | **Corrigido nesta fase** — nunca tinha sido executado com sucesso antes (só `npm run build`, front-end, roda na CI) | 535 erros em 109 arquivos antes da correção; build limpo depois |
| Descoberta de endpoints no build compilado | **Corrigido nesta fase** — regex só reconhecia `.ts`, nunca `.js` | `Descobertos 0 endpoints` antes → `Descobertos 54 endpoints` depois, com chamada real confirmada contra o Postgres |
| Config do agendador (`scheduled-jobs.json`) no build compilado | **Corrigido nesta fase** — nunca era copiada para `dist-server/` | Agendador registrava 0 tarefas antes → 5 tarefas depois |
| `tsx` como dependência de produção | **Corrigido nesta fase** — vivia só em `devDependencies`, quebraria `npm ci --omit=dev` + migrations oficiais num servidor limpo | Confirmado via `npm ci --omit=dev` real em container Linux |
| Migração em banco novo, do zero, via mecanismo oficial | **Validado nesta fase** | 26/26 tabelas, 13/13 migrations, container Linux real |
| SIGTERM real entre processos (Linux) | **Validado nesta fase pela primeira vez na sessão** — a Fase 56 só conseguiu testar no mesmo processo (Windows não entrega SIGTERM real entre processos) | `docker stop` → log de encerramento gracioso em ~0,4s |
| `TRUST_PROXY=1` através de nginx real | **Validado nesta fase pela primeira vez com nginx de verdade** — a Fase 52 só tinha testado contra o Express isolado | 25 requisições com `X-Forwarded-For` forjado e diferente a cada vez, através de nginx real, todas no mesmo bucket de rate limit |
| `deploy/nginx.conf` | Criado nesta fase, validado com `nginx -t` real | Sintaticamente correto |
| `deploy/levora-api.service` | Criado nesta fase, validado com `systemd-analyze verify` | Sintaticamente correto (só reclama da ausência do binário `node` no container de teste, esperado) |
| `.env.example` | Revisado nesta fase, sem lacunas | Todo `process.env.*` do backend tem entrada correspondente |
| Certificado TLS real / domínio real / Postgres gerenciado real | **Não resolvido nesta fase, propositalmente** — decisão de infraestrutura externa, fora do escopo de "não fazer deploy real" | `deploy/nginx.conf` usa caminhos de referência, sem certificado real |

## Atualização da seção 20 (Bloqueadores reais para produção)

4. ~~Processo de deploy nunca executado de ponta a ponta~~ —
   **RESOLVIDO na Fase 58**: a cadeia completa (build → migração oficial
   em banco novo → systemd → nginx → health check → tráfego) foi
   executada de verdade contra um ambiente Linux real, e três bugs reais
   que teriam quebrado um deploy em produção (build do backend quebrado,
   agendador sem config, zero endpoints no build compilado) foram
   encontrados e corrigidos **antes** de qualquer tentativa de deploy
   real — exatamente o tipo de problema que só aparece ao executar o
   build real, nunca ao só revisar o código.

Restam, sem alteração desde a Fase 56/57: a contratação real de
domínio+certificado+provedor de Postgres gerenciado — decisão de
infraestrutura externa, não resolvível com código ou documentação.

---

# Requalificação independente do pacote de deploy (Fase 59)

A Fase 58 provou que o pacote funciona em Linux. A Fase 59 reproduziu o
procedimento do zero, num segundo ambiente Linux completamente
independente (rede Docker nova, imagem base diferente — `bullseye` em vez
de `bookworm`, Postgres novo, nenhum arquivo reaproveitado do ambiente
anterior), para confirmar que o resultado não dependia do container
específico da fase anterior.

## Resultado

**Todo o caminho se repetiu identicamente**: `npm ci --omit=dev` (sem
nenhuma instalação manual) → `npm run build`/`build:server` → migração
num Postgres novo via mecanismo oficial (26 tabelas, 13/13 migrations) →
`node dist-server/server/index.js` (54/54 endpoints descobertos,
idênticos aos do código-fonte) → nginx real → SIGTERM real (~0,3s,
encerramento gracioso) → restart limpo. Adicionalmente, o
`verifyAuditLogChain()` canônico confirmou `integra: true` contra um
restore real de backup, e os endpoints críticos (login, registro,
sessão, logout, organizações, needs, opportunities, inventory,
platform-organizations, background-tasks) responderam corretamente
através do router real, incluindo validação Zod e autorização por papel
(403 para usuário comum em rotas de plataforma).

## Dois achados reais novos, corrigidos nesta fase

1. **`deploy/nginx.conf` vazava headers do documento para `/_api/*`** —
   `add_header` no nível do `server{}` é herdado por qualquer location
   sem o seu próprio, incluindo o proxy da API, duplicando o
   `Content-Security-Policy` do Express. Corrigido: headers do documento
   movidos para dentro de `location = /index.html` e `location /`
   apenas.
2. **`npm start` não deve nunca ser o `ExecStart`** — testado
   isoladamente (não fazia parte do `deploy/levora-api.service`, que já
   estava correto desde a Fase 58): `npm start` como processo principal
   de um container não repassa SIGTERM de forma confiável ao Node filho,
   impedindo o desligamento gracioso de rodar. Como `deploy/levora-api.service`
   já chamava `node` diretamente, a correção foi só de teste/documentação
   — mas a razão concreta para essa escolha, antes só convenção, agora
   tem evidência real.

Um terceiro ponto, de processo de teste (não do artefato): validar nginx
só com `curl` não detecta um `mime.types` ausente — só um Central Visual
real, carregando a página num navegador através do nginx, expôs que o
JavaScript viria como `text/plain` nessa condição. Nota adicionada em
`deploy/nginx.conf` e no runbook.

## Estado depois da requalificação

| Item | Fase 58 | Fase 59 (independente) |
|---|---|---|
| `npm ci --omit=dev` | OK | OK, ambiente novo |
| 54 endpoints descobertos | OK | OK, confirmado 1:1 contra o código-fonte |
| Scheduler carregado | OK | OK |
| Migração em banco novo | 26 tabelas, 13/13 | 26 tabelas, 13/13, confirmado de novo |
| Restore + integridade do audit chain | Fase 57 (procedimento) | Reexecutado nesta fase, `integra: true` |
| SIGTERM real | OK (~0,4s) | OK (~0,3s) — e provou por que `npm start` nunca pode ser o `ExecStart` |
| nginx + TRUST_PROXY + spoofing | OK | OK, reconfirmado, e um bug real de duplicação de headers foi encontrado e corrigido |
| Central Visual através do nginx real | Não feito (só `curl`) | Feito — achado do `mime.types` só apareceu aqui |

Nenhum deploy real, domínio real ou certificado real usado. O pacote de
deploy está qualificado: o resultado da Fase 58 não dependia do
container específico daquela fase.

---

# Seleção de infraestrutura de produção (Fase 60)

Decisão completa e detalhada em
[`docs/INFRASTRUCTURE_DECISION.md`](./INFRASTRUCTURE_DECISION.md).
Resumo factual (pesquisa feita em 01/10/2026, direto nos sites/documentação
oficiais dos provedores — não de memória):

## Fornecedores candidatos pesquisados

- **VPS**: Hetzner Cloud (CPX22: 2 vCPU/4 GB/80 GB/20 TB tráfego,
  €19,99/mês) e DigitalOcean (Basic Droplet: 2 vCPU/4 GB/80 GB/4 TB
  tráfego, US$24,00/mês).
- **PostgreSQL gerenciado**: DigitalOcean Managed PostgreSQL
  (US$15,15/mês, 1 GB/1 vCPU, backup nativo de 7 dias, VPC gratuita com
  o Droplet), Neon (pay-as-you-go, ~US$19–22/mês sem scale-to-zero,
  PITR até 7 dias), Supabase (US$25/mês Pro, backup de só 7 dias — 14
  dias exigiria o plano Team, US$599/mês).
- **DNS**: Cloudflare (grátis).
- **TLS**: Let's Encrypt (já era a referência desde a Fase 58).
- **Storage de backup independente**: Hetzner Storage Box (1 TB,
  €3,20/mês) e DigitalOcean Spaces (250 GB, US$5,00/mês).

## Achado real desta fase

**Nenhum provedor de PostgreSQL gerenciado pesquisado cumpre sozinho o
requisito de retenção ≥30 dias já definido pelo projeto na Fase 57**
(todos oferecem 7 dias de backup/PITR nativo nos planos de entrada). Isso
não muda a arquitetura: o procedimento `pg_dump`/`pg_restore` já validado
na Fase 57 continua sendo a camada responsável pelos 30 dias de retenção,
independentemente do provedor escolhido — o backup nativo do provedor só
cobre recuperação rápida de incidentes recentes.

Hetzner **não** oferece PostgreSQL gerenciado — qualquer VPS Hetzner
precisaria de um provedor de banco separado, cruzando a internet pública
entre VPS e banco (mitigado só por `sslmode=require`, sem VPC).

## Decisão

**Topologia selecionada**: DigitalOcean Droplet (4 GB/2 vCPU) +
DigitalOcean Managed PostgreSQL (1 GB/1 vCPU) + DigitalOcean Spaces
(backup independente), todos na mesma VPC gratuita — ≈US$44/mês
recorrente, domínio à parte. Critério de decisão: é a única das duas
topologias concretas comparadas que cumpre, sem contorno, o requisito já
documentado de que "o PostgreSQL não deve ficar aberto à internet
desnecessariamente" / rede privada quando o provedor suportar — o custo
mensal das duas alternativas é equivalente.

Nenhuma conta foi criada, nenhum domínio registrado, nenhum deploy real
feito nesta fase.

---

# Arquitetura escolhida e validada em infraestrutura real descartável (Fase 61)

A decisão de infraestrutura paga (seção anterior) foi **pausada** — o
projeto decidiu não assumir custo de hospedagem antes de haver
investimento. Em vez de provisionar o DigitalOcean real, a Fase 61
validou um **staging zero-custo**, real e funcional, publicado na
internet de verdade via Cloudflare Tunnel (gratuito, sem conta): Docker
local (nginx + Express compilado + PostgreSQL) no computador do
proprietário do projeto. Detalhe completo em
[`docs/STAGING_ZERO_COST.md`](./STAGING_ZERO_COST.md).

**O que foi comprovado de verdade, com evidência real (não simulação)**:
build (`npm ci --omit=dev` + `build`/`build:server`) idêntico ao
validado nas Fases 58/59; migração oficial num Postgres novo (26
tabelas, 13/13 migrations); 54/54 endpoints descobertos; scheduler com 5
tarefas; backup real (`pg_dump`, SHA-256) e restore real num banco
separado, com a aplicação de verdade (login incluído) funcionando contra
o banco restaurado; SIGTERM real (~0,3s) e restart limpos; persistência
de dados e uploads através de um ciclo completo `docker compose
down`/`up`; rate limiting resistente a spoofing através da cadeia
completa `Cloudflare → túnel → nginx → Express`; e acesso público real
via HTTPS, incluindo Central Visual completo (desktop + mobile) pela URL
pública, não por `localhost`.

**Cadeia de confiança de IP investigada e comprovada** (não assumida):
`CF-Connecting-IP` não pode ser forjado pelo cliente (testado — a borda
da Cloudflare devolve 403 antes mesmo de a requisição chegar ao túnel);
`X-Forwarded-For` pode ser definido pelo cliente, mas a Cloudflare só
acrescenta o IP real ao final da lista, nunca substitui. O nginx do
staging usa só `CF-Connecting-IP`, nunca o `X-Forwarded-For` de entrada.

**Classificação explícita**: este é um ambiente de **staging/demonstração
gratuita**, não produção empresarial nem alta disponibilidade — depende
deste computador e desta conexão de internet estarem ligados, sem
backup geograficamente independente, sem alertas externos. A arquitetura
real paga (DigitalOcean, seção anterior) e todo o material de deploy em
VPS (`deploy/nginx.conf`, `deploy/levora-api.service`,
`docs/DEPLOYMENT_RUNBOOK.md`) permanecem prontos e documentados, sem
nenhuma alteração de arquitetura, para quando houver investimento — o
mesmo backup/restore validado nesta fase é a ponte entre os dois
ambientes.

Custo desta fase: **US$0,00**. Nenhuma conta de provedor pago criada,
nenhum cartão usado.


---

# Operacionalização do staging gratuito (Fase 62)

O staging zero-custo validado na Fase 61 passou a ser o
**ambiente de demonstração/teste oficial** da Levora Solidária, com
scripts reprodutíveis (`scripts\staging-up.ps1`/`staging-status.ps1`/
`staging-down.ps1`/`staging-backup.ps1`/`staging-restore.ps1`/
`staging-reset.ps1`/`staging-destroy.ps1`) e um runbook completo em
[`docs/STAGING_OPERATIONS.md`](./STAGING_OPERATIONS.md). O proprietário
do projeto consegue subir, demonstrar, fazer backup e desligar o
ambiente sem depender desta conversa.

**Achado real crítico desta fase, corrigido**: o pool de conexões do
Postgres (`src/helpers/db.tsx`) podia sofrer um deadlock total e
permanente — o mecanismo de lock do scheduler disputava o mesmo pool
pequeno (`max: 3`) usado por toda query da aplicação, e uma sobreposição
real entre tarefas agendadas (reproduzida de propósito) travava login e
qualquer rota que tocasse o banco indefinidamente. Esse defeito só
aparece com tempo de execução real — nenhuma validação anterior (todas
de duração curta) tinha rodado o suficiente para expô-lo. Corrigido com
um pool dedicado e separado para o scheduler (`max: 5`), nunca
compartilhado com o pool principal da aplicação — sem essa correção,
qualquer deploy real de longa duração desta arquitetura (staging ou
produção futura) eventualmente travaria por completo.

Classificação reafirmada: staging/demonstração gratuita, não produção
empresarial. Custo desta fase: US$0,00.

---

# Hardening de IA/transação/erros de infraestrutura (Fase 64)

Corrige os dois achados registrados (não corrigidos) na Fase 63:

1. **Timeout de IA dentro da transação de matching**: a chamada ao
   provedor de IA em `src/helpers/opportunityMatching.tsx` (dentro de
   `db.transaction()`, segurando uma conexão do pool de 3) nunca teve
   limite de tempo. Investigado se seria seguro mover a chamada para fora
   da transação: não é, sem uma reestruturação maior — o `SELECT ... FOR
   UPDATE` da oportunidade protege a consistência de
   `remaining`/`existingOrgIds` contra execuções concorrentes, e esse
   lock só existe enquanto a transação está aberta. Corrigido com a
   menor mudança segura: timeout de 8s + `AbortController` real
   (`src/helpers/aiClient.tsx`), cancelando a requisição HTTP de verdade,
   não só desistindo de esperar localmente. Comportamento funcional
   preservado — o fallback determinístico por palavra-chave, que já
   existia para qualquer falha de IA, agora também cobre timeout
   explicitamente.
2. **Erro de infraestrutura mascarado como falha de autenticação**:
   `login_with_password_POST.ts` tinha um catch único que devolvia
   sempre 400 "Falha na autenticação" para QUALQUER exceção, sem log —
   incluindo o PostgreSQL ficar indisponível (reproduzido de verdade na
   Fase 63). Corrigido distinguindo entrada malformada (Zod/JSON → 400)
   de erro inesperado (→ 500, logado no servidor, mensagem pública
   genérica sem vazar detalhes internos). As falhas de credencial reais
   (e-mail/senha errados, rate limit) já eram tratadas antes deste catch
   e continuam exatamente iguais (401/429).

**Validado de verdade, não só em teste unitário**: reproduzido dentro do
container de staging real — login respondeu em 0,36s enquanto uma
transação de matching segurava uma conexão esperando uma IA
deliberadamente travada (mock de `fetch`, nunca o provedor real), que
abortou em ~8036ms exatamente como configurado. PostgreSQL derrubado em
staging → login agora devolve 500 (antes: 400) com o erro real logado no
servidor, nunca exposto ao público; religado → recuperação automática.

Matching 1.4 preservado integralmente: nenhum peso, critério, threshold,
`ALGORITHM_VERSION` ou regra de elegibilidade alterado — só a fronteira
de timeout ao redor da chamada externa e a classificação de erro no
login.

Três testes de regressão novos (`test/aiTimeoutAndPoolIsolation.test.ts`)
somados aos dois da Fase 63 — todos contra o Postgres real de
desenvolvimento.

---

# Auditoria global da classificação de erros da API (Fase 65)

Investigado o achado registrado na Fase 64 (não corrigido lá por risco
não avaliado): `buildErrorResponse` (`src/helpers/errorResponse.tsx`),
usado por 49 dos 54 endpoints, tinha default 400 para erro desconhecido
e repassava `error.message` ao cliente para QUALQUER `Error`.

**Confirmado real e concreto, não hipotético**: reproduzido contra um
Postgres real — um erro de conexão expõe o hostname interno
(`getaddrinfo ENOTFOUND <host>`), um erro de query expõe nome de
tabela/schema (`relation "x" does not exist`). Mapeados todos os 49
consumidores: nenhum dependia legitimamente do default 400 para erro
desconhecido (só 1 `throw new Error` de negócio em todo o conjunto,
corrigido com uma nova classe `ConflictError` → 409, substituindo uma
comparação de texto frágil que a própria fase encontrou ainda viva).

**Corrigido, num único ponto central**: erro desconhecido → 500 (nunca
mais 400), mensagem pública nunca mais é `error.message` bruto — sempre
o `fallbackMessage` seguro que cada endpoint já define. Dois achados de
regressão real, descobertos pela própria suíte de testes durante a
correção (não hipotéticos): `ZodError` e `SyntaxError` (corpo
malformado, antes mesmo de chegar ao Zod) precisaram de classificação
explícita para continuar 400 — ambos corrigidos antes de fechar a fase.

Validado ao vivo em staging: Postgres indisponível → 500 com mensagem
genérica e erro real logado só no servidor; Zod inválido → 400;
autenticação ausente → 401; conflito real (oportunidade já recebida) →
409; corpo JSON malformado → 400 com mensagem genérica. Recuperação
confirmada após religar o Postgres.

Três testes de regressão novos (`test/errorResponse.test.ts`,
`test/opportunitiesStatusConflict.test.ts`) cobrindo o helper central e
o único caso de conflito real do projeto.
