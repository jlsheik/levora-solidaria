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

- ~~Testes de isolamento cruzado mais extensos~~ — resolvido:
  `test/crossOrgIsolation.test.ts` cobre `opportunity_allocations`
  (decidir, registrar logística, listar), `approval_requests` (listar,
  decidir) e o isolamento de nível de plataforma do `opportunity_registry`
  (só admin de plataforma altera status, não qualquer proprietário de
  organização).
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
- ~~CI sem build nem verificação de dependências (SEC-08)~~ — resolvido na
  Fase 54: o mesmo workflow agora roda `npm run build` (só o cliente —
  confirmado que não exige nenhuma variável de ambiente) e `npm audit
  --audit-level=moderate` depois dos testes, cada etapa capaz de falhar o
  job sozinha (nenhum `|| true`, nenhuma etapa com saída mascarada).
  Política de severidade deliberada: `moderate` ou mais bloqueia;
  `low`/`info` não (ver `docs/SECURITY.md` e o workflow para a
  justificativa). `permissions: contents: read` explícito (menor
  privilégio — o workflow só lê e roda scripts locais, nunca escreve no
  repositório). As quatro etapas foram testadas de propósito: um erro de
  tipo, um teste quebrado e um erro de sintaxe foram introduzidos
  temporariamente e confirmados fazendo o job falhar (depois revertidos);
  o gate de `npm audit` foi provado com uma fixture isolada (fora deste
  repositório, nunca tocando o lockfile real) fixando uma versão antiga e
  conhecidamente vulnerável do `react-router-dom`.
- ~~CI não valida o artefato real de produção do backend~~ — resolvido na
  Fase 66: o workflow agora roda **`npm run build:server`** depois do
  build do frontend, antes do `npm audit`
  (`npm ci → typecheck → testes → build → build:server → verificação do
  artefato → audit`). Achado que motivou este gate (Fase 58): `npm run
  typecheck`/`npm test`/`npm run build` verdes nunca garantiram que
  `dist-server/` (o artefato que `npm start` roda em produção de verdade)
  sequer compilava — `tsconfig.server.json` usa `moduleResolution`
  NodeNext (exige extensão `.js` em import relativo), regra que o
  typecheck do frontend (`moduleResolution: Bundler`) nunca aplica. Uma
  etapa extra ("Verify server build artifact") confere, sem fixar uma
  contagem exata de arquivos (frágil a qualquer endpoint novo legítimo),
  que as três coisas que já quebraram de verdade continuam presentes:
  `dist-server/server/index.js` (entrypoint), `scheduled-jobs.json`
  (config do scheduler, Fase 58 também encontrou isso faltando) e pelo
  menos 1 endpoint descoberto. Determinismo confirmado localmente: duas
  builds limpas em sequência produzem a mesma lista de arquivos e os
  mesmos hashes SHA-256 byte a byte. O gate foi testado de propósito
  quebrando `build:server` com um import inexistente — confirmado exit
  code ≠ 0, depois revertido por completo.
- Não foi possível confirmar a execução remota real no GitHub Actions
  nesta sessão (sem push realizado — este projeto segue a regra, mantida
  em toda a sessão, de nunca commitar/empurrar automaticamente) — os
  mesmos comandos exatos do workflow (incluindo o novo `build:server` da
  Fase 66) foram validados localmente, com o mesmo resultado esperado do
  job remoto.
- `security-review` (skill nativa de revisão de segurança, baseada em
  `git diff origin/HEAD...`) não foi adicionada ao CI: não é uma
  ferramenta de linha de comando invocável por um `run:` do GitHub
  Actions — depende do próprio Claude Code estar presente para interpretar
  o diff, não é um binário/script determinístico que o workflow possa
  chamar sozinho. `npm audit` continua sendo o gate determinístico de
  segurança de dependências; revisão de segurança de código continua
  sendo uma atividade sob demanda (como esta própria sessão de fases),
  não um gate automático de CI.
- ESLint/lint: continua **não configurado** neste projeto (confirmado de
  novo na Fase 54 — nenhum `.eslintrc`/`eslint.config.*`, nenhum script
  `lint`, nenhuma dependência de lint instalada). Não adicionado ao CI por
  não existir nenhuma configuração de lint real para rodar — instalar um
  sistema de lint inteiro só para ter mais um gate estava fora do escopo
  da Fase 54.
