# Levora Solidária

[![CI](https://github.com/jlsheik/levora-solidaria/actions/workflows/ci.yml/badge.svg)](https://github.com/jlsheik/levora-solidaria/actions/workflows/ci.yml)

Levora Solidária é uma infraestrutura de solidariedade que conecta
automaticamente recursos disponíveis (doações) a necessidades reais de
pessoas em situação de vulnerabilidade, com rastreabilidade de ponta a
ponta. A plataforma é multi-tenant (múltiplas organizações beneficiárias
isoladas entre si), com papéis por organização (proprietário, administrador,
operador, voluntário), inventário com ledger de estoque append-only,
registro e matching de oportunidades de doação (com apoio opcional de IA),
logística de coleta/transporte/entrega com prova, prestação de contas e
trilha de auditoria imutável. Segurança e controle de risco têm prioridade
sobre automação total: ações de alto risco (ex.: grandes reduções de
estoque) passam por dupla autorização em vez de execução direta. Toda a
interface é em português brasileiro.

Este repositório é a portagem da Levora Solidária do Floot (onde o projeto
foi originalmente construído e testado) para um stack Node padrão:
Express (API) + Vite/React (cliente) + PostgreSQL, sem dependências
específicas de plataforma.

## Pré-requisitos

- Node.js 22+
- PostgreSQL (local ou remoto)
- Opcional: uma chave de API da Anthropic, para o apoio de IA no motor de
  correspondência (matching) de oportunidades

## Configuração

```bash
# 1. Instale as dependências
npm install

# 2. Copie o arquivo de ambiente e preencha os valores
cp .env.example .env
# Edite .env: DATABASE_URL, JWT_SECRET (gere com `openssl rand -base64 48`)
# e, opcionalmente, ANTHROPIC_API_KEY

# 3. Crie o banco de dados
createdb levora_solidaria

# 4. Aplique o schema
npm run db:migrate
```

## Rodando em desenvolvimento

São dois processos separados:

```bash
# Servidor de API (Express, porta 3001 por padrão)
npm run dev

# Cliente (Vite, porta 5173, com proxy de /_api para o servidor acima)
npm run client:dev
```

Abra `http://localhost:5173`. Todas as chamadas do cliente para `/_api/*`
são encaminhadas pelo Vite para o Express em `http://localhost:3001` — a
migração preservou o prefixo `/_api` que o código já portado usava; a API é
versionada (`/_api/v1/...`, ver
[`docs/VERSIONAMENTO_API.md`](docs/VERSIONAMENTO_API.md)).

## Build de produção

```bash
npm run build         # tsc (client) + vite build -> dist/
npm run build:server  # tsc -p tsconfig.server.json -> dist-server/
npm start              # node dist-server/server/index.js
```

## Estrutura

- `src/components`, `src/helpers`, `src/pages`, `src/endpoints`,
  `src/base.css` — código de negócio portado verbatim do Floot.
- `src/main.tsx`, `src/App.tsx`, `vite.config.ts`, `index.html` — scaffold
  de build criado nesta migração (roteador React Router substituindo o
  roteamento por convenção de arquivos do Floot; ver abaixo).
- `server/index.ts` — servidor Express real, criado nesta migração, que
  descobre automaticamente cada `src/endpoints/**/*_GET.ts` e `*_POST.ts`
  (cada um exporta `handle(request: Request): Promise<Response>`, no
  padrão Web Fetch API) e os monta em `/_api/v1/<rota>`.
- `db/schema.sql` — migração Postgres completa, reconstruindo o schema do
  banco provisionado originalmente pelo Floot.

### Roteamento

O Floot roteava `src/pages/*.tsx` por convenção de nome de arquivo
(`_index.tsx` → `/`, `organizacoes.$organizationId.tsx` →
`/organizacoes/:organizationId`, etc.), com um arquivo `<página>.pageLayout.tsx`
opcional por página exportando um array de componentes de ordem superior
para proteção de rota (ex.: `[UserRoute]`, `[AdminRoute]`, ou `[]` para
página pública). Esse mecanismo não existe fora do Floot, então
`src/App.tsx` recria o mesmo comportamento manualmente com
`react-router-dom` (`createBrowserRouter`): cada rota é registrada
explicitamente e envolvida pelos mesmos componentes de proteção
(`src/components/ProtectedRoute.tsx`) que o `pageLayout.tsx` da página já
declarava — nenhuma lógica de autenticação/autorização nova foi inventada.

## Testes automatizados

O projeto tem uma suíte de testes automatizados (vitest) cobrindo
autenticação, isolamento multi-organização, integridade de estoque e o
motor de correspondência. Ver [`docs/TESTING.md`](docs/TESTING.md) para como
rodar (`npm test`) e o que já está coberto.

## Documentação

Documentação obrigatória do master prompt (seção 142), refletindo o estado
real do sistema — cada uma diz explicitamente o que existe e o que ainda
não existe, nunca finge cobertura:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — stack, fluxo de
  requisição, domínios implementados, isolamento multi-organização.
- [`docs/SECURITY.md`](docs/SECURITY.md) — autenticação, autorização, rate
  limiting, e o que a seção 5 do master prompt pede que ainda falta (MFA,
  passkeys, detecção de anomalia).
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — build, variáveis de
  ambiente, migração de banco, limitações em múltiplas instâncias.
- [`docs/AI_AGENTS.md`](docs/AI_AGENTS.md) — o único uso de IA real (apoio
  ao matching) e todos os agentes da visão do master prompt que não
  existem ainda.
- [`docs/WHATSAPP.md`](docs/WHATSAPP.md) — não implementado; o que precisa
  existir desde o primeiro commit quando for construído.
- [`docs/ACCESS_CODES.md`](docs/ACCESS_CODES.md) — o fluxo real de
  ativação de organização (auto-cadastro + aprovação), diferente do
  código de ativação descrito no master prompt, com a lacuna de segurança
  correspondente.
- [`docs/AUDIT.md`](docs/AUDIT.md) — trilha de auditoria append-only real,
  e a lacuna real (sem hash encadeado ainda).
- [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md) — o que
  investigar hoje para cada categoria de incidente.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — dados pessoais coletados hoje,
  RBAC como controle de privacidade, lacunas de retenção/exclusão (LGPD).
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — tarefas de fundo,
  monitoramento, backup (não configurado), recuperação de desastre.

## Estado conhecido / lacunas

Estas lacunas já eram conhecidas e documentadas no projeto original (ver
`src/static/__dev/docs/plano-implementacao.md`, o registro de implementação
que segue sendo a referência viva do progresso e das decisões de escopo) e
continuam existindo aqui, por design — a regra do projeto é nunca fingir
que uma funcionalidade existe:

- ~~Sem fluxo de convite de membros~~ — resolvido. Ver
  [`docs/CONVITE_DE_MEMBROS.md`](docs/CONVITE_DE_MEMBROS.md).
- ~~Sem vínculo automático necessidade→baixa de estoque~~ — resolvido.
  Marcar uma necessidade vinculada a um item como "atendida" agora gera
  automaticamente uma saída de estoque (ou bloqueia com erro claro se o
  saldo for insuficiente). Ver `src/endpoints/needs-status_POST.ts`.
- ~~Sem upload real de arquivo para comprovação de entrega~~ — resolvido.
  Ver [`docs/UPLOAD_DE_ARQUIVOS.md`](docs/UPLOAD_DE_ARQUIVOS.md).
- ~~Tarefas agendadas (expirar reserva/oportunidade, varredura de matching)
  sem disparo automático real fora do Floot~~ — resolvido. Ver
  `src/helpers/scheduler.tsx`. Aproveitado para também resolver
  ~~pedido de dupla autorização sem expiração~~ (`expireApprovalRequests`).
- ~~Sem rate limiting~~ — resolvido nos pontos reais de abuso (login,
  cadastro, convite, upload, consulta pública de convite). Ver
  [`docs/RATE_LIMITING.md`](docs/RATE_LIMITING.md) — reset de senha, API
  pública e webhooks ainda não existem, então não há o que limitar lá
  ainda.
- ~~RBAC só por papel, sem permissões nomeadas~~ — resolvido. 18 endpoints
  migrados de listas de papéis soltas para um catálogo único de permissões.
  Ver [`docs/RBAC_PERMISSOES.md`](docs/RBAC_PERMISSOES.md).
- ~~API sem versionamento~~ — resolvido. Todos os endpoints agora em
  `/_api/v1/...`. Ver [`docs/VERSIONAMENTO_API.md`](docs/VERSIONAMENTO_API.md).
- ~~Sem exclusão de conta (LGPD)~~ — resolvido. Ver "Retenção e exclusão"
  em [`docs/PRIVACY.md`](docs/PRIVACY.md).
- **Nenhum conector de descoberta automática está ativo**, exceto o
  registro manual de oportunidades. Conectores reais (WhatsApp, e-mail,
  scraping) ainda não foram construídos — construir um fingindo que existe
  violaria a regra do projeto contra "fake features".
- **Apoio de IA no matching é opcional.** Sem `ANTHROPIC_API_KEY`
  configurada, o motor de correspondência continua funcionando com o
  escore determinístico por palavras-chave (ver
  `src/helpers/opportunityMatching.tsx`); com a chave, `src/helpers/aiClient.tsx`
  adiciona apoio semântico, sempre marcado como inferência, nunca como
  fato confirmado.
- **Proximidade geográfica é aproximada por cidade/estado**, não por
  distância real — não há geocodificação nem integração de mapas
  configurada.

Para o histórico completo de decisões, fases concluídas e escopo
explicitamente adiado, ver
[`src/static/__dev/docs/plano-implementacao.md`](src/static/__dev/docs/plano-implementacao.md).
