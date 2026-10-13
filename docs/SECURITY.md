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

Auditado de propósito (não por omissão). **Atualizado na Fase 94** depois de testar em navegador real (`npm run qa:security`, ver
[`docs/QA_VISUAL.md`](QA_VISUAL.md)): o raciocínio original tinha uma lacuna e ela foi fechada.

**O que a medição mostrou (antes da correção).** Três origens foram exercitadas contra a pilha local, com a sessão do dono aberta no navegador:

| Origem do atacante | Cookie enviado? | Resultado da escrita forjada |
|---|---|---|
| **Outro site** (`localhost` → app em `127.0.0.1`), `Sec-Fetch-Site: cross-site` | não (`SameSite=Lax`) | bloqueado (401) |
| **Outra origem do MESMO site** (outra porta do mesmo host), `Sec-Fetch-Site: same-site` | **sim** | **criava o registro** com `fetch`/XHR/`sendBeacon` `text/plain` e com formulário `enctype="text/plain"` (4 de 4 tipos "simples") |
| Mesma origem (controle legítimo) | sim | criado (esperado) |

A afirmação antiga "(3) um `<form>` não gera esse payload" era **falsa**: `enctype="text/plain"` produz `nome=valor` e um nome/valor bem
escolhido forma JSON válido, e o servidor lia o corpo de **qualquer** Content-Type (`express.raw({ type: "*/*" })`). `SameSite=Lax` só protege
entre SITES; subdomínios/portas do mesmo domínio registrável (ex.: um subdomínio comprometido ou com conteúdo de terceiros) continuavam
enviando o cookie. `fetch` com `application/json` já era barrado (exige preflight CORS e a API não responde CORS).

**Defesa atual** (sem token, sem estado; [`src/helpers/csrfGuard.ts`](../src/helpers/csrfGuard.ts), ligada em `server/index.ts` antes da leitura do corpo):

1. **Cookie `SameSite=Lax`** ([`getSetServerSession.tsx`](../src/helpers/getSetServerSession.tsx)) — não vai em POST entre sites.
2. **Sem CORS** — nenhuma origem externa recebe `Access-Control-Allow-Credentials`; um `fetch` `application/json` de outra origem nem é enviado.
3. **Fetch Metadata** — toda escrita (`POST`, etc.) com `Sec-Fetch-Site` diferente de `same-origin`/`none` recebe **403**. O navegador define esse
   cabeçalho; a página do atacante não consegue forjá-lo. Cobre o mesmo-site.
4. **Content-Type obrigatório** — escrita só com `application/json` (senão **415**), para navegadores sem Fetch Metadata. Uma página de outra
   origem só envia `application/json` por um fetch com preflight, que o navegador bloqueia por falta de CORS. O cliente do app sempre envia esse tipo.
5. **Autenticação 100% via cookie**, sem token/header alternativo.

**Limites conhecidos.** Cliente que não é navegador (curl, scripts) não é "CSRF" e passa pela camada 3 sem `Sec-Fetch-Site`: exige
`application/json` e, claro, a sessão. Um proxy reverso **não pode remover** `Sec-Fetch-Site` (nginx repassa por padrão). Se o front-end
for servido em outro subdomínio da API no futuro, essa escrita same-site passaria a ser bloqueada de propósito: seria preciso decidir entre
ligar CORS com origem explícita e token, ou manter a mesma origem. Isso deixa de valer também se alguém: adicionar CORS com credenciais
para origem não confiável; rebaixar `SameSite` para `None`; ou criar autenticação por token/query-string. `test/auth.test.ts` trava os atributos do
cookie e `test/csrfGuard.test.ts` trava as camadas 3 e 4 (inclusive contra um servidor Express real).

## Comprovante (`proofUrl`) e esquemas de URL

`proofUrl` é texto livre digitado pelo operador e vira `<a href>` na linha do tempo da atribuição. O React 18 **não** bloqueia `javascript:` em `href`.
Medido em Edge e Chrome (`npm run qa:security`): o servidor gravava `javascript:` (200), a interface criava a âncora, mas o clique com
`target="_blank" rel="noopener noreferrer"` **não executou** nos dois navegadores (achado latente, não explorável ali; outros motores não foram testados).
Corrigido mesmo assim: [`src/helpers/proofUrl.ts`](../src/helpers/proofUrl.ts) aceita só caminho relativo do app ou `http(s):`; o servidor recusa
(400), o formulário valida e a linha do tempo não cria link para endereço fora da regra (dados antigos). `test/proofUrl.test.ts`.

## Armazenamento de arquivos

Ver [`docs/UPLOAD_DE_ARQUIVOS.md`](UPLOAD_DE_ARQUIVOS.md). Privado por
padrão (disco fora de diretório estático, ou S3 com download sempre
mediado pelo servidor autenticado) — nunca URL pública direta.

### Upload e download: o que foi verificado e corrigido (Fase 94)

Fluxo real mapeado: `files-upload` exige sessão + permissão `arquivos.envie`, limita a 30 envios/hora por usuário, aceita só `image/jpeg`,
`image/png`, `image/webp` e `application/pdf` (enum no schema), até 8 MB decodificados (corpo bruto até 16 MB), grava com chave
`<organizacao>/<uuid>` (o nome do cliente nunca vira caminho) e o download `files-download` exige sessão + membro ATIVO da organização do arquivo,
a cada acesso (nenhuma URL pública). Medido em navegador real (`npm run qa:security`, parte "uploads"), com o rótulo de cada resultado
(aceito e servido com segurança · rejeitado corretamente, sem rastro · violação · não medido):

| Defeito encontrado (antes) | Evidência | Correção |
|---|---|---|
| O `contentType` era o do CLIENTE: SVG/HTML com script declarado como `image/png`/`application/pdf` era **aceito e guardado** | 4 FAIL (200, linha e arquivo novos) | `src/helpers/fileSignature.ts`: os primeiros bytes (JPEG/PNG/WebP/PDF) têm de bater com o tipo declarado, **antes** de gravar |
| Base64 inválido era aceito (`Buffer.from` ignora caracteres inválidos: o arquivo gravado era outro) | teste de unidade | base64 estrito antes de decodificar |
| Nome com Unicode (`日本語.png`) → download **500** (o cabeçalho tinha caractere fora de Latin-1); nome `../../x.png` ia ao cabeçalho com barras | FAIL no navegador | `src/helpers/contentDisposition.ts`: só ASCII, sem aspas/barras/`;`, nome completo em `filename*` |
| Linha **antiga** com tipo ativo (`text/html`, `image/svg+xml`) era servida inline com o tipo original | 2 FAIL | tipos fora da lista viram `application/octet-stream` + `attachment` |
| Corpo > 16 MB → o Express respondia uma **página HTML** (e trocava a CSP da API) | FAIL | handler de erro em JSON; cabeçalhos da API preservados |

Defesas que já valiam e foram confirmadas: `X-Content-Type-Options: nosniff` em toda resposta, `Cache-Control: private, no-store` no download, a CSP
da API (`default-src 'none'`; mesmo um HTML antigo servido inline **não executou** — por isso o achado do tipo ativo é endurecimento, não exploração
demonstrada), 401 sem sessão, 403 para outra organização (no download **e** no envio), 404 inexistente, 400 id inválido, nome nunca vira caminho.
`Content-Disposition: inline` foi **mantido** para as quatro imagens/PDF: o botão "ver comprovante" abre o arquivo no navegador; o risco de
renderizar conteúdo do usuário na origem autenticada é tratado por lista fechada de tipos + conferência dos bytes + nosniff + CSP da API, não só
pelo `Content-Disposition`. **Consistência (Fase 94):** o upload compensa a falha do banco removendo só o objeto que ele mesmo criou (testado em disco e S3 com falhas reais do Postgres); se a remoção também falha, a inconsistência vira um log `ARQUIVO_ORFAO` com provedor e chave (sem credenciais), não um silêncio — não há limpeza automática com o armazenamento fora do ar. O download escolhe o adaptador pelo
`files.storageProvider` gravado no registro, depois da autorização, e valor desconhecido ou provedor não configurado é erro controlado sem fallback (ver `docs/UPLOAD_DE_ARQUIVOS.md`).

**Armazenamento S3:** o adaptador foi exercitado com o SDK real contra um servidor S3 **local** (`test/storageS3.test.ts`; ver `docs/UPLOAD_DE_ARQUIVOS.md`): chave só no formato `<org>/<uuid>` (uma chave adulterada
no banco era enviada ao S3 com segmentos `..`; corrigido), timeout de inatividade de 30 s (antes um S3 mudo pendurava o download), autorização antes de qualquer leitura no armazenamento e erros sem vazar bucket,
endpoint, chaves ou assinatura. **Não feito (decisão/infraestrutura):** varredura de malware, reencodar imagens, isolar uploads em outra origem (não há necessidade demonstrada: nenhum tipo renderizável como
documento ativo é aceito) e compatibilidade com um bucket **real** (AWS/R2/MinIO) — o servidor local não valida assinaturas e não substitui um teste com credenciais de um serviço de verdade.

## Security headers HTTP (Fase 50)

### Verificação contínua (CI)

O job `qa-browser` do GitHub Actions roda `npm run qa:security` (as 5 partes, **Chrome do runner**, Node 22, nginx real em Docker) a cada push/PR; o resumo e os JSON saem como
artefato e o job reprova se calibração, cabeçalhos do nginx ou qualquer parte obrigatória não rodar. É um subconjunto da execução local (1 navegador em vez de 2) e **ainda não foi
executado no GitHub** — ver `docs/QA_VISUAL.md`, "Execução reduzida no CI".

### Cabeçalhos de produção: quem controla o quê, e o que foi medido (Fase 94)

**Camadas.** O HTML e os assets do cliente são servidos pelo **nginx** (`deploy/nginx.conf`, arquitetura same-origin decidida na Fase 56); a API Express só
devolve JSON e define os próprios cabeçalhos (`API_SECURITY_HEADERS`); `vite dev`/`vite preview` NÃO são produção. Os valores do documento vivem em
`src/helpers/securityHeaders.ts` e o nginx tem uma **cópia manual** — `test/nginxHeaders.test.ts` exige igualdade textual e `npm run qa:security` (parte
"headers") confere a resposta de um **nginx real** (imagem Docker `nginx:1.27-alpine`, certificado autoassinado descartável, só 127.0.0.1) rodando o
`deploy/nginx.conf` do repositório com apenas domínio/certificado/porta da API trocados (cada troca é conferida).

**Política (CSP do documento).** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self'
https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` — **impõe
bloqueio** (não é Report-Only), sem `unsafe-eval`, sem `unsafe-inline` em script, sem curingas. A única exceção é `style-src 'unsafe-inline'` (o Radix UI
posiciona elementos por `style` inline); os valores são calculados em tempo de execução, então hash/nonce não são viáveis para esses atributos. Nenhuma política nova foi inventada: a existente foi **provada
em navegador real** — (a) seis ações de injeção (script inline, handler inline, script externo, `new Function`, conexão externa, troca de `<base>`)
funcionam numa página de controle sem CSP e **todas são bloqueadas** no app atrás do nginx (violações `script-src-elem`, `script-src-attr`, `connect-src`,
`img-src`, `base-uri`), (b) o app **funciona** sob ela: login, cinco páginas e envio de comprovante pela interface sem **nenhuma** violação, (c) o app não
é incorporável em iframe de outra origem (o controle sem proteção é).

**Defeitos de configuração achados no nginx real e corrigidos:**

| Defeito | Medido | Correção |
|---|---|---|
| `add_header` dentro de um `location` **substitui** os do `server`: o HSTS (declarado no `server`) só saía em `/_api/`, **nunca** no HTML nem nos assets | HSTS ausente em `/`, `/login`, `/index.html`, `/assets/*` | HSTS (e nosniff) repetidos em cada location que define `add_header`; teste estático trava a regra |
| Assets sem `X-Content-Type-Options: nosniff` | ausente em `/assets/*` | idem |
| `Cache-Control: public, immutable` (1 ano) com `always` também no **404** de `/assets/` | 404 com `immutable` | `map $status`: o cache imutável só vale para 200/304 |
| `client_max_body_size` no padrão do nginx (1 MB): foto acima de ~750 KB (JSON em base64) voltava **413 em HTML** — o envio de comprovante não funcionaria em produção | 3 MB e 8 MB (limite válido) → 413 | `client_max_body_size 17m` em `/_api/` (logo acima dos 16 MB do Express: o 413 seguinte vem em JSON da API) |

**Também verificado (sem defeito):** uma ocorrência de cada cabeçalho (o proxy não duplica a CSP da API), a API atravessando o proxy mantém `default-src
'none'; frame-ancestors 'none'`, tipo MIME correto de JS/CSS (módulo ES), `<meta>` CSP da build igual a `DOCUMENT_CSP`, HSTS só no bloco 443.

**Depende de infraestrutura externa (NÃO comprovado aqui):** o domínio, o certificado e a terminação TLS reais; o redirecionamento HTTP→HTTPS do bloco :80 (a
porta 80 não foi exercitada); a política HSTS (`max-age` moderado, sem `preload`; subir só com HTTPS estável); o **staging** (`nginx.staging.conf`, HTTP atrás do túnel
da Cloudflare, onde o HSTS e o TLS são da borda) só teve a sintaxe e as regras estáticas conferidas, não um navegador; CDN/WAF na frente podem acrescentar,
remover ou duplicar cabeçalhos — repetir a conferência de cabeçalhos (`curl -I` em `/`, em um asset e em `/_api/__health`) contra a URL pública no deploy real; `Sec-Fetch-Site` precisa ser
repassado pelo proxy. Não há `Report-Only` em uso; nenhuma etapa de observação foi necessária.


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
