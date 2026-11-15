# Recuperação de acesso — especificação implementável (M50)

**Status: ESPECIFICAÇÃO. Nada deste documento está implementado. Nenhuma decisão do proprietário foi tomada.** Complementa `docs/CONTA_ESPECIFICACAO.md` §3 (que descreve o desenho geral) com o que falta para implementar sem nova rodada de descoberta. Não propõe nova plataforma de identidade: reaproveita `user_passwords`, `sessions`, `mfa_methods`, `mfa_recovery_codes`, `auth_challenges`, `platformBootstrap`, `identityKeys`, `passwordPolicy`, `auditLog`, `emailAdapter`.

## 1. Lacuna real (verificada no código)

| Situação | Hoje |
|---|---|
| Usuário comum esquece a senha | **sem caminho** (não há endpoint nem tela) |
| Usuário com TOTP perde o autenticador, **tem** códigos de recuperação | entra com um código de uso único (existe: `mfa_recovery_codes`, `mfa-recovery-regenerate`) e pode regenerar |
| Perde autenticador **e** códigos | **sem caminho** para usuário comum; nenhum administrador pode redefinir MFA/senha/sessão de outra conta (por desenho) |
| Titular de acesso de plataforma / Platform Owner | `npm run platform:owner-recovery` (CLI no servidor, token 256 bits, 15 min, uso único) |
| Conta só com login Google | recupera pelo provedor; Microsoft: novo cadastro desabilitado |
| Troca de senha com sessão ativa | existe (`password-change`: senha atual, step-up se MFA, revoga outras sessões, auditoria) |

Impacto: bloqueador de lançamento **para usuários de organizações que entram com senha**; não bloqueia o Platform Owner.

## 2. Alternativas

| | Descrição | Adequação | Dependências | Risco principal |
|---|---|---|---|---|
| **A — por e-mail (senha)** | link de uso único para o e-mail cadastrado | **recomendada** para senha | SMTP confiável (SPF/DKIM/DMARC), texto do e-mail, domínio | e-mail comprometido = conta comprometida; entregabilidade; enumeração se mal feito |
| **B — administrativa controlada** | pessoa da plataforma, após verificação de identidade **fora** do sistema, emite um token para o e-mail cadastrado | **recomendada só para MFA perdido** (e como contingência da A) | procedimento humano escrito, pelo menos 2 pessoas com papel (dupla autorização) | engenharia social; custo operacional |
| **C — só identidade federada** | usuário recupera pelo provedor | **não viável hoje**: apenas Google está integrado (Microsoft sem cadastro novo, não qualificada) e exclui quem não tem conta Google | provedor homologado | exclusão de usuários |

**Recomendação técnica (decisão do proprietário):** A para senha, condicionada à contratação/aprovação de SMTP; para MFA, manter os códigos de recuperação como caminho normal e adotar B (sem autoatendimento) para quem perdeu autenticador e códigos. Sem SMTP aprovado, o piloto fechado pode usar **B também para senha**, em escala pequena, com o risco operacional declarado. Nunca desativar MFA a partir de pedido não verificado; nunca criar "porta" administrativa que defina senha de terceiros.

## 3. Especificação da opção A (recuperação de senha por e-mail)

### 3.1 Persistência (migration `0041_password_reset_tokens.sql`, tabela nova vazia)
`password_reset_tokens(id bigserial pk, user_id int not null references users(id) on delete cascade, token_hash bytea not null unique, pepper_version smallint not null, created_at timestamptz not null default now(), expires_at timestamptz not null, used_at timestamptz, invalidated_at timestamptz, request_ip_hash bytea)` + índice parcial único `(user_id) where used_at is null and invalidated_at is null` (no máximo um token ativo por usuário). Token: 256 bits de `randomBytes`; só o HMAC (`hmacSecret`, novo contexto `password-reset:v1:` em `PepperContext`); versão do pepper registrada. Validade proposta: **30 min** (decisão de produto, não aprovada).

### 3.2 Endpoints (todos públicos, `POST`, corpo validado por `zod strict`)
1. `auth/password-reset-request` — corpo: `{ email }`. **Sempre** responde `202` com a mesma mensagem e forma, exista ou não a conta, esteja ela elegível ou não, tenha o envio funcionado ou não. Trabalho real após responder (ou em tempo constante): normaliza e-mail; busca usuário elegível (§3.4); invalida token ativo anterior; cria novo; envia e-mail **somente ao e-mail cadastrado**. Falha de SMTP: log seguro (`email_send` com `reason`), resposta inalterada, nenhum token exposto.
2. `auth/password-reset-validate` (opcional, melhora a tela) — `{ token }` → `{ valid: boolean }` sem distinguir motivo; não consome.
3. `auth/password-reset-confirm` — `{ token, newPassword, mfaCode? }`. Em **uma transação** (ordem canônica de locks `users → user_passwords → sessions → audit`, como `password-change`): consome o token com `UPDATE … SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND invalidated_at IS NULL AND expires_at>now() RETURNING user_id`; se a conta tem MFA ativo exige TOTP **ou** código de recuperação válido (mesmos limites de tentativa e mesma lógica do login; falha de MFA **não** consome o token... mas conta tentativa; esgotadas as tentativas o token é invalidado); valida `newPasswordSchema`; troca o hash; **revoga todas as sessões** do usuário; invalida outros tokens; auditoria; após o commit envia e-mail de aviso ("sua senha foi alterada"). Falha de qualquer tipo ⇒ mensagem única e genérica.

### 3.3 Interface
- Link "Esqueci minha senha" na tela de login → página `/recuperar-senha` (campo e-mail → mensagem fixa "Se houver uma conta com esse e-mail, enviaremos instruções.").
- Página `/redefinir-senha` lê o token do **fragmento** da URL (`#token=…`), remove-o do histórico (`history.replaceState`) e envia por POST; campos: nova senha (+ confirmação), código TOTP/recuperação quando a resposta de validação indicar MFA; estados: validando, formulário, enviando, sucesso (pede novo login), link inválido/expirado (oferece novo pedido). Acessibilidade: mensagens em `role="status"/"alert"`, foco no primeiro erro.
- `Referrer-Policy: strict-origin-when-cross-origin` já existe; a página de redefinição não carrega recursos de terceiros.

### 3.4 Elegibilidade e estados
Elegível: usuário ativo (não anonimizado), com linha em `user_passwords`, que **não** seja titular de `platform_access` (esses seguem o procedimento do owner). Contas só sociais não são elegíveis (a resposta pública continua idêntica). Estados do token: `ativo → usado | expirado | invalidado`.

### 3.5 Segurança
- Respostas indistinguíveis em corpo, status, cabeçalhos e **tempo aproximado** (teste de forma e de tempo).
- Limites: por IP e por e-mail normalizado (janela fixa), por token e por usuário para tentativas de MFA. **Atenção:** `checkRateLimit` atual é **em memória** (válido para um único processo); com mais de uma instância os limites precisam ser compartilhados (tabela/contador no banco) — decisão de arquitetura da implantação.
- Token só em fragmento, nunca em log, query string, auditoria ou resposta; e-mail transacional sem a senha e sem dados de organização.
- Reuso, expiração, novo pedido e uso concorrente: exatamente um uso vence (o `UPDATE` condicional garante).
- Idempotência: repetir `request` apenas substitui o token; repetir `confirm` com token já usado responde a falha genérica sem efeito.
- Auditoria (`usuario.senha_redefinicao_solicitada`, `usuario.senha_redefinida`, `usuario.senha_redefinicao_falhou`): ator = o próprio usuário (ou sistema), sem token, hash, senha ou e-mail completo; contagem de sessões revogadas.
- Sem contornar MFA; sem revelar se a conta tem MFA antes do token válido.

### 3.6 Dependências externas (não existem hoje)
SMTP aprovado e configurado (`SMTP_*`), remetente e domínio com SPF/DKIM/DMARC, texto jurídico/de marca do e-mail, política de retenção do registro de tentativas. **Não enviar e-mails reais antes da aprovação.** Em staging usar caixa de captura (ex.: servidor SMTP de teste local), nunca endereços reais.

### 3.7 Testes necessários (a implementar)
Unitário/endpoint (PostgreSQL real): resposta idêntica para conta inexistente/inelegível/elegível; token uso único, expirado, substituído, concorrente (2 usos simultâneos); MFA obrigatório e limite de tentativas; todas as sessões revogadas; senha antiga deixa de funcionar; auditoria sem segredo; log sem token/e-mail; falha de SMTP não altera a resposta; limites por IP/e-mail; conta de plataforma/social/anonimizada inelegível; migration (tabela nova vazia; `migrationCompat`); interface estática (`ui*` — fragmento do token removido do histórico, mensagens, foco); smoke em staging com SMTP de captura.

### 3.8 Critérios de aceite
Todos os testes acima verdes; `release:validate` integral verde em Node 22; revisão independente do módulo; homologação em staging com e-mail real **somente após** aprovação; nenhum aumento de superfície administrativa.

## 4. Especificação da opção B (recuperação administrativa controlada)

- **Quem:** apenas o Platform Owner, por **CLI no servidor** (mesmo desenho de `platform:owner-recovery`), nunca por endpoint web e nunca um administrador comum.
- **Verificação de identidade:** procedimento humano **escrito e aprovado pelo proprietário** (fora do sistema); o CLI exige registrar `--motivo` e `--verificado-por`.
- **Dupla autorização:** quando houver uma segunda pessoa com acesso de plataforma, um segundo aprovador confirma (reaproveitando o padrão de segunda aprovação); com um único owner, o procedimento é registrado como **risco aceito** pelo proprietário.
- **Efeito:** emite um **token de uso único e curto** (reaproveita `platform_bootstrap_tokens` com novo propósito `account_recovery` ou tabela própria) entregue **ao e-mail cadastrado** (ou, sem SMTP, ao titular por canal verificado fora do sistema); atraso de segurança configurável antes de valer (proposta: 24 h, **a decidir**) com aviso ao titular; ao usar: redefine senha (A) e/ou **reinscreve o TOTP** (desativa o MFA atual, revoga todas as sessões, exige nova inscrição e novos códigos no próximo login); auditoria (quem pediu, quem aprovou, quando, motivo; sem segredo).
- **Proteções:** limite de pedidos por conta; o aprovador nunca é o titular; contas de plataforma seguem o fluxo do owner; nada disso desliga MFA sem verificação.
- **Testes e aceite:** análogos a §3.7, mais teste de que o CLI recusa execução sem motivo/verificação e que o token não funciona antes do atraso.

## 5. Decisões necessárias do proprietário
1. Escolha: A (+B para MFA) × B para tudo no piloto. 2. Aprovação de SMTP e domínio de envio. 3. Validade do token e atraso de segurança. 4. Procedimento de verificação de identidade para B. 5. Aceitar ou não o risco de um único aprovador.

## 6. O que não fazer
Não redefinir senha de terceiros por administrador; não remover MFA por pedido não verificado; não enviar token por query string; não registrar token/e-mail completo em log; não reaproveitar o login social como substituto sem homologação do provedor.
