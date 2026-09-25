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

## Múltiplas instâncias (escala horizontal)

Duas peças deste sistema hoje são **estado em memória de um único
processo**, e precisam de atenção antes de rodar mais de uma instância:

1. **Rate limiting** (`src/helpers/rateLimit.tsx`) — contador em `Map` por
   processo. Com N instâncias atrás de um load balancer, o limite efetivo
   vira `limite × N`. Upgrade: trocar por um backend compartilhado (Redis).
2. **Agendador de tarefas** (`src/helpers/scheduler.tsx`) — cada instância
   rodaria as mesmas tarefas agendadas de forma independente. As tarefas
   já são idempotentes o bastante para não corromper dado (ex.:
   `expireReservations` só atualiza linhas cujo prazo já passou — rodar em
   paralelo em 2 instâncias não duplica nada), mas gera trabalho
   redundante. Upgrade natural: um lock distribuído (ex.: advisory lock do
   Postgres) para só uma instância disparar cada tarefa por vez.

Nenhuma dessas duas coisas quebra com múltiplas instâncias — só ficam
menos eficientes/precisas do que com uma instância só. Documentado aqui
para quem for decidir escalar horizontalmente saber o que revisar primeiro.

## O que este documento não cobre (porque não existe ainda)

- Backup automatizado e procedimento de restauração — ver
  [`docs/OPERATIONS.md`](OPERATIONS.md).
- Infraestrutura como código (Terraform, etc.) — não existe neste
  repositório; a escolha de onde hospedar (Railway, Fly.io, um VPS, etc.)
  não foi tomada.
- CI/CD — não há pipeline configurado (ver `docs/TESTING.md`, "o que ainda
  falta").
