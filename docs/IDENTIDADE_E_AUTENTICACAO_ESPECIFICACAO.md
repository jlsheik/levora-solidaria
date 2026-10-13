# Identidade, autenticação, MFA e códigos de acesso — especificação definitiva (Fase 88)

> **Natureza deste documento:** arquitetura + auditoria. **Nenhum código, schema, migration, endpoint ou tela foi
> alterado** para produzi-lo. Base auditada: `HEAD a628bd4` (leitura da árvore principal; as alterações em andamento
> de agentes/plataforma — `automacao.*`, `0014_agent_platform.sql` — não são identidade e não foram tocadas).
>
> **PRECEDÊNCIA (Fase 88.1):** a seção **25 — DECISÕES CONGELADAS — FASE 88.1** prevalece sobre qualquer trecho anterior
> em conflito. Os trechos substituídos foram marcados com `[SUBSTITUÍDO → §25.x]`. Em particular: o modelo de autorização
> de plataforma (`users.role='admin'`) é **transitório**; o modelo definitivo é `platform_access` (§25.1).
>
> **Legenda de status (usada em todo o documento):**
> `IMPLEMENTADO/VERIFICADO` (visto no código **e** coberto por teste) · `PARCIAL` · `DOCUMENTADO, MAS NÃO CONFIRMADO NO CÓDIGO`
> · `NÃO CONFIRMADO` · `NÃO EXISTE`.

---

## 1. Estado atual (fatos comprovados no código)

### 1.1 Usuários, senha, sessão

| Item | Estado | Evidência |
|---|---|---|
| Tabela `users` (`id`, `email` UNIQUE + `idx_users_email_lower` único em `LOWER(email)`, `display_name`, `avatar_url`, `role user_role('admin'\|'user')`) | IMPLEMENTADO/VERIFICADO | `db/schema.sql:34-49`, migration 0013, `test/emailCaseInsensitive.test.ts` |
| Senha: `user_passwords(id, user_id, password_hash)` — bcryptjs, custo 10 (`generatePasswordHash`) | IMPLEMENTADO/VERIFICADO | **sem `UNIQUE(user_id)`** (só FK); o login usa `LIMIT 1` |
| Política de senha: somente `min(8)` no cadastro | PARCIAL | `register_with_password_POST.schema.ts`; não há teto de 72 bytes (bcrypt trunca em silêncio), nem verificação contra senhas vazadas |
| Cadastro público por e-mail+senha, **sem nenhum código** | IMPLEMENTADO/VERIFICADO | `auth/register_with_password_POST.ts` — resposta única anti-enumeração (Fase 51), 10/h por IP, índice único como barreira de corrida |
| Verificação de e-mail | **NÃO EXISTE** | nenhum token/coluna `email_verified`; qualquer pessoa cadastra qualquer e-mail |
| Login e-mail+senha | IMPLEMENTADO/VERIFICADO | `auth/login_with_password_POST.ts`: advisory lock por e-mail, bloqueio 5 falhas/15 min **por e-mail** (`login_attempts`), 20/15 min por IP, hash fictício p/ igualar tempo (SEC-04) |
| Sessão | IMPLEMENTADO/VERIFICADO | linha em `sessions(id TEXT PK aleatório 256 bits, user_id, expires_at, created_at, last_accessed)` + cookie `floot_built_app_session` = JWT HS256 (`jose`) com `{id, createdAt, lastAccessed}`, exp 7 d, `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7d` |
| Validação da sessão | IMPLEMENTADO/VERIFICADO | `getServerUserSession`: verifica JWT **e** exige a linha em `sessions` (join com `users`); papel (`users.role`) é relido do banco **a cada requisição**; atualiza `last_accessed`; o cookie é renovado em `session_GET` (deslizante) |
| `sessions.expires_at` | PARCIAL | gravada no login, **nunca lida** na validação; a validade real vem do `exp` do JWT + limpeza probabilística (10 %) por `last_accessed` > 7 d |
| Logout | IMPLEMENTADO/VERIFICADO | `auth/logout_POST` apaga a linha da sessão atual e limpa o cookie |
| Logout global / revogar outras sessões / listar sessões | **NÃO EXISTE no HEAD** | existe apenas como trabalho **não commitado** da fase "Conta do usuário" (worktree `levora-f88`, 24+1 testes) — **não faz parte do HEAD** |
| Troca de senha / definir senha / recuperação de senha | **NÃO EXISTE no HEAD** | idem (troca de senha só no trabalho não commitado); recuperação: nenhuma tabela/token/endpoint |
| `passwordChangeRequired` | PARCIAL (inerte) | campo do tipo `Session`/JWT herdado do template; ninguém grava nem lê |
| Rotação de sessão (novo id em mudança de privilégio) | **NÃO EXISTE** | o id é novo a cada login (sem fixation), mas nada rotaciona em mudança de credencial |
| IP / user agent na sessão | **NÃO EXISTE** | não são gravados |
| Exclusão de conta (LGPD) | IMPLEMENTADO/VERIFICADO | `auth/account-delete_POST`: exige senha (5/15 min por usuário), bloqueia se único proprietário de organização, **anonimiza** `users` (e-mail → `usuario-excluido-<id>@removido.invalid`), apaga `user_passwords` e `sessions`, inativa memberships, audita `usuario.conta_excluida` |
| Auditoria de autenticação | PARCIAL | só `usuario.conta_excluida`. **Login, falha de login, logout, cadastro e criação de sessão não geram evento de auditoria** (apenas `login_attempts`, que guarda e-mail+sucesso, sem IP) |
| MFA / TOTP / recovery codes / OAuth / OIDC / passkeys | **NÃO EXISTE** | nenhum código, tabela ou dependência. Citados só no master prompt (seções "MFA para perfis administrativos", "passkey") → DOCUMENTADO, MAS NÃO CONFIRMADO NO CÓDIGO |
| E-mail (SMTP) | PARCIAL | `src/helpers/emailAdapter.tsx` (nodemailer) existe e **recusa fingir envio**; sem credenciais SMTP o adaptador devolve `not_configured`. Usado hoje só em convites |
| Rate limit | IMPLEMENTADO/VERIFICADO | `rateLimit.tsx`: janela fixa **em memória**, 1 processo (confirmado como limitação na Fase 52). Buckets: `login`, `register`, `account-delete`, `organization-invites-*`, `files-upload`, `organization-members` |
| Cabeçalhos / CSP | IMPLEMENTADO/VERIFICADO | `src/helpers/securityHeaders.ts`: `default-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`; sem CORS; CSRF coberto por `SameSite=Lax` + ausência de CORS + corpo exigido como superjson (`docs/SECURITY.md`) |
| Topologia | DOCUMENTADO e coerente | nginx same-origin → Express, `TRUST_PROXY=1`, 1 instância (`DEPLOYMENT_RUNBOOK.md`); IP do cliente injetado como `x-client-ip-verified` por `server/index.ts` (sobrescreve o do cliente) |

### 1.2 Administrador da plataforma — "Hoje o administrador de plataforma funciona assim…"

1. **O que o identifica:** o campo `users.role = 'admin'`. Não há tabela `platform_access`, nem papel de plataforma
   separado (`platformAccess.tsx` o declara: "não existe um sistema de papéis de plataforma separado").
2. **Como é imposto:** `requirePlatformAdmin(userId)` relê `users.role` **no banco** e lança `PlatformAccessError` (→ 403).
   Está **presente em todos os 13 endpoints de plataforma auditados** (grep: `platform-organizations(_GET|-status_POST)`,
   `platform-automation-controls_POST`, `background-tasks(_GET|-retry_POST)`, `sources(_GET|_POST)`,
   `opportunity-registry(_GET|_POST|-status_POST|-match_POST)`, `audit-log-verify_GET`, `match-evaluations_GET`).
   O frontend (`AdminRoute`, botão "Operação de plataforma") é só conveniência — **a autorização é backend-enforced**
   (IMPLEMENTADO/VERIFICADO; testes de 403 por papel em `permissions`/`crossOrgIsolation`/`needFulfillment*`).
3. **Não depende de e-mail, de "primeiro usuário", de segredo compartilhado nem de hardcode:** nenhum desses existe no
   código (grep de `role: "admin"`, `'admin'` em `src`, `server`, `db`). Cadastro público **sempre** cria `role: "user"`;
   **nenhum endpoint altera `users.role`** — não há privilege escalation pela API (confirmado por busca de todos os
   `updateTable("users")`). Membership de organização (`memberships.role`) é independente de `users.role`.
4. **Como alguém vira admin:** somente por `UPDATE users SET role='admin'` direto no banco, ou pelo seed sintético de
   staging (`db/seedStaging.ts:451`, protegido por `seedStagingGuard.ts` com 3 evidências positivas de ambiente). **Não
   existe procedimento documentado nem script para criar o primeiro admin em produção** (nenhuma menção em
   `DEPLOYMENT*.md`/`OPERATIONS.md`) → **NÃO CONFIRMADO** como o primeiro admin real é criado.
5. **Quantos admins podem existir:** o sistema **não limita** (nenhuma constraint/regra). "Único admin" é, hoje, uma
   circunstância operacional, não uma regra.

**Conclusão objetiva: NÃO existe hoje uma identidade administrativa exclusivamente controlada pelo proprietário da
plataforma.** Existe um *papel* (`users.role='admin'`) imposto corretamente no backend, mas (a) ele pertence a uma conta
comum, do mesmo subsistema do cliente, **sem MFA**, **sem verificação de e-mail**, sujeita ao bloqueio por e-mail
(DoS de login), e (b) nada impede que a conta seja excluída via LGPD (ver P-3, P-4) nem garante procedimento de criação.

### 1.3 Fluxo atual de conta ↔ organização

`register_with_password` cria **só** `users` + `user_passwords` (sem sessão, sem organização, sem membership). Depois de
entrar, o usuário chama `organizations_POST`, que cria a organização (`status='em_analise'`) + membership `proprietario`
+ auditoria `organizacao.criada`; a plataforma aprova (`platform-organizations-status_POST`). Convite
(`organization-invites-accept_POST`) **exige conta já existente e logada**, com `user.email == invite.email` (comparação
case-insensitive) + token de 32 bytes: aceitar cria/reativa a membership. `docs/ACCESS_CODES.md` confirma: **o "código de
acesso" da seção 9 do master prompt NÃO EXISTE**; é uma lacuna real. Frontend: `/login` já tem as abas **Entrar** e
**Criar conta** (`login.tsx`, `PasswordLoginForm`, `PasswordRegisterForm`); `/plataforma` protegido por `AdminRoute`.

---

## 2. Problemas encontrados

Classificação: **C** crítico · **I** importante · **M** melhoria.

| # | Sev. | Problema |
|---|---|---|
| P-1 | C | **Cadastro público aberto**: qualquer pessoa cria conta (viola ID-2). |
| P-2 | C | **Conta de plataforma sem MFA** e do mesmo subsistema do cliente; um vazamento de senha dá `/plataforma` (fontes, organizações, registro central, tarefas). |
| P-3 | C | **Admin pode se autoexcluir** (`account-delete` não olha `role`): a plataforma pode ficar sem admin; e a anonimização **mantém `role='admin'`** na linha anonimizada (admin "zumbi", sem senha/sessão — inerte, mas incorreto). |
| P-4 | C | **Sem procedimento de criação do primeiro admin** em produção (só SQL manual); sem trilha de auditoria de promoção. |
| P-5 | I | **E-mail não verificado**: o convite compara só `email` (protegido pelo token); um cadastro pode "reservar" o e-mail de outra pessoa. Impede tratar e-mail como prova em qualquer vinculação futura. |
| P-6 | I | **Bloqueio de login por e-mail** (5 falhas/15 min) é um vetor de DoS contra o dono da plataforma (qualquer um trava o login dele de qualquer IP). |
| P-7 | I | **Nenhum evento de auditoria de login/logout/sessão**; `login_attempts` não guarda IP. |
| P-8 | I | `user_passwords` sem `UNIQUE(user_id)` (login ambíguo se duplicar); sem teto de 72 bytes (senhas longas truncadas em silêncio). |
| P-9 | I | `sessions.expires_at` não é imposto; sem rotação de id em mudança de privilégio; sem IP/UA; sem expiração absoluta separada da deslizante (a sessão renova a cada `session_GET`). |
| P-10 | I | Sem logout global / revogação / troca de senha / recuperação (parte existe só como trabalho não commitado). |
| P-11 | I | Rate limit em memória: aceitável em 1 instância; **não** serve para limites de segurança que precisam sobreviver a reinício (tentativas de TOTP). |
| P-12 | M | Ordem de locks hoje diverge entre `account-delete` (orgs → memberships → senha → sessões → users) e o que as novas operações de credencial precisam (ver §12, regra L1). |
| P-13 | M | Mensagem de erro de validação do registro devolve o texto cru do Zod (já documentado como dívida). |

---

## 3. Arquitetura alvo (visão geral)

```
                          ┌──────────────────────────── users (identidade interna: user.id) ───────────────────────────┐
                          │  email (atributo, único, não é chave de identidade externa)   role ('admin' | 'user')       │
                          └─┬───────────────┬────────────────────┬──────────────────────┬─────────────────┬────────────┘
                            │               │                    │                      │                 │
                     user_passwords   user_identities      mfa_methods(totp)     mfa_recovery_codes   user_passkeys (futuro)
                     (0..1 por user)  (google|microsoft|    (0..1 ativo)          (lote ativo)
                                       apple) UNIQUE(provider,issuer,subject)
                            │
   sessions  ← única origem de sessão plena (todo método termina aqui)      auth_challenges ← estado "autenticação parcial"
   (existente, estendida)                                                   (NUNCA vira linha em sessions até concluir)

   registration_access_codes (provisionamento)  ──consumido atomicamente com──►  users.registered_via_code_id (UNIQUE)
   signup_attempts (estado servidor do cadastro social, c/ state/nonce/PKCE)
   password_reset_tokens (futuro, depende de SMTP)       audit_log (existente, hash-chain)
```

Princípios: (1) `user.id` é a identidade; métodos de login são atributos da conta; (2) **uma única definição de sessão
plena** — o estado parcial vive em outra tabela, então nenhum endpoint existente (`getServerUserSession`) pode ser
enganado por sessão "meio autenticada"; (3) provisionamento (código) e autenticação recorrente são trilhas separadas;
(4) toda decisão de segurança no backend/banco; (5) sem novas dependências de infraestrutura — `jose` (já presente) valida
JWT/JWKS e assina o client secret da Apple; TOTP e hashing via `node:crypto`; e-mail via `nodemailer` já presente.

---

## 4. Modelo de dados conceitual (entidades, constraints, índices)

> Nomes finais podem variar na implementação; a separação de responsabilidades e as constraints **não**.

### 4.1 `users` (existente) — mudanças futuras
- `registered_via_code_id INTEGER NULL UNIQUE REFERENCES registration_access_codes(id)` — prova no banco "1 código → no
  máximo 1 usuário" (independente do UPDATE condicional). NULL para usuários anteriores ao gating e para o admin
  (bootstrap).
- `email_verified_at TIMESTAMPTZ NULL` (preparação; preenchido por provedor com e-mail verificado ou pelo futuro SMTP).
- **[SUBSTITUÍDO → §25.1]** ~~`role` permanece como única fonte da autorização de plataforma (D-1)~~. `users.role='admin'` é o modelo
  *atual/transitório*; o definitivo é `platform_access`. (texto original:) `role` permanece (`'admin'|'user'`) como **única** fonte da autorização de plataforma (decisão D-1): não criar tabela de
  papéis paralela agora; multiplicidade futura de admins já é suportada (nada limita a 1 no schema). **A política "um
  admin principal" é imposta pelo procedimento de bootstrap (§8), não por constraint** — assim múltiplos admins no futuro
  não exigem mudar o modelo.

### 4.2 `user_passwords` — `UNIQUE(user_id)` (migration futura; auditar duplicatas antes). Ausência de linha = conta
sem senha local (social-only). **A API não pode pressupor senha** (hoje `account-delete` devolve 400 "não foi possível
confirmar sua senha" para quem não tem; a reconfirmação precisa ser generalizada — §10.3).

### 4.3 `user_identities` (identidades externas)
```
id BIGSERIAL PK
user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE
provider TEXT NOT NULL CHECK (provider IN ('google','microsoft','apple'))
issuer TEXT NOT NULL            -- ex.: https://accounts.google.com | https://appleid.apple.com | https://login.microsoftonline.com/{tid}/v2.0
subject TEXT NOT NULL           -- claim "sub" (ou oid — ver §7.2)
email_snapshot TEXT NULL        -- último e-mail informado pelo provedor (atributo, nunca chave)
email_verified BOOLEAN NOT NULL DEFAULT false
is_private_relay BOOLEAN NOT NULL DEFAULT false   -- Apple
created_at, last_used_at TIMESTAMPTZ
UNIQUE (provider, issuer, subject)       -- INVARIANTE: uma identidade externa pertence a um único usuário
INDEX (user_id)
```
Metadados mínimos: nenhum token de acesso/refresh é armazenado (o LEVORA só usa o provedor para **autenticar**, não para
chamar APIs do provedor).

### 4.4 `mfa_methods`
```
id, user_id FK, type ('totp' | futuro 'webauthn'), status ('pending'|'active'|'disabled')
secret_ciphertext BYTEA, secret_key_id SMALLINT     -- AES-256-GCM, chave MFA_ENCRYPTION_KEY (env), versão p/ rotação
algorithm 'SHA1', digits 6, period 30                -- máxima compatibilidade com Google/Microsoft Authenticator
created_at, confirmed_at, last_used_at
last_used_step BIGINT NULL      -- último time-step aceito (anti-replay: aceitar só step > last_used_step)
failed_attempts INT, locked_until TIMESTAMPTZ NULL   -- persistidos no banco (sobrevivem a reinício)
UNIQUE (user_id) WHERE status IN ('pending','active')   -- no máximo 1 TOTP em configuração/ativo
```
O segredo precisa ser recuperável (valida-se HMAC com ele) ⇒ **cifrado em repouso**, nunca em texto puro nem em log.

### 4.5 `mfa_recovery_codes`
`id, user_id FK, batch_id UUID, code_hash BYTEA UNIQUE, used_at NULL, created_at`. 10 códigos por lote, 80 bits cada
(formato `XXXX-XXXX-XXXX-XXXX` Crockford), armazenados como **HMAC-SHA256 com pepper** (alta entropia ⇒ hash rápido
é adequado). Consumo = `UPDATE ... SET used_at=now() WHERE id=? AND used_at IS NULL` (rowcount 1 ou recusa). Regenerar =
transação que invalida o lote anterior (`DELETE`/marca) e cria o novo.

### 4.6 `sessions` (existente, estendida — **mesmo mecanismo**, sem segundo sistema)
Colunas novas: `primary_method TEXT` (`password|google|microsoft|apple|passkey`), `mfa_verified_at TIMESTAMPTZ NULL`,
`last_reauth_at TIMESTAMPTZ NULL`, `user_agent_hash`/`ip_prefix` opcionais (diagnóstico, nunca decisão). `expires_at`
passa a ser **imposto na leitura** (P-9). Cookie e JWT permanecem como estão (nome, flags).

### 4.7 `auth_challenges` (autenticação parcial)
`id` (hash do segredo opaco; o cookie `levora_challenge` HttpOnly/Secure/SameSite=Lax/Path=/_api/v1/auth, TTL 5 min),
`user_id`, `kind` (`mfa_required` | `mfa_enroll_required`), `primary_method`, `expires_at`, `consumed_at`, `attempts`.
**Uma `auth_challenge` jamais concede acesso a endpoint de dados**; só habilita os endpoints `/auth/mfa/*` de verificação
ou de inscrição. Concluída ⇒ cria a linha em `sessions` e consome o challenge (transação).

### 4.8 `registration_access_codes` (§6)
```
id BIGSERIAL PK
code_hash BYTEA NOT NULL UNIQUE          -- HMAC-SHA256(pepper, código normalizado)
code_last4 TEXT NOT NULL                 -- máscara operacional "LEV-••••-••••-••••-••••-AB12"
label TEXT NULL
created_by_user_id INT NOT NULL REFERENCES users(id)   -- admin da plataforma
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
expires_at TIMESTAMPTZ NOT NULL
revoked_at TIMESTAMPTZ NULL, revoked_by_user_id INT NULL
redeemed_at TIMESTAMPTZ NULL, redeemed_by_user_id INT NULL
organization_id INT NULL                 -- reservado p/ extensão futura (§6.9); ignorado na v1
CHECK ((redeemed_at IS NULL) = (redeemed_by_user_id IS NULL))
CHECK (NOT (redeemed_at IS NOT NULL AND revoked_at IS NOT NULL))
CHECK (expires_at > created_at)
INDEX (created_at DESC), INDEX (expires_at) WHERE redeemed_at IS NULL AND revoked_at IS NULL
```
Status é **derivado** no servidor (não armazenado): `utilizado` (redeemed_at), `revogado` (revoked_at), `expirado`
(`now() >= expires_at`), senão `ativo` — evita estado divergente e a necessidade de job de expiração.

### 4.9 `signup_attempts` (cadastro social, estado servidor)
`id`, `access_code_id FK`, `state_hash`, `nonce_hash`, `pkce_verifier_ct` (cifrado), `provider`, `binding_hash`
(hash do cookie de vínculo do navegador), `status` (`started` → `identity_verified` → `completed`|`expired`|`failed`),
`verified_provider/issuer/subject`, `verified_email`, `verified_email_flag`, `suggested_display_name`, `expires_at`
(15 min), `created_at`, `ip_prefix`. **Não** reserva/queima o código.

### 4.10 `password_reset_tokens` (futuro, §11.4) · `user_passkeys` (futuro, §14)

---

## 5. Fluxo de cadastro e login

### 5.1 Cadastro (código obrigatório — ID-2/3/5/7)
```
/login → aba "Criar conta"
   │  (1) campo "Código de acesso"
   ▼
POST /auth/signup/code-check  ── rate limit IP ──► valida (hash lookup, ativo?) ► resposta genérica
   │  ok → cria signup_attempt(started) + cookie levora_signup (binding, HttpOnly, 15 min)
   │       (NÃO consome o código; NÃO reserva)
   ▼
(2) escolher método: senha | Google | Microsoft | Apple
   ├── senha:  POST /auth/signup/complete-password {nome, e-mail, senha}
   └── social: GET  /auth/oauth/{provider}/start?intent=signup  → redirect ao provedor → callback (§7)
   ▼
(3) TRANSAÇÃO ÚNICA (§6.6):  revalida código + cria users (+ senha | + identity) + consome código + audita
   ▼
(4) cria sessão (ou challenge MFA se aplicável — conta nova não tem MFA) → app
```
O **código nunca é lido do navegador na etapa final**: o servidor recupera `access_code_id` do `signup_attempt` ligado ao
cookie de vínculo. Cadastro por senha usa o mesmo `signup_attempt` (uniformidade; sem caminho paralelo).

### 5.2 Login recorrente (sem código — ID-8)
```
[Método primário: senha | Google | Microsoft | Apple]
   │ valida credencial / id_token
   ▼
 conta existe e método vinculado?  ── não ──► resposta neutra ("não foi possível entrar") — NÃO cria conta
   │ sim
   ▼
 conta tem MFA ativo (ou é admin)?
   ├── não ─► cria sessão plena
   └── sim ─► cria auth_challenge ─► POST /auth/mfa/verify {TOTP | recovery} ─► cria sessão plena (mfa_verified_at)
```
Estados explícitos no backend: `primary_authenticated` (= existe `auth_challenge`, **sem** sessão), `mfa_required`
(= `auth_challenge.kind='mfa_required'`), `fully_authenticated` (= linha em `sessions`). Não é escondido na UI.

### 5.3 Matriz "o que um login social faz"
| Situação | Resultado |
|---|---|
| `(provider,issuer,subject)` já vinculado | login (+ MFA se houver) |
| identidade nova **com** `signup_attempt` válido | finaliza cadastro (§5.1) |
| identidade nova **sem** tentativa de cadastro | **não cria conta**; mensagem neutra "nenhuma conta vinculada — para criar conta, use um código de acesso" |
| e-mail do provedor igual ao de um `users.email` existente | **nunca vincula**; no cadastro: conflito neutro (§9.4) |

---

## 6. Códigos de acesso

### 6.1 Formato e entropia
`LEV-XXXX-XXXX-XXXX-XXXX-XXXX` — 20 caracteres Crockford base-32 = **100 bits** de `crypto.randomBytes`. Sem contador,
data, id ou sequência. Normalização na entrada: maiúsculas, remove espaços/hífens, `I,L→1`, `O→0`. Inviável de adivinhar
(2¹⁰⁰) mesmo antes do rate limit; o rate limit existe contra abuso/fuzzing, não como única defesa.

### 6.2 Armazenamento e localização
O valor bruto é **mostrado uma única vez** na criação (modal com "copiar"; nunca reexibido). No banco: `code_hash =
HMAC-SHA256(ACCESS_CODE_PEPPER, normalizado)` + `code_last4` (máscara) + `label`. Localização = `WHERE code_hash = $1`
(índice único; busca por igualdade, sem comparação de string em texto puro). O pepper é segredo de ambiente (como
`JWT_SECRET`); vazamento só do banco não permite forjar códigos.

### 6.3 Duração (decisão do admin; decidida **pelo servidor**)
O admin escolhe: minutos / horas / dias (presets 1 h, 24 h, 7 d, 30 d) **ou** data/hora absoluta; mínimo 5 min, máximo
90 dias (política ajustável). Tudo em **UTC** (`timestamptz`); a UI mostra o horário local e o tempo restante calculado
no cliente **só para exibição**. Limite exato: válido ⇔ `now() < expires_at` (no instante `expires_at` já é inválido).
"Expirar agora" = **revogar**. O cálculo de `expires_at` a partir da duração é feito no servidor (`now() + interval`).

### 6.4 Estados (derivados)
`ativo` → (`utilizado` | `expirado` | `revogado`). Terminais e mutuamente exclusivos (constraints de §4.8).

### 6.5 Validar ≠ consumir (ID-5)
`code-check` apenas confirma que o código **está utilizável agora** e abre o `signup_attempt`. Nada é gravado no código.
Múltiplas tentativas em andamento podem coexistir; a corrida é resolvida **só** no consumo (§6.6). Trade-off aceito: quem
perde a corrida só descobre ao concluir (mensagem "código já utilizado"). Alternativa documentada e **não** adotada na v1:
reserva temporária (`reserved_by_attempt/reserved_until`) — evita fluxo desperdiçado mas permite bloquear um código ao
iniciar tentativas.

### 6.6 Consumo atômico (a estratégia)
Uma única transação (nível READ COMMITTED basta; a barreira é a linha):
```
BEGIN;
  -- 1) bloqueios por usuário/e-mail conforme §12 (ordem canônica)
  -- 2) INSERT users (... registered_via_code_id = :code_id)  [+ user_passwords | user_identities]
  -- 3) UPDATE registration_access_codes
        SET redeemed_at = now(), redeemed_by_user_id = :new_user_id
      WHERE id = :code_id
        AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING id;
      → 0 linhas ⇒ ROLLBACK de tudo (nenhum usuário, identidade ou senha é criado)
  -- 4) auditoria (por último: o audit_log toma lock global da hash-chain)
COMMIT;
```
Camadas: (a) **UPDATE condicional** — o Postgres serializa dois UPDATEs na mesma linha; o segundo reavalia o `WHERE` com a
linha já confirmada e afeta 0 linhas; (b) **`users.registered_via_code_id UNIQUE`** — mesmo que a lógica falhe, o banco
rejeita um 2º usuário com o mesmo código (violação 23505 ⇒ rollback); (c) **checks** de §4.8; (d) **UNIQUE em
`user_identities(provider,issuer,subject)` e em `LOWER(users.email)`** — barram identidade/e-mail duplicados. Nunca
`SELECT` + `IF` + `UPDATE` sem a condição no `WHERE`. Controle só no frontend não conta.

### 6.7 Anti-enumeração e rate limit
Respostas públicas para código inexistente/expirado/revogado/utilizado são **idênticas** ("código inválido ou
indisponível") — tempo equalizado (sempre HMAC + 1 consulta). O admin vê o motivo detalhado **só em `/plataforma`**.
Limites (§13): 10 tentativas/15 min por IP no `code-check`; adicionalmente contagem por `signup_attempt`/cookie e teto
global de falhas/hora (alarme). Falha **não** revela se o formato era válido.

### 6.8 Compartilhamento (cenário §14 do brief)
A recebe e repassa a B. A conclui primeiro → A criado, código `utilizado`. B, ao concluir (mesmo tendo autenticado no
provedor), recebe "código inválido ou indisponível" e **nenhum** usuário/identidade é criado para B (rollback).

### 6.9 Vínculo futuro com organização
`organization_id` (e, se necessário, `grants JSONB`) reservados e **ignorados na v1**: v1 = "código → cadastro geral".
O fluxo atual (usuário cria organização depois, `em_analise`, aprovada pela plataforma) **não muda**. Um código ligado a
organização só será segura se o consumo também criar a membership **na mesma transação** e respeitar o RBAC; fica como
extensão com decisão própria.

### 6.10 Painel `/plataforma` (especificação; **não** implementar agora)
Gerar (1 ou lote até 50; label; validade; exibe/copia **uma vez**), listar com filtros (status, label, período, criador),
busca por label/últimos 4, colunas (criado, expira + tempo restante local, status, utilizado em/por, revogado em/por),
revogar (confirmação + reauth), histórico. Endpoints sob `requirePlatformAdmin` + **reauth recente** (§8.4).

---

## 7. Provedores externos (OIDC) — Fases futuras

Mecânica comum (servidor, **sem** SDKs externos; `jose` já presente): fluxo **authorization code** no servidor
(confidential client), `state` (≥128 bits) + `nonce` + **PKCE S256** (Google/Microsoft; Apple aceita nonce, PKCE opcional),
URI de callback fixa `${APP_PUBLIC_URL}/_api/v1/auth/oauth/<provider>/callback` (registrada no provedor, HTTPS), troca
do `code` por `id_token` no **back-channel**, validação do `id_token`: assinatura via JWKS do provedor
(`createRemoteJWKSet`, com cache), `iss` exato, `aud` = nosso client_id, `exp`/`iat` (tolerância ≤ 60 s), `nonce` igual ao
da tentativa, `sub` presente. Nada vindo do navegador é aceito como prova (nem e-mail, nem "user info"). Tokens de
acesso/refresh **descartados** (não persistidos, não logados). Anti-replay: `state` de **uso único** (consumido na
primeira resposta; replay do callback ⇒ rejeitado) e `signup_attempt/login_attempt` com TTL curto.

Estado entre o redirect e o callback (**sem** confiar em parâmetro do frontend): `state` aponta para uma linha servidor
(`signup_attempts` p/ cadastro; tabela análoga `oauth_login_attempts` p/ login/vinculação) contendo `nonce`, `verifier`,
`intent` (`login|signup|link`), `access_code_id` (cadastro) ou `user_id` (vinculação) — o código **nunca** trafega na URL.

**Callback em duas etapas** (resolve o `form_post` da Apple e é seguro para todos):
1. `GET|POST /auth/oauth/<p>/callback` — **não depende de cookie** (a Apple faz POST cross-site; `SameSite=Lax` não envia
   cookie nesse POST): localiza a tentativa por `hash(state)`, valida tudo acima, grava a identidade verificada na tentativa
   (`identity_verified`) e responde **303** para `/cadastro/concluir` (ou `/login/concluir`, `/conta/vincular/concluir`).
2. `POST /auth/oauth/finalize` (same-site, com cookie de vínculo `levora_signup`/sessão): confere o `binding_hash`, revalida
   o código e executa a **transação do §6.6** (cadastro) / login / vínculo. Assim o callback sozinho não cria nada e uma
   resposta externa roubada/reencaminhada por outro navegador não finaliza (falta o cookie de vínculo).

### 7.1 Google — `issuer = https://accounts.google.com` (aceitar também `accounts.google.com` sem esquema, conforme o
discovery); `subject = sub` (estável, único); `email`/`email_verified` do `id_token` (somente `email_verified=true` conta
como verificado); escopos `openid email profile`; JWKS `https://www.googleapis.com/oauth2/v3/certs`. Não usar `hd` como
identidade.

### 7.2 Microsoft — authority **`https://login.microsoftonline.com/common/v2.0`** (aceita contas pessoais **e**
corporativas/escolares). O `iss` do `id_token` varia por tenant: `https://login.microsoftonline.com/{tid}/v2.0`; contas
pessoais usam o tenant fixo `9188040d-6c67-4c5b-b112-36a304b66dad`. Regra: validar `iss == https://login.microsoftonline.com/{tid}/v2.0`
com `tid` do próprio token (e `tid` na allowlist de política, se um dia restringirmos tenants). Identidade externa:
`provider='microsoft'`, `issuer = https://login.microsoftonline.com/{tid}/v2.0`, `subject = sub` (único por usuário **por
aplicação**; estável enquanto o registro do app não for substituído). **[FECHADO → §25.8]** `subject = sub` validado; `oid`/`tid` ficam só como `provider_metadata`. **Importante:** o claim `email` da Microsoft **não é
garantido verificado** (classe de ataque "nOAuth"): **tratar sempre `email_verified=false`** e nunca usar para
vincular/promover.

### 7.3 Apple — `issuer = https://appleid.apple.com`, `subject = sub` (estável por *team*), `aud` = **Services ID**
(client_id web), JWKS `https://appleid.apple.com/auth/keys`. `client_secret` é um **JWT ES256 assinado com a chave
privada .p8** (kid + team id; validade ≤ 6 meses; gerar por requisição/curta duração com `jose`) — a chave privada só vive
em variável de ambiente/arquivo de segredo, nunca no banco/log/audit. `response_mode=form_post` é obrigatório ao pedir
`name`/`email` ⇒ callback por **POST cross-site** (§7, etapa 1). **Nome e e-mail vêm só na primeira autorização** (o nome
chega num campo `user` do POST — controlado pelo navegador ⇒ tratar como **não confiável**, apenas sugestão de exibição;
o e-mail confiável é o do `id_token`). Em logins seguintes podem não vir — **não pressupor**. `is_private_email` /
`@privaterelay.appleid.com`: e-mail legítimo do provedor, **sem regra especial** de rejeição; gravar
`is_private_relay` só informativo. Se o nome se perder, o passo `/cadastro/concluir` pede o nome ao usuário. Requer
HTTPS e domínio verificado (não funciona em `localhost` ⇒ teste de integração real só em staging).

### 7.4 Conta social sem senha
Permitida (`user_passwords` ausente). Nada gera senha automática. "Definir senha" ≠ "Trocar senha" (§10.3).

---

## 8. Administrador da plataforma (Platform Owner)

### 8.1 Modelo  **[SUBSTITUÍDO → §25.1: `platform_access` (owner | admin) em vez de `users.role`]**
Mantém-se `users.role='admin'` imposto por `requirePlatformAdmin` (decisão D-1; backend-enforced, relido do banco).
**Não** existe login universal, senha fixa, e-mail hardcoded, token compartilhado ou chave mestre. O admin é um **usuário
real** do mesmo subsistema, com métodos próprios (senha ou social) e **MFA obrigatório**.

### 8.2 Criação (bootstrap) — fora do fluxo normal  **[REFINADO → §25.2: token de ativação por hash, `platform_bootstrap_tokens`, `platform_access`]**
Script operacional offline (`npm run platform:bootstrap-admin -- --email <e-mail>`), executado por quem tem acesso ao
servidor/banco (o proprietário), que: recusa se já houver admin ativo (política "um principal"; `--allow-additional`
explícito e auditado para o futuro); cria/promove o `users` (`role='admin'`, `registered_via_code_id NULL`); **não define
senha**: gera um **link de ativação de uso único** (token 256 bits, hash no banco, TTL 30 min) para o proprietário definir
a credencial e **inscrever o TOTP** no primeiro acesso; escreve evento de auditoria `plataforma.admin_provisionado`
(`actor` = NULL/sistema, `metadata: {via:'cli'}`). Nenhum endpoint HTTP cria/promove admin; cadastro público e códigos de
acesso **só** criam `role='user'` (constraint de código: o INSERT do fluxo de cadastro fixa `role='user'`).

### 8.3 MFA obrigatório e proteção
- Login de admin sem TOTP ativo ⇒ `auth_challenge(kind='mfa_enroll_required')`: o único caminho é concluir a inscrição
  (§10.1) — **jamais** existe sessão de admin sem MFA (em produção; `PLATFORM_MFA_REQUIRED=false` só em staging).
- Não é permitido desativar/remover o único segundo fator de um admin (a operação é recusada).
- **[SUBSTITUÍDO → §25.3: titular de `platform_access` ativo não exclui conta; owner só após transferência]** Admin **não pode** excluir a própria conta (nem rebaixar-se) se for o último admin; anonimização passa a **zerar
  `role`** (corrige P-3).
- **[SUBSTITUÍDO → §25.15: 60 min ocioso / 8 h absoluto]** Sessões de admin: expiração deslizante curta e absoluta limitada (propostas: ociosa 2 h, absoluta 12 h → **O-2**),
  listagem/revogação disponíveis, cookie igual (mesmo mecanismo).
- Lockout: o bloqueio de login do admin **não** pode ser ativado por terceiros (P-6) — chave `e-mail+IP`/degradação
  progressiva e alerta, em vez de bloqueio global por e-mail.
- Auditoria completa (§15).

### 8.4 Reautenticação (step-up)
`requireRecentAuth(maxAgeSeconds)`: exige `sessions.last_reauth_at` recente (padrão 10 min); caso contrário 403 com
`code: "reauth_required"` e a UI pede TOTP (e senha, se o admin tiver). Obrigatório para: criar/revogar código de acesso,
promover/rebaixar admin, alterar MFA/credenciais do admin, alterar status de organização, controles de automação da
plataforma, retentar tarefas, qualquer ação destrutiva futura. Leituras (`GET`) não exigem.

### 8.5 Separação de autoridades
| Papel | Origem | Alcance |
|---|---|---|
| **Platform Owner/Admin** | `users.role='admin'` (bootstrap) | `/plataforma`, endpoints `requirePlatformAdmin`, códigos de acesso. **Não** concede acesso a dados de organização (precisa de membership). |
| **Organization Owner** (`proprietario`) | `memberships.role` | dentro de **uma** organização (todas as permissões RBAC). Nenhum efeito na plataforma. |
| **Organization Admin** (`administrador`) | `memberships.role` | subconjunto RBAC dentro de uma organização. |
| **Operador/Voluntário** | `memberships.role` | permissões nomeadas da organização. |
| **Usuário comum** | `users.role='user'` | só o que as memberships dão. |
Invariante: membership **nunca** concede privilégio de plataforma; `users.role='admin'` **nunca** concede privilégio
dentro de organização sem membership (comportamento atual, mantido).

---

## 9. Vinculação, remoção e conflitos de identidade

### 9.1 Vincular um método (usuário **autenticado**)
```
usuário logado ► "Minha conta → Adicionar Google" ► reauth (senha/TOTP/provedor existente, ≤ 10 min)
 ► oauth_attempt(intent=link, user_id) ► provedor ► callback ► finalize (cookie de sessão + binding)
 ► TRANSAÇÃO: lock users(row) ► INSERT user_identities (UNIQUE barra duplicata) ► audita ► (rotaciona sessão, revoga outras)
```
Nunca por e-mail igual. Se `(provider,issuer,subject)` já pertence a **outro** usuário ⇒ **conflito explícito**
(`identidade_ja_vinculada`, 409): **não** mescla, **não** move, **não** sobrescreve, **não** transfere.

### 9.2 Remover um método
Transação com lock da linha `users`: conta `métodos_primários_restantes = (senha?1:0) + count(identities) + count(passkeys)`;
**recusa se resultar em 0** (`ultimo_metodo`). MFA **não** conta como método primário. Remoção exige reauth e revoga
as outras sessões.

### 9.3 Definir vs trocar senha
`Definir senha` (não existe `user_passwords`): exige reauth por outro método (provedor/TOTP) — não há "senha atual";
`Trocar senha` (existe): exige senha atual **sempre**; mantém a sessão atual e revoga as demais (D-A1 da fase "Conta do
usuário"); ambos aplicam política (≥ 8, ≤ 72 bytes) e rotacionam o id da sessão atual.

### 9.4 Anti-enumeração nos conflitos  **[AJUSTADO → §25.9: e-mail verificado NÃO é requisito de criação social]**
Cadastro social cujo e-mail já pertence a outra conta: se o provedor afirmou `email_verified=true` (Google/Apple) o
usuário já provou posse do e-mail ⇒ pode-se informar "este e-mail já tem conta — entre com o método existente";
se não verificado (Microsoft) ⇒ resposta neutra genérica. Em nenhum caso a mensagem revela a quem pertence a identidade
externa ou se um código "já foi de alguém".

---

## 10. MFA (TOTP padrão — ID-11/12)

### 10.1 Ativação (nunca "QR gerado = ativo")
```
usuário autenticado (ou challenge mfa_enroll_required) ► reauth ► POST /auth/mfa/totp/begin
 ► servidor cria mfa_methods(status='pending') c/ segredo 160 bits (cifrado) e devolve otpauth://totp/Levora:<e-mail>?secret=…&issuer=Levora&algorithm=SHA1&digits=6&period=30
 ► UI mostra QR (render local) + chave manual ► usuário digita 6 dígitos
 ► POST /auth/mfa/totp/confirm ► valida (janela ±1 passo) ► TRANSAÇÃO: status='active', confirmed_at, gera recovery codes
   (exibidos UMA vez), rotaciona sessão, revoga outras ► audita
```
Código errado ⇒ continua `pending` (nada ativa); reiniciar `begin` substitui o `pending` (índice parcial único). RFC 6238,
SHA-1/6 dígitos/30 s = padrão que **Google Authenticator e Microsoft Authenticator** leem pelo mesmo QR/otpauth —
nenhuma integração proprietária. Implementação com `node:crypto` (HMAC) — sem dependência. O QR requer um gerador:
renderizar no cliente (SVG inline, sem mudar `img-src 'self'`) com **biblioteca pequena e mantida** (**[FECHADO → §25.12]**, sem encoder próprio).

### 10.2 Verificação no login e anti-replay
Aceita o passo atual e ±1 (30 s de tolerância de relógio); rejeita `step <= last_used_step` (replay do mesmo código);
`failed_attempts`/`locked_until` **persistidos no banco**; 5 falhas ⇒ bloqueio progressivo (1 → 5 → 15 min) e evento de
auditoria; sucesso zera. Verificação sob `SELECT … FOR UPDATE` da linha `mfa_methods` (serializa corridas).

### 10.3 Recovery codes
10 por lote, uso único, hash+pepper, exibidos só na ativação/regeneração (UI avisa "guarde agora"); usar um **consome o
código** e emite alerta ao usuário (e auditoria `mfa.recovery_code_usado` **sem** o valor); regenerar invalida o lote
anterior (transação). Usar recovery code **não** desativa o TOTP; recomenda-se reconfigurar. Nunca em log/audit/URL.

### 10.4 MFA do provedor ≠ MFA do LEVORA (ID, brief §31)
2FA no Google/Microsoft/Apple **não** satisfaz o MFA do LEVORA (política própria). Possível relaxamento futuro exige
decisão específica (claim `amr`/`acr` confiável) — **fora do escopo**.

### 10.5 Política
Usuários comuns: TOTP **disponível, opcional** (v1); modelo preparado para `required_by_org`/`required_by_role` futuros
(sem policy engine agora). Admin: **obrigatório** (§8.3).

---

## 11. Sessões, senha e recuperação

### 11.1 Sessão única (ID-9)
Todos os métodos terminam em `INSERT sessions` (mesmo cookie, mesma validação). `primary_method`/`mfa_verified_at`
registram **como** a sessão nasceu. Revogação = `DELETE` da linha (logout atual, "sair das outras", troca de senha,
alteração de método/MFA, exclusão de conta). Rotação do id em eventos de privilégio (login, ativar/desativar MFA, trocar/
definir senha, vincular/desvincular): cria nova linha/cookie e remove a antiga, preservando o `created_at` lógico.
`expires_at` imposto. Cookie: manter `HttpOnly; Secure; SameSite=Lax; Path=/` (sem `Domain` ⇒ host-only; nginx same-origin;
Cloudflare/nginx transparentes por `TRUST_PROXY`). Prefixo `__Host-` é possível numa troca coordenada de nome (invalida
todas as sessões) — **fora do escopo**, anotado como melhoria. CSRF: manter a análise de `docs/SECURITY.md` + exigir
`Origin` same-origin em POSTs de autenticação (defesa adicional); callbacks OAuth exigem `state` (CSRF de login).

### 11.2 Troca de senha
Senha atual obrigatória; nova senha ≥ 8 e ≤ 72 bytes e diferente; transação: lock senha → lock sessões → comparar → UPDATE →
**manter a sessão atual** e **revogar as demais**. (Existe implementada, **não commitada**, na fase "Conta do usuário".)

### 11.3 Logout / logout global — atual e "todas as outras" (idem acima) + "encerrar todas" (inclui a atual) para casos de
suspeita de comprometimento.

### 11.4 Recuperação de senha (futura; **bloqueada por SMTP** — ID-18/19)
`password_reset_tokens(id, user_id, token_hash UNIQUE, expires_at (≤ 30 min), used_at, requested_ip_prefix, created_at)`;
token 256 bits, **hash** no banco, uso único, **só o último token por usuário vale**; pedido sempre responde mensagem
neutra (nunca revela se o e-mail existe), 3/h por e-mail e 10/h por IP; concluir ⇒ define a senha, **revoga todas as
sessões** e eventuais tokens, audita e **não exige** MFA para redefinir mas **exige** MFA no próximo login. Contas
social-only usam o mesmo mecanismo como "definir senha" depois de reauth/prova de e-mail. Admin: recuperação **não** pode
contornar o MFA (recuperar senha ≠ recuperar acesso de admin — usa recovery code/ bootstrap offline). Envio via
`emailAdapter` quando houver SMTP; **sem fake**.

---

## 12. Concorrência

**Regras de lock (ordem canônica, evitam deadlock):** **L1** `organizations` → `users`(linha do usuário, `FOR UPDATE`) →
credenciais (`user_passwords`, `user_identities`, `mfa_methods`, `mfa_recovery_codes`, ordenadas por id) → `sessions`
(ordenadas por id) → `registration_access_codes` → `audit_log` (último; lock global). **L2** nenhuma chamada externa
(provedor, bcrypt de senha nova) dentro de transação com lock — hash e troca de `code` por token ocorrem **antes**.
**L3** a hash-chain de auditoria é sempre o último passo. (`account-delete` e a troca de senha atual deverão passar a
travar `users` primeiro — migração de comportamento na Fase 89.)

| ID | Cenário | Risco | Autoridade | Mecanismo | Resultado |
|---|---|---|---|---|---|
| A | Duas tentativas consomem o mesmo código | 2 contas | banco | UPDATE condicional `redeemed_at IS NULL` + `users.registered_via_code_id UNIQUE` | 1 sucesso; 2ª → "indisponível", rollback total |
| B | Google e senha com o mesmo código | idem, vias distintas | banco | mesma transação §6.6 em ambas | 1 vence |
| C | Google e Microsoft com o mesmo código | idem | banco | idem | 1 vence |
| D | Duas identidades externas criando o mesmo usuário (mesmo e-mail) | e-mail duplicado / usuário duplo | banco | `UNIQUE(LOWER(email))` + `UNIQUE(provider,issuer,subject)` ⇒ 23505 ⇒ rollback ⇒ conflito neutro | 1 usuário |
| E/F/G | Duas vinculações da mesma identidade Google/Microsoft/Apple | identidade em 2 usuários | banco | `UNIQUE(provider,issuer,subject)` + lock `users` do alvo | 1 vence; outra → `identidade_ja_vinculada` |
| H | Duas configurações de MFA simultâneas | 2 segredos ativos | banco | índice parcial `UNIQUE(user_id) WHERE status IN('pending','active')` + lock `users` | 1 `pending`; a outra substitui/recusa |
| I | Duas sessões alteram credenciais ao mesmo tempo | último-escreve-vence, hash perdido, remoção do último método | aplicação+banco | lock `users` (L1) serializa; recontagem de métodos sob o lock | serializadas; invariante "≥1 método" mantida |
| J | Admin revoga o código enquanto usuário o consome | consumo de código revogado | banco | UPDATE condicional exige `revoked_at IS NULL`; revogação é `UPDATE … WHERE redeemed_at IS NULL` | exatamente um dos dois vence; nunca "revogado e utilizado" (CHECK) |
| K | Callback OAuth replay / dois callbacks do mesmo `state` | duas finalizações | banco | `state` consumido por `UPDATE … WHERE status='started'` | 1 processa |
| L | Duas verificações TOTP com o mesmo código | replay | banco | `FOR UPDATE` + `step > last_used_step` | 1 aceita |
| M | Uso de recovery code em paralelo | reuso | banco | `UPDATE … WHERE used_at IS NULL` rowcount | 1 aceita |
| N | Login + revogação/ troca de senha | sessão sobrevive à troca | banco | revogação sob lock de sessões; login recria após commit | estado final consistente (sem sessão "fantasma") |

---

## 13. Rate limiting (coerente com a infraestrutura atual)

Mantém-se **em memória por processo** (suficiente enquanto houver 1 instância — `DEPLOYMENT_RUNBOOK.md`) para limites de
abuso. **Limites de segurança que precisam sobreviver a reinício/escala** (TOTP, recovery code, lockout de admin, `state`)
ficam **no banco** desde o dia 1. **Ponto de migração multi-instância:** extrair `checkRateLimit` para uma interface com
implementação em tabela `rate_limit_counters` (Postgres, `INSERT … ON CONFLICT DO UPDATE`), sem Redis.

| Operação | Limite proposto | Chave |
|---|---|---|
| `code-check` | 10 / 15 min (+ 5 falhas/ `signup_attempt`) | IP |
| conclusão de cadastro (senha) | 10 / h | IP (+ attempt) |
| `oauth/start` | 30 / 15 min | IP |
| `oauth/callback` (inválidos) | 20 / 15 min | IP |
| login senha | 20 / 15 min IP; bloqueio 5 falhas / 15 min por **e-mail+IP** (admin: progressivo + alerta) | IP, e-mail+IP |
| MFA verify | 5 falhas ⇒ bloqueio progressivo (banco) | usuário |
| recovery code | 5 / 15 min | usuário |
| iniciar/confirmar TOTP | 10 / h | usuário |
| vincular/desvincular | 10 / h | usuário |
| criar código (admin) | 30 / h (lote ≤ 50) | admin |
| trocar/definir senha | 5 / 15 min | usuário (já existe p/ `account-delete`) |
| pedir recuperação | 3 / h e-mail; 10 / h IP | e-mail, IP |

---

## 14. Passkeys (encaixe futuro, ID-17)
Tabela independente `user_passkeys(id, user_id FK, credential_id UNIQUE, public_key, sign_count, transports, created_at,
last_used_at, label)`. Conta como **método primário** na regra "≥ 1 método" (união senha ∪ identities ∪ passkeys) e pode
substituir senha+TOTP (WebAuthn com `userVerification`). `sessions.primary_method='passkey'`. Nada em `user_identities`
precisa mudar (passkey não é OIDC). RP ID = domínio; sem alteração de CSP além de `publickey-credentials-*` (a verificar).

---

## 15. Auditoria

Convenção existente: `dominio.acao_participio`; `organizationId` = NULL para eventos de usuário/plataforma; auditoria como
**último** passo da transação; **nunca** gravar senha, hash, segredo TOTP, recovery code, client secret, chave privada,
access/refresh/id token, cookie ou JWT. Para tentativa sem usuário identificável, gravar só `{motivo, ip_prefix}`.

`usuario.login_realizado{metodo}` · `usuario.login_falhou{metodo,motivo}` · `usuario.logout` ·
`usuario.sessoes_revogadas{quantidade}` · `usuario.sessao_revogada{handle}` · `usuario.senha_definida` ·
`usuario.senha_alterada{outrasSessoesRevogadas}` · `usuario.perfil_atualizado{campos}` ·
`usuario.identidade_vinculada{provider}` · `usuario.identidade_desvinculada{provider}` ·
`mfa.configuracao_iniciada` · `mfa.ativado` · `mfa.desativado` · `mfa.tentativa_falhou` · `mfa.recovery_code_usado` ·
`mfa.recovery_codes_regenerados` · `cadastro.concluido{via:'senha|google|microsoft|apple', codigoId}` ·
`codigo_acesso.criado{id,validade,label}` · `codigo_acesso.revogado{id}` · `codigo_acesso.consumido{id,usuarioId}` ·
`codigo_acesso.tentativa_invalida{motivo_interno,ip_prefix}` (agregável; amostrado p/ não inchar a cadeia) ·
`plataforma.admin_provisionado` · `plataforma.admin_credencial_alterada` · `usuario.conta_excluida` (existente).
`codigo_acesso.expirado` é **derivado** (sem job; sem evento por código — opcionalmente um evento diário agregado).
Falha de login passa a ser auditada (resolve P-7) com limite de volume (somente a 1ª falha por e-mail+IP/10 min).

---

## 16. Segurança — threat model e mitigação

| Ameaça | Mitigação |
|---|---|
| Adivinhar/enumerar códigos | 100 bits, HMAC com pepper, resposta única, rate limit por IP/attempt, alarme de falhas |
| Duplicar uso de código (corrida/compartilhamento) | §6.6 + `registered_via_code_id UNIQUE` |
| Bypass de código por login social | callback **não cria**; só `finalize` com `signup_attempt` válido + vínculo de navegador + consumo atômico |
| CSRF de login/OAuth, injeção de resposta de outro navegador | `state` servidor de uso único + `binding` cookie + nonce + PKCE |
| Token substitution / replay | validação `iss/aud/exp/nonce/sub`, `state` consumido uma vez |
| Account takeover por e-mail igual | **sem auto-link por e-mail**; e-mail é atributo; Microsoft sempre "não verificado" |
| Pré-sequestro (cadastrar e-mail alheio) | gating por código reduz; verificação de e-mail (SMTP) futura; social verificado preferido |
| Sessão roubada | HttpOnly/Secure/Lax, revogação, rotação, expiração imposta, MFA no login |
| Brute force de TOTP | limites no banco, anti-replay, bloqueio progressivo |
| Escalada para plataforma | `role` só por bootstrap offline; backend-enforced; MFA + step-up; auditoria |
| Lockout-DoS do admin | chave e-mail+IP/ progressivo, alerta (P-6) |
| Vazamento de segredos | segredos de MFA cifrados (AES-GCM); códigos/recovery só em HMAC; nada em log/audit; chave privada Apple só em env |
| Perda do TOTP | recovery codes; para o admin, bootstrap offline controlado |
| Enumeração de contas | respostas neutras em login/cadastro/callbacks/recuperação |

Risco residual aceito: o proprietário com acesso ao servidor/banco continua sendo a raiz de confiança (bootstrap offline);
mitigado por auditoria e hash-chain, não eliminado.

---

## 17. API (rotas futuras — **apenas especificadas**, prefixo `/_api/v1/auth/`)

`signup/code-check` (POST) · `signup/complete-password` (POST) · `oauth/{google|microsoft|apple}/start` (GET) ·
`oauth/{provider}/callback` (GET; Apple POST) · `oauth/finalize` (POST) · `login_with_password` (existente, + challenge) ·
`mfa/verify` (POST) · `mfa/totp/begin|confirm|disable` (POST) · `mfa/recovery/regenerate` (POST) ·
`reauth` (POST) · `identities` (GET) · `identities/link/start` (POST) · `identities/unlink` (POST) ·
`password-set` (POST) · `password-change` (POST) · `sessions` (GET) · `sessions-revoke` · `sessions-revoke-others` (POST) ·
`password-reset/request|complete` (POST, futuro).
Plataforma: `platform-access-codes` (GET) · `platform-access-codes-create` (POST) · `platform-access-codes-revoke` (POST) —
todos `requirePlatformAdmin` + `requireRecentAuth`. Convenção do projeto: um arquivo por rota + `.schema.ts`, superjson,
`buildErrorResponse`, `ApiRequestError` no cliente, mensagens neutras.

---

## 18. Frontend / UX (preview real obrigatório nas fases futuras)

`/login` mantém **Entrar** / **Criar conta** (já existe). **Entrar:** botões Google/Microsoft/Apple + e-mail/senha →
(se aplicável) etapa **MFA** (TOTP, link "usar código de recuperação"). **Criar conta:** passo 1 **"Código de acesso"**
(texto: "autoriza a criação da conta — não é a sua senha"), passo 2 método, passo 3 `/cadastro/concluir` (confirmar nome).
Estados: carregando, código inválido/indisponível (mensagem única), callback com erro/expirado, cadastro social,
MFA incorreto/bloqueado, recovery, sessão encerrada, conflito de identidade. Conta: métodos de login (adicionar/remover,
"definir senha" vs "trocar"), MFA (ativar, regenerar recovery), sessões. `/plataforma`: aba "Códigos de acesso" (§6.10) com
modal de reauth. Validar em desktop, 375, 390, tablet, claro/escuro, no preview interativo real (diretriz permanente).

---

## 19. Matriz de testes (futuras fases)

**Códigos:** válido · expirado (no limite `expires_at`: 1 ms antes/depois) · revogado · inexistente · utilizado ·
concorrência (A, B, C, J com `Promise.all` e conexões reais) · duas abas / duas máquinas · signup senha/Google/Microsoft/
Apple · callback replay / expirado / sem código · pepper ausente (falha segura).
**Identidade social:** nova · existente · subject duplicado · issuer diferente · `aud` errada · token expirado · nonce/
state incorretos/reusados · identidade já ligada a outro usuário · e-mail igual sem auto-link · Apple sem e-mail/nome no 2º
login · relay · Microsoft `tid` pessoal vs corporativo · **provedor simulado** (JWKS local) — nunca provedor real em CI.
**MFA:** ativar · código errado (permanece `pending`) · certo · relógio ±1 passo · fora da tolerância · replay do mesmo passo
· recovery (uso único, reuso recusado) · regenerar invalida antigos · remover o único fator do admin recusado · 5 falhas ⇒
bloqueio persistido (sobrevive a "reinício" simulado) · segredo cifrado em repouso (coluna ≠ segredo).
**Sessão:** login/logout · global · troca de senha (atual fica, outras caem) · identidade adicionada/removida ·
MFA falho **não** cria sessão · `auth_challenge` não passa em nenhum endpoint de dados · expiração imposta · rotação.
**Plataforma:** admin consegue · usuário comum/operador/proprietário de org/outro tenant não · chamada HTTP direta sem
cookie/ com cookie comum · reauth exigido · admin sem MFA não obtém sessão · cadastro/código não criam `role='admin'` ·
autoexclusão do último admin recusada.
**Invariantes de não regressão:** nenhum secret em `audit_log`/logs (varredura automatizada); mensagens neutras (teste de
enumeração por conteúdo **e** tempo, como `authEnumeration.test.ts`); "≥ 1 método de login" sob concorrência.

---

## 20. Invariantes (formais)
**Identidade:** I1 identidade interna = `users.id`. I2 `(provider,issuer,subject)` pertence a no máximo um usuário (UNIQUE).
I3 e-mail nunca é chave de identidade social nem causa de vínculo.
**Código:** C1 consumo ≤ 1 vez (UPDATE condicional + UNIQUE). C2 expirado/revogado nunca consumível. C3 código não autentica.
C4 código não é contornável por login social (callback não cria). C5 validar não consome; consumo e criação de conta são uma
transação.
**MFA:** M1 TOTP só ativa após código válido. M2 recovery code uso único. M3 conta sempre ≥ 1 método primário. M4 admin
sempre com MFA ativo para obter sessão.
**Plataforma:** P1 usuário comum nunca acessa plataforma (backend). P2 membership não concede plataforma. P3 nenhum caminho
público/HTTP cria ou promove admin.
**Sessão:** S1 sessão plena é a única linha de `sessions`; estado parcial vive em `auth_challenges`. S2 todo método usa o
mesmo mecanismo. S3 mudança de credencial revoga as outras sessões.
**Segredos:** X1 nenhum segredo (senha, TOTP, recovery, client secret, chave privada, tokens) em log/audit.

---

## 21. Decisões congeladas (ID-1…ID-20 + as tomadas nesta fase)

ID-1…ID-20 do brief permanecem integralmente. Adicionadas:
- **D-1** **[SUBSTITUÍDA → §25.1]** ~~`users.role='admin'` é a fonte da autorização de plataforma~~. Definitivo: `platform_access`.
- **D-2** Estado de autenticação parcial em `auth_challenges`, nunca em `sessions`.
- **D-3** Código: 100 bits, HMAC+pepper, consumo por UPDATE condicional + `users.registered_via_code_id UNIQUE`; sem reserva na v1.
- **D-4** Callback OAuth em duas etapas (callback não cria; `finalize` com cookie de vínculo cria).
- **D-5** TOTP SHA-1/6/30, segredo cifrado AES-256-GCM, anti-replay por `last_used_step`, contadores no banco.
- **D-6** Microsoft: authority `common`, sempre `email_verified=false`; Apple: `form_post`, nome/e-mail não confiáveis fora do `id_token`.
- **D-7** **[REFINADA → §25.2]** Primeiro Platform Owner por **bootstrap offline** com token de ativação de uso único (hash); nenhuma rota HTTP pública promove/cria owner.
- **D-8** Ordem canônica de locks L1–L3 (§12); `users` travado antes das credenciais.
- **D-9** Rate limit: memória p/ abuso; banco p/ limites de segurança persistentes; migração futura para tabela Postgres, sem Redis.
- **D-10** Sem novas dependências obrigatórias: `jose`, `node:crypto`, `nodemailer` bastam (QR: ver O-5).

## 22. Decisões abertas (realmente indefinidas após a investigação) — **TODAS FECHADAS na Fase 88.1 (ver §25.17)**
- **O-1** Convite de organização para pessoa **sem conta** (hoje exige conta prévia): continuará exigindo **código**
  (default seguro) ou o token do convite autoriza o cadastro do e-mail convidado? (Produto.)
- **[FECHADO → §25.15]** **O-2** Durações exatas de sessão do admin (ociosa 2 h / absoluta 12 h propostas) e de usuários comuns.
- **O-3** Microsoft: `subject = sub` ou `oid` (verificar empiricamente com tokens reais de conta pessoal e corporativa).
- **O-4** Exigir `email_verified=true` para cadastro social (recomendado) — implica Microsoft só entrar se o usuário
  confirmar o e-mail por outro meio (futuro SMTP) ou aceitar o e-mail do provedor sem verificação.
- **O-5** Gerador de QR do TOTP: pequena dependência de front-end vs. implementação própria (sem mudar CSP).
- **O-6** Gestão do `ACCESS_CODE_PEPPER` / `MFA_ENCRYPTION_KEY` (onde guardar/rodar) — operacional, antes da Fase 90.

## 23. Roadmap recomendado (ordem **alterada** em relação à sugestão do brief — justificativa)

A sugestão do brief começa pelos provedores sociais. **Recomendo inverter**: os maiores riscos *atuais* são P-1 (cadastro
aberto), P-2/P-3/P-4 (admin sem MFA/sem bootstrap/autoexclusão) — e os provedores sociais só são seguros **depois** que o
gating por código e a sessão "parcial" existirem (senão abrem exatamente o bypass que ID-7 proíbe).

| Fase | Conteúdo | Por quê nesta posição |
|---|---|---|
| **89** | **[escopo definitivo → §25.18]** **Fundação de sessão e credenciais**: `UNIQUE(user_id)` em senhas; teto 72 bytes; `expires_at` imposto; rotação de sessão; colunas de método/reauth; auditoria de login/logout; regra L1 de locks; (absorve **Conta do usuário**: troca de senha, perfil, listar/revogar sessões — já prototipada e não commitada); correção da autoexclusão/`role` do admin | tudo depende de sessão confiável e de auditoria |
| **90** | **TOTP + recovery codes + `auth_challenges` + step-up**; **bootstrap offline do Platform Owner com MFA obrigatório** | fecha P-2/P-3/P-4 (maior risco) antes de abrir qualquer porta nova |
| **91** | **Códigos de acesso + gating do cadastro por senha** (`signup_attempts`, consumo atômico, painel `/plataforma`) | fecha P-1 e cria o trilho que os sociais vão usar |
| **92** | Infra OIDC + **Google** (`oauth_*_attempts`, callback 2 etapas, `finalize`) | valida a arquitetura num provedor simples |
| **93** | **Microsoft + Apple** (tenant/`oid`, `form_post`, relay) | casos difíceis, reaproveitam 92 |
| **94** | **Account linking/unlinking, definir senha, recuperação de senha** (SMTP quando existir) | exige MFA, reauth e provedores prontos |
| **95** | Passkeys/WebAuthn (se mantiver prioridade) | independente; encaixe já reservado |
| **96** | Auditoria final de identidade (varredura de segredos, enumeração, concorrência, penetração dirigida) | fecha o ciclo |

## 24. Status da Fase 88 (original)
Especificação **completa**; **nenhum** código, schema, migration, endpoint ou componente foi alterado. Pendências de
produto listadas em §22. Nada neste documento afirma comportamento não verificado como existente (cf. legenda do topo).

---

## 25. DECISÕES CONGELADAS — FASE 88.1

> Esta seção **fecha** as decisões estruturais pendentes e **prevalece** sobre as seções 1–24 em caso de conflito.
> Continua sendo **somente especificação**: nenhum código, migration, dependência ou dado foi alterado.
> Itens marcados *(verificado)* foram conferidos contra o código em `HEAD a628bd4`.

### 25.1 Platform Access — separação USER × PLATFORM ACCESS (substitui D-1)

**Estado atual (verificado):** a autorização de plataforma é `users.role='admin'` lido por `requirePlatformAdmin`
(`src/helpers/platformAccess.tsx`); o `User` enviado ao cliente carrega `role` e o frontend usa `AdminRoute`/`_index.tsx`
com esse campo; o helper de testes `createPlatformAdmin` e o seed de staging também usam `users.role`. Isso permanece
**válido como estado atual**, mas **não é o modelo definitivo**: mistura "quem é a pessoa" com "que poder de plataforma
ela tem" e não consegue expressar *owner* × *admin* nem impor "exatamente um owner".

**Modelo definitivo** — o poder de plataforma é uma **concessão** separada da identidade:

```
users (identidade — nunca muda por ser owner/admin)
  └── platform_access   0..1 linha por usuário
        user_id            INT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT
        level              ENUM('owner','admin') NOT NULL
        status             ENUM('active','revoked') NOT NULL
        granted_at         TIMESTAMPTZ NOT NULL
        granted_by_user_id INT NULL REFERENCES users(id)      -- NULL = bootstrap pelo CLI
        bootstrap_token_id INT NULL REFERENCES platform_bootstrap_tokens(id)
        revoked_at, revoked_by_user_id, revoked_reason
        CHECK ((status='active') = (revoked_at IS NULL))

platform_state   (singleton)
        id                    SMALLINT PRIMARY KEY CHECK (id = 1)
        owner_bootstrapped_at TIMESTAMPTZ NULL      -- preenchido na 1ª ativação de owner; nunca volta a NULL
```

**Cardinalidade imposta no banco (não no frontend, não só em JS):**
1. `CREATE UNIQUE INDEX platform_access_single_active_owner ON platform_access ((1)) WHERE level='owner' AND status='active';`
   ⇒ **no máximo 1 Platform Owner ativo**. `OWNER A` + `OWNER B` é impossível mesmo sob concorrência (a 2ª escrita viola o índice).
2. **Constraint trigger `DEFERRABLE INITIALLY DEFERRED`** em `platform_access` (INSERT/UPDATE/DELETE) e em `platform_state`:
   se `owner_bootstrapped_at IS NOT NULL`, exige `count(owner ativo) = 1` **no COMMIT**. ⇒ **nunca 0 owners** depois do
   bootstrap, e a **transferência** de ownership (`owner→admin` do antigo e `admin→owner` do novo na **mesma transação**)
   é possível porque a verificação é no commit.
3. `DELETE` em `platform_access` é bloqueado por trigger (só `status='revoked'`); `ON DELETE RESTRICT` impede apagar o
   `users` referenciado (de qualquer forma `users` nunca é apagado: a LGPD anonimiza).
4. `users.role` **deixa de ser fonte de autorização**: após a migração, um trigger recusa `role='admin'` em INSERT/UPDATE de
   `users`; a coluna é mantida por compatibilidade e removida numa fase posterior de limpeza. O cliente passa a receber
   `platformLevel: 'owner'|'admin'|null` (e, por compatibilidade temporária, `role` calculado: `platformLevel ? 'admin':'user'`).

**Cardinalidade de produto:** `Platform Owner = 1` (índice), `Platform Admin = 0..N` (nenhum limite estrutural). O
**cadastro nunca** escreve em `platform_access` (§25.4). Todo `INSERT/UPDATE` de `platform_access` só ocorre em: (a) o
procedimento de bootstrap (§25.2); (b) concessão/revogação de *admin* por um **owner** com step-up, auditada (futuro);
(c) transferência de ownership (§25.3). Nunca por rota pública, cadastro, convite, organização, código ou login social.

**Poderes (decisão):**

| Capacidade | Owner | Admin |
|---|:--:|:--:|
| Acessar `/plataforma` e endpoints `requirePlatformAdmin` | ✔ | ✔ |
| Criar/revogar/consultar códigos de acesso | ✔ | ✔ |
| Conceder/revogar *Platform Admin* | ✔ | ✘ |
| Transferir ownership / emitir bootstrap de recuperação | ✔ (CLI offline p/ recuperação) | ✘ |
| Acessar dados de uma organização | só com membership (inalterado) | só com membership |

`requirePlatformAdmin(userId)` passa a consultar `platform_access` (`status='active'`) — **qualquer** nível; um novo
`requirePlatformOwner(userId)` cobre as operações só-owner. Ambos relêem o banco a cada requisição (comportamento atual
mantido) e, quando houver MFA, exigem sessão **plena** (§25.14).

**Migração (Fase 89, determinística, sem adivinhar):** criar `platform_access`/`platform_state`; *backfill* a partir de
`users.role='admin'`: **exatamente 1** ⇒ vira `owner` (`granted_by NULL`, `revoked_reason NULL`, nota
`migrated_from_users_role`) e `owner_bootstrapped_at=now()`; **0** ⇒ `owner_bootstrapped_at` fica NULL (exige bootstrap);
**> 1** ⇒ a migration **aborta com mensagem**, exigindo designação explícita do owner (parâmetro) — o sistema não escolhe.

> **Comportamento OFICIAL implementado (Fase 89/89.1) quando existirem 2 ou mais usuários com o legado `users.role='admin'`:**
>
> - **sem designação explícita:** a migration **aborta integralmente** (rollback total; nada é alterado);
> - **com designação explícita** (`PGOPTIONS="-c levora.platform_owner_user_id=<id>"`): o usuário designado recebe
>   `platform_access.level='owner'`; **os demais deixam de possuir acesso de plataforma e retornam ao estado de usuário
>   comum** (`users.role='user'`, sem linha em `platform_access`).
>
> **Nenhum admin legado adicional é convertido em Platform Admin automaticamente** (menor privilégio). Os ids dos admins sem
> acesso são listados num `NOTICE` da migration; o owner pode reconceder o nível *admin* depois, de forma auditada.
> Admins legados já **anonimizados** ("zumbis") nunca recebem acesso. Esta regra substitui qualquer leitura anterior deste
> parágrafo que sugerisse converter os demais admins em *Platform Admin*.

Ajustes acompanhantes: `createPlatformAdmin` (testes) e `seedStaging` passam a criar `platform_access`; `User`/`session_GET`/
`login` devolvem `platformLevel`.

### 25.2 Bootstrap do Platform Owner (out-of-band, sem SMTP)

Nenhuma rota pública cria owner. O caminho é um **CLI administrativo executado por quem tem acesso ao servidor/banco**
(o proprietário), seguido de uma **ativação de uso único** no navegador.

```
[CLI] npm run platform:bootstrap-owner -- --email <e-mail do owner>
   precondições: platform_state.owner_bootstrapped_at IS NULL  (senão recusa)
                 e nenhum token pendente (um pendente é revogado explicitamente antes de emitir outro)
   gera token 256 bits (crypto.randomBytes) "LEVB-…"; grava SÓ o HMAC; imprime o token UMA vez no terminal
   audita plataforma.bootstrap_emitido (actor NULL, origem 'cli', issued_by "<usuário-SO>@<host>")
        │  entrega manual do token (o operador é o próprio proprietário)
        ▼
[Navegador] /plataforma/ativar  → POST /auth/bootstrap/activate {token}
   valida HMAC/estado/validade ► "claim" atômico: UPDATE … SET claimed_at=now(), claimed_challenge=:c
        WHERE used_at IS NULL AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at>now()
   cria auth_challenge(kind='bootstrap_owner', TTL 30 min, vinculada ao navegador) — NÃO é sessão
        ▼
   escolhe método primário (Fase 90: senha; sociais entram depois por vinculação) + nome (e-mail = o do CLI, fixo)
   inscreve TOTP (begin/confirm) ► recebe recovery codes (exibidos uma vez)
        ▼
[Transação final — única]
   INSERT users (role='user'!) → credencial → mfa_methods(active) → recovery codes
   INSERT platform_access(level='owner', status='active', bootstrap_token_id)
   UPDATE platform_state SET owner_bootstrapped_at = now()
   UPDATE platform_bootstrap_tokens SET used_at=now() WHERE id=:id AND used_at IS NULL AND revoked_at IS NULL  (0 linhas ⇒ rollback)
   audita plataforma.owner_provisionado (por último) ► cria sessão plena (mfa_verified_at)
```

`platform_bootstrap_tokens`: `id, purpose ('owner'|'owner_recovery'), token_hash BYTEA UNIQUE, pepper_version SMALLINT,
expected_email TEXT, target_user_id INT NULL (só recuperação), created_at, expires_at, claimed_at, claimed_challenge,
used_at, revoked_at, issued_by TEXT, failed_attempts INT`. Índice único parcial **“um token pendente por vez”**
`ON ((1)) WHERE used_at IS NULL AND revoked_at IS NULL`.

| Propriedade | Definição |
|---|---|
| Validade | **15 min** padrão (máx. 30); em UTC, decidida pelo servidor; `expires_at > now()` |
| Uso único | `used_at` por UPDATE condicional na transação final; `claimed_at` impede dois navegadores de avançarem |
| Armazenamento | apenas `HMAC(IDENTITY_CODE_PEPPER, "bootstrap:v1:"+token)`; o token nunca é gravado nem logado |
| Revogação | `npm run platform:bootstrap-revoke` (idempotente); emitir novo token revoga o pendente |
| Expiração | token expirado ≠ aceito; nada é criado; o operador reemite pelo CLI (o expirado fica `expirado` derivado) |
| Falha | resposta neutra e idêntica para token inexistente/expirado/usado/revogado; 5 falhas/15 min por IP; `failed_attempts` e alarme |
| Replay | segundo uso do mesmo token ⇒ 0 linhas no UPDATE ⇒ rollback; desafio expirado ⇒ recomeça pelo CLI |
| Concorrência | duas ativações simultâneas: o *claim* atômico deixa passar uma; a outra recebe a resposta neutra |
| Auditoria | `plataforma.bootstrap_emitido` / `_revogado` / `_expirado` (derivado, agregado) / `_falhou` / `owner_provisionado`; `actor_user_id` NULL para eventos do CLI |
| Proibido | senha universal, e-mail hardcoded, token permanente, segredo compartilhado, rota pública que promove |

**Recuperação do owner (perdeu senha **e** TOTP **e** recovery codes):** `npm run platform:owner-recovery` emite um token
`purpose='owner_recovery'` ligado ao `target_user_id` do owner atual; a conclusão **revoga todas as sessões do owner,
desativa o TOTP/recovery anteriores e exige nova inscrição de TOTP** (e senha nova, se a credencial for senha), tudo
auditado. É o **único** caminho de recuperação do owner (recuperação de senha por e-mail nunca contorna o MFA do owner).
Exige acesso ao servidor — a raiz de confiança continua sendo o proprietário (risco residual registrado em §16).

**Transição:** o owner migrado na Fase 89 (backfill) continua logando como hoje até a Fase 90, quando o primeiro login
após a ativação do MFA obrigatório cai em `auth_challenge(kind='mfa_enroll_required')` (§25.14).

### 25.3 Último Platform Owner — proteções

Invariante: **nunca existe um estado com 0 owners depois do bootstrap**, e **o último owner não perde o acesso**.

| Operação | Comportamento definitivo |
|---|---|
| `account-delete` (LGPD) | se o usuário tem `platform_access` **ativo** (owner **ou** admin) ⇒ **409 `plataforma_acesso_ativo`**: precisa antes ter o acesso **revogado** (admin: por um owner; owner: **só** após transferir ownership). O check roda **dentro** da transação, depois de travar `users` e `platform_access` (§25.19 L1). |
| Anonimização | nunca ocorre com `platform_access` ativo (trigger `BEFORE UPDATE` em `users` recusa gravar `anonymized_at`/e-mail anonimizado se existir `platform_access.status='active'`). Se a anonimização acontecer (após revogar), `platform_access` fica `revoked` — **nenhum registro semântico incoerente** (`role=admin` sem identidade válida deixa de existir, pois `role` não é mais autorização). |
| Desativação/suspensão de conta (futuro `users.status`) | recusada para titular de `platform_access` ativo até a revogação/transferência. |
| Remoção/alteração de método de login | invariante "≥1 método primário" (M3) **e** o owner não pode remover o último método nem o único TOTP (M4). |
| Alterar identidade (vincular/desvincular) | permitido com step-up; sempre mantendo ≥1 método e o MFA. |
| Revogar o próprio acesso | owner **não pode** (nem admin revogar owner). |
| **Transferência de ownership (futura, especificada agora)** | duas etapas: (1) owner inicia, com step-up (≤2 min), indicando um *Platform Admin* já ativo com MFA ativo; (2) o alvo **aceita** com step-up próprio; transação única: `owner→admin` (antigo) e `admin→owner` (novo) — o índice parcial valida por statement na ordem correta (antigo primeiro) e o trigger deferido garante exatamente 1 owner no commit; sessões do antigo owner são rotacionadas/reduzidas; auditoria `plataforma.ownership_transferido`. Não implementar antes de existir o primeiro *Platform Admin*. |

### 25.4 Código de acesso — regra definitiva (congelada)

1. **Nenhuma conta LEVORA nasce sem código de acesso válido emitido pela plataforma**: senha, Google, Microsoft, Apple
   e **qualquer método futuro**. Exceções **estruturais** (não são "cadastro"): o **bootstrap do owner** (§25.2) e o **backfill**
   de contas existentes. Não há terceira exceção.
2. O código é **provisionamento**, não credencial: **não** autentica, **não** redefine senha, **não** satisfaz MFA, **não**
   serve para login. Depois de usado o código só tem valor de registro (`redeemed_*`). Nenhum endpoint de login/recuperação/MFA
   consulta `registration_access_codes`.
3. **1 código → no máximo 1 `users`** (duas abas, duas máquinas, dois processos, senha+Google, Google+Microsoft,
   Microsoft+Apple, callbacks concorrentes) por **três camadas independentes**: (a) transação única; (b) `UPDATE`
   condicional `… WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()` com 0 linhas ⇒ rollback total;
   (c) unicidade no banco `users.registered_via_code_id UNIQUE` (+ `CHECK` de §4.8). JavaScript sozinho **nunca** basta.
4. **Papel recebido no cadastro: sempre usuário normal.** O fluxo de cadastro **não toca** em `platform_access`; o INSERT
   do cadastro é feito por um único helper cujo contrato não aceita nível de plataforma (`role='user'`, sem concessão).
   Não existe promoção por cadastro, código, convite, login social ou criação de organização.
5. **Entrega única:** na criação o painel mostra `LEV-XXXX-XXXX-XXXX-XXXX-XXXX` (copiável) **uma única vez**; depois
   `LEV-••••-••••-••••-••••-X7K2` (últimos 4). Guardam-se: HMAC (com `pepper_version`), `code_last4`, estado, timestamps,
   `redeemed_by_user_id`, auditoria. O valor bruto **nunca** é armazenado nem recuperável (perdeu ⇒ revoga e emite outro).
6. Validação ≠ consumo (§6.5). O consumo ocorre só na transação de conclusão (§6.6).

### 25.5 Chaves e segredos (separação por finalidade; sem reutilizar `JWT_SECRET`)

| Segredo | Finalidade | Uso | Versão |
|---|---|---|---|
| `IDENTITY_CODE_PEPPER` | **hash/lookup de segredos bearer de alta entropia**: códigos de acesso, recovery codes, tokens de bootstrap, tokens de reset (futuros). Separação de contextos por *domain separation* no HMAC (`"access-code:v1:"`, `"recovery:v1:"`, `"bootstrap:v1:"`, `"reset:v1:"`). | HMAC-SHA-256 | `pepper_version SMALLINT` em cada tabela |
| `MFA_ENCRYPTION_KEY` | **cifrar** o segredo TOTP em repouso | AES-256-GCM (IV aleatório 96 bits por registro; AAD = `user_id`+`method_id`) | `secret_key_id SMALLINT` em `mfa_methods` |
| `JWT_SECRET` | assinatura do cookie de sessão (existente) | HS256 | inalterado; **não** reutilizado pelos demais |
| Segredos de provedores (client secret Google/Microsoft, chave `.p8` Apple) | back-channel OIDC | — | por provedor |

Regras: (1) **três a quatro chaves distintas, nenhuma derivada de outra**; (2) formato de ambiente versionado:
`IDENTITY_CODE_PEPPER_V1`, `_V2`… + `IDENTITY_CODE_PEPPER_CURRENT=1`; `MFA_ENCRYPTION_KEY_V1`… + `…_CURRENT`;
(3) **rotação sem invalidar tudo:** a nova versão é usada para **novos** registros; a validação testa as versões aceitas
(≤2) — como códigos/tokens têm vida curta, a versão antiga se esgota sozinha; para o TOTP, um *job* de re-cifragem migra
`secret_key_id` e depois a chave antiga é retirada; (4) **nunca** no banco, no audit log, em log, em resposta ou no
repositório; (5) ausência de qualquer chave obrigatória ⇒ **falha segura** na inicialização da feature (não gera código
fraco); (6) **staging local:** os segredos ficam no mecanismo de ambiente já usado pelo projeto (`.env` fora do git /
variáveis do compose), sem hardcode; **produção:** a decisão do *secret manager* é adiada até o ambiente final ser definido
— hoje **não há** outro mecanismo documentado além de variáveis de ambiente (`DEPLOYMENT_RUNBOOK.md`), então esse é o
contrato mínimo. Nenhuma dependência nova é necessária para isso.

### 25.6 `signup_attempt` e o callback da Apple (`form_post`) — autoridade no servidor

`signup_attempt` = **tentativa de criação**, não conta parcial: não grava `users`, identidade nem senha antes da
transação final. Propriedades: `id` e `state` **imprevisíveis** (256 bits; só o hash do `state` é guardado); **TTL 15 min**;
**uso único** (`status`: `started → identity_verified → completed | expired | failed | cancelled`, transições por UPDATE
condicional); vinculada ao **navegador** por cookie `levora_signup` (HttpOnly, Secure, SameSite=Lax; guarda só um
segredo opaco cujo hash fica em `binding_hash`); **invalidada** ao concluir, ao expirar e ao cancelar
(`POST /auth/signup/cancel`); **nenhuma** autoridade vem de `localStorage`, React state ou parâmetro da URL.

**Quem manda no callback é o `state`, não o cookie.** Para a Apple (`response_mode=form_post`, **POST cross-site**) um
cookie `SameSite=Lax` **não** é enviado; por isso a **etapa 1** do callback **não lê cookie nenhum**:

```
POST /auth/oauth/apple/callback  (form_post: code, id_token?, state, user?)
  1. hash(state) ► signup_attempt (server-side)  → ESTE registro contém, e só ele: access_code_id, provider, nonce, PKCE verifier,
                                                      intent e user_id (se vinculação). O navegador NÃO fornece nem pode trocar
                                                      o código nem o usuário associados.
  2. consome o state (UPDATE … WHERE status='started') → replay = 0 linhas → rejeita
  3. troca `code` por `id_token` no back-channel (client_secret JWT ES256) e valida: assinatura (JWKS), iss, aud (Services ID),
     exp/iat, nonce (== o da tentativa), sub
  4. grava no attempt: status='identity_verified', provider/issuer/subject, e-mail e flags do id_token, nome sugerido
  5. 303 → /cadastro/concluir          (resposta a um POST cross-site PODE definir cookie; não depende de receber um)
etapa 2 (same-site):  POST /auth/oauth/finalize
  exige o cookie de vínculo (levora_signup) == binding_hash do attempt; revalida o código (ainda utilizável?); executa a transação §6.6
```
O cookie de vínculo é uma **defesa adicional** (impede que a resposta de outro navegador/aba finalize o cadastro de quem
não iniciou o fluxo), **não** a fonte de autoridade. Cookie ausente (bloqueado) ⇒ `finalize` recusa e o attempt é
invalidado (o usuário recomeça; custo de UX aceito). Google e Microsoft usam a **mesma** mecânica (GET ou POST).
Validações obrigatórias no callback: `state`, `nonce`, `iss`, `aud`, `exp`, `sub` — qualquer falha ⇒ attempt `failed`,
resposta neutra, evento de auditoria sem tokens.

### 25.7 Login social nunca cria conta

`/auth/oauth/<provider>/start?intent=login|signup|link` — **somente** `intent=signup` com `signup_attempt` válido (e
código ainda utilizável) pode levar a `INSERT users`. `intent=login` com `(provider,issuer,subject)` inexistente **não
cria nada**: resposta neutra ("nenhuma conta vinculada a esta identidade; para criar conta, use um código de acesso").
`intent=link` exige sessão plena + reauth (§9.1). Não existem rotas `/login/google|microsoft|apple` que criem usuário.

### 25.8 Microsoft — o modelo geral não muda

Mantém-se `provider + issuer + subject` para **todos** os provedores. Para Microsoft: `issuer =
https://login.microsoftonline.com/{tid}/v2.0` (o `iss` do token), `subject = sub` **validado do token** (identidade
externa); **não** se muda o modelo para `provider + oid`. `oid` e `tid` (e qualquer outro dado específico do provedor)
vão apenas para `user_identities.provider_metadata JSONB` (nova coluna, **sem** papel de chave). O adaptador pode usar
`tid` para validar o `iss` e, no futuro, para allowlist de tenants. Se algum dia se provar tecnicamente necessário
(ex.: substituição do *app registration* alterando `sub`), a correção é um **procedimento de re-vinculação auditado** usando
`oid` do metadata — não uma troca do modelo. Authority `common` (pessoal + corporativa/escolar) e a regra do `iss` por
`tid` ficam como em §7.2. **Decisão O-3: fechada.**

### 25.9 E-mail verificado **não** é requisito de criação (fecha O-4)

A conta social é autorizada por **`issuer + subject`** (e pelo código), não pela verificação do e-mail. Armazenam-se
separadamente `email` e `email_verified` (em `user_identities` e, quando confiável, `users.email_verified_at`):
Google `true` (se o `id_token` afirmar); Microsoft **sempre `false`/indeterminado**; Apple conforme `email_verified` do
`id_token` (string/booleano normalizado) — **nunca** presumido a partir do domínio relay. **E-mail não verificado nunca é prova
de posse** e nunca autoriza vinculação, login, convite ou recuperação. Consequências documentadas:
- Como `users.email` é `UNIQUE (LOWER)` e o projeto depende disso, **colisão** (o e-mail do provedor já pertence a outro
  usuário) ⇒ **a criação não ocorre, o código NÃO é consumido** (rollback) e a resposta é neutra (§9.4; só se o provedor
  afirmou `email_verified=true` informa-se "já existe conta — entre pelo método existente").
- Se o provedor **não** fornece e-mail (caso possível Apple/Microsoft), o `finalize` pede um e-mail ao usuário (não verificado,
  `email_verified_at NULL`), sujeito à mesma unicidade.
- **Dívida registrada (não corrigir agora):** o aceite de convite compara só `invite.email == user.email`; com e-mails não
  verificados, o segredo real continua sendo o token do convite. Qualquer recurso que dependa de **posse** do e-mail
  (recuperação de senha por e-mail, correspondência de convite sem token) **exigirá** `email_verified_at` e SMTP.

### 25.10 Apple private relay (congelado)
O relay é e-mail **legítimo**: **nunca** rejeitar por domínio (`@privaterelay.appleid.com`); `is_private_relay` é só
informativo. A identidade é **`issuer + subject`**; e-mail **nunca** é identidade. **Nome e e-mail não vêm em todos os
logins**: só na 1ª autorização (o nome chega num campo do POST controlado pelo navegador ⇒ **não confiável**, serve só
como sugestão; o e-mail confiável é o do `id_token`). Se o nome faltar, `/cadastro/concluir` o pede. Em logins
posteriores nada disso é pressuposto.

### 25.11 Convite × código (fecha O-1)

**Convite NÃO autoriza criar conta.** Finalidades distintas: **CÓDIGO** autoriza a criação de uma identidade LEVORA;
**CONVITE** autoriza a entrada/vinculação numa organização (membership).

```
abre /convites/:token
   │
   ├─ já tem conta e está logado/loga ───────────► aceitar convite normalmente (fluxo atual, inalterado)
   └─ não tem conta
        └─► "Criar conta" exige CÓDIGO DE ACESSO (§25.4) ─► cria conta ─► volta ao convite ─► aceitar/vincular
```
Não existe segundo caminho de provisionamento. O token do convite **não** é lido pelo fluxo de cadastro como
autorização. O aceite continua exigindo conta logada (comportamento atual *verificado*). O código é emitido pela
plataforma (o convidado o obtém do operador/organização por canal humano).

**Dívida arquitetural registrada — convite × Apple private relay (não corrigir agora):** o aceite atual exige
`invite.email == user.email` *(verificado)*; uma conta criada por Apple com e-mail relay **nunca** coincidirá com o e-mail
convidado. A solução (ex.: aceite por token com confirmação explícita quando os e-mails divergem, ou vincular o convite ao
`user_id` após login) será decidida **junto com account linking / ciclo de vida de memberships** (Fases 94+), **sem**
reabrir o modelo de convite agora.

### 25.12 QR do TOTP (fecha O-5)
**Não implementar encoder QR próprio.** Na fase TOTP: usar uma **biblioteca pequena, conhecida e mantida**, sujeita à
análise de dependência **antes de instalar** (licença, manutenção, tamanho, dependências transitivas = idealmente 0, sem
rede, saída em **SVG** para não alterar `img-src 'self'`; execução no **cliente**: o servidor só devolve a URI
`otpauth://totp/Levora:<e-mail>?secret=…&issuer=Levora&algorithm=SHA1&digits=6&period=30`). A biblioteca só desenha a
imagem; **o LEVORA continua dono** de geração do segredo (160 bits), cifragem, validação, ciclo de vida e auditoria. A
chave manual (base32) é exibida como alternativa ao QR.

### 25.13 TOTP — parâmetros e tolerância de relógio (congelado)
`TOTP · HMAC-SHA-1 · 6 dígitos · período 30 s` (RFC 6238/4226) — o perfil que **Google Authenticator** e **Microsoft
Authenticator** (e outros apps TOTP) interpretam do mesmo `otpauth://`. **Tolerância explícita: ±1 passo** (aceita o passo
atual, o anterior e o seguinte ⇒ até ±30 s de desvio entre relógios); fora disso, rejeita. **Anti-reuso:** só é aceito um
passo `> last_used_step` (gravado sob `SELECT … FOR UPDATE` da linha `mfa_methods`), de modo que o mesmo código nunca vale
duas vezes, nem em verificações concorrentes. Comparação em tempo constante. Falhas/bloqueio persistidos no banco (§10.2).
Ativação só após código válido (§10.1).

### 25.14 MFA do Platform Owner, estados de autenticação e step-up

**MFA obrigatório para todo titular de `platform_access` (owner e admin).** Estados no backend (não só na UI):
`primary_authenticated` (= existe `auth_challenge`; **nenhuma** linha em `sessions`) → `mfa_required` /
`mfa_enroll_required` → `fully_authenticated` (= linha em `sessions` com `mfa_verified_at`). **Nenhum endpoint de
plataforma — nem de dados — aceita um `auth_challenge`**: `getServerUserSession` só reconhece `sessions`. Um titular de
`platform_access` que ainda não tem TOTP ativo **não obtém sessão**, só pode concluir a inscrição (enrollment).
`PLATFORM_MFA_REQUIRED=false` existe **apenas** para staging sintético (guarda de ambiente, como o seed).

**Step-up (reautenticação recente — `sessions.last_reauth_at`, janela padrão 10 min; 2 min para transferência):**

| Escopo | Ações que exigem step-up |
|---|---|
| Plataforma | criar código · revogar código · conceder/revogar Platform Admin · transferir ownership · alterar status de organização (`platform-organizations-status`) · controles de automação (`platform-automation-controls`) · retentar tarefas (`background-tasks-retry`) · registrar/alterar fontes · qualquer ação destrutiva futura |
| Qualquer usuário | alterar/definir senha · desativar MFA · regenerar recovery codes · vincular/desvincular método de login · alterar identidade administrativa · excluir conta |
| Sem step-up | leituras (`GET`), logout, listar sessões |

Resposta: `403 {code:'reauth_required'}`; reautenticar = TOTP (+ senha, se existir; para conta social-only, TOTP ou novo
ciclo do provedor). Só **especificado** aqui.

### 25.15 Sessão — valores atuais, problemas e política (fecha O-2)

**Valores atuais *(verificado)*:**

| Item | Valor hoje |
|---|---|
| Cookie `floot_built_app_session` | `Max-Age` 7 dias, `HttpOnly; Secure; SameSite=Lax; Path=/` |
| JWT (HS256) | `exp` = agora + 7 dias, **reassinado** no login **e a cada `session_GET`** (o SPA chama no carregamento; `staleTime: Infinity`) ⇒ janela **deslizante** |
| `sessions.expires_at` | gravada = login + 7 d; **nunca lida** |
| Ocioso (`last_accessed`) | atualizado a cada requisição autenticada; a limpeza (10 % por requisição) apaga linhas com `last_accessed` > 7 d — **probabilística**, não é imposição |
| Duração absoluta | **não existe**: quem abre o SPA ao menos 1×/7 d renova para sempre |
| Rotação do id | novo id a cada login (sem *fixation*); **nenhuma** rotação por mudança de credencial/privilégio |
| Distinção por papel | **nenhuma** |

**Problemas:** (1) sem teto absoluto, um cookie roubado vive indefinidamente enquanto for usado; (2) `expires_at` é
decorativo; (3) sem política para contas privilegiadas; (4) sem rotação em eventos de privilégio.

**Política recomendada (constantes num único módulo `sessionPolicy`, ajustáveis sem mudança estrutural):**

| Perfil | Ocioso (idle) | Absoluto | MFA | Observações |
|---|---|---|---|---|
| **Platform Owner / Platform Admin** | **60 min** | **8 h** | obrigatório em **todo** login (sem "lembrar dispositivo") | step-up 10 min; sessões listáveis/revogáveis |
| **Org Owner / Org Admin / Operador / Usuário** (tier padrão) | **7 dias** (mantém o comportamento atual) | **30 dias** | opcional (usuário) | ações sensíveis com step-up (§25.14); o RBAC da organização **não** muda o tier (evita consulta de membership por requisição) |

Justificativa: mantém o idle atual dos usuários (zero fricção), adiciona o **teto absoluto** que falta, e aperta
fortemente só a conta que, se comprometida, compromete a plataforma; 60 min/8 h é um dia útil com reautenticação diária.
**Não** há "lembrar dispositivo" na v1 (decisão futura, fora do escopo) e **não** se adiciona limite de sessões simultâneas
(hoje inexistente).

**Imposição (Fase 89):** `sessions.absolute_expires_at` (novo; preenchido na criação; **preservado** na rotação) e
`last_accessed` são avaliados em `getServerUserSession` com o tier do usuário (`LEFT JOIN platform_access ativo`); expirou ⇒
`DELETE` da linha e **401**. `expires_at` passa a ser imposto (ou substituído por `absolute_expires_at`). A limpeza
probabilística vira só *garbage collection*. **JWT:** continua sendo apenas transporte do `id`; `exp = min(absolute,
agora+7 d)`, reassinado só em login/rotação/`session_GET`; **a linha é a autoridade** — JWT válido com linha expirada/
removida ⇒ 401 (já é assim para linha removida). **Revogação:** `DELETE` da linha (logout, sair das outras, troca de
credencial, exclusão de conta, revogação administrativa). **Renovação:** `session_GET` renova só o cookie/idle, **nunca**
o absoluto.

**Rotação do id (requisito):** após **login**, **conclusão de MFA**, **alteração de credencial** (trocar/definir senha),
**vincular/desvincular método**, **ativar/desativar MFA** e **step-up**, cria-se **novo id** (nova linha + novo cookie) e a
anterior é removida, herdando `absolute_expires_at`/`created_at` lógico — impede *session fixation* e invalida o
identificador antigo. O estado anterior das **outras** sessões é revogado quando apropriado (troca de senha, MFA, métodos).

**Sessão comum:** uma única tabela/cookie/validação para senha, Google, Microsoft, Apple e passkey; o método fica em
`sessions.primary_method` (metadado, **não** uma sessão por método). `primary authentication` (credencial primária
válida) → `mfa authentication` (`auth_challenge`) → `session authentication` (linha em `sessions`).

### 25.16 Senha
`user_passwords` ganha `UNIQUE(user_id)` (0..1 senha por usuário; a migration **primeiro audita duplicatas** e aborta se
existirem). Política: ≥ 8 caracteres e **teto de 72 BYTES** (UTF-8) — acima disso o bcrypt ignora o excedente em silêncio;
a API **rejeita** em vez de truncar. Alternativa **não adotada**: *prehash* (SHA-256→base64 antes do bcrypt, hash
versionado) para aceitar senhas longas; só considerar se um dia houver requisito de frases-senha > 72 bytes. Ausência de
linha = conta sem senha; nenhum endpoint pode pressupor senha (a confirmação "digite sua senha" passa a escolher o
fator disponível).

### 25.17 Account linking, rate limiting e pendências separadas
- **Account linking (congelado):** nunca e-mail igual ⇒ vínculo; sempre `usuário autenticado → intent explícito → reauth →
  callback → validar identidade → UNIQUE → vincular`; conflito ⇒ **409** (não move, não sobrescreve, não transfere).
- **Rate limiting:** **single-instance ⇒ `Map` em memória é aceitável** para limites de abuso (IP/usuário). **Multi-instância
  futura ⇒ rate limit compartilhado necessário** (migrar `checkRateLimit` para tabela Postgres com `INSERT … ON CONFLICT`,
  sem Redis). **Não** adicionar Redis agora. Limites de segurança que **precisam** sobreviver a reinício (TOTP, recovery code,
  `state`, bloqueio de admin) ficam **no banco desde o início** (§13).
- **Pendência separada (não faz parte da identidade):** **F85 — estabilidade do `impactReport`** (1 falha na 1ª execução da
  regressão do worktree, `test/impactReport.test.ts`, teste "mesmo número de consultas"; 2ª execução 595/595). **Não** foi
  alterada, **não** é justificativa para mudar esta especificação; investigar numa fase própria sem mascarar (sem retry/sleep).

### 25.18 Escopo definitivo das Fases 89 e 90

**Fase 89 — Fundação (inclui correção obrigatória de `expires_at`):** (1) `platform_access` + `platform_state` + índice de
owner único + trigger deferido + backfill determinístico + trigger que proíbe `users.role='admin'` + reescrita de
`requirePlatformAdmin`/`requirePlatformOwner` + `platformLevel` no `User` + ajuste de seed/helper de testes; (2) `account-delete`
bloqueado para titular de `platform_access` ativo + `anonymized_at` + trigger de anonimização; (3) sessão: `absolute_expires_at`,
imposição de `expires_at`/idle por tier, rotação, colunas `primary_method`/`mfa_verified_at`/`last_reauth_at`; (4) `UNIQUE(user_id)`
em `user_passwords` + teto 72 bytes; (5) auditoria de login/logout/falha/sessão; (6) regra de lock L1 (abaixo) aplicada a
`account-delete` e às operações de credencial; (7) **Conta do usuário** (trocar senha, perfil, listar/revogar sessões) —
protótipo existente no worktree, a ser integrado. **Fase 90:** `platform_bootstrap_tokens` + CLIs de bootstrap/recuperação +
ativação; `auth_challenges`; TOTP + recovery codes + step-up; MFA obrigatório para `platform_access`; biblioteca de QR
(após análise de dependência); chaves `IDENTITY_CODE_PEPPER`/`MFA_ENCRYPTION_KEY` versionadas. **91+:** conforme §23
(códigos de acesso e gating → Google → Microsoft/Apple → linking/senha/recuperação → passkeys → auditoria final).

**Ordem canônica de locks (atualiza L1):** `organizations` → `users` (linha do usuário) → `platform_access` →
credenciais (`user_passwords`, `user_identities`, `mfa_*`) → `sessions` (por id) → `registration_access_codes` /
`platform_bootstrap_tokens` → `audit_log` (último). **Concorrência adicional:** **P-a** duas ativações de bootstrap (claim
atômico); **P-b** `account-delete` do owner × transferência/revogação (lock `users`→`platform_access` + trigger deferido
garante ≥1 owner); **P-c** duas concessões simultâneas de admin/transferência (índice de owner único + lock);
**P-d** emissão de código de acesso × revogação do admin (UPDATE condicional já cobre).

### 25.19 Respostas objetivas (checklist de não-ambiguidade para iniciar a Fase 89)

| Pergunta | Resposta definitiva |
|---|---|
| Quem é o Platform Owner? | o único usuário com `platform_access(level='owner', status='active')`; 1 por índice parcial único |
| Como nasce? | **somente** CLI `platform:bootstrap-owner` + ativação de uso único (token em hash, 15 min, 1 uso) + TOTP; (já existente: migrado do `users.role='admin'` se exatamente 1) |
| Como é protegido? | MFA obrigatório, sessão 60 min/8 h, step-up, rate limit reforçado, auditoria, proteção de último owner, recuperação só offline |
| Como nasce uma conta normal? | **somente** com código válido (senha ou social), `INSERT` com papel normal e **nenhuma** concessão de plataforma |
| Quem pode criar conta? | quem apresenta um código de acesso utilizável emitido por Owner/Admin da plataforma |
| Qual papel o cadastro recebe? | usuário normal (nenhuma linha em `platform_access`; membership só depois, por organização/convite) |
| Convite × código? | convite **não** cria conta; sem conta ⇒ código primeiro, depois aceita o convite |
| Google / Microsoft / Apple entram como? | `user_identities (provider, issuer, subject)`; criação só com `signup_attempt`+código; login só se já vinculado |
| TOTP? | SHA-1/6/30, ±1 passo, anti-replay por `last_used_step`, segredo AES-256-GCM, QR por biblioteca pequena |
| Sessão? | única (`sessions`), tier idle/absoluto, rotação, estado parcial só em `auth_challenges` |
| Como identities são vinculadas? | explicitamente, autenticado + reauth, UNIQUE, conflito 409, nunca por e-mail |
| Quais segredos existem? | `JWT_SECRET`, `IDENTITY_CODE_PEPPER`(v), `MFA_ENCRYPTION_KEY`(v), segredos de provedores, chave `.p8` Apple |
| Quem pode perder acesso? | o último Owner **não** pode (delete/revogação/remoção do último método/MFA bloqueados); transferência é transacional |
| Como evitar concorrência? | UPDATE condicional + UNIQUE + índice parcial + trigger deferido + ordem de locks L1 (§25.18) |
| Como evitar privilege escalation? | nenhuma rota pública escreve `platform_access`; cadastro/código/convite/social/org não o tocam; trigger veta `users.role='admin'`; autorização relida do banco; MFA + step-up |

### 25.20 Decisões abertas após a Fase 88.1

**Nenhuma decisão estrutural permanece aberta** para iniciar a Fase 89. Restam apenas **itens não estruturais**, todos com
dono e fase definidos (não bloqueiam a implementação):
1. **Secret manager de produção** — adiado até o ambiente final existir; contrato mínimo = variáveis de ambiente versionadas (§25.5).
2. **Convite × Apple private relay** — dívida registrada; resolve-se na fase de account linking/membership (§25.11).
3. **Recursos que dependem de posse de e-mail** (recuperação por e-mail, convite sem token) — dependem de SMTP + `email_verified_at` (§25.9).
4. **"Lembrar dispositivo" e limite de sessões simultâneas** — inexistentes e fora do escopo; decisão futura, sem impacto estrutural.
5. **Valores numéricos de sessão (§25.15)** — recomendados e congelados como padrão; são constantes de configuração, ajustáveis sem mudar a arquitetura.
6. **F85 — estabilidade do `impactReport`** — pendência independente (§25.17).

## 26. Estado após a Fase 90 (implementado)

Implementados e verificados (detalhes, formatos e testes em `docs/IDENTIDADE_FASE90_AUDITORIA.md`): bootstrap offline do Platform Owner
(§25.2, incluindo `owner_recovery`), `auth_challenges`, TOTP (§25.13), recovery codes, MFA obrigatório para titulares de
`platform_access` com bloqueio de sessão sem MFA concluído (§25.14), step-up (mecanismo + org-status, regenerar códigos e desativar
MFA), chaves `IDENTITY_CODE_PEPPER`/`MFA_ENCRYPTION_KEY` versionadas (§25.5), QR por biblioteca (`uqr`, §25.12).
**Desvios/decisões registrados:** (1) o lock de login deixou de ser global por e-mail para contas protegidas (por e-mail+rede /24 +
alerta de várias redes) — resolve P-6; (2) step-up aplicado, nesta fase, a org-status, regenerar recovery codes e desativar MFA; os
demais endpoints de plataforma e as ações futuras continuam pendentes de aplicar o mecanismo; (3) a revogação de `platform_access` não
remove a sessão (o privilégio é relido a cada requisição). **Continuam não implementados:** provedores sociais, passkeys, recuperação de
senha por e-mail (Fases 91+; os códigos de acesso foram implementados na Fase 91 — ver §27).

## 27. Estado após a Fase 91 (implementado)

Implementados e verificados (arquitetura, ciclo de vida, concorrência, painel, testes e controles negativos em
`docs/IDENTIDADE_FASE91_AUDITORIA.md`): `registration_access_codes` (migration 0017), cadastro por senha **somente com código**,
validação pública sem consumo, criação/revogação/listagem para `platform_access` (owner/admin) com step-up, painel "Códigos de acesso"
em `/plataforma`, auditoria (`codigo_acesso.criado|revogado|consumido|tentativa_invalida`) e rate limits (§10 do doc de auditoria).

**Decisões congeladas nesta fase (implementação das §25):**
1. **Nenhuma conta nova nasce sem código válido** (exceções legítimas e documentadas: bootstrap do owner, backfill/migration, seed
   interno de staging). O aceite de convite nunca cria usuário; convite e código são independentes.
2. **Consumo atômico** em `provisionUserWithAccessCode(código, createUser)`: `FOR UPDATE` + UPDATE condicional + `UNIQUE(users.registered_via_code_id)`;
   qualquer falha ⇒ rollback integral. O callback `createUser` torna o provisionamento **independente do método de autenticação**
   (senha hoje; `signup_attempt` Google/Microsoft/Apple no futuro), sem implementar nenhum provedor.
3. **Resposta pública única** (`400 codigo_indisponivel`) para inexistente/mal formado/expirado/revogado/utilizado; o motivo só aparece na
   auditoria e no painel. E-mail já cadastrado + código válido ⇒ resposta neutra de sucesso, **sem consumir** (anti-enumeração, Fase 51).
4. **Validade** definida pelo servidor: 5 min … 90 dias (também CHECK no banco); estado derivado (sem job de expiração).
5. **Armazenamento**: só HMAC (`access-code:v1:`, pepper versionado) + últimos 4; texto puro exibido uma única vez; perdeu ⇒ revogar e gerar outro.
6. O código cria sempre `role='user'`: nunca `platform_access`, nunca MFA, nunca membership.

**Desvios/pendências:** emissão em lote (até 50, §25) não implementada (emissão unitária); `organization_id` reservado e ignorado; sem e-mail
automático do código (SMTP); resposta pública única é mais restritiva que a mensagem diferenciada sugerida em rascunhos anteriores (justificativa no doc de auditoria).
**Continuam não implementados:** Google/Microsoft/Apple/OAuth/OIDC, account linking, passkeys, recuperação de senha por e-mail (Fase 92+).

## 28. Estado após a Fase 92 (implementado)

Implementado e verificado **por testes locais com um Google sintético** (nada foi executado contra o Google real; ver `docs/IDENTIDADE_FASE92_GOOGLE_AUDITORIA.md` §14):
login e cadastro com **Google** (OIDC Authorization Code + PKCE S256), `user_identities` e `oauth_attempts` (migration 0018), validação local do ID token (assinatura RS256 por JWKS do
Discovery, `iss`, `aud`/`azp`, `exp`/`iat`, `nonce`, `sub`), integração com `registration_access_codes` (cadastro Google exige código; consumo atômico pelo mesmo
`provisionUserWithAccessCode`), com o MFA LEVORA (Google **não** substitui o 2º fator) e com as sessões existentes (`primary_method='google'`), auditoria
(`usuario.login_google|login_google_falhou|cadastro_google|cadastro_google_falhou|google_identity_rejected`), rate limits (`google-start`, `google-callback`) e frontend (botão no login; cadastro em dois passos).

**Decisões congeladas nesta fase (implementação de §7, §25.6, §25.7, §25.9):**
1. Identidade Google = `(google, issuer, sub)`; o e-mail é só atributo; **sem auto-link por e-mail**; o login Google **nunca** cria conta (CHECK no banco: tentativa `login` não carrega código).
2. O callback é a única autoridade: `state` de uso único (UPDATE condicional) + vínculo de navegador (`levora_oauth`) + PKCE + nonce; o código de acesso **nunca** está em URL — a tentativa guarda só o `access_code_id`.
3. Para Google (GET same-site) o callback conclui login/cadastro na mesma requisição; o `finalize` em duas etapas do §25.6 continua reservado à Apple (`form_post`).
4. Nenhum token do Google é armazenado (o `access_token` é descartado). `email_verified=false` não bloqueia o cadastro, mas é gravado como `false`.
5. A anonimização da conta apaga `user_identities`; o código consumido continua redimido.

**Pendências/desvios:** account linking explícito; ~~exclusão self-service de conta Google-only~~ (resolvida na Fase 92.1, §29); e-mail ausente no token ⇒ falha neutra (o §25.9 previa pedir o e-mail); `hd`/allowlist de domínio.
**Continuam não implementados:** Microsoft, Apple, passkeys, recuperação de senha por e-mail (Fase 93+).

## 29. Estado após a Fase 92.1 (implementado)

**Reautenticação por identidade** (`docs/IDENTIDADE_FASE92_GOOGLE_AUDITORIA.md` §16): `sessions.primary_reauth_at` + `oauth_attempts.intent='reauth'` (migration 0019). `account-delete` de conta **sem senha**
exige identidade vinculada + confirmação digitada + reautenticação recente da identidade (5 min, validada no servidor sob lock) e, com MFA ativo, também o step-up do MFA — o Google **não** substitui o MFA LEVORA e o MFA não
substitui a identidade (carimbos distintos). Nenhuma senha é criada em fluxos sociais; não há endpoint de exclusão específico de provedor. O mecanismo é provider-agnóstico (Microsoft/Apple/senha/passkey poderão satisfazê-lo).

**Qualificação do Google:** validado por testes locais com provedor **sintético** e por preview com provedor sintético; **NÃO validado contra o Google real** (roteiro em §17 do doc de auditoria). Não declarar "pronto para produção" antes disso.
**Decisões:** e-mail ausente ⇒ falha neutra (produto); `email_verified` é atributo; `hd` não implementado; CAP/RISC fora de escopo. **Continuam não implementados:** Microsoft (Fase 93), Apple, passkeys, account linking completo, recuperação de senha.

## 30. Estado após a Fase 93 (implementado)

**Microsoft OIDC** (`docs/IDENTIDADE_FASE93_MICROSOFT_AUDITORIA.md`): Authorization Code + PKCE S256, authority `common` (padrão; `organizations`/`consumers`/tenant GUID por configuração), scopes `openid profile email` (sem Graph), nenhum token guardado. `jose` + `fetch` (sem MSAL; decisão no §15 do doc de auditoria). Migration `0020`: `oauth_attempts.provider ∈ {google, microsoft}` e `user_identities.provider_metadata` (JSONB, `tid`/`oid`/`ver`/`idp`, **sem papel de chave**).

**Identidade (fecha §7.2/§25.8 com evidência):** `(provider='microsoft', issuer = https://login.microsoftonline.com/{tid}/v2.0, subject = sub)`. O `iss` do token tem de ser exatamente o emissor do `tid` do próprio token e o `tid` tem de ser permitido pelo authority; a chave que assinou é amarrada ao emissor que a Microsoft publica no JWKS (`issuer`/`cloud_instance_name`). `oid` divergente para o mesmo `(issuer, sub)` é anômalo e rejeitado. **Não** se migrou para `oid+tid`. E-mail/UPN/`preferred_username` nunca são chave; `email_verified` é **sempre false** para a Microsoft.

**Estrutura:** fluxo OAuth compartilhado (`oauthStart`/`oauthCallback`/`oauthPrimitives`) + dois adaptadores (`oauthProviders`); endpoints Google e Microsoft finos; `claimOauthAttempt` filtra por provedor. Reauth e `account-delete` social-only usam o mesmo mecanismo da 92.1 (por provedor: `409 {google|microsoft}_nao_vinculado`).

**Qualificação:** validado com provedor **sintético** (testes + preview local) e contra o **Discovery/JWKS reais** da Microsoft (somente leitura, sem credenciais). **NÃO validado:** login real (pessoal, corporativo, convidado), registro de aplicativo, consentimento, claims reais (§17 do doc de auditoria). Pendência relevante: contas corporativas podem não trazer `email` ⇒ cadastro falha de forma neutra (decisão de produto aberta). **Continuam não implementados:** Apple, passkeys, account linking completo, recuperação de senha, SMTP.
