# Segurança

Master prompt, seção 142 (documentação obrigatória) e seção 5 (regra
fundamental de segurança: nunca declarar o sistema "100% seguro" — nenhum
sistema conectado à internet garante risco zero; o objetivo é segurança por
arquitetura, em camadas). Este documento descreve as camadas que existem
hoje, honestamente, e as que ainda não existem.

## Autenticação

- Senha com `bcrypt` (`src/helpers/generatePasswordHash.tsx`), nunca texto
  puro.
- Sessão: **não é JWT stateless**. Login cria uma linha real na tabela
  `sessions` (id aleatório de 32 bytes, `expires_at`); o cookie carrega só
  o id da sessão, assinado com JWT (`jose`) para garantir integridade —
  `src/helpers/getSetServerSession.tsx`. Isso permite revogar uma sessão
  específica apagando a linha (usado em logout), diferente de JWT puro
  stateless, que não pode ser revogado antes de expirar.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Bloqueio por força bruta em duas camadas** (`src/endpoints/auth/login_with_password_POST.ts`):
  por e-mail (5 tentativas falhas / 15 min, tabela `login_attempts`) e por
  IP (`src/helpers/rateLimit.tsx`, 20 tentativas / 15 min) — a primeira
  protege uma conta específica sendo atacada, a segunda protege o servidor
  de alguém varrendo muitos e-mails a partir do mesmo IP.
- ~~Discrepância entre `Max-Age` do cookie (7 dias) e expiração do JWT
  interno (1 dia fixo)~~ — **corrigida**. `setExpirationTime` agora usa
  `SessionExpirationSeconds` (a mesma constante do `Max-Age`), então os
  dois sempre casam — confirmado com o servidor real (`iat`/`exp`
  decodificados do JWT emitido, diferença de exatos 604800s) e testado
  (`test/auth.test.ts`).

## Autorização

RBAC granular por permissão nomeada, não só papel — ver
[`docs/RBAC_PERMISSOES.md`](RBAC_PERMISSOES.md). Toda ação passa por
`requireOrganizationMembership` (é membro?) e, quando restrita,
`requirePermission` (o papel do membro tem a permissão nomeada?). Papel de
plataforma (`users.role === 'admin'`) é separado do papel dentro de uma
organização (`memberships.role`) — ver `src/helpers/platformAccess.tsx`.

## Isolamento multi-organização

Ver `docs/ARCHITECTURE.md`. Sem RLS no banco — isolamento 100% em código,
testado explicitamente (`docs/TESTING.md`).

## Rate limiting

Ver [`docs/RATE_LIMITING.md`](RATE_LIMITING.md). Cobre os pontos reais de
abuso que existem hoje (login, cadastro, convite, upload, consulta pública
de convite). Sem limite genérico em nível de Express para toda a API.

## Auditoria

Ver [`docs/AUDIT.md`](AUDIT.md). `audit_log` é append-only via trigger de
banco (bloqueia `UPDATE`/`DELETE`) **e** tem hash encadeado
(`previous_event_hash`/`event_hash`), verificável via
`GET /_api/v1/audit-log-verify` — prova matematicamente se a sequência de
eventos foi adulterada, mesmo por acesso direto ao Postgres.

## Validação de entrada

Todo endpoint valida o corpo/query com `zod` (`schema.parse`) antes de
tocar no banco — nunca confia em tipo declarado no TypeScript sozinho
(que não existe em runtime). Queries usam Kysely (parametrizado
automaticamente) — nunca concatenação de string SQL, o que já elimina a
classe de vulnerabilidade de SQL injection por constução.

## CSRF — por que este app não usa um token explícito

Auditado de propósito (não por omissão) antes de decidir se um token CSRF
seria necessário. Três propriedades independentes da arquitetura atual já
tornam CSRF clássico não explorável, sem precisar de um mecanismo dedicado:

1. **Cookie de sessão `SameSite=Lax`** ([`getSetServerSession.tsx`](../src/helpers/getSetServerSession.tsx)) —
   não é enviado em requisições POST/fetch cross-site (só em navegação
   GET de topo), que é exatamente o vetor que CSRF explora.
2. **Sem CORS configurado** (`server/index.ts`) — nenhuma origem externa
   recebe `Access-Control-Allow-Credentials`, então nem um `fetch`
   JavaScript cross-origin com credenciais é possível.
3. **Corpo obrigatoriamente serializado em `superjson`** — todo endpoint
   que muda estado faz `superjson.parse(await request.text())`. Um
   `<form>` HTML simples não consegue gerar esse payload (produz
   `application/x-www-form-urlencoded` ou `multipart/form-data`, que
   falha o parse antes de qualquer efeito colateral) — testado
   explicitamente em `test/securityHardening.test.ts`.
4. **Autenticação é 100% via cookie**, sem token/header alternativo — não
   existe um caminho de autenticação secundário que pudesse contornar o
   `SameSite=Lax` acima.

Isso deixaria de valer se, no futuro, alguém: adicionar CORS com
credenciais para uma origem não confiável; rebaixar `SameSite` para
`None`; ou criar um caminho de autenticação via token/query-string.
`test/auth.test.ts` trava os atributos do cookie
(`HttpOnly`/`Secure`/`SameSite=Lax`) como teste de regressão para o
primeiro caso.

## Armazenamento de arquivos

Ver [`docs/UPLOAD_DE_ARQUIVOS.md`](UPLOAD_DE_ARQUIVOS.md). Privado por
padrão (disco fora de diretório estático, ou S3 com download sempre
mediado pelo servidor autenticado) — nunca URL pública direta.

## Segredos

`.env` nunca commitado (`.gitignore`). Nenhum segredo hardcoded no código.
`JWT_SECRET`, credenciais de banco, SMTP e S3 vêm só de variável de
ambiente. Não há um cofre de segredos (Vault, AWS Secrets Manager) — para
produção, isso é responsabilidade de quem faz o deploy (ver
`docs/DEPLOYMENT.md`), não deste repositório.

## O que o master prompt pede (seção 5) que ainda NÃO existe

Listado honestamente, sem fingir cobertura:

- **MFA** para perfis administrativos — não implementado. Login é só
  e-mail+senha.
- **Passkeys** — não implementado.
- **Código de ativação de organização** (seção 9 do master prompt) — não
  implementado da forma descrita, mas a lacuna de segurança que isso
  causava (organização "em análise" operando normalmente) já foi corrigida
  — ver [`docs/ACCESS_CODES.md`](ACCESS_CODES.md) para o que existe no
  lugar (auto-cadastro + aprovação manual pelo admin
  de plataforma).
- **Rotação/revogação de lista de sessões ativas** pelo próprio usuário —
  não existe uma tela "ver meus dispositivos conectados, revogar um
  específico". A sessão pode ser revogada apagando a linha no banco, mas
  não há interface para isso.
- **Detecção de comportamento anômalo** (seção 62 do master prompt: muitos
  ajustes manuais em pouco tempo, mesma entrega em múltiplos destinos,
  etc.) — não implementada como mecanismo dedicado. O rate limiting e a
  dupla autorização cobrem parte do risco (volume de requisições, ajuste
  de estoque de alto valor), mas não há um "Risk Analytics" separado.
- **Backup automatizado e teste de restauração** — ver
  [`docs/OPERATIONS.md`](OPERATIONS.md): não configurado neste
  repositório, é responsabilidade de infraestrutura no deploy real.
- **Proteção contra SSRF** — não há nenhum endpoint que busque uma URL
  fornecida pelo usuário (nenhum conector automático real ainda existe, ver
  README "Estado conhecido / lacunas"), então essa classe de risco não se
  aplica hoje. Vai precisar de atenção quando um conector de descoberta
  automática (WhatsApp, e-mail, scraping) for construído.
