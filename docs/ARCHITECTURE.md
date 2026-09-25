# Arquitetura

Master prompt, seção 142. Visão de como o sistema é construído hoje —
não a arquitetura de referência da seção 6 do master prompt (que sugere
Next.js/Supabase), e sim a decisão real tomada nesta migração, documentada
e justificada como o master prompt pede quando a stack difere da sugerida.

## Stack real

```
Cliente:  React 18 + Vite 6 + React Router 6 + TanStack Query 5
          Radix UI + CSS Modules + zod (validação) + superjson (serialização)
Servidor: Express 4 (Node) — camada fina de roteamento sobre endpoints
          escritos na Web Fetch API padrão (Request/Response)
Banco:    PostgreSQL, acessado via Kysely (query builder tipado) +
          driver "postgres" (postgres.js) — sem ORM tradicional
Auth:     JWT (jose) para o cookie de sessão + sessão real na tabela
          `sessions` (não é JWT stateless puro) + bcrypt para senha
Testes:   vitest, banco de teste real (não mock)
```

Por que não Next.js/Supabase (sugestão da seção 6 do master prompt): o
projeto nasceu no Floot e foi portado para um stack Node padrão sem
dependência de nenhuma plataforma específica — ver `README.md` para o
contexto da migração. RLS do Postgres (sugerido para Supabase) não é usado;
o isolamento entre organizações é feito 100% em código de aplicação
(`requireOrganizationMembership`/`requirePermission`, ver
`docs/RBAC_PERMISSOES.md`), testado explicitamente (ver `docs/TESTING.md`).

## Por que cada endpoint é um arquivo com `handle(request)`

Todo endpoint em `src/endpoints/**/*_GET.ts` / `*_POST.ts` exporta:

```ts
export async function handle(request: Request): Promise<Response>
```

usando só a Web Fetch API (`Request`/`Response`/`Headers` nativos do
runtime, não algo específico do Express). `server/index.ts` descobre esses
arquivos automaticamente (por nome de arquivo e posição no diretório) e os
converte de/para Express. Vantagens reais que isso traz, não só herança do
Floot:

- **Testável sem servidor**: os testes (`test/*.test.ts`) importam
  `handle` diretamente e chamam com um `Request` construído na mão — nunca
  precisam subir o Express nem abrir uma porta de rede. Ver
  `docs/TESTING.md`.
- **Portável**: se o projeto um dia trocar de Express por outro runtime
  (Cloudflare Workers, Deno, etc.), os endpoints em si não mudam — só a
  camada de adaptação em `server/index.ts`.

## Fluxo de uma requisição

```
Cliente (fetch)
  → Vite dev proxy (/_api/* → localhost:3001)   [só em desenvolvimento]
  → Express (server/index.ts)
      injeta x-client-ip-verified a partir de req.ip
      converte Express Request → Web Fetch Request
  → handle(request) do endpoint correspondente
      1. getServerUserSession(request)           — quem está pedindo
      2. checkRateLimit(...)                      — está dentro do limite?
      3. schema.parse(json)                       — corpo é válido? (zod)
      4. requireOrganizationMembership / requirePermission
                                                   — pode fazer isto?
      5. lógica de negócio (db.transaction quando múltiplas escritas)
      6. recordAuditLogEntry(...)                 — o que mudou, quem, quando
  → Response (JSON via superjson, ou bytes crus para download de arquivo)
  → Express converte de volta e envia ao cliente
```

Nem todo endpoint tem todos os 6 passos (leituras não escrevem auditoria;
endpoints públicos como `organization-invites-lookup` não exigem sessão) —
mas a ordem, quando presente, é sempre essa.

## Domínios implementados

```
Autenticação          auth/register_with_password, login_with_password,
                       session, logout
Organizações           organizations, organization-members
Convite de membros     organization-invites* (ver docs/CONVITE_DE_MEMBROS.md)
Inventário             inventory-items, stock-transactions
Necessidades           needs, needs-status (com baixa automática de estoque)
Oportunidades locais   opportunities* (modelo legado por-organização)
Registro central       sources, opportunity-registry, opportunity-allocations,
                       organization-allocations, match-evaluations
Logística              allocations-logistics, allocations-receive
Dupla autorização      approval-requests* (ver src/helpers/approvals.tsx)
Arquivos               files-upload, files-download (ver docs/UPLOAD_DE_ARQUIVOS.md)
Auditoria              audit-log (ver docs/AUDIT.md)
Plataforma (admin)     platform-organizations*
Tarefas de fundo       background-tasks*, src/helpers/scheduler.tsx
```

Domínios da visão completa do master prompt que **não existem ainda**:
Beneficiary Management, Donor Management (como entidade própria — hoje
doador é só texto livre na oportunidade legada), Transparência Pública,
Financeiro, Notification Center, e os agentes de IA especializados além do
apoio ao matching (ver `docs/AI_AGENTS.md`).

## Isolamento multi-organização

Toda tabela de negócio associada a uma organização tem `organization_id`.
Não existe RLS no banco — o isolamento é garantido em código, sempre pelo
mesmo caminho: `requireOrganizationMembership`/`requirePermission` (ver
`src/helpers/organizationAccess.tsx`) checando a tabela `memberships` antes
de qualquer leitura/escrita, e toda query subsequente filtrando por
`organization_id`. Testado explicitamente (`docs/TESTING.md`): um usuário
não consegue acessar nem referenciar dado de uma organização da qual não é
membro, mesmo alterando IDs manualmente na requisição.

## CORS

Não configurado — não é necessário porque o cliente e a API sempre são
servidos como mesma origem (via proxy do Vite em desenvolvimento, e o mesmo
domínio em produção — ver `docs/DEPLOYMENT.md`). Se um consumidor de
origem diferente (app mobile nativo, parceiro externo) precisar chamar a
API diretamente, isso exigirá configurar CORS explicitamente então — não
adicionado agora por não haver esse consumidor ainda.
