# Testes automatizados — Levora Solidária

Este documento descreve a suíte de testes automatizados introduzida para
substituir a validação manual via chamadas HTTP que era usada durante o
desenvolvimento original no Floot (ver `src/static/__dev/docs/plano-implementacao.md`).
Antes desta suíte, não havia nenhum teste automatizado no projeto.

## Ferramentas

- **[vitest](https://vitest.dev/)** — escolhido por já compartilhar
  configuração/transformação com o Vite que o projeto já usa no cliente, sem
  exigir um segundo bundler/transformer só para os testes.
- **Postgres real** para os testes de integração — não usamos mocks do banco.
  As regras de negócio mais críticas deste projeto (isolamento entre
  organizações, saldo de estoque nunca negativo, dupla aprovação) vivem em
  transações SQL (`FOR UPDATE`, `CHECK` constraints, triggers append-only) —
  um mock de banco daria falso positivo exatamente nos cenários que mais
  importa testar.

## Como rodar

```bash
npm test            # roda a suíte inteira uma vez
npm run test:watch  # modo watch, re-roda ao salvar
npm run test:coverage
```

### Pré-requisito: banco de dados de teste

1. Copie `.env.example` (ou o `.env.test` já versionado como exemplo — na
   verdade `.env.test` está no `.gitignore`, então cada ambiente precisa
   criar o seu) apontando `DATABASE_URL` para um banco **dedicado a
   testes**, cujo nome termine em `_test` (ex.:
   `postgres://usuario:senha@localhost:5432/levora_solidaria_test`).
2. Não é necessário criar o banco manualmente nem rodar
   `npm run db:migrate` nele — `test/global-setup.ts` cria o banco se não
   existir e recria o schema inteiro (`DROP SCHEMA public CASCADE` +
   reaplica `db/schema.sql`) uma vez, antes de toda a suíte rodar.
3. **Nunca aponte esta variável para o banco de desenvolvimento.** Duas
   proteções impedem isso por engano: `global-setup.ts` e `setup.ts` recusam
   rodar se o nome do banco não terminar em `_test`.

## Estrutura

```
test/
  global-setup.ts        # roda 1x antes de toda a suíte: cria/recria o banco de teste
  setup.ts                # roda antes de cada arquivo: TRUNCATE em todas as tabelas de negócio
  helpers.ts               # criação de usuário/sessão/organização direto no banco, sem passar pelo HTTP
  auth.test.ts              # cadastro, login, bloqueio por força bruta (5 tentativas / 15 min)
  stockTransactions.test.ts # entrada/saída/ajuste de estoque, saldo nunca negativo, dupla aprovação, isolamento
  needsStatus.test.ts       # atualização de status de necessidade, auditoria, isolamento
  opportunityMatching.test.ts # teste unitário puro da pontuação por palavra-chave do motor de matching
```

Cada teste roda contra um banco limpo (`beforeEach` trunca todas as tabelas
de negócio com `RESTART IDENTITY CASCADE`) — testes não dependem de ordem de
execução nem de dados deixados por outro teste.

## Como os endpoints são testados

Cada endpoint em `src/endpoints/**/*_GET.ts` / `*_POST.ts` exporta uma função
`handle(request: Request): Promise<Response>` usando a Web Fetch API padrão
(ver `server/index.ts`). Isso significa que os testes de integração **não
precisam subir um servidor Express** — importam `handle` diretamente e
constroem um `Request` de verdade (`test/helpers.ts#buildRequest`), incluindo
cookie de sessão real (criada via `test/helpers.ts#createAuthenticatedUser`,
que insere a sessão na tabela `sessions`, o mesmo caminho que o login usa).
Isso testa autenticação, autorização (`requireOrganizationMembership`),
validação de schema (zod) e a query real no Postgres, tudo numa única
chamada — sem precisar mockar nada dessas camadas.

## O que já está coberto

- **Autenticação**: cadastro, login com senha certa/errada, e o rate
  limiting de força bruta (bloqueio após 5 tentativas falhas em 15 minutos,
  seção 108 do master prompt).
- **Isolamento multi-organização**: um usuário não consegue lançar estoque
  ou alterar uma necessidade de uma organização da qual não é membro (403),
  nem usar um `itemId`/`needId` de outra organização mesmo sendo membro de
  alguma organização (404) — os dois vetores de escape de tenant descritos
  no master prompt (seção 7).
- **Integridade de estoque**: saldo nunca fica negativo (409), e ajuste
  negativo acima do limite de risco vira pedido de dupla aprovação em vez de
  aplicar direto (seção 40 do master prompt — "quem detecta a divergência
  não é quem autoriza a saída sozinho").
- **Motor de correspondência**: teste unitário da função pura de pontuação
  por palavra-chave (normalização de acentos, correspondência parcial,
  ausência de correspondência).

## O que ainda falta (próximos passos naturais desta suíte)

- Testes de isolamento cruzado mais extensos (ex.: `opportunity_registry`,
  `opportunity_allocations`, `logistics_events`, `approval_requests`) — hoje
  só `stock_transactions` e `needs` têm teste de isolamento explícito.
  Novos testes devem seguir o mesmo padrão de `stockTransactions.test.ts`.
- Testes de idempotência (`background_task_runs.idempotency_key`,
  `runMatchingForOpportunity` chamado duas vezes para a mesma oportunidade).
- Testes de segurança adicionais listados no master prompt (seções 111–119):
  tentativa de SQL injection via campos de texto (mitigado pelo Kysely
  parametrizado, mas vale um teste que documente isso), CSRF/XSS na camada
  de API (o projeto retorna JSON puro, risco é baixo, mas não testado
  ainda), tentativa de reativar um código de acesso expirado/revogado.
- ~~Rodar a suíte em CI a cada push~~ — resolvido:
  `.github/workflows/ci.yml` roda `npm run typecheck` e `npm test` a cada
  push/PR na `master`, contra um Postgres real (serviço do próprio job, não
  mock), com `DATABASE_URL`/`JWT_SECRET` só de CI (nunca os valores reais de
  desenvolvimento/produção).
