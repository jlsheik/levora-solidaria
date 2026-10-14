# Deploy

Master prompt, seção 142. Este documento descreve como colocar a Levora
Solidária em produção com a infraestrutura real deste repositório — não
uma receita genérica de "suba num PaaS qualquer".

## Visão geral

```
                    ┌─────────────────────┐
 usuário  ──────►   │  servidor de arquivos │  serve dist/ (cliente estático)
                    │  estáticos (nginx,    │
                    │  CDN, etc.)           │
                    └──────────┬────────────┘
                               │ proxy reverso de /_api/*
                               ▼
                    ┌─────────────────────┐
                    │  processo Node       │  node dist-server/server/index.js
                    │  (Express + agendador)│
                    └──────────┬────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  PostgreSQL           │
                    └─────────────────────┘
```

**Importante**: `server/index.ts` (o processo Node) não serve os arquivos
estáticos do cliente (`dist/`) — só a API em `/_api/v1/*`. Isso significa
que este projeto não é um único processo autocontido em produção; precisa
de duas peças rodando: o processo Node para a API, e algo servindo `dist/`
com um proxy reverso de `/_api/*` para esse processo (exatamente como o
Vite faz em desenvolvimento — ver `vite.config.ts`). Se preferir um único
processo, adicionar `express.static("dist")` + fallback de SPA em
`server/index.ts` é a mudança necessária (não feita ainda porque não havia
decisão de infraestrutura de produção tomada).

## Build

```bash
npm run build          # tsc (cliente) + vite build → dist/
npm run build:server   # tsc -p tsconfig.server.json → dist-server/
```

## Rodando em produção

```bash
NODE_ENV=production node dist-server/server/index.js
```

## Verificação no nginx real (Fase 94)

`npm run qa:security` sobe o **`deploy/nginx.conf` do repositório** num contêiner `nginx:1.27-alpine` (certificado autoassinado descartável, só 127.0.0.1) e mede os
cabeçalhos e o envio de arquivos de verdade. Três regras do nginx que isso revelou, e que valem para qualquer ajuste da configuração: (1) `add_header` num
`location` **substitui** os do `server` — repita o HSTS/nosniff em toda location que defina o seu; (2) cache imutável só para sucesso (`map $status`), nunca
`always` fixo; (3) `client_max_body_size` (padrão 1 MB) precisa ficar acima do envio válido (8 MB em base64 ≈ 10,7 MB) e do limite do Express (16 MB): usamos 17m
em `/_api/`. `test/nginxHeaders.test.ts` trava (1)–(3) e a igualdade da CSP com `src/helpers/securityHeaders.ts`. Detalhes e limites: `docs/SECURITY.md`.

## Security headers na camada estática (Fase 50)

A API (`server/index.ts`) já aplica seus próprios security headers por
conta própria (ver `docs/SECURITY.md`) — não precisa de nenhuma ação aqui.
Mas o HTML do cliente é servido por uma camada que **este repositório não
controla** (ver "Visão geral" acima), então dois headers do documento só
podem ser garantidos de verdade ali, na configuração real de produção
(nginx, Cloudflare, etc.):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), bluetooth=(), midi=(), picture-in-picture=(), display-capture=(), fullscreen=(), autoplay=(), clipboard-write=(self)
```

(Mesmos valores de `src/helpers/securityHeaders.ts` — reproduzidos aqui
porque a camada que precisa aplicá-los está fora deste repositório. A
build (`dist/index.html`) já injeta a mesma CSP via `<meta>` como primeira
camada de defesa, mas `<meta>` não suporta `frame-ancestors` nem `sandbox`
— só um header HTTP real cobre isso, por isso a lista acima precisa ser
configurada na camada estática de verdade, não só "esperada" do build.)
`vite preview` (ver `.claude/launch.json`, config `"preview"`) já aplica
esses headers localmente — é a referência viva para conferir o
comportamento antes de configurar o servidor de produção.

### HSTS — dependência operacional, não configuração deste repositório

`Strict-Transport-Security` **não é definido em nenhum lugar deste
código** (nem na API, nem no build do cliente) — de propósito. Esta
aplicação não controla a camada que termina TLS em produção (não se sabe
ainda se será a mesma camada que serve `dist/`, um load balancer separado,
ou um CDN), e um header HSTS cego nesse código seria, na melhor das
hipóteses, ignorado (navegadores só honram HSTS em resposta já servida via
HTTPS) e, na pior, uma garantia falsa.

**Antes de abrir a aplicação para produção real**, quem configurar a
camada de TLS precisa adicionar, na resposta HTTPS do domínio público:

```
Strict-Transport-Security: max-age=31536000
```

Começar sem `includeSubDomains` nem `preload` — essas duas exigem auditar
TODOS os subdomínios/propriedades sob o mesmo domínio raiz antes de ativar
(um subdomínio sem HTTPS pronto ficaria inacessível), decisão que não pode
ser tomada de dentro deste repositório.

## Variáveis de ambiente obrigatórias

Ver `.env.example` para a lista completa comentada. As que não têm valor
padrão seguro e precisam ser definidas:

- `DATABASE_URL` — string de conexão do Postgres de produção.
- `JWT_SECRET` — gerar com `openssl rand -base64 48`, único por ambiente,
  nunca reaproveitado do `.env.example` nem entre ambientes.
- `PORT` — porta do processo Node (padrão 3001).

## Variáveis opcionais que mudam comportamento em produção

- `TRUST_PROXY` — **necessário** se houver um proxy reverso/load balancer
  na frente (nginx, Cloudflare, etc.), senão o rate limiting por IP
  (`docs/RATE_LIMITING.md`) trata todo tráfego como vindo do IP do proxy.
- `SMTP_*` — sem isso, convite de membro (`docs/CONVITE_DE_MEMBROS.md`)
  continua funcionando, só sem envio automático de e-mail.
- `S3_*` — sem isso, upload de arquivo usa disco local
  (`docs/UPLOAD_DE_ARQUIVOS.md`) — **atenção**: disco local não sobrevive a
  um redeploy que troca o container/instância, nem funciona corretamente
  com múltiplas instâncias atrás de um load balancer (cada instância teria
  seu próprio disco). Para produção com mais de uma instância do processo
  Node, configurar S3 é necessário, não opcional.
- `ANTHROPIC_API_KEY` — sem isso, o motor de correspondência (matching)
  continua funcionando só com o escore determinístico.

## Migração de banco

```bash
npm run db:migrate               # banco NOVO, vazio — aplica db/schema.sql inteiro
npm run db:migrate:incremental   # banco JÁ existente — aplica só o que falta de db/migrations/
```

**Nunca rode `db:migrate` contra um banco que já tem dados** — o script é
propositalmente "hostil a idempotência" (`CREATE TABLE` sem
`IF NOT EXISTS`), para falhar alto em vez de mascarar um erro. Use
`db:migrate:incremental` para bancos existentes.

### Antes de atualizar um banco COM dados: pré-verificação automática (Fase 94)

`test/schemaMigrationsData.test.ts` atualiza um banco que já tinha dados (baseline do commit 590ff60) migração por migração e prova que **nenhum registro é alterado, perdido, trocado ou duplicado**.
Cinco migrações, porém, criam restrições que **dados antigos válidos no baseline podem violar** — são condições preexistentes dos dados (restrições legítimas), não defeitos do runner:

| Migração | Restrição criada | Dado antigo que a impede |
|---|---|---|
| `0005` | `CHECK (quantity IS NULL OR quantity > 0)` em `opportunity_registry` | oportunidade com quantidade **0 ou negativa** |
| `0007` | índice único parcial `match_evaluations(allocation_id) WHERE allocation_id IS NOT NULL` | **duas ou mais avaliações** para a mesma alocação |
| `0009` | índice único parcial `need_fulfillments(reverses_fulfillment_id) WHERE entry_type = 'reversal'` | **duas reversões** da mesma linha do ledger (o ledger não tem produtor de reversão no código: só aparece por SQL manual) |
| `0010` | chave estrangeira composta `need_fulfillments(stock_transaction_id, organization_id)` → `stock_transactions(id, organization_id)` | atendimento cujo movimento de estoque é de **outra organização** (o código sempre usa a mesma; só por SQL manual) |
| `0013` | índice único `users(LOWER(email))` | e-mails que **diferem só em maiúsculas/minúsculas** (a comparação é a do próprio índice: mesma expressão e mesma collation) |

Sem proteção, o runner aplicaria as migrações anteriores e só então falharia (atômico, mas deixando a atualização pela metade). Por isso `npm run db:migrate:incremental` agora executa, **antes de qualquer escrita**
(inclusive antes de criar `schema_migrations`), a pré-verificação de `db/legacyPreflight.ts`; o mesmo código roda sozinho, sem aplicar nada, com:

```bash
npm run db:preflight                      # a partir do repositório (como db:migrate:incremental; os .sql não vão para dist-server)
```

**Códigos de saída** (os mesmos no `db:preflight` e no início do `db:migrate:incremental`): `0` autorizada (o runner segue o fluxo original, na mesma ordem e com a mesma transação por migração) ·
`2` **bloqueada** (dados legados impeditivos, estrutura ausente ou estado inconsistente) · `3` **não verificada** (conexão, permissão ou consulta falhou: a atualização NÃO é autorizada por omissão) ·
`1` continua sendo falha ao aplicar uma migração. Com código 2 ou 3 **nenhuma migração é aplicada ou registrada, nada é criado e nenhum dado muda**; reexecutar depois de corrigir funciona normalmente.

**O que é verificado e quando.** Só as migrações **pendentes** (não registradas em `schema_migrations`): se a 0013 já foi aplicada, os dados atuais não são tratados como bloqueio. Estados: `ja-aplicada` (registrada e a restrição existe) ·
`pendente-limpa` · `pendente-com-conflito` (lista os ids) · `estrutura-ausente` (a tabela/coluna não existe: banco fora do ponto histórico esperado — instalação nova usa `npm run db:migrate`) ·
`inconsistente` (registrada mas a restrição não existe, ou a restrição existe mas não está registrada — p.ex. banco criado de `db/schema.sql` sem registrar as migrações; o runner falharia ao recriá-la). Estruturas ausentes e
inconsistências **bloqueiam quando há alguma migração pendente**; sem pendências viram apenas aviso. Migrações registradas que esta versão do código não conhece também só geram aviso. A instalação nova por `db/schema.sql` (`db:migrate`)
já registra tudo e passa como `ja-aplicada`. A verificação roda numa transação `READ ONLY` e as consultas são agregações feitas no PostgreSQL.

**Privacidade.** O relatório mostra **ids** (e contagens), nunca e-mails nem outros dados pessoais, URL de conexão, host ou senha; na 0007/0013 cada grupo aparece como `id1,id2`, separados por ` | `; acima de 20 itens, mostra 20 e "… e mais N".

**Tabelas que a própria atualização cria.** Se a estrutura de uma verificação ainda não existe porque uma migração anterior **pendente** a cria (0009/0010 dependem da 0006/0008), ela nasce vazia nesta atualização: a verificação é "pendente-limpa". Se a migração que a cria já foi aplicada e a estrutura falta, é `estrutura-ausente` (bloqueia).

**Como corrigir (manual, nunca automático) e repetir:**
- `0013`: para cada grupo de contas listado, decida qual mantém o e-mail e altere ou consolide as outras (os ids identificam as contas em `users`).
- `0005`: corrija a quantidade das oportunidades listadas em `opportunity_registry` (0 e negativos não são aceitos; `NULL` é aceito).
- `0007`: em cada grupo de `match_evaluations`, decida qual avaliação vale e desvincule as demais (`allocation_id = NULL`).
- `0009` e `0010` (ledger `need_fulfillments`, append-only): decisão de dados com revisão; a correção exige desligar temporariamente os gatilhos `need_fulfillments_no_update`/`no_delete` com `ALTER TABLE … DISABLE TRIGGER`, corrigir as linhas listadas e **religar** os gatilhos (o teste faz exatamente isso em banco descartável).
Depois rode `npm run db:preflight` até sair `0` e então `npm run db:migrate:incremental`. A ferramenta não oferece correção, remoção ou "ignorar".

**Desvio de testes.** `LEVORA_SKIP_PREFLIGHT=1` só tem efeito com `NODE_ENV=test` (o harness que aplica migrações uma a uma precisa chegar à migração em si); com qualquer outro `NODE_ENV` é ignorado e o bloqueio vale (testado).

**O que a atualização faz com os dados antigos** (verificado): linhas do `audit_log` ficam com `previous_event_hash`/`event_hash` NULL (início de uma nova cadeia, não corrupção — `docs/AUDIT.md`);
`opportunity_allocations.need_id` fica NULL (sem backfill); as tabelas novas (convites, arquivos, capacidades, configurações e áreas de matching, ledger de atendimento e resoluções) nascem vazias — nenhuma
migração fabrica dados a partir dos antigos. **Não coberto:** bancos criados antes do baseline 590ff60, volumes grandes (tempo e bloqueios das migrações em tabelas grandes), concorrência durante a
atualização, e condições de dados que **futuras** migrações venham a exigir (cada nova migração que crie uma restrição deve ganhar a sua verificação em `CHECKS`).

### Escrevendo uma migração nova: classificação obrigatória

Toda migração em `db/migrations/` precisa de uma entrada em `db/migrationCompat.ts` **no mesmo commit**, ou `test/migrationCompat.test.ts` falha:
- `{ kind: "precheck" }` — a migração impõe uma condição nova sobre linhas **que já existem** (CHECK, índice único, chave estrangeira, NOT NULL em coluna existente...). Exige também a entrada correspondente em `CHECKS` (`db/legacyPreflight.ts`):
  `migration` (o nome do arquivo), `rule`, `requires` (tabela.coluna usadas pela consulta), `providedBy` (migrações pendentes que criam essa estrutura, se for o caso), `objectExists` (como saber que a restrição já existe), `conflictQuery`
  (agregação **somente leitura** que devolve `ids` e `n` dos registros impeditivos, com a MESMA expressão/chave da restrição, nunca dados pessoais) e `fixHint`. Escreva também um teste com dados conflitantes em `test/legacyPreflight.test.ts`.
- `{ kind: "safe", category, reason }` — comprovadamente não rejeita dados existentes. `category`: `tabela-nova-vazia` (só CREATE; sem ALTER TABLE), `coluna-nullable-sem-rejeicao` (coluna nullable sem constraint, índice único ou NOT NULL novo) ou
  `restricao-satisfeita-por-construcao` (a restrição é implicada por algo que já vale: chave primária, DEFAULT aceito pelo CHECK, restrição antiga mais forte). `reason`: ≥ 60 caracteres, **específica**, citando objetos reais do SQL (tabela, coluna, índice) e dizendo POR QUE nenhuma linha antiga pode violar. "n/a", "sem risco" ou frases que não citam nada da migração são recusadas.

**Como o teste detecta omissões:** falha se houver migração sem classificação, classificação de arquivo inexistente, "precheck" sem verificação (ou verificação sem "precheck"/de arquivo inexistente/duplicada), justificativa genérica, curta ou sem objetos do SQL, ou categoria que contradiz o SQL. Cada caso é exercitado com metadados em memória (os arquivos de produção não são alterados) e por mutações das classificações reais.
**O que NÃO garante:** não há análise semântica do SQL — o teste garante que a decisão existe, é revisável e coerente, **não que esteja certa**; a revisão humana da frase e da consulta continua obrigatória. Casos que sempre pedem análise manual: backfills e conversões de dados, `ALTER COLUMN … TYPE`, `SET NOT NULL` em coluna existente, constraints sobre colunas preenchidas por código, qualquer `UPDATE`/`DELETE` dentro da migração, e dependências entre migrações pendentes.
**Relação com o comando real:** `npm run db:preflight` (e o início do `db:migrate:incremental`) executa as verificações de `CHECKS`; se houver migração **pendente** sem classificação, ele imprime um **aviso** (os códigos de saída 0/2/3 não mudam) — o gate é o teste. Quando a migração `0014` (hoje em outro checkout) for incorporada, o teste exigirá sua classificação e o SQL real deverá ser inspecionado antes de escolher entre "precheck" e "safe".

## Múltiplas instâncias (escala horizontal)

Duas peças deste sistema hoje são **estado em memória de um único
processo**, e precisam de atenção antes de rodar mais de uma instância:

1. **Rate limiting** (`src/helpers/rateLimit.tsx`) — contador em `Map` por
   processo. Com N instâncias atrás de um load balancer, o limite efetivo
   vira `limite × N`. Upgrade: trocar por um backend compartilhado (Redis).
2. **Agendador de tarefas** (`src/helpers/scheduler.tsx`) — **RESOLVIDO**:
   `withScheduledTaskLock` (`src/helpers/scheduledTaskLock.tsx`, ver
   `docs/OPERATIONS.md`) usa `pg_try_advisory_lock` de sessão do Postgres,
   que é global ao servidor de banco — não por processo. Múltiplas
   instâncias tentando disparar a mesma tarefa (`expireReservations` etc.)
   ao mesmo tempo já são protegidas pelo mesmo mecanismo que protege
   sobreposição dentro de uma única instância, sem precisar de nenhum lock
   distribuído adicional (Redis etc.) — o Postgres já É o coordenador
   distribuído aqui, e todas as instâncias já se conectam a ele.

Rate limiting continua sendo estado em memória por processo — não quebra
com múltiplas instâncias, só fica menos preciso (limite efetivo vira
`limite × N`). Documentado aqui para quem for decidir escalar
horizontalmente saber o que ainda precisa de atenção.

## O que este documento não cobre (porque não existe ainda)

- Backup automatizado e procedimento de restauração — ver
  [`docs/OPERATIONS.md`](OPERATIONS.md).
- Infraestrutura como código (Terraform, etc.) — não existe neste
  repositório; a escolha de onde hospedar (Railway, Fly.io, um VPS, etc.)
  não foi tomada.
- **CD** (deploy automático) — não há pipeline configurado: nenhum deploy
  dispara sozinho ao mergear na `master`, nenhuma infraestrutura como
  código. **CI** (integração contínua) existe e é diferente disso —
  `.github/workflows/ci.yml` roda a cada push/PR: `npm ci` → typecheck →
  testes → build → `npm audit` (Fase 54, SEC-08) — ver `docs/TESTING.md`.
