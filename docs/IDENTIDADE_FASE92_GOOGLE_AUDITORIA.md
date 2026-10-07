# Login e cadastro com Google (OIDC) — Fase 92

Implementa §7, §25.6, §25.7 e §25.9 da `docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md` sobre a Fase 91.1 (`4479d1d`).
**Fora de escopo (e não implementado):** Microsoft, Apple, passkeys, account linking completo, recuperação de senha, SMTP, outros
provedores, novos mecanismos de MFA. **Nada da Fase 89/90/91 foi reaberto**: o consumo do código continua em
`provisionUserWithAccessCode` (generalizado, ver §5) e o MFA/sessão são os da Fase 89/90.

> **STATUS DE VALIDAÇÃO (Fase 92 + 92.1) — leia antes de qualquer decisão de produção.**
>
> | VALIDADO (testes server-side com provedor SINTÉTICO + preview local com provedor sintético) | NÃO VALIDADO (depende do Google real) |
> |---|---|
> | validação do ID token (assinatura, iss, aud/azp, exp, iat, nonce, sub) com chaves geradas na hora | **Google OAuth real** (fluxo ponta a ponta com `accounts.google.com`) |
> | state de uso único, vínculo de navegador, PKCE (o harness reproduz a regra), replay | **tela de consentimento real** (escopos, `prompt=select_account`, estado "Em teste") |
> | rotação de JWKS e cooldown (JWKS sintético) | **redirect URI real** cadastrado no Google Cloud Console (casamento exato) |
> | concorrência A–J, IDOR, MFA LEVORA após Google, access code, anti-enumeração | **claims reais de produção** (formato exato de `iss`, `email_verified` string/booleano, ausência de `email`/`name`) |
> | ciclo de vida Google-only (reauth por identidade, exclusão, logout) e controles negativos | **JWKS real** (cabeçalhos de cache, chaves em rotação reais, latência) |
>
> **`sintético ≠ Google de produção`.** O provedor sintético existe só para provar a NOSSA validação, a máquina de estados e a integração com código de
> acesso/MFA/sessão; ele não simula nada do Google que não possamos comprovar. **O Google NÃO está declarado "pronto para produção"** — isso só ocorre depois do
> roteiro de teste real do §17. Nenhuma execução contra o Google real aconteceu até aqui.

> **Nota (Fase 93):** a lógica de `google-start`/`google-callback` descrita abaixo foi **movida sem mudança de comportamento** para o fluxo OAuth compartilhado (`src/helpers/oauthStart.tsx`, `oauthCallback.tsx`, `oauthPrimitives.tsx`, adaptador em `oauthProviders.tsx`), reutilizado pela Microsoft (`docs/IDENTIDADE_FASE93_MICROSOFT_AUDITORIA.md`). Os endpoints do Google continuam existindo como wrappers finos.

## 1. Princípio

Google é um **método de autenticação**, não uma conta nova. A identidade LEVORA continua sendo `users.id`; a identidade externa é
`user_identities (provider='google', issuer, subject=sub)`. O e-mail é **atributo** (`email_snapshot`, `email_verified`), nunca chave.
Login e cadastro são caminhos **separados**: o login jamais cria conta; o cadastro jamais dispensa o código de acesso.

## 2. Arquitetura

```
LOGIN   [Entrar com Google] ─POST google-start {intent:login}──► oauth_attempts(login) ──► Google ──► GET google-callback
CADASTRO [código] ─access-code-check─► [Continuar com Google] ─POST google-start {intent:signup, accessCode} (corpo)─►
          oauth_attempts(signup, access_code_id) ──► Google ──► GET google-callback
callback:  state (uso único) → vínculo de navegador → troca do code (PKCE, back-channel) → ID token validado LOCALMENTE → decide:
   login   : (google, iss, sub) vinculada? ── não ─► nada criado, resposta neutra
                                              └ sim ► completePrimaryLogin: sessão plena OU auth_challenge de MFA (Fase 90)
   cadastro: identidade já existe? ─ sim ─► nada criado, código NÃO consumido
             e-mail já usado?      ─ sim ─► nada criado, código NÃO consumido (sem auto-link, resposta neutra)
             senão provisionUserWithAccessCode({codeId}) — UMA transação: FOR UPDATE do código → INSERT users → INSERT user_identities
                → INSERT sessions → UPDATE condicional do código → auditoria (último). Falha ⇒ ROLLBACK de tudo.
```
O código de acesso **nunca** está na URL (nem do nosso callback, nem da URL do Google): vai no corpo do `POST google-start`, o servidor
resolve `access_code_id` e guarda só o id na tentativa; o callback lê o id **da tentativa** (a requisição não fornece código, usuário
nem intenção — parâmetros extras no callback são ignorados e há teste).

## 3. Dados (migration `0018_google_identity.sql`, espelhada em `db/schema.sql`)

| Tabela | Conteúdo |
|---|---|
| `user_identities` | `user_id` (CASCADE), `provider` (`google|microsoft|apple` por CHECK, só Google tem fluxo), `issuer`, `subject`, `email_snapshot`, `email_verified`, `created_at`, `last_used_at`; **`UNIQUE(provider, issuer, subject)`**. Nenhuma coluna de token. |
| `oauth_attempts` | `state_hash` (UNIQUE), `binding_hash`, `nonce_hash`, `pkce_verifier_ct` (**cifrado** AES-256-GCM, AAD = hash do state), `intent` (`login|signup`), `access_code_id`, `status` (`started→processing→completed|failed`), `expires_at` (10 min), `ip_prefix`. CHECK: **signup SEMPRE com código, login NUNCA**. |

Chaves: `issuer + subject`. `(google, X, A)`, `(google, X, B)` e `(google, Y, A)` são identidades distintas (teste). O `issuer` gravado é o
**canônico configurado** (`https://accounts.google.com`), nunca uma string escolhida pelo token (o Google emite `iss` com e sem esquema; ambos
são aceitos na validação). Hashes de state/nonce/vínculo: HMAC-SHA-256 com o pepper existente (contextos `oauth-state|nonce|binding:v1:`).

## 4. Validação do ID token (`src/helpers/googleOidc.tsx`, só `jose` + `node:crypto` + `fetch`; sem dependência nova)

Authorization Code Flow (nunca implicit; nenhum token em fragmento; nada vindo do frontend é confiado). Scopes **`openid email profile`**;
sem `access_type` (sem refresh token); `prompt=select_account`. A troca do `code` é no back-channel (`client_secret` do ambiente, `code_verifier`).
Do resultado só o `id_token` é usado; **`access_token` é descartado e nada do Google é persistido** (verificado em teste varrendo o banco).

| Verificação | Como |
|---|---|
| Assinatura | RS256 apenas (`alg` ≠ RS256 ⇒ rejeita; `none`/HS256 testados), JWKS do `jwks_uri` do Discovery (`createLocalJWKSet`) |
| `iss` | ∈ {`https://accounts.google.com`, `accounts.google.com`} — **a configuração define o emissor; o token não** |
| `aud` | == `GOOGLE_CLIENT_ID`; `aud` múltipla exige `azp` == client id; `azp` presente e diferente ⇒ rejeita |
| `exp` / `iat` | `exp` com tolerância de 60 s; `iat` no futuro além de 60 s ⇒ rejeita. A expiração do ID token **não** governa a sessão LEVORA |
| `nonce` | HMAC do claim comparado em tempo constante ao `nonce_hash` da tentativa; ausente/errado ⇒ rejeita |
| `sub` | obrigatório, string 1–255 |
| Discovery | emissor esperado; `authorization/token/jwks` têm de ser **HTTPS em domínios do Google** (endpoint adulterado ⇒ 502, nada vai para outro host). Cache 24 h |
| JWKS | cache 1 h; `kid` desconhecido dispara **no máximo 1 refresh por 60 s** (rotação sem martelar o Google; teste: 10 kids desconhecidos ⇒ 0 fetch extra; rotação após o cooldown ⇒ 1 fetch) |
| `tokeninfo` | **nunca** usado (varredura estática) |

## 5. State, nonce, PKCE, vínculo e replay

`state`, `nonce`, vínculo e verifier PKCE: 256 bits cada (`randomBytes(32)`), independentes. O callback consome o `state` com
`UPDATE … SET status='processing' WHERE state_hash=… AND status='started' AND expires_at>now()` — **uso único**; replay/expirado/inexistente/
de outro fluxo ⇒ 0 linhas ⇒ a mesma falha neutra, **sem tocar no Google**. O cookie `levora_oauth` (HttpOnly, Secure, SameSite=Lax, Path
`/_api/v1/auth`, 10 min) liga a tentativa ao navegador: `state` de B não funciona no navegador de A. O `code` do Google é de uso único (replay ⇒
`invalid_grant`). O verifier só existe cifrado em repouso e só sai do servidor no back-channel da troca do `code`. O redirect URI e o
client id vêm **exclusivamente** da configuração (nunca de Host/X-Forwarded-Host/Origin — teste e varredura estática); os redirecionamentos do
callback são **relativos**.

`provisionUserWithAccessCode` ganhou: (a) alvo `{codeId}` além do texto do código; (b) hook `afterRedeem` (auditoria do cadastro Google antes
do evento `consumido`, preservando "auditoria por último"); (c) o motivo `identidade_em_uso` (violação de `UNIQUE` de `user_identities` ⇒ rollback).

## 6. Login, MFA e sessão

Identidade vinculada ⇒ `completePrimaryLogin` (sob o lock da linha do usuário, ordem canônica de locks): conta com MFA ativo, ou titular de
`platform_access` ⇒ `auth_challenge` (`mfa_login`/`mfa_enroll`), **sem sessão** ⇒ `/login?google=mfa|mfa_setup` ⇒ `mfa-verify` (TOTP ou recovery) ⇒
sessão com `primary_method='google'`. **Google não substitui o 2º fator.** Conta sem MFA ⇒ sessão plena. A decisão é tomada no callback (MFA
ativado entre o início e o callback é respeitado). Atualiza `last_used_at` e `email_snapshot` (atributo da identidade já autenticada; `users.email`
nunca muda). Conta anonimizada não entra. Cadastro: conta nova é `role='user'` (nunca `platform_access`, nunca MFA, sem senha), sessão plena criada
**dentro** da mesma transação do provisionamento.

## 7. Regras de e-mail e anti-enumeração

- Identidade = `issuer+sub`; `email_verified=false` **não** impede o cadastro, mas é gravado como `false` (nada afirma e-mail verificado sem o claim).
- Não há restrição a `@gmail.com` (qualquer Conta Google/Workspace validada).
- **Sem auto-link:** e-mail igual ao de um usuário existente com `sub` novo ⇒ login = "não vinculada"; cadastro = falha neutra, **nada criado, código não
  consumido, usuário existente intacto**. As respostas ao usuário são um conjunto fechado (`nao_vinculada`, `ja_cadastrada`, `codigo_indisponivel`,
  `cancelado`, `limite`, `falha`); a colisão de e-mail usa `falha` (indistinguível de outras falhas), sem "esse e-mail já tem conta".
- Identidade já pertencente a outro usuário: não é movida nem sobrescrita (`ja_cadastrada`, código intacto).

## 8. Auditoria e rate limit

Eventos: `usuario.login_google`, `usuario.login_google_falhou`, `usuario.cadastro_google`, `usuario.cadastro_google_falhou`,
`usuario.google_identity_rejected` (token/state/vínculo rejeitados; `motivo` constante como `audience_invalida`). Falhas: 1 evento por (ação, motivo, rede)
a cada 10 min (não infla a hash-chain). **Nunca** gravam code, ID/access token, nonce, state, verifier, client secret, senha nem e-mail (teste varre `audit_log`).

| Bucket | Limite |
|---|---|
| `google-start` | 20 / 15 min / IP |
| `google-callback` | 30 / 15 min / IP |
| cadastro Google | cobre-se por `google-start` (código validado) + corrida atômica do código |
| vínculo futuro | não implementado (account linking fora de escopo) |

Em memória (sem Redis). IP pelo mesmo `getClientIp` anti-spoof da Fase 52.

## 9. Concorrência (A–J), sem sleeps

A dois callbacks do mesmo `state` ⇒ 1 prossegue · B dois logins da mesma identidade ⇒ 2 sessões, 1 identidade · C mesmo código + mesma identidade ⇒ 1 usuário ·
D mesmo código + identidades diferentes ⇒ 1 conta · E/I mesma `issuer+sub` com dois códigos ⇒ 1 conta, **o código perdedor não é queimado** · F callback duplicado de
identidade existente ⇒ 1 sessão · G revogação antes e **simultânea** ao callback ⇒ ou conta+consumo, ou nada (nunca ambos; CHECK) · H código expirado ⇒ nada ·
J MFA ativado durante o login ⇒ challenge ou sessão pré-ativação, nunca sessão plena para quem termina com MFA. Mecanismos: `UPDATE` condicional do `state`, `FOR UPDATE` do
código, `UNIQUE(provider,issuer,subject)`, lock do usuário. Nenhuma chamada externa dentro de transação com lock.

## 10. IDOR

State de B no navegador de A (vínculo) · cookie de outra tentativa · `user_id`/`userId`/`intent`/`accessCode`/`accessCodeId` na query do callback (ignorados; teste prova que um
login não vira cadastro e que o id do código vem da tentativa) · identidade de outra conta · `code` do Google emitido para a tentativa A usado com o state de B (PKCE do Google recusa; teste).

## 11. Exclusão de conta

`account-delete` (anonimização, exige senha) agora também **apaga `user_identities`** do usuário na mesma transação (a identidade é credencial). O código consumido
**continua redimido** (`registered_via_code_id` e `redeemed_by_user_id` permanecem) e a mesma conta Google não volta a entrar (`nao_vinculada`). **Lacuna da Fase 92 — RESOLVIDA na 92.1** (§16): uma conta criada só com Google não tem senha; agora exclui a conta por **reautenticação da identidade**.

## 12. Frontend

Login: "Entrar com Google" sob o formulário (divisor "ou"). Cadastro em **dois passos**: (1) só o campo de código + "Validar código" (`access-code-check`, não consome); (2) só então
aparecem "Continuar com Google" e e-mail/senha — o botão não é um bypass. O código vive só em estado de componente e no corpo do POST (nada de URL/storage). O retorno do callback
chega como código curto (`/login?google=erro&motivo=…|mfa|mfa_setup`), é lido e removido da barra de endereço (`replace`). MFA pós-Google reutiliza `MfaCodeForm`/`MfaSetupPanel`.
Botão neutro (fundo do cartão/texto em primeiro plano), "G" oficial decorativo; o botão fica em loading e desabilitado durante o início (impede signups simultâneos). Contraste auditado
(375/390/768/desktop, claro/escuro: sem falhas ≥ 4,5:1); um `ghost` do Button com 1,35:1 no escuro foi substituído por um botão de texto local.

## 13. Configuração e Google Cloud (nada versionado)

Variáveis (`.env.example`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, opcional `GOOGLE_DISCOVERY_URL`. Sem elas o início responde 503 "não disponível" e nada é criado.
Passos (a fazer por quem administra o projeto; **não** assumimos que produção esteja configurada): (1) criar/selecionar um projeto no Google Cloud; (2) configurar a **tela de consentimento OAuth**
(escopos apenas `openid`, `email`, `profile`; usuários de teste enquanto "Em teste"); (3) criar um **ID do cliente OAuth "Aplicativo da Web"**; (4) cadastrar os **URIs de redirecionamento autorizados**, um por ambiente,
idênticos ao `GOOGLE_REDIRECT_URI`: desenvolvimento `http://localhost:5173/_api/v1/auth/google-callback`; staging/produção `https://<domínio>/_api/v1/auth/google-callback` (HTTPS obrigatório fora de localhost);
(5) colocar id/segredo no gerenciador de segredos/variáveis do ambiente. Os testes unitários não exigem nada disso.

## 14. Pendências e o que depende do Google real

Não validado contra o Google real: tela de consentimento/`prompt=select_account`, o formato exato do `iss` emitido, `email_verified` como string/booleano, latência/cache do JWKS real, e a recusa de PKCE pelo Google
(o harness reproduz a regra, não o serviço). Pendências: account linking explícito (e re-autenticação para vincular; o mecanismo de reauth da §16 já serve de base), e-mail ausente no token (hoje ⇒ falha neutra; o spec previa pedir e-mail ao
usuário), `hd`/allowlist de domínio (decisão de produto; **não** implementado: o LEVORA aceita Conta Google pessoal e Workspace), Microsoft/Apple (§25.8 — mesma mecânica, fases próprias), limite por `signup_attempt` além do por IP.

## 15. Testes

`test/googleAuth.test.ts` (login/cadastro/MFA/e-mail/código), `test/googleSecurity.test.ts` (validação de token com chaves/JWKS sintéticos, state/PKCE/vínculo/replay, IDOR, concorrência A–J, rate limit, auditoria sem segredos,
exclusão de conta, varreduras estáticas e contrato do frontend), migration 0018 em `identityMigration.test.ts`. **Controles negativos** (defesa quebrada ⇒ teste falha): state sem uso único (2), nonce (2), audience (2), issuer (1),
vínculo de navegador (1), PKCE sem verifier (4), MFA ignorado (3), checagem de identidade + `UNIQUE` removidas (4; cada uma isolada é coberta pela outra: defesa em profundidade).

## 16. Fase 92.1 — ciclo de vida de contas sociais (reautenticação por identidade)

**Problema:** uma conta criada só com Google (sem `user_passwords`) não conseguia usar `account-delete` (exigia senha). A correção **não** é uma exceção do Google nem uma senha inventada:
o modelo passa a ser "conta autenticada **+** reautenticação apropriada ⇒ pode excluir". Os métodos de uma conta são `user_passwords`, `user_identities` e `mfa_methods`; `users.id` continua sendo a identidade.

**Mecanismo geral (provider-agnóstico) — "reautenticar identidade":**
- Migration `0019_social_reauth.sql`: `sessions.primary_reauth_at` (carimbo da última reautenticação do método **primário**, na MESMA sessão, rotacionado junto com o id) e `oauth_attempts.intent='reauth'` + `user_id` (CHECK: `reauth ⇔ user_id`).
- `google-start {intent:'reauth'}`: exige **sessão** (o usuário vem da sessão, nunca do corpo; `userId`/`provider`/`accessCode` no corpo ⇒ 400) e uma identidade Google vinculada (409 `google_nao_vinculado` caso contrário).
- Callback `reauth`: mesma cadeia state→vínculo→PKCE→ID token da Fase 92; depois exige (1) identidade `(google, issuer, sub)` **do próprio usuário da tentativa**, (2) sessão corrente do **mesmo** usuário, e então rotaciona a sessão com `primary_reauth_at=now`. Qualquer falha ⇒ `/?reauth=erro` (o usuário continua logado), nada é carimbado.
- Política (`src/helpers/accountReauth.tsx`): carimbo válido por **5 min**, nunca no futuro; avaliado no **servidor**. Microsoft/Apple/senha/passkey poderão satisfazer o mesmo requisito sem mudar quem o consome.
- `account-delete`: conta **com senha** ⇒ senha (inalterado). Conta **sem senha** ⇒ identidade vinculada + confirmação digitada `EXCLUIR` (contra execução acidental/CSRF) + `primary_reauth_at` recente, tudo **revalidado dentro da transação, sob o lock do usuário** (sessão ainda existe, conta ainda não excluída). Sem método nenhum ⇒ 400. `GET account-methods` (`hasPassword`, `providers`, `mfaActive`) só serve para a interface escolher a forma de confirmar; a decisão é sempre do servidor.

**MFA — sem bypass.** O carimbo de identidade (`primary_reauth_at`) é **distinto** do step-up do 2º fator (`last_reauth_at`). Conta com MFA ativo: excluir exige **os dois** — reauth da identidade **e** step-up recente do MFA (`reauth_required`); reautenticar com o Google **não** renova o step-up, e o step-up **não** substitui a identidade. A rotação de sessão herda os dois carimbos. Login Google de conta com MFA continua passando por `auth_challenge` (§6).

**Códigos de erro:** `reauth_social_required` (403; a UI oferece "Confirmar com o Google"), `reauth_required` (403; a UI abre o `StepUpDialog`), `confirmacao_necessaria` (400), `senha_necessaria` (400; só conta com senha).

**Frontend:** `DeleteAccountDialog` (conta com senha: campo de senha; Google-only: digitar EXCLUIR; ao receber `reauth_social_required` mostra "Confirmar com o Google"; retorno `/?reauth=ok` reabre o diálogo com "Identidade confirmada"; a URL é limpa por `replace`). Contraste e layout auditados (375/390/768/desktop, claro/escuro: sem falhas).

**Nada de "Google account-delete":** não existe endpoint específico de provedor; `account-delete` não contém lógica de Google (varredura estática). Nenhuma senha é criada em nenhum fluxo social.

**Testes (`test/googleLifecycle.test.ts`, 26):** Google-only (métodos, login, logout, sessão); exclusão sem reauth/sem confirmação/janela vencida/carimbo por sessão; fluxo completo (código segue redimido, identidade apagada, Google não volta a entrar); conta com senha intacta; ownership/IDOR da reauth (identidade de outro usuário, state de outra tentativa, `user_id`/`provider` adulterados, replay, cancelamento, redirect URI só da configuração); MFA (reauth sozinho ⇒ 403, step-up sozinho ⇒ 403, ambos ⇒ ok); concorrência (duas exclusões, dois reauths, reauth×logout, reauth×sessão expirada, reauth×step-up). **Controles negativos** (defesa quebrada ⇒ teste falha): delete sem exigir reauth (4 testes), MFA não exigido (1), reauth Google renovando o step-up (2), identidade de outro usuário aceita (1), sessão de outro usuário aceita (1), sem revalidar sob lock (1), janela sem limite de tempo (1).

## 17. Roteiro de validação contra o Google REAL (a executar quando houver credenciais; NÃO executado)

Pré-requisitos: projeto/cliente OAuth e redirect URIs de §13; `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` no ambiente (nunca no Git). Registrar o resultado de cada item **sem** colar tokens/segredos.
1. **Login** — Google existente ⇒ login. 2. **MFA** — Google → MFA → TOTP (e recovery). 3. **Cadastro** — código de acesso → Google → nova conta (código consumido, `role=user`).
4. **Account delete** — Google-only → reauth → excluir. 5. **Cancelamento** — Google → cancelar ⇒ retorno seguro, nada criado. 6. **Replay** — repetir o callback real ⇒ rejeitado.
7. Conferir os claims reais: formato de `iss`, `email_verified`, `aud/azp`, `name`; conferir JWKS real (rotação) e a recusa de PKCE inválido pelo Google.
8. Conferir que o redirect URI configurado casa **exatamente** com o autorizado em cada ambiente (dev `http://localhost:5173/_api/v1/auth/google-callback`; staging/produção `https://<domínio>/_api/v1/auth/google-callback`).

## 18. Decisões de produto/arquitetura registradas na 92.1

- **E-mail ausente no ID token ⇒ falha neutra** (decisão de produto): o cadastro Google exige que a identidade forneça e-mail suficiente para o modelo atual do usuário LEVORA. Pode ser reavaliado (uma etapa de coleta de e-mail NÃO foi adicionada).
- **`email_verified` é atributo**, não identidade nem requisito: `false` não bloqueia o cadastro. **Subject:** `(google, issuer, sub)` inalterado; o e-mail nunca é chave.
- **`hd` / allowlist de domínio: não implementado.** O LEVORA aceita Conta Google pessoal e Workspace; `hd` só seria relevante se uma política futura restringisse domínios.
- **Redirect URI:** vem exclusivamente da configuração do servidor; `Host`, `Origin`, `Referer` e parâmetros de query/corpo não participam (testes e varredura estática, inclusive no callback de reauth).
- **JWKS:** arquitetura mantida (Discovery oficial, `jwks_uri` do Discovery, cache de 1 h, refresh limitado por `kid` novo, RS256 apenas, emissor/audience pela configuração); sem `tokeninfo`. A comparação com as recomendações atuais do Google é item do roteiro real (§17.7).
- **Tokens:** o `access_token` continua descartado e nenhum refresh token é pedido (o LEVORA não chama APIs do Google).
- **Cross-Account Protection / RISC:** não implementado (evolução futura, só se o produto passar a depender de sinais de segurança do Google sobre contas vinculadas).
- **Próxima fase:** Fase 93 — Microsoft (mesma arquitetura de identidade, `account-delete`/reauth e código de acesso). Apple fica separada.
