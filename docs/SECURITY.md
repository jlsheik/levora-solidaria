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
- ~~SEC-04 (timing side-channel no login)~~ — **corrigida na Fase 51**.
  Medido com 150 amostras por cenário (metodologia: criar uma conta nova
  por amostra, para nunca acionar o próprio bloqueio por e-mail do
  sistema, que mascarava a diferença real numa primeira tentativa de
  medição): usuário inexistente respondia ~59ms mais rápido que senha
  incorreta (desvio-padrão <2ms nos dois cenários — diferença real, não
  ruído), porque só o segundo caminho chamava `bcrypt.compare`. Corrigido
  com um hash bcrypt fixo e pré-computado (nunca gerado por request,
  mesmo custo — `saltRounds: 10` — de `generatePasswordHash.tsx`),
  comparado (resultado descartado) quando o e-mail não existe. Depois da
  correção: diferença de média 0.00ms. Ver
  `src/endpoints/auth/login_with_password_POST.ts`.
- ~~SEC-03 (enumeração de e-mail no cadastro)~~ — **corrigida na Fase 51**.
  `register_with_password_POST.ts` respondia 409 "Este e-mail já está em
  uso" quando o e-mail já tinha conta — um oráculo de enumeração direto e
  público. Não existia reset de senha nem verificação de e-mail para
  construir uma confirmação assíncrona genuína (`docs/DEPLOYMENT.md`
  continua sem esses fluxos), então a correção escolhida (Estratégia A,
  avaliada contra B e C) foi tornar a resposta pública IDÊNTICA
  (status 200, mesmo corpo, nunca `Set-Cookie`) tanto para um e-mail novo
  quanto para um já existente — o que exigiu remover o login automático
  após cadastro (login continua existindo, só deixou de ser automático):
  sem isso, a PRESENÇA do cookie de sessão seria, sozinha, um sinal
  distinguível mesmo com corpo/status idênticos. O hash da senha também
  passou a ser calculado SEMPRE (descartado quando o e-mail já existe),
  pelo mesmo motivo do SEC-04 acima: sem isso, o TEMPO de resposta vazaria
  a mesma informação que a mensagem escondia. Cadastro duplicado nunca
  sobrescreve nome/senha da conta existente. Ver
  `src/endpoints/auth/register_with_password_POST.ts`,
  `src/components/PasswordRegisterForm.tsx` e
  `test/authEnumeration.test.ts`.

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

## Security headers HTTP (Fase 50)

Fecha o achado SEC-05 da auditoria de segurança. Valores centralizados em
[`src/helpers/securityHeaders.ts`](../src/helpers/securityHeaders.ts) — um
único lugar, nunca duas cópias divergentes entre a API e o front-end.

- **API** (`server/index.ts`, `API_SECURITY_HEADERS`): `X-Content-Type-
  Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` restritiva (desabilita câmera/microfone/
  geolocalização/pagamento/USB/bluetooth/sensores/MIDI/picture-in-picture/
  captura de tela/autoplay — nenhum uso real encontrado em `src/` —, mas
  permite `clipboard-write=(self)`, usado de verdade em "copiar link de
  convite"), `X-Frame-Options: DENY`, e `Content-Security-Policy:
  default-src 'none'; frame-ancestors 'none'` (máximo possível: esta API só
  devolve JSON, nunca HTML renderizável). Aplicado por um middleware que é
  o PRIMEIRO do pipeline Express — cobre toda rota real, o 404 explícito
  (ver abaixo) e o catch de erro 500.
  - **Achado de regressão corrigido nesta mesma fase**: o 404 padrão do
    Express (`finalhandler`) sobrescrevia o `Content-Security-Policy` desta
    aplicação com um valor próprio mais curto (sem `frame-ancestors`) ao
    renderizar sua página de erro HTML — descoberto reproduzindo um 404
    real e comparando os headers. Corrigido adicionando um handler 404
    explícito que devolve JSON (consistente com o resto desta API, que
    nunca devolve HTML), coberto por teste de regressão
    (`test/securityHeaders.test.ts`).
- **Documento HTML do front-end** (`vite.config.ts` + `index.html`):
  `server/index.ts` nunca serve o HTML do cliente (ver
  `docs/DEPLOYMENT.md`), então a CSP do documento vai como `<meta
  http-equiv="Content-Security-Policy">`, injetada SÓ na build de produção
  (`vite build`) por um plugin próprio (`transformIndexHtml`) — nunca no
  dev server, porque o preâmbulo inline do React Fast Refresh (injetado
  pelo próprio Vite em todo request de dev, confirmado lendo a resposta
  real do dev server) exigiria `'unsafe-inline'` em `script-src`,
  enfraquecendo a política real sem necessidade.
  `style-src` inclui `'unsafe-inline'` deliberadamente: Radix UI (usado em
  Dialog/Select/Popover/Tooltip em todo o front-end) posiciona elementos
  via `style` inline calculado em JS, e uma dependência transitiva
  (`react-style-singleton`, via `react-remove-scroll-bar`) injeta uma tag
  `<style>` para compensar a largura da scrollbar — sem essa permissão,
  todo diálogo do sistema quebraria. `style-src`/`font-src` também liberam
  Google Fonts (`fonts.googleapis.com`/`fonts.gstatic.com`, único recurso
  de terceiros carregado pelo navegador, via `@import` em `src/base.css`).
  `frame-ancestors` não é suportado em `<meta>` (a spec do CSP ignora essa
  diretiva nesse contexto) — por isso não entra na build; a variante com
  `frame-ancestors` (`DOCUMENT_CSP_WITH_FRAME_ANCESTORS`) é usada só como
  header HTTP real em `vite preview` e documentada em
  `docs/DEPLOYMENT.md` para a camada estática de produção.
- **HSTS**: deliberadamente NÃO configurado em nenhum processo deste
  repositório. `server/index.ts` só serve `/_api/*`, nunca sabe se está
  atrás de um proxy que termina TLS, e o front-end nunca é servido por um
  processo Node controlado aqui (ver `docs/DEPLOYMENT.md`) — fabricar esse
  header sem controlar a camada que termina TLS seria, na melhor das
  hipóteses, um no-op, e na pior, uma falsa garantia de HTTPS que este
  repositório não pode cumprir. Registrado como dependência operacional da
  camada de proxy reverso/CDN de produção, não como algo "esquecido".

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
