# MFA, bootstrap do Platform Owner, auth_challenges e step-up — Fase 90

Implementa §25.2, §25.13, §25.14 da `docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md` sobre a fundação da Fase 89
(`docs/IDENTIDADE_FASE89_AUDITORIA.md`). Base: `3244445`. **Fora de escopo (e não implementado):** provedores sociais,
OAuth/OIDC, passkeys, códigos de acesso, cadastro fechado, recuperação de senha por e-mail, SMTP.

## 1. Arquitetura

```
credencial primária ──► auth_challenge (cookie levora_challenge, SEM sessão) ──► TOTP | recovery code ──► INSERT sessions (id novo, mfa_verified_at)
                         └─ nunca autentica nada: getServerUserSession só lê o cookie de sessão
step-up:  sessão plena ──► POST step-up (TOTP) ──► last_reauth_at na MESMA sessão (id rotacionado) ──► requireRecentAuth(10 min)
bootstrap: CLI offline ──► token (hash) ──► /plataforma/ativar ──► challenge ──► senha ──► TOTP ──► TRANSAÇÃO ÚNICA ──► sessão
```

Regra de sessão (central, em `getServerUserSession`): **titular de `platform_access` ativo sem `mfa_verified_at` = 401 em qualquer
endpoint** (inclui sessões anteriores à Fase 90). `PLATFORM_MFA_REQUIRED=false` só vale com `LEVORA_ENVIRONMENT=staging`.

## 2. Migration 0016 (`db/migrations/0016_mfa_foundation.sql`; espelhada em `db/schema.sql`)

```
STEP 1  enums + mfa_methods (segredo CIFRADO, last_used_step, falhas/bloqueio, índice único: 1 método pending|active por usuário)
STEP 2  mfa_recovery_codes (HMAC + pepper_version; used_at / invalidated_at)
STEP 3  auth_challenges (secret_hash, purpose, status, attempts, expires_at, estado pendente do bootstrap)
STEP 4  platform_bootstrap_tokens (token_hash, TTL, claimed/used/revoked; índice único parcial: UM pendente por vez)
STEP 5  platform_access.bootstrap_token_id
STEP 6  constraint trigger DEFERIDO: titular ativo nunca termina a transação sem TOTP ativo (quando já tinha um)
STEP 7  login_attempts.ip_prefix (+ índice)
```
Reversível: só objetos novos + 2 colunas nullable. Testes: aplica sobre o estado da Fase 89 (owner migrado sem MFA não é
bloqueado), atomicidade (falha no meio não deixa nada), igualdade com `schema.sql`.

## 3. Chaves e formatos armazenados (`src/helpers/identityKeys.tsx`)

| Segredo | Uso | Formato |
|---|---|---|
| `IDENTITY_CODE_PEPPER_V<n>` (+`_CURRENT`) | HMAC-SHA-256 de segredos bearer, com *domain separation* (`recovery:v1:`, `bootstrap:v1:`, `challenge:v1:`) | colunas `*_hash BYTEA` (32 bytes) + `pepper_version` |
| `MFA_ENCRYPTION_KEY_V<n>` (+`_CURRENT`) | AES-256-GCM do segredo TOTP | `secret_ciphertext BYTEA = iv(12) ‖ tag(16) ‖ ciphertext`, `secret_key_id SMALLINT`, AAD `mfa:<user_id>` (ou `bootstrap:<challenge_id>` enquanto pendente no challenge) |
| `JWT_SECRET` | cookie de sessão (inalterado) | **não** reutilizado |

Nenhuma chave deriva de outra; ausência/tamanho errado ⇒ `IdentityKeyConfigError` (falha segura). Rotação: nova versão para
novos registros, validação aceita todas as versões configuradas (testado: V1→V2 mantém TOTP/códigos antigos válidos).
Não há job de re-cifragem (pendência operacional; formato já comporta).

## 4. Bootstrap offline do Platform Owner

- **CLI** `npm run platform:bootstrap-owner -- --email X` / `platform:owner-recovery` / `platform:bootstrap-revoke` / `platform:bootstrap-status`
  (`db/platform-bootstrap-cli.ts`): roda fora da aplicação HTTP; token `LEVB-…` (256 bits, `crypto.randomBytes`) impresso **uma vez**;
  só o HMAC é gravado; **15 min**; **uso único**; **um pendente por vez** (índice único parcial; emitir revoga o pendente — dois
  emissores simultâneos serializam no lock de `platform_state`); recusa se já existe owner (orienta `owner-recovery`) ou se o
  e-mail já é de uma conta (o owner nunca promove conta comum). Auditoria `plataforma.bootstrap_emitido/_revogado` (`actor` NULL).
- **Ativação** (`POST /auth/bootstrap-activate`, única rota pública relacionada): token ruim (inexistente, de outro
  ambiente/pepper, expirado, usado, revogado, já reivindicado) ⇒ **a mesma resposta 401**; limite 10/15 min por IP; claim atômico
  (`UPDATE … WHERE claimed_at IS NULL …`): duas ativações simultâneas ⇒ 1 vence. Abre um challenge `bootstrap_owner` (TTL = min(30 min, restante do token)).
- **Passos:** credenciais (`bootstrap-credentials`: nome + senha na política de 72 bytes, só no challenge) → `mfa-setup-begin`
  (segredo cifrado no challenge) → `mfa-setup-confirm` (TOTP correto) ⇒ **transação final única** (`bootstrapFinalize.tsx`):
  users (`role='user'`) + user_passwords + platform_access(owner, origem `bootstrap`) + mfa_methods(active) + recovery codes +
  token `used_at` (UPDATE condicional) + challenge consumido + sessão (MFA concluído) + auditoria. Qualquer falha ⇒ ROLLBACK total:
  nunca owner sem MFA, nunca token consumido sem owner. Expirar durante a ativação ⇒ recusado; e-mail tomado/owner surgido no
  meio ⇒ recusado (token não consumido).
- **Recuperação (`owner_recovery`):** mesmo fluxo; na transação final desativa o TOTP anterior e cria o novo (o trigger deferido valida
  no COMMIT), invalida os recovery codes antigos, encerra **todas** as sessões do owner e (opcional) troca a senha.
  É o único caminho de recuperação do owner.
- Recovery codes são devolvidos na resposta da confirmação (se a resposta se perder após o COMMIT, regenerar com step-up).

## 5. auth_challenges

Segredo opaco de 256 bits só em hash; cookie `levora_challenge` (`HttpOnly; Secure; SameSite=Lax; Path=/_api/v1/auth`).
**TTL 5 min** (login/inscrição) / até 30 min (bootstrap, limitado ao token); **uso único** (`UPDATE … WHERE status='pending' AND expires_at>now()`);
**5 tentativas** (depois `failed`, cookie apagado); um novo login **cancela** challenges pendentes anteriores do usuário; propósito
errado/expirado/consumido/cancelado/inexistente ⇒ a mesma resposta (`challenge_invalido`). Não é aceito como sessão em nenhum
endpoint; a sessão só nasce em `mfa-verify` / `mfa-setup-confirm` (id novo — a "rotação" na conclusão do MFA é a própria criação,
pois nunca existiu sessão pré-MFA; fixation testado).

## 6. TOTP (`src/helpers/totp.tsx`, `src/helpers/mfa.tsx`)

SHA-1, 6 dígitos, 30 s (RFC 6238; vetores oficiais testados), tolerância **±1 passo**, `otpauth://totp/Levora:<conta>?…` (compatível
com Google/Microsoft Authenticator). Anti-replay: só aceita passo **> `last_used_step`** gravado sob `SELECT … FOR UPDATE`
(8 verificações simultâneas do mesmo código ⇒ 1 sucesso). Falhas **persistidas no banco**: a partir de 10 em 1 h, bloqueio de
30 s dobrando até **15 min** (nunca permanente; falhas antigas deixam de contar; sucesso zera). **(Fase 90.1)** o recovery code NÃO compartilha mais o contador/bloqueio do TOTP — ver §15.4.
Ativação: segredo `pending` (nunca ativo antes do código); 5 erros descartam o pendente. QR: biblioteca **`uqr`** (MIT, 79 kB,
0 dependências, mantida por unjs; `npm audit` = 0), SVG no cliente.

## 7. Recovery codes

10 por lote, `XXXX-XXXX-XXXX-XXXX` (Crockford, 80 bits), **HMAC-SHA-256 com pepper versionado** (segredo de alta entropia ⇒ hash rápido
é adequado; lookup por igualdade restrito ao `user_id`); uso único por `UPDATE … WHERE used_at IS NULL` (concorrência: 1 sucesso);
regenerar (sessão plena + step-up) invalida o lote anterior; nunca em audit/log; nunca devolvidos de novo.

## 8. Step-up

`requireRecentAuth(session, 600 s)` (`mfa_verified_at` logo após o login com MFA conta como recente); 403 `reauth_required`;
`POST /auth/step-up` (TOTP ou recovery) marca `last_reauth_at` **na mesma sessão** (rotaciona o id; não cria sessão paralela).
**Ações com step-up nesta fase:** alterar status de organização (`platform-organizations-status`, com diálogo na tela
`/plataforma` que repete a ação), regenerar recovery codes, desativar MFA. **Ainda sem step-up (pendência da especificação §25.14):**
demais endpoints de plataforma (`background-tasks-retry`, `sources_POST`, registro central) e as ações futuras (códigos de acesso,
concessão de admin, transferência de ownership) — o mecanismo existe; falta aplicá-lo (cada um exige tratar `reauth_required` na tela).

## 9. Platform Owner e MFA obrigatório

Titular (owner **e** admin) só tem sessão com MFA concluído; sem TOTP ⇒ login cai na **inscrição** (challenge `mfa_enroll`).
O MFA **não é removível**: `mfa-disable` ⇒ 409 `mfa_obrigatorio`; SQL direto (apagar/desativar) barrado pelo trigger deferido;
a troca na mesma transação é aceita (recuperação). Não existe estado persistente "owner ativo com TOTP desativado".
Owner migrado da Fase 89 (sem TOTP) continua sem sessão até se inscrever (o trigger não o afeta). `account-delete` apaga segredo TOTP,
recovery codes e challenges (minimização).

## 10. Lock de login — decisão (resolve a dívida da Fase 89)

Problema: 5 falhas/15 min **por e-mail** (qualquer origem) permitiam travar o login do owner. Solução (`login_with_password_POST.ts`):
- conta **protegida** (TOTP ativo ou titular de plataforma): bloqueio **por (e-mail, rede /24)** — quem erra de outra rede não trava o
  dono; a rede do atacante é bloqueada (mesmo com a senha certa, 15 min). Força bruta continua limitada por rede (5/15 min), por IP
  (20/15 min) e, sobretudo, pelo **2º fator** (senha certa não abre sessão; TOTP tem bloqueio progressivo próprio);
- conta **sem 2º fator**: bloqueio por e-mail preservado (a senha é a única defesa);
- ≥ 20 falhas somadas de várias redes ⇒ **alerta** `usuario.login_suspeito` (1/h por conta), nunca bloqueio;
- resposta externa idêntica (não revela MFA/owner); resíduo: quem tiver ≥ 6 redes pode distinguir conta protegida (bloqueio
  por rede × por e-mail) — custo alto, aceito.
Risco residual: quem **já tem a senha** pode provocar bloqueio temporário (≤ 15 min) do TOTP do owner por falhas acumuladas.

## 11. Concorrência (cada caso com teste; sem sleep/retry)

Bootstrap: 2 ativações do mesmo token (1 vence), 2/3 emissões (1 pendente), expiração durante a ativação, replay, token de outro
ambiente, falha no meio (rollback), owner surgido no meio. TOTP/recovery: mesmo código simultâneo (1 sucesso), mesmo código em 2
challenges (1 sucesso). MFA setup: 2 `begin` (1 pendente), 2 `confirm` (1 ativação), **ativação × login** (achado real: login
criava sessão pré-MFA depois de a ativação revogar as outras; corrigido com o lock da linha do usuário no login; prova determinística
e controle negativo). Step-up simultâneo (1 vence / sessão rotacionada derruba o outro). Login do owner × transferência de ownership.
Lock canônico: `users → platform_access → auth_challenges → mfa_methods → mfa_recovery_codes → sessions → audit`.

## 12. Auditoria (sem segredos; testado por varredura)

`plataforma.bootstrap_emitido|revogado|falhou`, `plataforma.owner_provisionado|owner_recuperado`, `mfa.desafio_emitido`,
`mfa.configuracao_iniciada`, `mfa.ativado`, `mfa.desativado`, `mfa.utilizado`, `mfa.tentativa_falhou`, `mfa.recovery_code_usado`,
`mfa.recovery_codes_regenerados`, `step_up.concluido|falhou`, `usuario.login_suspeito`. Nunca: código, segredo, hash, token, cookie, e-mail digitado.

## 13. Bug de infraestrutura encontrado no preview

`server/index.ts` repassava headers com `res.setHeader` uma a uma; `Set-Cookie` repetido **sobrescrevia** — a resposta de `mfa-verify`
(sessão + limpeza do challenge) perdia o cookie de sessão (login "funcionava" só na memória da SPA; recarregar deslogava). Corrigido
(`getSetCookie()` → array) com teste contra o Express real e controle negativo.

## 14. Pendências / decisões deliberadas

- Step-up aplicado só a org-status/regenerar/desativar (ver §8).
- Revogação de `platform_access` **não** remove a sessão (dívida da Fase 89): decisão — mantida por desenho: o privilégio é relido a cada
  requisição (403 imediato) e a sessão passa a valer como a de um usuário comum; nenhuma ação adicional necessária.
- Sem job de re-cifragem para rotação da chave MFA; gestão de segredos de produção (secret manager) continua adiada.
- Contraste do texto/botões primários sobre cartão escuro (~3,1:1) vem do Design System (abas "Entrar/Criar conta" têm o mesmo valor) — não alterado.
- Usuários comuns: MFA **opcional** (política atual preservada).

## 15. Fase 90.1 — acessibilidade, hardening e auditorias de fechamento

### 15.1 Contraste (WCAG 1.4.3: texto normal ≥ 4,5:1; texto grande ≥ 3:1)
**Investigação.** O "3,1:1" do relatório da Fase 90 era um **artefato de medição**: as transições CSS de cor ficavam congeladas na
metade quando a aba não pintava (screenshots expiravam), e o script lia a cor "de partida" (tema claro) sobre o fundo escuro. Com
transições desligadas, alfa composto sobre o fundo efetivo e cores normalizadas por canvas, os tokens reais do Design System dão:
`--primary` escuro `hsl(16,68%,56%)` sobre `--card` `hsl(20,18%,14%)` = **4,64:1** (4,61:1 medido nos botões/abas) — **já aprovado**; claro
`hsl(14,62%,45%)` sobre branco = 5,0:1. **Nenhum token global foi alterado.**

**Problemas reais encontrados (medição em todas as etapas, claro e escuro, 375/390/768) e correção local:**

| Elemento | Antes | Depois | Correção (escopo) |
|---|---|---|---|
| Mensagem de erro do login/cadastro ("E-mail ou senha inválidos") — texto `--error` sobre fundo `--error` 15 %, tema escuro | **3,41:1** | ≥ 4,6:1 (claro 4,8:1) | `.errorMessage` do `PasswordLoginForm`/`PasswordRegisterForm`: texto em `--foreground`; o erro segue sinalizado por fundo e borda `--error` |
| "Cancelar" e link "Usar um código de recuperação" no diálogo de step-up, tema escuro (acento sobre `--popup`) | 4,48:1 | ≥ 4,5:1 | `.dialogScope` (só dentro do `StepUpDialog`): `--primary: hsl(16,68%,61%)` no `.dark` |
| "Cancelar" do MFA como botão `ghost` (texto escuro sobre fundo escuro) | ilegível | 4,61:1 | `variant="outline"` (MfaCodeForm, StepUpDialog) |
| Alvo de toque do "Guardei estes códigos" | 32 px | **44 px** | `.check { min-height: 2.75rem }` |

Sem exceção de "texto grande" usada. Sem falhas após as correções: login, erro de login, MFA, erro de TOTP, recovery, erro de recovery,
bootstrap (token, token inválido — o expirado usa a mesma mensagem —, credenciais com avisos, início do TOTP, QR, erro de código, códigos de
recuperação) e step-up (diálogo e erro), em **375 escuro, 390 claro, 768 escuro/claro**. Fora do escopo de autenticação (não alterado): o selo
"concluida" da tela `/plataforma` mede 4,41:1 no tema escuro e o texto oculto "Close" do botão de fechar do `Dialog` do Design System.

### 15.2 Recovery codes em 375 px escuro (evidência visual real)
Fluxo completo no preview real (bootstrap → TOTP → códigos): título, aviso "somente agora", **os 10 códigos em coluna única, sem corte nem
overflow** (`scrollWidth` = 375 e cada item dentro da viewport, sem `scrollWidth > clientWidth`), "Copiar códigos" (44 px, 4,61:1), caixa
"Guardei" (44 px após a correção) e "Concluir" (44 px, desabilitado até marcar). Screenshot capturado da parte superior; a parte inferior foi
verificada por geometria (o recorte rolado do painel emulado desloca a imagem — artefato do painel).

### 15.3 Foco e teclado (verificado no preview com teclas reais)
Foco inicial no campo certo (`mfa-code`, `stepup-code`, token); ordem de tabulação: abas → campo → Cancelar → alternar modo (o "Verificar" desabilitado
sai da ordem até haver 6 dígitos); **Enter envia** o formulário de MFA (login concluído só com teclado); diálogo de step-up: foco preso dentro,
fecha com Esc e **devolve o foco ao botão que abriu** (correção: o diálogo é aberto por código após um 403, sem `Dialog.Trigger`; agora guarda e restaura o
elemento focado); rótulos associados (`label`/`aria-labelledby`).

### 15.4 Bloqueio do TOTP — auditoria e correção mínima
**Desenho (verificado no código e testado):** é um bloqueio **por usuário/método** (colunas `failed_attempts`, `last_failed_at`, `locked_until` da linha
de `mfa_methods`) — **não** por rede, **não** global. Contador: falhas dentro de 1 h; a partir de 10 ⇒ espera de 30 s dobrando até **15 min**; sucesso
(TOTP ou recovery) zera; falhas antigas deixam de contar; nunca permanente. Alcance: exige a senha (só existe challenge depois dela) e vale para
qualquer origem (várias redes somam no mesmo contador).
**Risco:** quem JÁ tem a senha pode manter o TOTP do dono bloqueado por ≤ 15 min por vez, repetidamente (custo: 2 logins por ciclo). Os dois
ajustes possíveis seriam novos subsistemas (chave por rede reabre o brute-force distribuído; limite global é outro mecanismo) — **não implementados**.
**Correção inequívoca (implementada):** o **recovery code não é barrado pelo bloqueio do TOTP e suas falhas não alimentam o contador do TOTP**;
um recovery bem-sucedido **limpa** o bloqueio. Assim o bloqueio de TOTP nunca bloqueia o único caminho de recuperação. Recovery continua limitado
por: 80 bits de entropia, 5 tentativas por challenge, 30 verificações/15 min por IP e 10 step-ups/15 min por usuário. Testes: TOTP bloqueado +
recovery válido ⇒ login permitido (handler real) e step-up por recovery; recovery inválido não piora o bloqueio; escopo por usuário/método.

### 15.5 Cobertura de step-up (plataforma) — classificação
| Endpoint | Risco | Step-up hoje? | Decisão |
|---|---|---|---|
| `platform-organizations_GET`, `sources_GET`, `background-tasks_GET`, `match-evaluations_GET`, `opportunity-registry_GET`, `audit-log-verify_GET` | baixo (leitura) | não | não precisa |
| `platform-organizations-status_POST` (aprova/suspende organização) | **alto** | **sim** | feito (Fase 90) |
| `sources_POST` (registra fonte) | médio | não | avaliar na Fase 91+ (precisa tratar `reauth_required` na tela) |
| `background-tasks-retry_POST` | médio | não | idem |
| `opportunity-registry_POST` / `-status_POST` / `-match_POST`, `opportunity-allocations_POST` (caminho de plataforma) | médio | não | idem |
| (trabalho em andamento fora do HEAD) `platform-automation-controls_POST` | alto | n/a | aplicar quando integrado |
| **Futuros (Fase 91)**: criar código de acesso, **revogar código**, alterar validade/política de códigos | **crítico/alto** | — | **devem ser considerados operações administrativas sensíveis e avaliados para `requireRecentAuth` (janela 10 min)**; conceder/revogar *Platform Admin* e **transferir ownership** (janela 2 min) idem |

Mitigação atual para os "médios" sem step-up: o titular só tem sessão com MFA concluído, ocioso 60 min, absoluto 8 h.

### 15.6 Exposição dos recovery codes (auditado; comportamento mantido)
Só existem em `mfa-setup-confirm`/`mfa-recovery-regenerate` (+ transação final do bootstrap); `mfa-status` devolve **apenas a contagem**; nenhum endpoint os
devolve de novo (teste de contrato varre `src`). No frontend: estado local do componente (`useState`), **sem React Query para a emissão** (a regeneração
usa `gcTime: 0` + `reset()` — corrigido: antes o resultado ficava no cache de mutações em memória), **sem localStorage/sessionStorage/persistência**
em todo `src`, sem `console`. Erros do cliente (`authRequest`) só carregam mensagem/status/código. Servidor: logs só com o **nome** do erro; auditoria
sem códigos (varredura nos testes). **Novo:** respostas de autenticação saem com `Cache-Control: no-store`. Não há "gravação de payload" de rede no produto.

### 15.7 Cookies e challenges (Express real)
Challenge: `levora_challenge=<43 chars>; HttpOnly; Secure; SameSite=Lax; Path=/_api/v1/auth; Max-Age≤300` (sem `Domain`), apagado com os mesmos
atributos (`Max-Age=0`). Sessão: `HttpOnly; Secure; SameSite=Lax; Path=/`. Respostas com dois cookies (sessão + limpeza do challenge, inclusive a
conclusão do bootstrap) chegam inteiras pelo Express real (teste HTTP com controle negativo). Nenhum endpoint de dados aceita o challenge
(cookie e segredo fora do `getServerSessionOrThrow`; testado). TTL 5 min, uso único, propósito/usuário conferidos, replay e expiração rejeitados,
concorrência controlada (testes da Fase 90).

### 15.8 Bootstrap — auditoria final (sem mudanças de código)
256 bits (`LEVB-` + 52 base32), HMAC com pepper versionado (nunca o token), TTL 15 min, uso único (UPDATE condicional), um pendente (índice único
parcial), claim atômico, transação final única (owner + MFA + token no mesmo COMMIT, rollback completo), recuperação só offline (CLI), nenhum segredo
em log/audit; o token trafega só no corpo do POST. Reexecutados nesta fase os testes de bootstrap (29) e a ativação pelo Express real.
