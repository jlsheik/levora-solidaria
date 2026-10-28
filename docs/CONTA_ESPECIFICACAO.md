# Página Conta: o que existe, o que muda e a especificação de recuperação

> **Status:** branch `integration/conta-pr-20261020` (PR empilhado sobre `integration/identity-master-20261018`, PR #20). A branch original `integration/conta-20261018` (base `15561a0`) foi **preservada sem alteração**. **Não mesclada.** A seção 3 (recuperação de senha e de MFA) é **especificação**: **nada dela está implementado**. Nada foi validado em staging ou produção.

## 1. Origem e escopo

Origem: worktree local `levora-f88` (base `a628bd4`, 18 alterações **nunca publicadas**; cópia verificada em `levora-backup-ciclo0-20261018`). Importada sem alteração de lógica no primeiro commit; adaptada à identidade no segundo. **Nenhuma migration é necessária** (o trabalho original não cria objetos de banco; usa `sessions`, `user_passwords`, `users` e `audit_log`). Não reutiliza a 0014 nem qualquer número já usado.

## 2. Separação: já existe × falta

| Capacidade | Estado |
|---|---|
| Perfil: alterar o próprio nome (e-mail, papel e organização não editáveis) | **implementado** (`profile_POST`, `strict()`; auditoria sem gravar o nome) |
| Sessões ativas: listar as próprias, sem id real, IP ou user agent; agora com o **teto absoluto real** e o método de entrada | **implementado** (`sessions_GET`) |
| Revogar uma sessão (IDOR-seguro: o handle só resolve dentro das sessões do próprio usuário; a atual é recusada, use "Sair") e "sair de todas as outras" | **implementado** |
| Troca de senha autenticada: senha atual, política única (`passwordPolicy.tsx`), step-up recente se houver MFA, revoga as outras sessões, **rotaciona a sessão atual sem prolongá-la**, 5 tentativas/15 min por usuário | **implementado** nesta branch |
| Conta só com login social (sem senha) | troca recusada com 400 `sem_senha`; **definir uma senha inicial não existe** (precisa de especificação própria) |
| Atalho para `/seguranca` (TOTP e códigos de recuperação) | **implementado** (a gestão do MFA continua na página da identidade) |
| Notificação de segurança (e-mail) após troca de senha, revogação em massa ou mudança de MFA | **não existe** (só auditoria). Depende do SMTP |
| **Recuperação de senha (esqueci minha senha)** | **não existe**: especificada abaixo |
| **Recuperação de conta sem autenticador e sem códigos** | **não existe** para usuários comuns: procedimento administrativo especificado abaixo |

Mudanças em relação ao original (motivos nos commits): ordem canônica de locks (o original travava `sessions → users`, o inverso do login, ciclo de deadlock), step-up de MFA, rotação da sessão, política de senha compartilhada, `sem_senha`, listagem com teto absoluto.

## 3. Especificação (não implementada)

### 3.1 Recuperação de senha por e-mail
1. **Pedido** `password-reset-request_POST` (público): corpo só com o e-mail. **Resposta idêntica** (corpo, status 202 e tempo aproximado) exista a conta ou não; nada de "e-mail enviado para…". Limites por IP **e** por e-mail (janela fixa), com o mesmo desenho de `register`/`login`. Só envia para o e-mail **cadastrado** na conta; nunca para um endereço informado no pedido.
2. **Elegibilidade:** conta ativa (não anonimizada), **com** linha em `user_passwords`. Contas só com login social e titulares de `platform_access` **não** usam o autoatendimento (a resposta pública continua igual; o caminho deles é o procedimento da seção 3.3).
3. **Token:** 256 bits de `randomBytes`, **só o HMAC** com o pepper versionado (novo contexto `password-reset:v1:` em `PepperContext`), validade **30 min**, **uso único**, no máximo **um ativo por usuário** (um novo pedido invalida o anterior). Tabela nova `password_reset_tokens` (migration **≥ 0032**, a numerar quando houver implementação; `migrationCompat`: tabela nova vazia). O token vai **no fragmento da URL** (`/redefinir-senha#token=…`), nunca na query nem em log.
4. **Confirmação** `password-reset-confirm_POST`: token + nova senha (`newPasswordSchema`). Consumo atômico (`UPDATE … WHERE used_at IS NULL AND expires_at > now()`); falha com mensagem única. **MFA não é contornado:** se a conta tem TOTP ativo, a confirmação exige também o código TOTP ou um código de recuperação (mesmos limites de tentativa do login). Rate limit por IP e por token.
5. **Efeitos:** troca o hash, **revoga todas as sessões** (inclusive a de quem pediu, se existir), invalida outros tokens de reset, grava auditoria (`usuario.senha_redefinida`, sem token nem hash) e **notifica por e-mail** ("sua senha foi alterada; se não foi você…").
6. **Dependências:** SMTP configurado (`emailAdapter.tsx` existe, sem configuração no repositório), texto jurídico do e-mail, decisão sobre retenção do log de tentativas.
7. **Critérios de aceitação:** respostas indistinguíveis (teste de forma e de tempo), token inutilizável após uso/expiração/novo pedido, MFA obrigatório quando ativo, todas as sessões revogadas, auditoria sem segredo, concorrência (dois usos simultâneos: um vence), `qa:security` e testes negativos de enumeração.

### 3.2 Definir senha em conta sem senha (login social)
Não especificado nem implementado. Exigiria reautenticação da identidade do provedor (`accountReauth.tsx`) e MFA recente; fica para uma decisão de produto.

### 3.3 Perda do autenticador e dos códigos (procedimento administrativo)
- **Quem pode:** apenas o **Platform Owner**, pelo procedimento operacional (CLI no servidor, como o `platform:owner-recovery`), **nunca** um administrador comum de plataforma nem de organização, e **nunca** o próprio solicitante por autoatendimento.
- **Verificação reforçada:** prova de identidade **fora** do sistema (definida pelo responsável), conferida e registrada pelo owner; token de recuperação de **uso único e curto**, emitido para o e-mail cadastrado; atraso de segurança antes de ativar (ex.: 24 h, valor a decidir) com **aviso por e-mail** ao titular.
- **Efeito:** desativa o MFA atual, **revoga todas as sessões**, força nova inscrição de TOTP e novos códigos no próximo login; auditoria completa (quem pediu, quem aprovou, quando, sem segredo).
- **Proteções:** limite de pedidos por conta; o aprovador nunca é o próprio titular; operações sobre contas de plataforma exigem o fluxo do owner. **Dependências:** definição da verificação de identidade, SMTP, procedimento operacional escrito.

## 4. Validação desta branch

Ver o relatório do ciclo 4: testes da Conta (`userAccount`, `accountIdentity`), suíte completa, `typecheck`, build, `qa:visual`/`qa:security` e preview. Itens que dependem de serviço externo (OAuth real, ClamAV real, SMTP) **não foram exercitados**.
