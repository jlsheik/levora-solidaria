# Recuperação de acesso — especificação implementável (M50)

**Status (F1): a opção A (recuperação de senha por e-mail) está IMPLEMENTADA LOCALMENTE e VERIFICADA com transporte de e-mail SINTÉTICO; NÃO está homologada.** Nada foi enviado por SMTP real: o uso real continua bloqueado até haver SMTP aprovado, domínio verificado e homologação do fornecedor. A opção B (recuperação administrativa excepcional, inclusive de MFA perdido) continua apenas especificada, **não implementada**, e depende de política de verificação de identidade aprovada pelo proprietário. Ver §7 (o que a F1 implementou e como difere do plano).

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

## 7. Implementação F1 (opção A) — o que existe e onde

| Item | Onde |
|---|---|
| Tabela `password_reset_tokens` (migration `0041`, tabela nova e vazia; só `user_id`, HMAC do token, pepper, expiração, uso/invalidação, tentativas) | `db/migrations/0041_password_reset_tokens.sql`, `db/schema.sql`, `db/migrationCompat.ts` |
| Regras (token, URL, elegibilidade, pedido, inspeção, confirmação, aviso) | `src/helpers/passwordReset.tsx` |
| Endpoints públicos `POST /_api/v1/auth/password-reset-request`, `-validate`, `-confirm` | `src/endpoints/auth/password-reset-*` |
| Telas `/recuperar-senha` e `/redefinir-senha`; link "Esqueci minha senha" no login | `src/components/PasswordReset*.tsx`, `src/pages/recuperar-senha.tsx`, `src/pages/redefinir-senha.tsx` |
| Transporte de e-mail sintético (`EMAIL_TRANSPORT=synthetic`, recusado em produção) | `src/helpers/emailAdapter.tsx` |
| Testes | `test/passwordReset.test.ts` (backend, 41), `test/uiPasswordReset.test.ts` (interface em runtime, 21) |

**Decisões de implementação (padrões de engenharia, a ratificar pelo proprietário):** token de 256 bits em base64url; **validade 30 min** (`PASSWORD_RESET_TTL_MINUTES`, 10–120); cooldown de 60 s por conta no banco; 5 tentativas de segundo fator por token; limites por IP (10 pedidos/15 min; 20 confirmações; 60 validações) **em memória** (um processo; IPv6 por /64) e, **no banco**, cooldown de 60 s e teto de 3 tokens por conta por hora (ver §8.2); retenção: tokens usados/invalidados/expirados há mais de 7 dias são removidos pelo próprio fluxo; link montado só com `APP_PUBLIC_URL` (https obrigatório em produção).

**Diferenças em relação ao plano:** (1) a resposta pública do pedido é idêntica e o trabalho (consulta, token, envio) roda **depois** da resposta; (2) sem transporte configurado o pedido **não cria token** e o log operacional traz o código `smtp_nao_configurado`; (3) o aviso "sua senha foi alterada" é enviado depois da troca (melhor esforço); (4) a confirmação cancela também os desafios de login (`auth_challenges`) pendentes; (5) uma nova abertura de link na mesma aba (mudança de fragmento) refaz a verificação.

**MFA:** o link não basta. Conta com TOTP ativo exige TOTP **ou** código de recuperação na confirmação (o código é consumido, uso único, como no login); falhas contam por token (5) e esgotam o link; o MFA **nunca** é desativado e os códigos **não** são regenerados; o login seguinte continua pedindo o segundo fator. Titulares de acesso de plataforma ficam **inelegíveis** (mesma resposta pública) e seguem o procedimento do Platform Owner. O login por e-mail bloqueado (5 falhas/15 min) **não** é zerado por uma redefinição (comportamento preexistente do login, não alterado).

**Limites desta implementação:** não há homologação com SMTP real nem de entregabilidade; limites em memória (um processo); recuperação administrativa de MFA não existe; o e-mail comprometido continua sendo o risco residual (mitigado: MFA exigido, sessões revogadas, aviso ao titular).

## 8. Endurecimento F2 (análise e correções)

### 8.1 Envio DEPOIS da resposta HTTP
- **Onde termina a resposta:** `password-reset-request_POST.ts` devolve o 202 genérico logo após validar o formato do e-mail e passar pelo limite por IP. **Onde começa o trabalho:** `scheduleResetWork(processResetRequest(...))` é chamado *antes* de retornar; a promessa é guardada num conjunto e **independe da conexão** (o cliente que fecha a conexão não cancela nada — testado).
- **Reinício do processo:** o trabalho em andamento termina no encerramento gracioso (`SIGTERM`/`SIGINT`: o servidor para de aceitar conexões, espera as requisições, **aguarda o envio pendente** e só então fecha o pool; limitado a 10 s). Queda abrupta entre a gravação do token e o envio deixa um **token ativo sem e-mail**: dentro do cooldown (60 s) não sai outro e-mail; passado o cooldown um novo pedido **substitui** o token e envia (testado). Não existe fila persistente nem retry automático **por decisão**: o próprio usuário reenvia (a tela tem reenvio controlado).
- **SMTP falha:** o token é invalidado (nunca fica válido sem mensagem), seja o transporte a devolver falha **ou a lançar exceção** (defeito encontrado na F2: a exceção deixava o token ativo; corrigido e testado). Sem transporte configurado, o pedido nem cria token.
- **Silêncio:** nenhuma exceção é engolida sem registro: `processResetRequest` nunca lança e devolve um desfecho; cada desfecho tem **um evento de log** `password_reset_request` com código seguro (`ok`, `ignorado: inelegivel|cooldown|limite_horario|smtp_nao_configurado`, `falha: ENVIO_FALHOU|APP_URL_INVALIDA|<código do erro>`), sem e-mail, token ou corpo da mensagem. Esses eventos permitem ao administrador diagnosticar (contagem por código) sem ver dados pessoais.
- **Duplicidade:** pedidos simultâneos para a mesma conta serializam no lock do usuário e o cooldown no banco deixa passar **um** e-mail e **um** token ativo (testado com 6 pedidos paralelos de IPs diferentes).
- **Conclusão:** adequado para o ambiente previsto (uma instância, volume baixo, o usuário pode reenviar). **Não** é entrega garantida: se for exigida, a evolução é uma caixa de saída (outbox) em tabela própria com reprocessamento — não implementada por não haver necessidade demonstrada.

### 8.2 Limites (rate limiting)
- **Em memória (por processo):** só o limite por **IP** (10 pedidos/15 min; 20 confirmações; 60 validações). Zera a cada reinício e, com N instâncias, vale por instância (N× o limite) — **não é global**.
- **No BANCO (vale entre reinícios e instâncias):** cooldown de 60 s por conta, **teto de 3 tokens por conta por hora** (os tokens ficam retidos 7 dias), 5 tentativas de segundo fator por token e bloqueio progressivo do método de MFA.
- **Medição (F2):** o limitador em memória custa ≈ 0,47 KB por identificador (1 M identificadores distintos ≈ 474 MB). Por isso o limite **por e-mail em memória foi removido** (um atacante que girasse e-mails inexistentes criaria um contador por e-mail) e o IPv6 passou a usar o prefixo **/64** como identificador (sem isso, girar endereços dentro de um /64 criaria um contador por requisição). IPv4 continua exato (agrupar em /24 puniria usuários atrás do mesmo NAT).
- **IP atrás de proxy:** o IP vem de `req.ip` (Express); **`TRUST_PROXY` precisa refletir o número real de proxies**. Sem ele, todos os usuários dividem o IP do proxy (um abusador esgotaria o limite de todos); valor maior que o real permite forjar `X-Forwarded-For`. Em produção, a ausência de `TRUST_PROXY` agora gera o aviso `proxy_trust: ausente_em_producao` no log de inicialização.
- **Implantação aprovada = uma instância** (o agendador também é de processo único): os controles acima são os compensatórios. **Se houver mais de uma instância:** os limites por IP precisam de um contador compartilhado — recomendação: tabela PostgreSQL de janela fixa com `INSERT … ON CONFLICT DO UPDATE` (sem Redis); **não implementado** (não há necessidade demonstrada no modo atual).
- **Limites conhecidos:** um atacante com muitos IPs distintos ainda pode pedir e-mails (cada conta recebe no máximo 3 por hora, 1 por minuto); a resposta é idêntica, então nada é enumerado; o 429 por IP independe de a conta existir. Um terceiro que peça 3 vezes por hora impede novos pedidos da própria vítima por até 1 hora (a vítima já recebeu os links; o último vale 30 min).

### 8.3 Parâmetros candidatos (continuam NÃO aprovados como política)
| Parâmetro | Valor | Avaliação | Alternativa |
|---|---|---|---|
| Validade do link | 30 min | coerente com o ciclo "pedir → abrir o e-mail → trocar" e com o teto de 3 tokens/hora; curto o bastante para limitar uso de link vazado | 15 min (mais seguro, mais reenvios) até 60 min (menos reenvios, mais janela) |
| Tentativas de 2º fator por token | 5 | com TOTP de 6 dígitos a chance de acerto por link é ≈ 5×10⁻⁶; o método ainda bloqueia após 10 falhas; código de recuperação (80 bits) é inviável de adivinhar | 3 (mais rígido; mais links perdidos por erro de digitação) |
| Cooldown | 60 s | igual à contagem da tela; evita inundação de e-mails | 30–120 s |
| Teto por conta | 3 tokens/hora | permite ~2 erros de reenvio sem abrir espaço para inundação | 5/hora |
| Retenção do token | 7 dias | tempo curto para diagnóstico; a auditoria já registra o evento | 1–30 dias |
Nenhum foi alterado; a aprovação é do proprietário.

### 8.4 Exposição do token pela interface
O token vai no **fragmento** da URL, que o navegador **nunca** envia ao servidor, a proxies nem no cabeçalho `Referer` (inclusive para a folha de fontes do Google Fonts, que é a única requisição a terceiro; a CSP é `script-src 'self'`). Não há scripts de terceiros, analytics ou telemetria na aplicação, e nenhum código lê `location.href`/`document.referrer` para enviá-lo. Depois de montar, a tela substitui a URL (`history.replaceState`), removendo o fragmento da barra de endereço e da entrada atual do histórico. **Isto não elimina todos os riscos:** o navegador pode ter registrado a URL original no histórico/sincronização antes do script rodar; extensões do navegador e o cliente de e-mail (inclusive scanners de links, que só fazem GET e não executam o script) enxergam o link; o e-mail em si é o ponto fraco. Mitigações: uso único, validade curta, MFA exigido, aviso ao titular e revogação de sessões.

### 8.5 Invariantes e onde são provados
| Invariante | Teste |
|---|---|
| fonte criptográfica, 256 bits, imprevisível | `passwordReset.test.ts`: "só o HMAC…256 bits…" e "dois pedidos produzem tokens diferentes" |
| persistência segura (só HMAC, pepper versionado) | idem; restrições do banco |
| uso único; reutilização rejeitada | "uso único: reutilizar o link…" |
| expiração | "token expirado…" |
| invalidação atômica e duas confirmações simultâneas | "concorrência: duas confirmações simultâneas…" |
| conta privilegiada não recupera | "titular de acesso de plataforma…", "o Platform Owner também é inelegível" |
| sem enumeração | "responde de forma idêntica…", "a resposta NÃO espera o envio", pedidos de e-mails inexistentes |
| sessões revogadas; desafios pendentes cancelados | "revoga TODAS as sessões…" |
| MFA continua exigido; código de recuperação uso único/não regenerado; anti-replay | grupo "MFA preservado" |
| sem token em logs; URL protegida | "logs de todo o fluxo…", "URL do link: validação de origem" |
| nenhuma alteração de senha em falha parcial | F2: "falha na auditoria no meio da confirmação…" |
| regressões F1: StrictMode; estado antigo ao abrir outro link; TOTP/código consumido com senha igual | `uiPasswordReset.test.ts` (renderiza em StrictMode; "abrir OUTRO link…"; "reabrir o MESMO link…") e "senha igual à atual com MFA: 422 e NADA é consumido" |
