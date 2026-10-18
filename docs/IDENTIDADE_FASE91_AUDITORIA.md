# Códigos de acesso e provisionamento controlado de contas — Fase 91

Implementa §25 (códigos de acesso) da `docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md` sobre a Fase 90.1 (`0fd9ff4`).
**Fora de escopo (e não implementado):** Google/Microsoft/Apple, OAuth/OIDC, login social, account linking, recuperação de senha,
SMTP, emissão em lote, código por organização. **A Fase 90 não foi reaberta** (TOTP, recovery, challenges, bootstrap, step-up,
sessão e lock de login ficaram intocados; o step-up é o mesmo `requireRecentAuth` de 10 min).

**Regra congelada:** nenhuma conta nova da plataforma é criada sem um código de acesso válido emitido pela plataforma. O código
**não é senha, login, MFA nem recovery** — só autoriza o *provisionamento* de uma conta.

## 1. Arquitetura

```
PLATFORM ADMIN (owner|admin, MFA + step-up) ──► platform-access-codes-create ──► registration_access_codes (HMAC + last4)
        │                                                                          └─ texto puro devolvido UMA vez
        └──► platform-access-codes-revoke / platform-access-codes (lista mascarada)

cliente ──► access-code-check (público, leitura pura, não consome)
        └─► register_with_password ──► provisionUserWithAccessCode(código, createUser)
                                          TX: SELECT … FOR UPDATE do código → ativo? → createUser(trx) → UPDATE condicional
                                              (redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now) → audit (último)
                                          qualquer falha ⇒ ROLLBACK (nem conta órfã, nem código queimado)
```

`provisionUserWithAccessCode(rawCode, createUser, now)` **não conhece o método de autenticação**: o callback cria o usuário e a
credencial que quiser (hoje, senha; amanhã, um `signup_attempt` Google/Microsoft/Apple). Ver §11.

## 2. Modelo de dados (migration `0028_registration_access_codes.sql`, espelhada em `db/schema.sql`)

| Objeto | Função |
|---|---|
| `registration_access_codes` | `code_hash BYTEA UNIQUE` (HMAC-SHA-256 com `IDENTITY_CODE_PEPPER`, contexto `access-code:v1:`), `pepper_version`, `code_last4`, `label` ≤120, `created_by_user_id`, `created_at`, `expires_at`, `revoked_at/by`, `redeemed_at/by`, `organization_id` (reservado, ignorado na v1) |
| CHECKs | `expires_at > created_at AND ≤ created_at + 90 dias`; pares redeemed/revoked consistentes; `NOT (redeemed AND revoked)` |
| `users.registered_via_code_id` | `UNIQUE` + FK: **prova no banco** de "1 código → no máximo 1 usuário", independente do UPDATE condicional |
| índice único parcial em `redeemed_by_user_id` | 1 usuário resgata no máximo 1 código |

O estado é **derivado** (`deriveCodeStatus`): `redeemed` > `revoked` > `expired` (`now >= expires_at`) > `active`. Não há job de
expiração nem estado armazenado que possa divergir. A migration não toca em dados existentes (usuários anteriores e o owner do
bootstrap ficam com `registered_via_code_id` NULL).

## 3. Formato, canonicalização e armazenamento

- `LEV-XXXX-XXXX-XXXX-XXXX-XXXX`: 20 símbolos Crockford sem I/L/O/U = **100 bits** de `crypto.randomBytes` (sem contador/data/id).
- Canonicalização **única, no servidor** (`canonicalizeAccessCode`): maiúsculas; remove espaços e hífens; remove o prefixo `LEV`
  só quando sobram exatamente 20 símbolos; I,L→`1` e O→`0`; valida `^[0-9A-HJKMNP-TV-Z]{20}$`, senão `null`. Como o gerador nunca
  emite I/L/O/U, duas grafias só viram o mesmo código se forem o mesmo código. O frontend só deixa em maiúsculas (visual).
- Persistência: apenas o HMAC e os 4 últimos símbolos. O texto puro **nunca** vai ao banco, à auditoria, a logs ou à listagem.
  Exibição: `LEV-••••-••••-••••-••••-A7K2`. Perdeu o código ⇒ revogar e gerar outro (não há "mostrar de novo").
- Rotação de pepper: o lookup aceita todas as versões configuradas (`accessCodeHashes`).

## 4. Ciclo de vida

`ativo → utilizado | expirado | revogado` (terminais e mutuamente exclusivos). Validade escolhida pelo **servidor**: mínimo
**5 min**, máximo **90 dias** (CHECK no banco também); relativa (`expiresInMinutes`) **ou** absoluta (`expiresAt`), exatamente uma;
passado e "2099" são rejeitados. Revogação é terminal (nunca reativa); só incide em código ativo (409 caso contrário, 404 se o id
não existe). Validar **não consome**; só a transação que cria a conta consome.

## 5. Concorrência

| Cenário | Mecanismo | Prova |
|---|---|---|
| A senha+senha / B duas abas / C duas máquinas (20 cadastros simultâneos, e-mails/IPs distintos) | `FOR UPDATE` do código + UPDATE condicional + UNIQUE | exatamente **1** conta, 19 × 400, 1 evento `consumido` |
| D requisição repetida (mesmo e-mail/senha/código) | idem + UNIQUE do e-mail | 1 conta, 1 consumo |
| replay depois do sucesso | status `utilizado` | 400, nada criado |
| E cancelamento após validação | `access-code-check` é leitura pura | código segue livre |
| F revogação × consumo | ambos disputam a mesma linha; CHECK impede "revogado E utilizado" | 5 rodadas: um vence, invariantes mantidas; **determinístico**: revogação injetada entre o lock e o UPDATE ⇒ rollback total |
| G expiração durante o consumo | `expires_at > now` no UPDATE | determinístico: expira dentro da transação ⇒ rollback, código não queimado |
| H falha depois de criar o usuário / falha no UPDATE do código (trigger de teste) | transação única | sem conta órfã, sem código queimado, resposta 500 genérica, código reutilizável |
| I mecanismo futuro simulado (callback sem senha) | mesmo `provisionUserWithAccessCode` | 3 corridas (2 callbacks + 1 senha) ⇒ 1 conta |

Sem `sleep`/retry nos testes. Ordem de locks (`lockOrder.tsx`): `registration_access_codes` → inserts → `audit_log` (último).
Violação de unicidade dentro da transação é mapeada por `constraint_name` (`registered_via_code` ⇒ `utilizado`; senão `email_em_uso`).

## 6. Cadastro

`register_with_password` exige `accessCode`. O hash bcrypt é calculado **antes** de qualquer consulta (mesmo tempo para todos os
ramos). Resultados:

| Situação | Resposta |
|---|---|
| código inexistente / mal formado / expirado / revogado / utilizado | **a mesma** 400 `codigo_indisponivel` + mensagem única (`Cache-Control: no-store`) — o motivo exato só vai para a auditoria e para o painel |
| código válido, e-mail novo | 200 neutro; usuário `role='user'` (nunca `platform_access`, nunca MFA), `registered_via_code_id`, código consumido |
| código válido, **e-mail já existente** | **mesma** resposta neutra de sucesso (Fase 51, anti-enumeração); **nada** criado, **nada** consumido |
| sem código | 400 de validação |

Justificativa da resposta única: distinguir "expirado" de "inexistente" daria a quem tem posse de uma grafia errada/antiga um oráculo
de existência; a plataforma sabe o motivo (painel/auditoria) e a pessoa só precisa saber que deve pedir outro código.
Revisão de criadores de usuário (varredura estática no teste): `register_with_password_POST` (com código), `bootstrapFinalize`
(owner — exceção legítima, fluxo offline), `db/seedStaging.ts` (exceção interna, não é endpoint) e `createTestUser` (testes). O aceite
de convite **não** cria usuário.

## 7. Convites × códigos

São independentes. Convite não cria conta e não consome código; pessoa sem conta precisa de um código para criá-la e só depois
aceita o convite (com a sessão já existente). Um código não concede membership, nem papel, nem acesso à organização do convite.
O formulário de cadastro em `/convites/:token` herda o campo "Código de acesso".

## 8. Painel (`/plataforma` → "Códigos de acesso", `AccessCodesPanel`)

Listagem (mascarado, descrição, status, criado em/expira em/criado por/usado em/usado por/revogado em), filtros (situação, descrição/
final do código/usuário consumidor, período de criação), modal "Gerar código" (descrição + presets 1 h/24 h/7 d/30 d + data/hora),
confirmação do código **uma vez** com "Copiar código", revogação com confirmação, `StepUpDialog` com retry automático em
`reauth_required`. Cartões em coluna única no celular (sem tabela com scroll). Status = ponto colorido **+ rótulo escrito** sobre
`--surface` (contraste garantido; o `Badge` global `warning` dava 2,86:1 e não foi usado). O tema escuro usa escopo local
(`dialogScope`) no acento dos diálogos (4,48 → ≥ 5,1:1), sem tocar os tokens globais.

## 9. Step-up e autorização

`getServerUserSession → requirePlatformAdmin(user.id) → requireRecentAuth(session) → rate limit → parse`, **no backend**. Papel de
organização (owner/admin/operador), usuário comum, sem membership e ID manipulado nunca bastam; `platform_access` revogado perde o poder
na hora (relido do banco). Criar e revogar exigem step-up de 10 min; **listar não** exige. Não há segundo mecanismo de reautenticação.
Os testes dão step-up **fresco** a todos os atores negados para provar que é o gate de papel (e não o step-up) que barra.

## 10. Auditoria e rate limiting

Eventos: `codigo_acesso.criado {codeId, validadeMinutos, temDescricao}`, `.revogado`, `.consumido {codeId, criadoPorUserId,
usuarioId}`, `.tentativa_invalida {motivo, ipPrefix}` (máx. 1 por motivo+rede/10 min — não infla a hash-chain). **Nunca** gravam o
código, o hash, o pepper, token de bootstrap, senha ou segredo MFA (verificado em teste). Auditoria sempre por último na transação.

| Bucket | Limite |
|---|---|
| `access-code-check` (público) | 20 / 15 min / IP |
| `register` (existente) | 10 / h / IP |
| `access-code-create` | 30 / h / administrador |
| `access-code-revoke` | 60 / h / administrador |

Em memória (sem Redis), como o restante do projeto; o IP vem do mesmo `getClientIp` (anti-spoof da Fase 52).

## 11. Preparação para login social (sem implementar)

Fluxo futuro: `código de acesso → signup_attempt → (senha | Google | Microsoft | Apple)`. Nada em `registration_access_codes` depende
da senha; um provedor chama `provisionUserWithAccessCode(codigo, (trx, {codeId}) => { cria users + identidade; return userId })`
e herda a atomicidade, a unicidade, a resposta pública única e a auditoria. O teste "I" prova isso com um callback sem credencial.

## 12. Testes (`test/accessCodes.test.ts`, 33 testes + 2 em `identityMigration.test.ts`)

Formato/canonicalização/hash só no banco e fora da auditoria · CHECKs e UNIQUE · status derivado e limites de validade · matriz de
autorização (admin, owner, usuário comum, owner/admin/operador de organização, sem sessão, `platform_access` revogado) · step-up
(criar/revogar bloqueados; leitura livre) · revogação (200/409/404/400) · listagem e filtros · validação pública (não consome, resposta
única, rate limit, auditoria) · cadastro (válido, inválido, expirado, revogado, usado, sem código, e-mail existente, senha, código ≠
senha) · convites · concorrência A–I · varredura estática de criadores de usuário · migration 0017 (aplica sem tocar dados, atômica).

**Controles negativos** (verificados manualmente: o código foi quebrado e o teste correspondente **falhou**; depois restaurado):
remover o WHERE do UPDATE de consumo → 2 testes falham (F/G determinísticos); remover a UNIQUE → 2 falham; remover
`requireRecentAuth` (criar) → falha; (revogar) → falha; remover `requirePlatformAdmin` (criar) → falha; (listar) → 2 falham;
fazer o aceite de convite inserir em `users` → a varredura estática falha; remover UNIQUE + WHERE + `FOR UPDATE` → 4 falham.

## 13. Pendências

Emissão em lote (até 50, §25), código por organização (`organization_id` reservado), e-mail do código ao cliente (SMTP), expiração
agregada diária na auditoria, e aplicar `requireRecentAuth` aos demais endpoints de plataforma (já listado na Fase 90).

## 14. Fase 91.1 — hardening final (base `a6c237a`)

**Alfabeto e entropia (pelo desenho).** O gerador já sorteava de um alfabeto canônico: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 símbolos
distintos, sem I/L/O/U), 20 símbolos, um byte de `crypto.randomBytes` por símbolo. Como `256 % 32 = 0`, `byte % 32` é uniforme (sem viés de
módulo). Espaço = 32²⁰ = 2¹⁰⁰ códigos; entropia efetiva = 20 × log₂32 = **100 bits** (o prefixo `LEV` e os hífens são só apresentação).
Nenhum símbolo gerável é reescrito pela canonicalização (ela é a **identidade** sobre o alfabeto) ⇒ **nenhuma perda de entropia por
convergência**. Hash final: HMAC-SHA-256 (32 bytes) do valor canônico, contexto `access-code:v1:`, pepper versionado.

**Normalização.** `I`,`L`→`1` e `O`→`0` são a regra intencional (Crockford) e só atuam em símbolos que o gerador nunca emite; portanto dois
códigos canônicos diferentes jamais colidem (teste: mutando cada uma das 20 posições por cada um dos 32 símbolos, 20·31+1 saídas
distintas, todas idênticas à entrada). Achado corrigido: `toUpperCase()` é Unicode (`ı`→`I`, `ſ`→`S`) e criava apelidos de entrada que não
são grafias do código; a canonicalização agora **rejeita qualquer entrada não-ASCII** (espaços Unicode continuam ignorados como espaço).

**Cache.** A resposta que entrega o código completo (`platform-access-codes-create`) usa `Cache-Control: no-store` (HTTP real via Express).
Achado corrigido: as respostas de **erro** de `buildErrorResponse` (ex.: validação 400 do `access-code-check`) não tinham `no-store`; agora
têm (erros nunca são cacheáveis). O ETag fraco do Express é inócuo (no-store proíbe guardar a cópia). No cliente: o código vive só em estado
do componente (sem URL/query/rota/localStorage/sessionStorage/IndexedDB/histórico) e a mutação usa `gcTime: 0` (o React Query não retém o resultado).

**Exclusão de conta.** `account-delete` anonimiza (não apaga) o usuário: `registered_via_code_id` e `redeemed_by_user_id` permanecem, o código
continua `redeemed` (não valida, não cadastra) e um `DELETE` direto do consumidor é barrado pela FK. Exclusão nunca libera um código.

**Sessão/JWT.** O JWT só tem `{id, createdAt, lastAccessed}`; corpo do login, `loadUserPayload`/`User` e as tabelas de sessão/credencial/MFA/
challenge não referenciam o código; o código não funciona como senha. A existência do código termina no provisionamento.

**`access-code-check`.** Rate limit (20/15 min/IP) antes de qualquer consulta; resposta válida exatamente `{valid:true}`; inválidas com
corpo único `{message, code}` (inexistente/expirado/revogado/utilizado/mal formado idênticos); sem criador, consumidor, hash, datas,
organização ou descrição; sem `Set-Cookie`. Estados detalhados só no `/plataforma`. Testes: `test/accessCodesHardening.test.ts` (12).
