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

### Antes de atualizar um banco COM dados: três pré-condições (medidas na Fase 94)

`test/schemaMigrationsData.test.ts` atualiza um banco que já tinha dados (baseline do commit 590ff60) migração por migração e prova que **nenhum registro é alterado, perdido, trocado ou duplicado**.
Mas três migrações adicionam restrições que **dados antigos válidos no baseline podem violar**; nesse caso o runner falha de forma ruidosa e atômica (nada fica pela metade, a migração que falhou não é
registrada em `schema_migrations`, os dados não mudam) e a atualização só conclui depois de corrigir o dado. Confira ANTES (cada consulta deve devolver 0 linhas):

```sql
-- 0013: e-mails que diferem só em maiúsculas/minúsculas
SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
-- 0005: oportunidades com quantidade zero ou negativa
SELECT id, quantity FROM opportunity_registry WHERE quantity IS NOT NULL AND quantity <= 0;
-- 0007: avaliações de matching duplicadas para a mesma alocação
SELECT allocation_id, count(*) FROM match_evaluations WHERE allocation_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
```

O que a atualização **faz com os dados antigos** (verificado): linhas do `audit_log` ficam com `previous_event_hash`/`event_hash` NULL (início de uma nova cadeia, não corrupção — `docs/AUDIT.md`);
`opportunity_allocations.need_id` fica NULL (sem backfill); as tabelas novas (convites, arquivos, capacidades, configurações e áreas de matching, ledger de atendimento e resoluções) nascem vazias — nenhuma
migração fabrica dados a partir dos antigos. **Não coberto:** bancos criados antes do baseline 590ff60, volumes grandes (tempo e bloqueios das migrações em tabelas grandes), concorrência durante a
atualização e as sequências de dados que só existem em produção.

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
