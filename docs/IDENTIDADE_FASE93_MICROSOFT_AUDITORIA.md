# Login e cadastro com Microsoft (OIDC) — Fase 93

Implementa §7.2, §25.8 e §25.9 da `docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md` sobre a Fase 92.1 (`b0b0afa`).
**Fora de escopo (e não implementado):** Apple, passkeys, account linking completo, recuperação de senha, SMTP, outras integrações.
Nada das Fases 89–92.1 foi reaberto: `users.id` segue sendo a identidade interna; `provisionUserWithAccessCode`, MFA, sessão, reauth por
identidade (`primary_reauth_at`) e `account-delete` são os mesmos — a Microsoft só entra como **mais um método de autenticação primária**.

> **STATUS DE VALIDAÇÃO (Fase 93) — leia antes de qualquer decisão de produção.**
>
> | VALIDADO (sintético) | VALIDADO CONTRA A MICROSOFT REAL (somente leitura, sem credenciais) | NÃO VALIDADO (depende de aplicativo registrado + contas reais) |
> |---|---|---|
> | validação do ID token (assinatura RS256/JWKS, `iss` por `tid`, `aud`, `ver`, `tid`, `exp`, `iat`, `nonce`, `sub`) com chaves geradas na hora | **Discovery real** de `common`, `organizations` e `consumers` aceito pela nossa validação (emissor `{tenantid}` / tenant pessoal, hosts, caminhos); URL de autorização oficial montada | **login real** com conta Microsoft **pessoal** |
> | state de uso único, vínculo de navegador, PKCE, replay, tipos de conta (pessoal × corporativa × convidada) e política do authority | **JWKS real** lido, filtrado (nuvens soberanas fora) e consultado por `kid` (assinatura falsa ⇒ `assinatura_invalida`; `kid` inventado ⇒ `chave_desconhecida`) | login real com conta **corporativa/escolar** e conta **convidada** |
> | concorrência A–J, IDOR, MFA LEVORA após Microsoft, access code, anti-enumeração, reauth e exclusão Microsoft-only | | **registro de aplicativo** (tipos de conta, redirect URI exato, segredo), **tela de consentimento** real |
> | preview local com provedor Microsoft sintético (desktop/375/390/768, claro/escuro) | | **claims reais de produção** (`iss`, `tid`, `oid`, `ver`, `email` ausente/presente, `idp`), amarração `issuer` da chave × `iss` com tokens reais |
>
> **`sintético ≠ Microsoft de produção`.** O provedor sintético prova a NOSSA validação e a integração com código de acesso/MFA/sessão; não prova nada
> que dependa da Microsoft real. A validação "real" acima é **só do Discovery/JWKS públicos** (`test/microsoftRealDiscovery.test.ts`, opt-in
> `MICROSOFT_REAL_DISCOVERY=1`): não há aplicativo, conta, token nem consentimento. **A Microsoft NÃO está declarada "pronta para produção"** — isso só
> ocorre depois do roteiro do §17. Nenhum login real aconteceu até aqui.

## 1. Princípio

Microsoft é um **método de autenticação**, não uma conta nova. Identidade LEVORA = `users.id`; identidade externa =
`user_identities (provider='microsoft', issuer, subject=sub)`. E-mail/UPN/`preferred_username` são **atributos**, nunca chave. Login jamais cria conta;
cadastro jamais dispensa o código de acesso; o MFA da conta Microsoft **não** é o MFA LEVORA.

## 2. Investigação: o que foi reaproveitado × o que é específico

| Reaproveitado (Fase 92, idêntico) | Específico da Microsoft (`src/helpers/microsoftOidc.tsx`) |
|---|---|
| `oauth_attempts` (state 256 bits uso único, vínculo, nonce, PKCE cifrado, TTL, intent login/signup/reauth) | authority multi-tenant (`common|organizations|consumers|<GUID>`) e Discovery com emissor-modelo `{tenantid}` |
| primitivas (`oauthPrimitives.tsx`: segredos, PKCE S256, HMAC, `safeEqual`) | `iss` **dinâmico** `https://login.microsoftonline.com/{tid}/v2.0` com `tid` do próprio token + política do authority |
| `provisionUserWithAccessCode`, `completePrimaryLogin` (MFA), `createSession`, `rotateSessionInTx` (reauth) | `ver == "2.0"`, `tid` GUID, `oid`/`idp` como metadata, e-mail sempre **não verificado** |
| auditoria (hash-chain), rate limit em memória, redirects relativos, resposta única do código | JWKS com `issuer`/`cloud_instance_name` por chave (nuvens soberanas fora; amarração chave × `iss`) |

**Refatoração mínima para compartilhar (sem framework):** `oauthPrimitives.tsx` (primitivas), `oauthProviders.tsx` (dois adaptadores: Google e Microsoft),
`oauthStart.tsx` e `oauthCallback.tsx` (o fluxo antes duplicável). `google-*` e `microsoft-*` viram endpoints finos. A Apple será fase própria (um 3º adaptador,
`form_post`). O comportamento do Google foi preservado (suítes 92/92.1 verdes; só as varreduras estáticas que apontavam para o arquivo antigo foram atualizadas).
`claimOauthAttempt` agora filtra por `provider`: **um `state` de um provedor nunca é consumido nem aceito no callback do outro** (teste).

## 3. Tipos de conta e registro do aplicativo (decisão de produto: `common`)

Objetivo: **contas pessoais E corporativas/escolares** ⇒ authority **`common`** (padrão, `MICROSOFT_TENANT` ausente). Não restringimos a `organizations`/`consumers`
sem decisão explícita; a restrição existe na configuração e é validada no token:

| `MICROSOFT_TENANT` | aceita | rejeita (`tenant_invalido`) |
|---|---|---|
| `common` (padrão) | qualquer `tid` GUID | — |
| `organizations` | `tid` ≠ `9188040d-…` (corporativa/escolar) | conta pessoal |
| `consumers` | `tid` = `9188040d-6c67-4c5b-b112-36a304b66dad` | corporativa/escolar |
| `<GUID>` | só aquele tenant | os demais |

No **registro do aplicativo (Microsoft Entra ID)** os "Tipos de conta com suporte" têm de bater com isso: para `common`, **"Contas em qualquer diretório
organizacional (qualquer diretório do Microsoft Entra ID – multilocatário) e contas Microsoft pessoais (como Skype e Xbox)"**. Um registro só-organizacional
faria contas pessoais falharem na Microsoft (antes de chegar a nós); a validação do `tid` aqui é a 2ª trava, não a 1ª.

## 4. Authority e Discovery

- Discovery: `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration` (derivado da configuração; **nunca** do cliente). Cache 24 h.
- **Medido contra o Discovery real (esta fase):** `common` e `organizations` anunciam `issuer = https://login.microsoftonline.com/{tenantid}/v2.0` (modelo);
  `consumers` anuncia o emissor fixo do tenant pessoal; `id_token_signing_alg_values_supported = ["RS256"]`; **`code_challenge_methods_supported` não é anunciado**
  (PKCE S256 é usado mesmo assim; não dependemos desse campo); `token_endpoint_auth_methods_supported` inclui `client_secret_post` (o que usamos).
- Validamos: emissor anunciado == o esperado para o authority; `authorization_endpoint`, `token_endpoint` e `jwks_uri` em **HTTPS**, host **exatamente**
  `login.microsoftonline.com` (sem porta/credenciais), caminho **dentro do tenant configurado**. Discovery adulterado ⇒ `502`, nada é enviado a outro host (teste com 7 variantes).
- Endpoints locais só existem em testes/preview via interruptor interno (`__allowMicrosoftLocalEndpointsForTests`), nunca por ambiente ou requisição.

## 5. Identidade: `sub`, `oid`, `tid`, `idp`, `ver`

Fonte: referência de claims do ID token da Microsoft (consultada nesta fase): `sub` é **imutável e pairwise** (único por aplicativo, tenant e usuário); `oid` é o id
imutável do objeto **no tenant** (igual entre aplicativos; diferente em cada tenant); `tid` identifica o tenant (`9188040d-…` = contas pessoais); `email`/`preferred_username`/`name`
são **mutáveis e não garantidos** ("nunca use para autorização ou para guardar dados de um usuário").

**Decisão (mantida da §25.8, agora com evidência):** a chave é `(provider='microsoft', issuer=https://login.microsoftonline.com/{tid}/v2.0, subject=sub)`.
Como o `issuer` carrega o `tid`, a chave equivale a (aplicativo, tenant, usuário) — exatamente o escopo do `sub`. Consequências provadas por teste:
- mesmo `sub` em **outro tenant** ⇒ outra identidade (o convidado no tenant B não herda a conta do tenant A — alinhado à orientação da Microsoft de tratar convidado como usuário novo);
- `issuer=A,sub=X` × `issuer=A,sub=Y` × `issuer=B,sub=X` ⇒ três identidades; mesmo `oid`+`tid` com `sub` diferente ⇒ **não** colide (o `oid` não é chave);
- o banco barra a repetição (`UNIQUE(provider,issuer,subject)`).

**Não migramos para `oid + tid`.** Risco conhecido e documentado: se o registro do aplicativo for **substituído** (novo Client ID), o `sub` muda para todos. Mitigação futura
(não implementada): procedimento auditado de re-vinculação usando o `oid` da metadata. **Metadata** (`user_identities.provider_metadata`, migration `0020`): `tid`, `ver`, `oid` (se presente),
`idp` (se presente) — nunca participa de busca. Defesa: se a identidade já gravada tem `oid` e o token traz **outro** `oid` para o mesmo `(issuer,sub)`, isso é anômalo ⇒ rejeita
(`metadata_divergente`, auditado), não "atualiza em silêncio". `oid` ausente não impede nada (a chave é `issuer+sub`).

## 6. Validação do ID token (jose + node:crypto + fetch; **sem dependência nova**)

| Item | Regra | Falha |
|---|---|---|
| algoritmo | cabeçalho `alg == RS256` (whitelist; `none`/HS*/RS384 recusados), `kid` obrigatório; `jku`/`x5u`/`jwk` ignorados | `assinatura_invalida` / `chave_desconhecida` |
| assinatura | chave do JWKS do Discovery pelo `kid` (cache 1 h; `kid` novo ⇒ 1 refresh por 60 s; falha temporária mantém o cache; sem cache ⇒ falha fechada) | `assinatura_invalida` / `chave_desconhecida` |
| chaves aceitas | só `cloud_instance_name` ausente ou `microsoftonline.com`; a chave **tem de declarar `issuer`** (ausente/vazio/não-string ⇒ rejeitada, fail-closed desde a 93.2) e ele, com `{tenantid}`→`tid`, tem de igualar o `iss` (chave de contas pessoais não assina `iss` corporativo) | `chave_desconhecida` / `chave_issuer_divergente` |
| `aud` | == `MICROSOFT_CLIENT_ID`, único (lista ≠ 1 valor recusada); `azp` se presente == client id | `audience_invalida` / `azp_invalido` |
| `ver` | == `"2.0"` | `versao_invalida` |
| `tid` | GUID minúsculo; **obrigatório** | `tenant_invalido` |
| `iss` | == `https://login.microsoftonline.com/{tid}/v2.0` **exato** (nunca "qualquer `iss` com assinatura válida") | `issuer_invalido` |
| authority | `tid` permitido pela configuração (§3) | `tenant_invalido` |
| `exp`/`nbf`/`iat` | tolerância 60 s; `iat` no futuro recusado | `expirado` / `iat_invalido` |
| `nonce` | HMAC do nonce == o da tentativa (tempo constante) | `nonce_invalido` |
| `sub` | string 1–255 | `subject_ausente` |
| `oid`/`idp` | se presentes, bem formados (GUID / ≤255); metadata | `token_malformado` |

A **configuração** (client id, authority) define o confiável; o token nunca define emissor ou audience. O `access_token` devolvido pela troca é **descartado**; sem `refresh_token`
(não pedimos `offline_access`); nenhum token é guardado (teste varre todas as tabelas) nem logado/auditado.

## 7. State, nonce, PKCE, vínculo e replay (idêntico ao Google)

State e nonce de 256 bits, de uso único (`UPDATE … started→processing`), TTL 10 min, cookie de vínculo `levora_oauth` (HttpOnly/Secure/Lax, Path `/_api/v1/auth`),
PKCE S256 com verifier **cifrado** em repouso (AES-GCM, AAD = hash do state), nunca em URL/storage. `response_mode=query`, `response_type=code`; **sem implicit, sem fragmento**.
Scopes **`openid profile email`** (`profile` é necessário para `oid`/`name`); nenhum escopo do Microsoft Graph; `prompt=select_account`. Redirect URI **só da configuração**.

## 8. Login, cadastro e código de acesso

- **Login:** `(microsoft, iss, sub)` vinculada ⇒ `completePrimaryLogin` (sessão plena ou `auth_challenge` de MFA LEVORA). Não vinculada ⇒ **nada é criado** (`nao_vinculada`).
- **Cadastro:** `[código] → access-code-check → Continuar com Microsoft → start(signup, corpo)` guarda só o `access_code_id` → callback → `provisionUserWithAccessCode({codeId})`
  (uma transação: users + identidade + sessão + consumo do código + auditoria). Sem código não há cadastro (CHECK no banco); o código nunca vai à URL/Microsoft.
- **E-mail:** a Microsoft **não garante a posse** do e-mail (nOAuth; a doc diz "nunca usar para autorização"). `email_verified` é **sempre `false`** para a Microsoft (o claim do token é ignorado);
  só o claim `email` é lido (nunca `preferred_username`/UPN). E-mail já usado por outro usuário ⇒ nada criado, código **não** consumido, sem auto-link e sem revelar a conta.
- **E-mail ausente no token** ⇒ falha neutra no **cadastro** (mesma decisão da 92.1; sem etapa extra de coleta). **Atenção:** contas corporativas costumam **não** trazer `email` por padrão
  (só como *optional claim*; o escopo `email` no v2.0 também o solicita, mas não é garantido). Se o teste real mostrar isso, a decisão de produto é ou configurar o *optional claim* `email` no registro
  do aplicativo (recomendado) ou aprovar uma etapa de coleta de e-mail numa fase própria. **Login** de identidade já vinculada não depende de e-mail.
- **Dívida herdada (§25.9):** `users.email` de uma conta social não é prova de posse; o aceite de convite compara `invite.email == user.email` e o segredo real é o token do convite. Recursos que dependam de
  posse do e-mail (recuperação de senha, convite sem token) exigirão `email_verified_at` e SMTP — não resolvido aqui.

## 9. MFA, reauth e sessão

- **MFA:** Microsoft ⇒ `auth_challenge` ⇒ TOTP/recovery ⇒ sessão. O MFA da conta Microsoft **não** conta. Titular de `platform_access` sem MFA ⇒ inscrição obrigatória.
- **Reauth (mecanismo genérico da 92.1):** `microsoft-start {intent:reauth}` (usuário da **sessão**; corpo estrito) → callback → identidade tem de ser do **mesmo** usuário da tentativa e da sessão →
  `rotateSessionInTx(…, {primaryReauth:true})` carimba `primary_reauth_at` (5 min) **sem tocar** `last_reauth_at` (step-up do MFA). `account-delete` de conta Microsoft-only: identidade vinculada +
  `EXCLUIR` + reauth fresco revalidado sob lock + (MFA ativo) step-up recente. **Não existe** endpoint "Microsoft account-delete"; o reauth é **por provedor** (`409 microsoft_nao_vinculado` / `google_nao_vinculado`).
- **Sessão:** `sessions` é a autoridade (idle/absoluto, tier, rotação). ID/access/refresh token **nunca** são sessão.

## 10. Auditoria e rate limit

Eventos: `usuario.login_microsoft`, `usuario.login_microsoft_falhou`, `usuario.cadastro_microsoft`, `usuario.cadastro_microsoft_falhou`, `usuario.reauth_microsoft`,
`usuario.reauth_microsoft_falhou`, `usuario.microsoft_identity_rejected` (falhas: 1 por ação+motivo+rede / 10 min). Nunca: code, ID/access/refresh token, nonce, verifier, segredos, state, `oid`, e-mail (teste varre `audit_log`).
Rate limit em memória (single-instance, sem Redis): `microsoft-start` 20/15 min/IP, `microsoft-callback` 30/15 min/IP, baldes independentes do Google; `reauth` usa o mesmo `microsoft-start`.

## 11. Concorrência (A–J), sem sleeps/retries

A dois callbacks da mesma tentativa ⇒ 1 vence · B dois cadastros mesmo código+mesma identidade ⇒ 1 conta · C mesma identidade com dois códigos ⇒ 1 conta, código perdedor intacto · D identidades diferentes + mesmo
código ⇒ 1 conta · E revogação durante o callback ⇒ conta+código **ou** nada · F expiração (antes e durante) ⇒ nada/consumo coerente · G MFA ativado durante o login ⇒ nunca sessão plena com MFA ativo ·
H reauth × logout · I reauth × sessão expirada (+ reauth × step-up, dois reauths, duas exclusões) · J identidade vinculada + replay/dois logins ⇒ no máx. 1 sessão por tentativa.

## 12. IDOR

Nada do navegador escolhe a identidade: `userId`, `provider`, `accessCode`, `intent`, `tid`, `oid`, `sub`, `iss`, `email`, `redirect_uri` na query/corpo são ignorados/recusados (400 estrito no start).
State/cookie de outra tentativa, signup/reauth de outro usuário, token de outra tentativa (nonce), identidade de outro usuário/tenant ⇒ rejeitados, nada carimbado, nada movido.

## 13. Frontend

`Entrar com Microsoft` (login) e `Continuar com Microsoft` **somente** no ramo do cadastro em que o código já foi validado; `Confirmar com a Microsoft` no diálogo de exclusão (o provedor vem de
`account-methods`, não do cliente). Componente genérico `OauthStartButton` (Google e Microsoft são wrappers). Retorno do callback: códigos curtos fechados (`?microsoft=erro|mfa|mfa_setup&motivo=…`), limpos da barra (replace).
Detalhes do preview: ver §16.

## 14. Configuração e registro do aplicativo (nada versionado)

`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (o **valor** do segredo), `MICROSOFT_REDIRECT_URI` (== redirect URI da plataforma **Web** do registro; `https` fora de localhost),
`MICROSOFT_TENANT` (padrão `common`), `MICROSOFT_DISCOVERY_URL` (opcional). Ver `.env.example`. Sem as 3 primeiras ⇒ `503 microsoft_nao_configurado` e nada é criado. Dev: `http://localhost:5173/_api/v1/auth/microsoft-callback`.
Passos no portal (a executar por quem tem acesso): Entra ID → Registros de aplicativo → Novo → tipos de conta (§3) → plataforma Web + redirect → Certificados e segredos → novo segredo (copiar o VALOR) →
(recomendado) Configuração de token → *optional claim* `email` no ID token.

## 15. Dependências: `jose` + `fetch` (Opção A) × MSAL Node (Opção B) — decisão

| Critério | `jose` + fetch (existente) | `@azure/msal-node` |
|---|---|---|
| segurança | validação explícita e testada de cada claim; whitelist de algoritmo; JWKS com cooldown; sem token persistido | foco em **adquirir tokens para APIs**; mantém cache de tokens (inclui refresh) — contrário a "não armazenar tokens" |
| integração | usa `oauth_attempts`, state/vínculo/PKCE já auditados, mesma máquina de estados do Google | traria **segundo** gerenciador de state/PKCE/nonce em paralelo ao nosso; risco de misturar dois sistemas |
| `common`/tipos de conta | tratado e testado (§3) | suporta authority `common` |
| manutenção/peso | 0 dependência nova; ~300 linhas próprias, cobertas por 100+ testes | +dependência (e transitivas) sem ganho para "só identidade" |
| auditoria (`npm audit`) | inalterada | superfície nova |

**Decisão: Opção A.** A Microsoft recomenda bibliotecas suportadas; a LEVORA não adquire tokens para chamar APIs (só autentica), e já possui o fluxo OIDC próprio auditado (Fase 92). Trocar por MSAL mudaria
o desenho de state/PKCE/cache sem benefício. **Reavaliar** se a LEVORA passar a chamar o Microsoft Graph (aí o MSAL faria sentido para o ciclo de tokens). Nenhum pacote foi instalado; esta comparação não executou MSAL.

## 16. Preview, testes e regressão

**Preview real** (servidores locais + Microsoft SINTÉTICA em localhost, banco dev descartável, tudo removido depois): login com conta não vinculada ⇒ mensagem neutra, **0** contas criadas; aba "Criar conta" **sem** botão Microsoft antes do código; código válido ⇒ "Continuar com Google/Microsoft"; cadastro com conta **pessoal** (token assinado por chave marcada com o emissor pessoal) ⇒ `user_identities.issuer = …/9188040d-…/v2.0`, `provider_metadata {tid,oid,ver}`, `email_verified=false`, sessão `primary_method=microsoft`, código consumido; exclusão sem reauth ⇒ 403 ⇒ diálogo "Confirmar com a Microsoft" ⇒ conta **errada** ⇒ falha segura (toast, continua logada, nada carimbado, auditoria `microsoft_identity_rejected`) ⇒ conta **certa** ⇒ diálogo reabre "Identidade confirmada" ⇒ `EXCLUIR` ⇒ conta anonimizada, sem identidade/sessão, código segue redimido, auditorias `cadastro_microsoft`, `reauth_microsoft`, `conta_excluida`. Retornos `?microsoft=erro&motivo=cancelado` e `?microsoft=mfa` renderizam (mensagem / formulário de MFA). Layout dos botões em **375, 390, 768 e 1280**, claro e escuro: sem rolagem horizontal, botões dentro da viewport, contraste do texto 15,66:1 (claro) / 13,16:1 (escuro). **Não exercitado no preview:** o ramo MFA+step-up do diálogo e o fluxo MFA ponta a ponta na UI (cobertos só por testes server-side); o preview não usou o Microsoft real.

**Testes:** `microsoftAuth` (26), `microsoftSecurity` (41), `microsoftLifecycle` (22), `microsoftRealDiscovery` (2, opt-in), mais 2 de migration `0020`. Controles negativos: 14 defesas quebradas uma a uma (provider no claim, `iss` por `tid`, política do authority, audience múltipla, `ver`, nonce, conflito de `oid`, amarração chave×emissor, nuvens soberanas, `email_verified`, `preferred_username` como e-mail, host do Discovery, whitelist de `alg`, dono da identidade no reauth) — cada uma derrubou ≥1 teste. Regressão completa: 68 arquivos / 1004 testes (1002 passam + 2 do Discovery real, pulados sem `MICROSOFT_REAL_DISCOVERY=1`), **2 rodadas verdes**; `tsc` das duas configs, `build` e `build:server` ok.

## 17. Roteiro de validação contra a Microsoft REAL (a executar quando houver registro e contas; NÃO executado)

1. Registrar o aplicativo (§14) em dev (`http://localhost:5173/...`) com `common`; configurar as 3 variáveis; subir API+Vite.
2. **Pessoal:** criar código de acesso → Criar conta → Continuar com Microsoft (conta Outlook/Hotmail) → conferir: consentimento, redirect, conta criada, `user_identities.issuer == …/9188040d-…/v2.0`, `provider_metadata.tid`, `email_verified=false`; sair; Entrar com Microsoft.
3. **Corporativa/escolar:** idem com conta de um tenant; **verificar se o claim `email` veio**; se não, configurar o *optional claim* (§8). Conferir `iss` do tenant e a amarração `issuer` da chave × `iss` (um `chave_issuer_divergente` aqui indicaria premissa errada sobre o JWKS real — a falha é segura).
4. **Convidada:** convidar uma conta externa a um tenant e entrar; confirmar que é identidade distinta (`tid` do tenant anfitrião; `idp`).
5. **MFA LEVORA:** ativar TOTP; Entrar com Microsoft ⇒ challenge ⇒ TOTP. **Reauth + exclusão** de conta Microsoft-only (com e sem MFA).
6. **Negativos reais:** cancelar no consentimento (`access_denied`), replay do callback, state de outra aba, redirect URI divergente (erro na Microsoft), segredo errado (⇒ `troca_codigo_falhou`).
7. Registrar os resultados e **só então** reclassificar o status deste documento.

## 18. Pendências

Validação real (§17) · e-mail ausente em contas corporativas (§8) · re-vinculação auditada por `oid` se o registro do aplicativo for trocado (§5) · account linking explícito · allowlist de tenants (hoje só
`MICROSOFT_TENANT` único) · `xms_edov`/e-mail verificado pelo domínio (não usado de propósito) · Apple (fase própria) · CAE/revogação contínua (fora de escopo).

## 19. Fase 93.1 — vulnerabilidade, auditoria de issuer/chave e preparação do teste real

> **Estado honesto:** as credenciais Microsoft **não estavam configuradas** neste ambiente (`MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI` ausentes; conferido só por presença, sem imprimir valores). **Nenhum login Microsoft real foi executado**; nenhum claim real foi observado. A parte real desta fase parou na preparação (§19.3–19.4). A Microsoft **continua NÃO validada** e **não** está "pronta para produção".

### 19.1 `source-map-js` (GHSA-68fv-2mgg-jv7q / CVE-2026-93749)
- **Advisory (confirmado na API do GitHub Advisories):** severidade alta, CVSS `AV:N/AC:L/PR:N/…/A:H`, afeta `>= 1.0.0, < 1.2.2`, corrigido em **1.2.2**. Falha: o deslocamento de linha por seção de *indexed source maps* não é validado; um valor enorme bloqueia o event loop de forma síncrona. Só dispara quando o pacote **processa um source map malicioso**.
- **Cadeia (`npm explain`, instalação limpa `npm ci` no worktree):** `source-map-js@1.2.1` (dev) ← `postcss@8.5.28` ← `vite@6.4.3` (build/dev server do frontend) e ← `magicast@0.5.5` ← `@vitest/coverage-v8` (cobertura de testes). Ambos os pais declaram `^1.2.1`, que **aceita 1.2.2**.
- **Exposição real:** só dependência de **desenvolvimento/build**. `npm ls --omit=dev source-map-js` ⇒ vazio; o `Dockerfile` instala o runtime com `npm ci --omit=dev`; nenhum código de `src/`, `server/` ou `db/` importa o pacote. **Não há evidência de que a API em execução fosse explorável remotamente por esse caminho.** O risco residual era local/de CI (um source map hostil processado por vite/postcss ou pela cobertura).
- **Correção (menor possível):** `npm update source-map-js` ⇒ **só o `package-lock.json`** (3 linhas: versão/URL/integridade 1.2.1 → 1.2.2). Sem `overrides`, sem atualizar pais, `package.json` sem mudança de dependências. Depois: `npm ls` mostra 1.2.2 nas duas cadeias (nenhuma 1.2.1 restante) e `npm audit` ⇒ **0 vulnerabilidades**.
- **Nota de ambiente:** nos worktrees anteriores `node_modules` era junção para outro worktree (por isso o `npm explain` ali saía "extraneous"); esta fase usa instalação própria para auditar a árvore real sem alterar a dos outros worktrees.

### 19.2 Auditoria de issuer e chave (leitura do código real + teste que prova cada etapa)
`src/helpers/microsoftOidc.tsx`. Regra da Microsoft para multitenant: trocar `{tenantid}` do emissor anunciado pelo `tid` do token e comparar o valor **exato** com `iss`; validar também o emissor da **chave** que assinou.

| Requisito | Onde (linha) | Prova |
|---|---|---|
| Discovery só de `login.microsoftonline.com`, HTTPS, sem porta/credenciais, caminho dentro do tenant | `isMicrosoftEndpoint` (127) | `microsoftAuth` "Discovery adulterado" (7 variantes) |
| Emissor anunciado == o esperado para o authority (modelo `{tenantid}` p/ common/organizations; fixo p/ consumers/GUID) | `expectedDiscoveryIssuer` (140), uso (157) | idem; **real (opt-in):** emissor do Discovery real com `{tenantid}`→tid == `microsoftIssuerFor(tid)` nos 3 authorities |
| `alg` só RS256, `kid` obrigatório, kid → chave do JWKS (nunca `jku`/`x5u`) | 289–291 | `microsoftSecurity` assinatura/kid (RS384, HS256, none) |
| `iss` == `https://login.microsoftonline.com/{tid}/v2.0` com `tid` do token (GUID minúsculo) | 333–334 | "ISSUER" (11 variantes) e "TID" |
| `tid` permitido pelo authority | 265, 335 | "authority organizations/consumers/GUID" |
| emissor da **chave** (`issuer` do JWKS, `{tenantid}`→tid) == `iss` | 338 | "JWKS: chave marcada pela Microsoft…" |
| nuvens soberanas fora (`cloud_instance_name`) | 171, 180 | idem + **real (opt-in):** chave de nuvem soberana do JWKS real ⇒ `chave_desconhecida` |
| `aud` único == client id; `azp`; `ver == "2.0"`; `exp`/`iat`/`nbf` (±60 s); `nonce` (HMAC, tempo constante); `sub` 1–255 | 302–344 | "AUDIENCE", "VER", "exp e iat", "nonce…" |
| JWKS: cache 1 h; `kid` novo ⇒ 1 refresh/60 s; falha temporária mantém o cache; sem cache falha fechada | 27–28, 188–189 | "JWKS: cache…rotação" e "falha TEMPORÁRIA" |

**Resultado (93.1):** nenhum defeito comprovado nos itens da tabela; a lacuna (b) abaixo foi encontrada depois e fechada na 93.2. Observações (não são bugs): (a) o `iss` é comparado à forma `https://login.microsoftonline.com/{tid}/v2.0`, equivalente ao emissor anunciado com `{tenantid}` substituído (agora provado contra o Discovery real); (b) ~~chaves sem `issuer` eram aceitas~~ — **corrigido na Fase 93.2 (§20): agora são rejeitadas (fail-closed)**; (c) uma chave de modelo `{tenantid}` pode assinar `iss` pessoal — decisão deliberada: restringir mais arriscaria quebrar login real que não conseguimos testar. **A amarração chave × emissor continua validada só com chaves sintéticas no formato real**; o primeiro login real é o teste dela (um `chave_issuer_divergente` indicaria premissa errada, com falha segura).

### 19.3 Checklist exato do App Registration (a executar no portal por quem tem acesso)
1. Microsoft Entra ID → **Registros de aplicativo → Novo registro**. Nome específico da **LEVORA SOLIDÁRIA** (ex.: "Levora Solidária — dev").
2. **Tipos de conta com suporte:** "Contas em qualquer diretório organizacional (multilocatário) **e contas Microsoft pessoais** (como Skype, Xbox)". Casa com `MICROSOFT_TENANT=common` (padrão). Para outro público, ajuste junto `MICROSOFT_TENANT` (§3).
3. **URI de redirecionamento — plataforma "Web"** (não SPA, não cliente público), valor **exatamente** igual a `MICROSOFT_REDIRECT_URI`:
   - dev: `http://localhost:5173/_api/v1/auth/microsoft-callback` (o proxy do Vite repassa `/_api` à API; `http://localhost` é permitido);
   - staging/produção: `https://<domínio-público>/_api/v1/auth/microsoft-callback` (HTTPS obrigatório fora de localhost; o código recusa `http` fora de localhost).
   O servidor usa **somente** esse valor (nunca `Host`/`Origin`/`Referer`/query — há teste).
4. **Certificados e segredos → Novo segredo do cliente:** copiar o **valor** (não o ID) direto para o ambiente seguro; nunca em chat, Git ou relatório.
5. **Configuração de token → Adicionar declaração opcional → ID → `email`** (recomendado). Sem isso, contas **corporativas/gerenciadas** podem não trazer `email` no ID token e o **cadastro** falha de forma neutra (`email_ausente`); o **login** de identidade já vinculada não depende de e-mail. Mesmo presente, o e-mail é **atributo**, nunca identidade, e nunca verificado.
6. **Permissões de API:** nada além do que `openid profile email` já concede (sem Microsoft Graph, sem `offline_access`, sem permissões administrativas).
7. Variáveis (somente ambiente local/seguro, nunca versionadas): `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`, (opcional) `MICROSOFT_TENANT`. Conferir com **`npm run microsoft:preflight`** (não imprime client id/segredo; só presença, redirect URI esperado e se o **Discovery real** é aceito; não faz login).
8. **Separação de produtos:** LEVORA SOLIDÁRIA e LEVORA CRM usam **App Registrations, client IDs, segredos, callbacks e tabelas de identidade distintos**; nada é reutilizado entre eles sem decisão arquitetural explícita (o `sub` é por aplicativo, logo identidades de um não valem no outro).

### 19.4 Continuidade se o App Registration/client ID for substituído
O `sub` é por aplicativo: um **novo** Client ID gera **novos** `sub` ⇒ nenhuma identidade Microsoft existente casa mais (os usuários não entrariam por Microsoft). Não migramos para `oid` nesta fase. Procedimento seguro (a formalizar em fase própria, **não implementado**): (1) preferir **não** trocar o registro; (2) se inevitável, manter o antigo ativo até concluir; (3) a re-vinculação por usuário exige **reautenticação por outro método** (senha/MFA LEVORA) e comparação do `oid`+`tid` guardados em `provider_metadata` com os do novo token, com auditoria; (4) nunca re-vincular por e-mail.

### 19.5 Resultados: real × sintético × não testado
| Caso | Status |
|---|---|
| Discovery de `common`/`organizations`/`consumers` aceito pelo nosso código; emissor `{tenantid}`→tid == `iss` exigido; JWKS real lido/filtrado, kid real encontrado, nuvem soberana recusada | **VALIDADO contra a Microsoft real** (somente leitura, sem credenciais; `MICROSOFT_REAL_DISCOVERY=1`) |
| Validação completa do ID token, state/nonce/PKCE, replay, cancelamento, identidade não vinculada, cadastro com código, login vinculado, MFA LEVORA, reauth Microsoft-only, exclusão, concorrência, IDOR, tokens com issuer/aud/nonce inválidos | **VALIDADO somente por teste sintético** (+ preview local com provedor sintético na Fase 93) |
| Login com conta **pessoal**; com conta **corporativa/escolar**; conta convidada; consentimento real; claims reais (`iss`, `tid`, `oid`, `ver`, `email`, `idp`); amarração chave × emissor com token real; segredo/redirect URI reais | **NÃO TESTADO** (sem App Registration/credenciais) |

**Claims reais observados:** nenhum (nenhum token real foi obtido). Roteiro do teste real: §17.

## 20. Fase 93.2 — fechamento do issuer das chaves (fail-closed)

**Antes (93/93.1):** a chave só era rejeitada se `jwk.issuer` fosse string **e** divergisse do `iss`; chave **sem** `issuer` pulava a checagem (e um teste aceitava essa condição). A ausência do campo funcionava como permissão implícita.

**Depois (93.2):** a chave que verifica o ID token **tem de declarar `issuer`**. Regra (`verifyMicrosoftIdToken`, após validar `iss`/`tid`):
1. `issuer` ausente, vazio/só espaços ou não-string ⇒ chave **não autorizada** (`chave_issuer_divergente`);
2. `{tenantid}` no `issuer` é substituído pelo `tid` **já validado**;
3. o resultado tem de ser **exatamente** igual ao `iss` do token; senão `chave_issuer_divergente`;
4. a ausência do campo **nunca** vale como autorização. As demais regras (RS256, Discovery confiável, `tid`, `aud`, `exp`, `iat`, `nonce`, `sub`, nuvem pública) e o modelo de identidade `provider + issuer + sub` não mudaram.

**Testes (microsoftSecurity):** chave sem `issuer` (10 formas: ausente, vazio, espaços, número, objeto, nulo, lista, sem esquema, `http`, modelo sem tenant) ⇒ rejeitada; `{tenantid}` do tenant ⇒ aceita; issuer exato do tenant ⇒ aceita; issuer de outro tenant / pessoal num token corporativo ⇒ rejeitada; nuvem soberana ⇒ continua `chave_desconhecida`; e2e de cadastro com chave sem `issuer` ⇒ nada criado, código intacto, auditoria; rotação e cache continuam. **Controle negativo:** voltar à checagem antiga (só quando `issuer` é string) derruba 3 testes.

**Discovery/JWKS reais (opt-in `MICROSOFT_REAL_DISCOVERY=1`, repetido nesta fase):** continuam aceitos, e **todas as chaves públicas atuais do JWKS real declaram `issuer`** (o modelo `{tenantid}` ou o tenant pessoal) — logo a nova regra não rejeita chave real de hoje. Isto valida **somente metadados públicos**: **nenhum login Microsoft real foi feito** e a cadeia completa **não** foi testada com token de usuário real. Se, num login real, a Microsoft publicar chave sem `issuer`, o login falhará de forma segura (e isso será um achado, não uma brecha).

**Correção do texto anterior:** onde o §19.2 dizia que chaves sem `issuer` eram aceitas, vale esta seção. **Estado:** autenticação Microsoft real **continua pendente**; a Microsoft **não** está pronta para produção.

## 21. Fase 93.3 — tentativa de qualificação real (2026-10-12): BLOQUEADA POR CONFIGURAÇÃO/VALIDAÇÃO HUMANA

**Ambiente:** worktree `levora-f933` (branch `fase-93-3-microsoft-qualificacao`, derivada de `ff29bd6`), Windows, instalação local.
**Resultado do `npm run microsoft:preflight`:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` e `MICROSOFT_REDIRECT_URI` **AUSENTES** (e nenhuma linha `MICROSOFT_*` no `.env` local do repositório principal; `.env` está no `.gitignore`); `MICROSOFT_TENANT` ausente (padrão `common`). Nada foi enviado à Microsoft; nenhum login, token ou claim real existe.

**Estado:** nenhum cenário real (pessoal, corporativo/escolar, MFA, reauth, exclusão, negativos) foi exercitado. **Não qualificada. A Microsoft NÃO está pronta para produção.** Nenhum código foi alterado; o fail-closed da 93.2 permanece. Nenhum token foi fabricado nem valor de teste usado no lugar de credenciais.

**Ações humanas pendentes (únicas que desbloqueiam):**
1. Criar o App Registration conforme §19.3 (contas organizacionais + pessoais; plataforma Web; redirect `http://localhost:5173/_api/v1/auth/microsoft-callback`; *optional claim* `email` no ID token; sem permissões Graph) — exclusivo da LEVORA SOLIDÁRIA (não reutilizar registro do LEVORA CRM).
2. Colocar `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (o **valor** do segredo) e `MICROSOFT_REDIRECT_URI` num `.env` local ignorado pelo Git (nunca no chat) e rodar `npm run microsoft:preflight` até o Discovery real ser aceito.
3. Disponibilizar uma conta **pessoal** (Outlook/Hotmail) e uma conta **corporativa/escolar** autorizadas, e um código de acesso válido; as senhas/MFA/consentimento da Microsoft são digitados **pela própria pessoa** no navegador.
Depois disso, executar o roteiro do §17 e registrar aqui: `iss`, `tid`, presença de `email`, `issuer` da chave usada e a igualdade `{tenantid}`→`tid` == `iss` observada (sem tokens nem dados pessoais).
