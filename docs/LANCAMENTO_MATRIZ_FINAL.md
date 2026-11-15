# Matriz final de lançamento, escopo fechado e critérios de homologação (M49)

**Estado:** preparação técnica local concluída; **nada está homologado em staging ou produção**. Evidências locais e sintéticas. Os PRs #30/#31 seguem Draft, sem CI remoto e sem revisão humana. Este documento não aprova merge nem deploy.

Estados: **CV** concluído e verificado · **NH** implementado, não homologado · **BL** bloqueado por decisão ou infraestrutura · **DT** defeito técnico pendente (nenhum conhecido ao final da M49).
Tipos de bloqueador: **A** implementado, falta validação · **B** implementação parcial · **C** capacidade não obrigatória · **D** decisão do proprietário · **E** contratação/configuração/autorização externa.

## 1. Bloqueadores informados na M48 — classificação objetiva

| Item | Tipo | Estado | Fato verificado | Próxima ação / critério de aceite |
|---|---|---|---|---|
| Revisão humana independente | E | BL | 0 revisões | Revisor aprova no GitHub após `REVISAO_INDEPENDENTE_PACOTE.md`; achados críticos zerados |
| CI remoto | E | BL | workflow `CI` `disabled_manually` (cobrança); 0 checks | Regularizar cobrança (proprietário) → reativar mediante autorização → checks verdes no head de cada PR. **Ver §5: o CI atual não roda no PR-2 enquanto a base não for `master`** |
| PostgreSQL gerenciado, domínio/TLS, monitoramento, papéis do banco | E | BL | só ensaio local; app escuta em todas as interfaces (proxy obrigatório) | Provisionar (decisão de fornecedor = proprietário); `__ready` 200, restauração testada no provedor, usuário da app sem superusuário |
| Backup/restauração na infraestrutura | A/E | NH | procedimento ensaiado localmente (contagens idênticas, cadeia 93/93, escrita pós-restore); arquivos têm backup separado | Repetir no provedor; RPO/RTO medidos |
| Rollback | A | NH | migrations sem "down"; rollback = restaurar backup anterior (ensaiado localmente) | Ensaio em staging com artefato anterior |
| ClamAV | A/E | NH | fail-closed provado por testes (indisponível/timeout/infectado/limpo/reanálise/concorrência); ClamAV real validado só localmente em 15–16/10/2026; reanálise automática existe (`retryFileScans`) | Serviço em rede privada; EICAR e arquivo limpo ponta a ponta no staging; alerta de idade das assinaturas (limiar = decisão) |
| Autenticação — cadastro/login/MFA/troca de senha/sessões | A | NH | smoke 13/13 e testes de sessão/MFA; recuperação do owner via CLI | Jornadas no staging com TLS (cookie `Secure`) |
| **Autenticação — recuperação de senha de usuário comum** | **B/D/E** | **BL** | **não existe** endpoint nem fluxo (especificado em `CONTA_ESPECIFICACAO.md` §3.1); sem SMTP aprovado; perda de MFA de usuário comum não tem recuperação | Resposta objetiva em §2 |
| Retenção/exclusão de dados | D (+J) | BL | conta: anonimização implementada; comprovantes/organização: sem rotina e sem decisão; ver `RETENCAO_DADOS_MATRIZ.md` | Decisão do proprietário + parecer jurídico antes de produção com dados reais |
| Políticas de agentes | D | BL | agentes em simulação; agendador de eventos desligado por padrão | Decisão explícita antes de qualquer ativação |
| Homologação visual | A | NH | gate visual desabilitado; 180 baselines não aprovadas (0 aprovadas) | Aprovação humana das baselines críticas |
| Acessibilidade | A | NH | teclado/foco verificados em Chrome/Edge; leitor de tela, contraste formal: não | Roteiro manual em staging |
| Carga | C/A | NH | não executada; uso esperado desconhecido | Definir volume esperado (D); teste proporcional em staging |
| Decisões de negócio (categoria, tolerância de quantidade, vinculação posterior, entrega física/prestação) | D | BL | defaults conservadores implementados | Ver §4 |

## 2. Se um usuário real perder a senha, como recupera o acesso?

**Hoje não há caminho seguro de autoatendimento.** Não existe "esqueci minha senha"; não existe procedimento para MFA perdido de usuário comum; nenhum administrador pode redefinir senha/MFA/sessão de outra conta (verificado no código e na documentação de identidade). O que existe: **troca** de senha autenticada; **recuperação do Platform Owner** por CLI (`npm run platform:owner-recovery`: token de 256 bits, 15 min, uso único); contas só com login Google continuam acessando pelo provedor.
**Classificação:** bloqueador para **usuários comuns com senha** (organizações), **não** para o owner da plataforma. Opções (decisão do proprietário):
1. **Recuperação por e-mail** (especificada, não implementada): exige SMTP aprovado, texto do e-mail e implementação da especificação (token HMAC de 30 min, uso único, MFA preservado). Recomendação técnica **se houver SMTP**.
2. **Procedimento administrativo controlado** pelo owner (CLI) com verificação de identidade fora do sistema, para uma versão inicial pequena (poucas organizações). Exige escrever e implementar o CLI (não existe para usuários comuns).
3. **Login social** como único caminho (Google) para a versão inicial; exclui quem não tem conta Google; Microsoft não está habilitada para novo cadastro.
Não declarar autenticação pronta para produção sem uma dessas opções aprovada.

## 3. Matriz de módulos

| Módulo | Estado | Impacto | Evidência | Aceite para homologação | Responsável | Dependência |
|---|---|---|---|---|---|---|
| Identidade, sessões, MFA, troca de senha | NH | alto | testes `identity*/mfa*/session*`; smoke 13/13 | jornadas reais com TLS | dev + QA | staging |
| Recuperação de usuário comum | BL | alto | inexistente | opção §2 aprovada e implementada | proprietário → dev | SMTP/decisão |
| Organizações, membros, convites, RBAC | NH | alto | `permissions`, `crossOrgIsolation` | revisão + jornadas | revisor/QA | revisão |
| Ofertas, necessidades, matching | NH | alto | `opportunityMatching*`, `matchingRuns` | jornadas em staging | QA | staging |
| Estoque/ledger, recebimento, destinação, estorno | NH | alto | `needFulfillment*`, `destination*`, `ledgerLockOrder` | revisão de concorrência | revisor | revisão |
| Prestação de contas | NH | médio | UI e testes de status | **não** é comprovação de entrega física | proprietário/QA | decisão §4 |
| Auditoria e cadeia | NH | alto | `auditChain*`, restore 93/93 | âncora externa (não configurada) é decisão | revisor/proprietário | decisão |
| Agentes (simulação) e controles | NH | médio | `agent*`, `schedulerControl` | permanecem desligados | proprietário | decisão |
| Arquivos + antimalware | NH | alto | `fileScan*` | ClamAV em staging | infra/QA | ClamAV |
| Observabilidade (logs, health, ready) | CV (local) | médio | `observability` + ensaio; **novo:** readiness exige chaves de identidade em produção | monitor externo consultando `__ready` | infra | provedor |
| Release/migrations/backup | CV (local) / NH (provedor) | alto | `release:validate`, `db-check` 24/24; ensaio M49 | repetir no provedor | infra | PostgreSQL gerenciado |
| Privacidade/retenção | BL | alto | matriz de dados | decisão + jurídico | proprietário | J |
| CI | BL | alto | desativado | verde em ambos os PRs | proprietário/dev | cobrança |
| Interface em navegadores | NH | médio | Chrome/Edge reais; Firefox/Safari não | matriz §6 | QA | staging |

## 4. Escopo do primeiro lançamento (proposta conservadora — **requer sua aprovação**)

**Indispensável para a finalidade central** (captar necessidades/ofertas, casar, registrar recebimento e destinação com rastro): identidade e RBAC, organizações/membros, ofertas e necessidades, matching, estoque/ledger, destinação com comprovante, auditoria, logs/readiness/backup, **um caminho de recuperação de acesso**, antimalware conectado se comprovantes forem usados.
**Pode permanecer desabilitado sem comprometer a finalidade:** agentes e agendador de eventos (simulação), login Microsoft, IA (`ANTHROPIC_API_KEY`), SMTP (convites mostram o link), âncora externa da auditoria, portal público.
**Expansão posterior:** vinculação posterior de oferta, categoria obrigatória, tolerância de quantidade configurável, confirmação de entrega física, reanálise com métricas, exclusão/retenção automática (só após decisão jurídica).
Nenhuma dessas condições vira política sem sua aprovação; nenhuma função prometida foi removida.

## 5. Plano de reativação do CI

- **Workflow existente:** `.github/workflows/ci.yml`, jobs `test` (postgres 16 de serviço: typecheck, `npm test`, build, build:server, `npm audit --audit-level=moderate`) e `qa-browser` (Chrome do runner, `qa:visual` perfil `ci`, `qa:security` com nginx real em Docker). Permissões: `contents: read` apenas; sem segredos; ações fixadas por SHA; imagens Docker fixadas por digest. Não envia nada a serviços externos.
- **Achado:** o gatilho `pull_request` só cobre bases `master` e `fase-**`. **O PR-2 (base `integracao/m32-m39`) não dispararia CI** antes de ser retargetado para `master`. Opções (decisão sua, não alterei workflow): validar o PR-1; após o merge do PR-1 retargetar o PR-2 para `master` (CI roda); ou, com autorização, incluir `integracao/**` nas bases do gatilho.
- **Outro risco:** o job `qa-browser` roda `qa:visual` sem baselines aprovadas; não sei como o perfil `ci` se comporta com 0 baselines aprovadas — pode falhar por razões do gate e não do código. Tratar a primeira falha como informação, não como regressão.
- **Verificação local do `npm audit`** (somente leitura, M49): 0 vulnerabilidades em todas as severidades (`m49-evidence/npm-audit.json`); isso **não** prova segurança.
- **Versão do Node:** os testes locais rodaram em Node v24.19.0; o projeto declara Node 22.x e o CI exige 22. A primeira execução do CI é a primeira prova em Node 22.
- **Como validar/repetir:** ao reativar, abrir/atualizar cada PR → conferir os dois jobs; falha de `test` = defeito do código; falha de `qa-browser` = ler `reports/qa-*.json`; repetir com "Re-run jobs". Nenhum job tem permissão para escrever ou publicar.

## 6. Matriz de homologação proporcional ao risco (staging)

| Fluxo | Navegador | Viewports | Verificar |
|---|---|---|---|
| Login/cadastro por código/logout | Chrome, Edge (Firefox/Safari se houver usuários nelas) | 375, 768, 1280 | cookie Secure, erro claro, sem enumeração |
| Oferta → matching → recebimento → destinação com comprovante | Chrome, Edge | 375, 1280 | saldo correto; comprovante só após análise |
| Estorno/correção com segunda autorização | Chrome, Edge | 1280 | duas pessoas distintas; auditoria |
| Plataforma (agentes, controles, tarefas) | Chrome | 1280 | agendador desligado; ações protegidas |
| Auditoria e prestação de contas | Chrome, Edge | 375, 1280 | sem dados de outra organização |
| Teclado/foco e leitor de tela nos fluxos acima | NVDA ou VoiceOver (execução real) | — | rotas, diálogos, erros |

## 7. Decisões do proprietário (poucas, as que destravam)

1. **Recuperação de acesso** (§2): e-mail (SMTP) × procedimento administrativo × social. *Recomendação:* e-mail se o SMTP for contratado; senão procedimento administrativo para o piloto. *Risco:* sem decisão, usuário que perde a senha fica sem acesso; procedimento administrativo não escala e exige prova de identidade.
2. **Retenção de comprovantes e encerramento de organização** (+ jurídico). *Recomendação:* decidir antes de dados reais; lançar piloto com aviso de que não há exclusão automática. *Risco:* acumular dado pessoal de terceiros; ou apagar evidência de prestação de contas.
3. **Estratégia de merge dos PRs empilhados** e gatilho do CI. *Recomendação:* merge commit do PR-1, depois retarget do PR-2 para `master`. *Risco do squash:* PR-2 volta a mostrar o conteúdo do PR-1.
4. **Escopo do primeiro lançamento** (§4), incluindo manter agentes/agendador desligados.
5. **Fornecedor e orçamento de infraestrutura** (PostgreSQL gerenciado, hospedagem, TLS, ClamAV). *Risco:* sem isso não há staging representativo.

## 8. Sequência mínima segura

1. Regularizar a cobrança → reativar o CI (autorizado) → checks do PR-1 → revisão humana do PR-1 (pacote) → corrigir achados.
2. Decisões 1, 3, 4 (e 2 antes de dados reais).
3. Se a decisão 1 exigir código: implementar a opção escolhida em cópia isolada, com testes, e atualizar o PR-1 por push normal autorizado.
4. Staging: provisionar (runbook `STAGING_PREPARACAO_M49.md`), ClamAV, smoke, jornadas §6, backup/restauração e rollback no provedor.
5. Merge controlado: PR-1 → `master`; retarget do PR-2; CI; revisão; merge.
6. Deploy autorizado com agendador desligado; monitorar `__ready`; piloto fechado.

## 9. Critério de encerramento do projeto

Todos os itens **BL** resolvidos ou aceitos por escrito; CI verde nos PRs; revisão independente aprovada; staging homologado com os fluxos de §6; backup/restauração e rollback ensaiados no provedor; decisões 1–5 registradas. Antes disso o produto não deve ser chamado de pronto para produção.
