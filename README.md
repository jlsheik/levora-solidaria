# Levora Solidária

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
são encaminhadas pelo Vite para o Express em `http://localhost:3001` — as
URLs usadas pelo código já portado (`src/endpoints/**/*.schema.ts`) não
foram alteradas na migração.

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
  padrão Web Fetch API) e os monta em `/_api/<rota>`.
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

## Estado conhecido / lacunas

Estas lacunas já eram conhecidas e documentadas no projeto original (ver
`src/static/__dev/docs/plano-implementacao.md`, o registro de implementação
que segue sendo a referência viva do progresso e das decisões de escopo) e
continuam existindo aqui, por design — a regra do projeto é nunca fingir
que uma funcionalidade existe:

- **Sem suíte de testes automatizados.** A validação de cada fase foi feita
  por chamadas HTTP reais de ponta a ponta e, para regras dependentes de
  tempo (ex.: expiração de reservas de matching), por simulação manual via
  SQL (adiantar/atrasar timestamps diretamente no banco). Não há
  `npm test` configurado.
- **Sem fluxo de convite de membros.** Adicionar uma pessoa a uma
  organização com um papel específico foi feito inserindo a membership
  diretamente no banco durante os testes; não existe endpoint/interface de
  convite por e-mail.
- **Sem upload real de arquivo para prova de entrega.** `proof_url` é um
  campo de link de texto simples (a pessoa cola um link já hospedado em
  outro lugar) — não há bucket de armazenamento configurado, e a interface
  não finge um "upload" que não existe.
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
