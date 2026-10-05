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
30 s dobrando até **15 min** (nunca permanente; falhas antigas deixam de contar; sucesso zera); TOTP e recovery compartilham o contador.
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
