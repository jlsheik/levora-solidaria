# Fundação de identidade — auditoria da Fase 89 (Fase 89.1)

Complementa `docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md` (§25). Nenhuma funcionalidade nova: este documento registra o
que foi **provado** sobre a Fase 89 (testes em `test/identity*.test.ts`) e o comportamento atual que a Fase 90 herda.

## 1. Flake de `impactReport` — causa e correção

| | |
|---|---|
| Teste | `test/impactReport.test.ts` › "1 necessidade/evento × 100 necessidades e 100 eventos: o MESMO número de consultas…" |
| Frequência medida | 1 falha em 27 execuções **isoladas** do teste (não depende de outro arquivo, de ordem, de paralelismo ou de estado residual) |
| Causa (capturada) | `getServerUserSession` executa, com probabilidade `CleanupProbability = 0,1` por requisição autenticada, `DELETE FROM "sessions" WHERE …` (coleta de lixo de sessões). Isso é **uma consulta a mais, aleatória, independente do tamanho dos dados**. Se cair numa das medições (small × big) e não na outra, as contagens diferem em 1 (observado: `expected 17 to be 16`, com a lista de SQL da medição mostrando o `delete from "sessions"` só na que deu 17). |
| N+1? | **Não.** O número de consultas de dados é constante (16 com 1 ou 100 necessidades/eventos). |
| Produto | Correto. A limpeza probabilística é deliberada (e já documentada); não foi alterada. |
| Teste | Incorreto: dependia de sorte. A medição agora fixa a aleatoriedade (`Math.random` ⇒ sem limpeza) **só dentro de `countQueries`**. As asserções (igualdade exata small = big; ≤ 24 consultas; filtros ≤ small) **não foram relaxadas**. |
| Prova da causa | Novo teste: com a limpeza forçada soma **exatamente +1** consulta (small e big), com ela desligada a contagem é a base; 10 repetições da mesma medição dão a mesma contagem. |
| Não usado | retry, sleep, aumento de timeout, `skip`, intervalo aceito. |

Esta era a mesma pendência "F85 — estabilidade do `impactReport`". Fechada.

## 2. Platform Owner — caminhos que poderiam inutilizá-lo

Busca global (`updateTable/deleteFrom` em `users`, `platform_access`, `sessions`, `user_passwords`; SQL cru; endpoints de
membership/organização). Operações **existentes** no HEAD desta fase:

| Operação | Owner único | Owner + outro admin disponível | Permitido? | Resultado (provado em teste) |
|---|---|---|---|---|
| Excluir conta (`account-delete`) | sim | sim | **Não** | 409 `plataforma_acesso_ativo`; nada alterado |
| Anonimizar (SQL direto) | sim | sim | **Não** | trigger `users_protect_platform_holder` |
| Desativar/sair de organização (membership) | sim | sim | sim, **sem efeito** | `platform_access` e login intactos |
| Suspender organização (plataforma) | sim | sim | sim, **sem efeito** | idem |
| Revogar acesso de plataforma | owner não revoga a si/outro owner (helper); SQL: trigger deferido | idem | **Não** | "último Platform Owner" |
| Rebaixar / apagar linha (SQL) | sim | sim | **Não** | trigger deferido / `platform_access_guard` |
| Transferir ownership | n/a (sem sucessor) | sim | sim, só a *admin* ativo | 1 owner antes e depois; concorrência: 1 vence |
| Revogar + promover sucessor na mesma transação (SQL) | — | sim | sim | aceito no COMMIT |
| Logout | sim | sim | sim | só encerra a sessão; novo login volta ao tier de plataforma |
| Expiração de sessão (60 min ocioso / 8 h) | sim | sim | sim | perde só a sessão; novo login funciona |
| Bloqueio de login (5 falhas/15 min por e-mail) | sim | sim | **temporário** | 429 mesmo com a senha certa; **termina sozinho**; não toca `platform_access` |
| Cadastro com o e-mail do owner | sim | sim | sem efeito | conta/senha/acesso inalterados |
| Troca de senha, logout global, suspensão/desativação de usuário, mudança de e-mail/role | — | — | **não existem** | teste afirma a ausência desses endpoints |

**Resposta:** não existe caminho atual que faça o único Platform Owner perder o acesso permanentemente ou chegar a 0 owners.
Risco residual **não** estrutural: o bloqueio de login por e-mail é um vetor de negação temporária (P-6 da §2 da
especificação); a Fase 90 troca por chave e-mail+IP/progressivo. Acesso direto ao banco (DBA) continua podendo tudo — fora
do modelo de ameaça de aplicação (os triggers protegem `platform_access`/`users`, não `user_passwords`/`sessions`).

### Invariante "exatamente 1 owner"
- **No máximo 1:** índice único parcial (`platform_access_single_active_owner`) — dois INSERT simultâneos: 1 vence.
- **Nunca 0 após existir:** trigger deferido `platform_access_keep_owner` (verificado no COMMIT; aceita a transferência).
- Teste de propriedade: 6 rodadas de operações concorrentes embaralhadas (conceder/revogar/transferir/excluir conta, por
  atores owner e não-owner) — após cada rodada: **1 owner ativo** e **nenhum titular ativo anonimizado**.
- Estado "0 owners" só existe **antes** do primeiro owner (banco novo ou migração sem admins) — é o estado que o bootstrap
  offline da Fase 90 resolve.

## 3. Migração 0015 — ordem exata

```
STEP 1  (só migração) pré-checagem: aborta se user_passwords tem usuário com >1 linha
STEP 2  users.anonymized_at (coluna) + (só migração) backfill: e-mail 'usuario-excluido-%@removido.invalid' ⇒ anonymized_at
STEP 3  enums platform_access_level/status; tabela platform_access (PK user_id, CHECK status×revoked_at, FKs RESTRICT)
STEP 4  índice único parcial "um owner ativo" + índice de consulta
STEP 5  tabela platform_state (singleton id=1) + linha inicial
STEP 6  trigger platform_access_guard (sem DELETE; user_id imutável)
STEP 7  constraint trigger DEFERIDO platform_access_keep_owner (só reage a UPDATE/DELETE — INSERT do backfill não o dispara)
STEP 8  (só migração) BACKFILL: conta admins ativos (não anonimizados)
          0 ⇒ nada; 1 ⇒ vira owner; >1 ⇒ exige levora.platform_owner_user_id, senão ABORTA
          INSERT owner (origem migrated_from_users_role) + platform_state.owner_bootstrapped_at
          os OUTROS admins NÃO recebem acesso (menor privilégio; ids no NOTICE)
          UPDATE users SET role='user' WHERE role='admin'   (inclui zumbis)
STEP 9  trigger users_forbid_admin_role (só agora: o UPDATE do STEP 8 nunca é barrado)
STEP 10 trigger users_protect_platform_holder (veto à anonimização de titular ativo)
STEP 11 sessions: absolute_expires_at (DEFAULT 30 d), primary_method, mfa_verified_at, last_reauth_at
        + (só migração) backfill: absolute = created_at + 30 d, primary_method = 'password'
STEP 12 user_passwords UNIQUE(user_id)
```

- **O trigger "nunca 0 owners" não bloqueia a migração:** é `AFTER UPDATE OR DELETE`, a migração só faz `INSERT` em
  `platform_access`; provado em banco SEM usuários e com 1 admin (e o trigger fica ativo depois).
- **Atomicidade:** o runner (`db/run-migrations.ts`) executa o arquivo numa transação. Provado: migração abortada (2 admins sem
  designação, designação inválida, senhas duplicadas) deixa colunas, tabelas, triggers, funções, enums e **dados** idênticos
  ao estado anterior (comparação por *snapshot*).
- `db/schema.sql` (banco novo) = o mesmo conjunto de objetos sem os trechos "só migração" — teste compara colunas, triggers e
  índices entre os dois caminhos.
- **Decisão (alinhada ao brief da 89.1):** com 2+ admins e designação, **só o designado** vira owner; os demais viram usuários
  comuns (menor privilégio), listados no `NOTICE`; o owner pode reconceder *admin* depois (auditado).

## 4. `users.role='admin'` — segunda fonte de verdade?

Busca em `src`, `server`, `db`, `scripts`, `test`, docs relevantes. Resultado:

- **Autoridade de plataforma:** somente `platform_access` (`requirePlatformAdmin`/`requirePlatformOwner`/`getServerUserSession`).
  O banco **recusa** `users.role='admin'` (trigger) e a migração zera todos.
- **Resíduos legítimos (não são autoridade):** (a) `User.role` ("admin"|"user") é **derivado** de `platformLevel` e existe só
  para o frontend (`AdminRoute`, botão "Operação de plataforma") — a autorização real é repetida no backend; (b) o enum
  `user_role` mantém o valor `admin` (remover um valor de enum exige recriar o tipo; o trigger o torna inalcançável) — remoção
  prevista numa fase de limpeza; (c) documentos históricos em `src/static/__dev/docs/*` (descrevem fases antigas).
- **Instruções operacionais atualizadas:** `docs/STAGING_DEMO.md` e `src/static/__dev/docs/status-implementacao.md` agora
  mandam conceder `platform_access` (o antigo `UPDATE users SET role='admin'` passaria a **falhar** pelo trigger).
- Frontend, seed de staging, helpers de teste e `needFulfillmentCorrections.test.ts` migrados para `platform_access`.

## 5. Sessão × `platform_access` (comportamento atual; lacunas da Fase 90)

- O tier (60 min/8 h × 7 d/30 d) é decidido **a cada requisição** pelo `platform_access` ativo — não é gravado na sessão.
- **Transferência A→B:** sessão de A segue válida e **continua no tier de plataforma** (A ainda é *admin* ativo); a de B vira
  *owner* na próxima requisição. Nenhuma sessão é invalidada.
- **Revogação de A:** o privilégio some **imediatamente** (403 em endpoint de plataforma; `platformLevel: null`), mas a
  **linha da sessão não é removida** — passa a seguir a política padrão (7 d ocioso). **Lacuna (Fase 90):** revogar/transferir
  deve rotacionar ou encerrar as sessões do usuário afetado.
- Ganhar acesso: a sessão ociosa há >60 min deixa de valer na hora (tier de plataforma).
- JWT válido + linha expirada ⇒ 401; JWT expirado + linha válida ⇒ 401; `session_GET` renova o cookie/ocioso, **nunca** o
  absoluto (Max-Age limitado ao que resta do teto).

### Dívidas de autenticação confirmadas (não alteradas na Fase 89/89.1)

**Revogação de `platform_access` não remove automaticamente a sessão existente.** A autorização de plataforma é
reavaliada por requisição; portanto a sessão deixa de ter acesso administrativo e recebe **403** nas rotas de plataforma
(comprovado em teste). A decisão sobre **revogação imediata** (encerrar ou rotacionar as sessões afetadas por mudança de
privilégio) fica para a **Fase 90**.

**O lock temporário de login por e-mail pode causar negação temporária de login do Platform Owner.** Cinco falhas em 15 min
bloqueiam o login daquele e-mail por 15 min, de qualquer origem (comprovado em teste: 429 mesmo com a senha certa; termina
sozinho; não toca `platform_access`). Esse comportamento pertence ao mecanismo de autenticação e será **revisado na Fase 90**.

## 6. Auditoria de login — o que cada mecanismo é

- **Deduplicação/limitação de VOLUME DA AUDITORIA** (não é rate limit de login): `usuario.login_falhou` só é gravado na
  1ª falha **de cada motivo** (`credenciais_invalidas` | `bloqueio_temporario`) por (e-mail digest, prefixo de IP) a cada 10 min (a falha comum não suprime o evento de bloqueio — bug encontrado e corrigido na 89.1 pelo teste de bloqueio) (`checkRateLimit` usado como porta de 1 evento — bucket
  `login-failure-audit`). Serve para um ataque de força bruta não inflar nem serializar a hash-chain.
- **Rate limit de login** (separado, inalterado): 20/15 min por IP + bloqueio 5 falhas/15 min por e-mail
  (`login_attempts`). Falhas **bloqueadas** também geram (no máximo 1) evento `bloqueio_temporario`.
- **Efeito colateral aceito:** só em memória (1 instância; reinício zera a porta e pode gerar 1 evento a mais). Sucesso e
  logout **não** são limitados (cada um gera 1 evento).
- Dados gravados: `{metodo, ipPrefix}` (+ `motivo` na falha). Nunca e-mail, senha, hash, token, cookie nem IP completo.
- Hash-chain: sucesso/falha/logout são o **último passo** da transação (lock global); 12 logins simultâneos e logins/logouts
  misturados mantêm a cadeia íntegra e sem deadlock.

## 7. `ipPrefix` (/24 IPv4, /48 IPv6)

- **Finalidade:** correlacionar tentativas de abuso por rede em investigação de incidente, **sem** gravar o IP completo
  (minimização, LGPD). Sem isso, `usuario.login_falhou` perderia a única pista de origem (`login_attempts` não guarda IP).
- **Retenção:** `audit_log` é append-only com hash-chain — não há exclusão; o prefixo vive tanto quanto o log. **Não há
  política de retenção configurável** (consistente com `docs/PRIVACY.md`); registrar como decisão futura junto da política de
  retenção da auditoria.
- **Exposição:** eventos de usuário têm `organization_id = NULL`; a única leitura de auditoria exposta
  (`audit-log_GET`, permissão `auditoria.leia`) filtra por organização ⇒ **não** devolve esses eventos; `audit-log-verify`
  devolve só integridade. Hoje o prefixo só é legível por quem acessa o banco. Não substituído por IP completo.

## 8. `rotateSession` — consumidores

Nenhum fluxo de produção do HEAD desta fase chama `rotateSession` (teste afirma isso). **Deliberado:** os consumidores
(troca/definição de senha, conclusão de MFA, vínculo/desvínculo de método, step-up) só existem a partir da Fase 90+; criar um
consumidor artificial agora seria funcionalidade nova. O login já gera **id novo** a cada autenticação (sem *fixation*). A função
é coberta por testes (id novo, antigo removido, `created_at`/absoluto herdados, 3 rotações simultâneas ⇒ 1 vence, sem sessões duplicadas).

## 9. Senha

`UNIQUE(user_id)` (concorrência: 1 de 3 inserções vence). Teto de **72 bytes UTF-8** no cadastro (mede bytes: 36×"é",
18×"😀" = 72 ✔; +1 byte ✘; vazia e <8 ✘). O login **não** impõe o teto: senha legada >72 bytes continua entrando; consequência
antiga do bcrypt (só os 72 primeiros bytes valem) agora é impedida de nascer e fica registrada em teste.
