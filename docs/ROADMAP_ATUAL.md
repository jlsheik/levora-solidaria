# Roadmap e estado atual — Levora Solidária

Criado na Fase 72, sobre o checkpoint `dbc4fe3` (Fases 1–70 concluídas,
407/407 testes). **Este documento reflete o estado real do código.**
`src/static/__dev/docs/plano-implementacao.md` continua sendo o **registro
histórico** de cada fase (o que foi feito, na ordem em que foi feito, com
os achados e decisões da época) e **não foi reescrito**: onde ele diverge
daquilo que está abaixo, vale este documento, e a divergência está mapeada
na seção 7.

Fontes cruzadas: o código (endpoints, helpers, schema, testes), o plano, as
decisões congeladas, `docs/*.md` e a auditoria da Fase 71. Nenhum item foi
incluído por parecer interessante: tudo abaixo vem de implementação real,
de uma decisão registrada, de uma pendência reconhecida em documento, de uma
dependência real ou de um bloqueio externo.

Classificações: **CONCLUÍDO · PARCIAL · PRÓXIMO · DECISÃO DE PRODUTO
PENDENTE · PENDENTE (dívida técnica) · ADIADO · BLOQUEADO · OBSOLETO ·
DOCUMENTAÇÃO DESATUALIZADA**.

## 1. CONCLUÍDO

| Item | Evidência | Próximo passo |
|---|---|---|
| Autenticação, sessão, bloqueio por tentativas, exclusão de conta (LGPD) | `endpoints/auth/*`, Fases 1, 18, 19, 48–52; `test/auth.test.ts`, `accountDelete.test.ts`, `authEnumeration.test.ts` | — |
| Multi-tenancy lógico e RBAC por permissão | `helpers/organizationAccess.tsx`, `permissions.tsx` (4 papéis × 19 permissões); `test/permissions.test.ts`, `crossOrgIsolation.test.ts` | Ver 3 (membros) |
| Organizações e aprovação pela plataforma | `organizations_*`, `platform-organizations-*`; `organizationStatusGate.test.ts` | — |
| Convites de membro por link/e-mail | `organization-invites*`, Fase 9; `organizationInvites.test.ts` | Ver 3 |
| Necessidades + progresso derivado (fulfilled/requiredRemaining/surplus) | `needs_*`, `helpers/needFulfillment.tsx`, Fases 2, 42 | — |
| Estoque por movimentações, dupla aprovação, baixa automática | `stock-transactions_*`, `approvals.tsx`, Fases 2, 7, 10; `stockTransactions.test.ts` | — |
| Ledger de atendimento (Modelo B) — **leitura, criação do `original` e integridade** | `need_fulfillments` + trigger de validação; Fases 29–34 | A criação de correção/reversão é decisão pendente (seção 4) |
| Resolução administrativa da necessidade | `need_resolutions` (`UNIQUE(need_id)`), Fases 38–40 | — |
| Registro central de oportunidades e fontes (manual) | `opportunity-registry_*`, `sources_*`, Fase 4 | Conectores: seção 6 |
| Matching 1.4 (determinístico + IA opcional) | `helpers/opportunityMatching.tsx`; limiares 90/70, reserva 30 min; Fases 5, 22–26, 43 | Congelado |
| Atribuições, decisão, logística, recebimento, conclusão | `allocations-*`, `opportunity-allocations_POST` (com `need_id`, Fase 45), `concludeOpportunity.tsx`, Fases 6, 27, 28 | — |
| Oportunidades por organização (modelo local) | `opportunities_*`, Fase 3 | — |
| Prestação de contas | `impact-report_GET` e tela `prestacao-contas`, presentes desde o import inicial; Fase 41 corrigiu o link de navegação; Fase 69 o overflow mobile | — |
| Auditoria imutável com hash-chain e verificação periódica | `audit_log` + triggers, `verifyAuditChain*`, Fases 1, 53 | — |
| Agendador (5 tarefas) com advisory lock e pools separados | `scheduler.tsx`, `scheduled-jobs.json`, Fases 12, 26, 62, 63; execução real do cron observada na Fase 69 | — |
| Upload/download de arquivos (disco local; S3 pronto, inativo) | `files-*`, `storageAdapter.tsx`, Fase 11 | — |
| Rate limiting pontual (em memória, processo único) | `rateLimit.tsx`, `docs/RATE_LIMITING.md`, Fases 13, 52 | — |
| Auditoria de segurança SEC-01…SEC-08 | Todos fechados: Fases 48–54 (confirmado em `plano` L2613) | — |
| Hardening HTTP, headers, erros classificados, timeout de IA | Fases 50, 64, 65 | — |
| Build de produção, CI com gates, backup/restore testado | Fases 54, 57–59, 66; `.github/workflows/ci.yml` | — |
| Staging zero-custo, seed sintético e qualificação do túnel | Fases 61, 62, 68–70; `docs/STAGING_*.md` | Teste por segunda rede: seção 6 |
| Frontend (11 rotas), responsivo 375/390/768 | `src/pages/*`; Fase 69 | — |

## 2. PARCIAL

| Item | Estado real | Evidência | Próximo passo |
|---|---|---|---|
| Equipe da organização | Convida, aceita, revoga, lista, **altera papel, desativa membro e sai da organização** (Fase 73). Falta: botão direto de reativação (hoje é novo convite) e encerrar/arquivar organização | `organization-members-{role,deactivate,leave}_POST`; `test/membershipLifecycle.test.ts` | Decisões P-5/P-6 (seção 4) |
| Ledger de atendimento | Só linhas `original` são criadas; o schema aceita `correction`/`reversal` mas nenhum código as produz | `grep` em `endpoints/` e `helpers/`: nenhum produtor | Seção 4 |
| Discovery / conectores | Contrato `SourceConnector` + conector `manual`; nenhum conector real e **nenhum código chama `run()`** | `helpers/connectors*.tsx` (excluídos do build do servidor) | Seção 6 |
| IA | Apoio opcional no matching; sem chave configurada; agentes dos documentos (Scout, Outreach…) não existem | `aiClient.tsx` usado só em `opportunityMatching.tsx` | Seção 6 |
| Observabilidade | `__health`, logs, `background_task_runs`, auditoria; sem métricas nem alertas | `server/index.ts`, `docs/PRODUCTION_READINESS.md` §13–14 | Pós-MVP |
| Edição de dados | Cria, mas não edita: organização, necessidade (título/quantidade/prioridade), item de inventário, fonte | Inventário completo de endpoints (Fase 71) | Sem decisão registrada; levar ao dono quando surgir demanda |
| Autenticação de conta | Sem troca/redefinição de senha | `docs/SECURITY.md`, `docs/RATE_LIMITING.md` já registram | Seção 6 (depende de SMTP) |

## 3. CONCLUÍDO (Fase 73) — gestão de membros

Implementada conforme **`docs/MEMBROS_ESPECIFICACAO.md`** (Fase 72): alterar
papel, desativar membro e sair da organização, com a invariante "sempre ao
menos um proprietário ativo" garantida sob lock da organização, nova
permissão `propriedade.gerencie` (só proprietário), aceite de convite que não
sobrescreve membro ativo (A2) e exclusão de conta com a regra de proprietário
único dentro da transação (A1). **PRÓXIMO**: plataforma de agentes, ver
`docs/AGENTES_ESPECIFICACAO.md` (Fase 1 daquela especificação).

## 4. DECISÃO DE PRODUTO PENDENTE

Nenhum destes itens é bug; todos foram deliberadamente deixados para o dono
do projeto decidir (registrados em "instrução explícita" nas Fases 27–45).

| Item | Onde está registrado | O que falta decidir |
|---|---|---|
| Criar correção/reversão do ledger (estorno de recebimento) | `plano` L1678, L1766 | Quem pode estornar, o que acontece com o movimento de estoque e a oportunidade; interage com dupla aprovação |
| ~~Política de excedente (recebido acima do necessário/alocado)~~ | L1556, L2015 | **DECIDIDA pelo dono (pós-Fase 94): PERMITIR**, sem bloquear a realidade física, excedente identificável na auditoria — ver §10 e `LEDGER_CORRECOES_ESPECIFICACAO.md` §AG |
| `unit_mismatch_note` | L1608 | `need_id=NULL` + nota (atual) ou `need_id` preservado com flag "não contabilizável" |
| Bloqueio de reaparecimento de organização recusada no matching | L1396 | Cooldown, bloqueio histórico ou nada |
| `raio_atendimento` × `proximidade` (dupla contagem quando a sede também é área) | L1161 | O seed demo reproduz o caso; exige mexer no Matching 1.4 |
| Outras ações de alto risco com dupla aprovação | L303 | Qual limite dispara a exigência em cada caso |

## 5. PENDENTE (dívida técnica) e ADIADO

| Item | Estado | Evidência | Observação |
|---|---|---|---|
| Valores mortos `aguardando_coleta`/`em_transporte` em `opportunity_registry_status` | PENDENTE | `plano` L149, L1399; sem uso no código | Remover exige migration e decisão |
| Coluna `sessions.expires_at` nunca lida | PENDENTE | L777 | A expiração real vem do `exp` do JWT |
| Gatilho de matching ao criar/editar necessidade | ADIADO | L238; `needs_POST` não dispara | O sweep a cada 15 min cobre parcialmente |
| Reenvio real de convite | ADIADO | L402 | Hoje é revogar + criar |
| Exclusão de arquivo / limite de armazenamento | ADIADO | L491 | — |
| Rate limiting genérico no Express | ADIADO | L574; confirmado em `server/index.ts` | Só limites pontuais |
| Customização de permissões por organização | ADIADO | L616 | Mapeamento é global |
| API v2 e coexistência de versões | ADIADO | L653 | Sem mudança de contrato pendente |
| CSRF/XSS em navegador real | ADIADO | L934 | — |
| Logística em etapas para oportunidades locais | ADIADO | L273 | Decisão deliberada |
| Tarefas de notificação e indicadores | ADIADO | L190 | Dependem de notificações, que não existem |
| `Input` com `width:100%` + `content-box` | PENDENTE | Fase 69 | Corrigir alteraria a altura de todos os campos |

## 6. BLOQUEADO

| Item | Bloqueio | Evidência |
|---|---|---|
| Produção | Domínio, certificado e Postgres gerenciado: investimento e decisão externos | `docs/PRODUCTION_READINESS.md` §20–21, Fase 60 |
| SMTP | Credenciais não configuradas; convites funcionam por link | `emailAdapter.tsx` |
| Redefinição de senha | Depende de SMTP para entrega real | `docs/SECURITY.md` |
| WhatsApp | Conta Business externa; nada existe no código | `docs/WHATSAPP.md` |
| Conectores externos (site público, Meta, X, e-mail, formulário) | Credenciais, políticas das plataformas e decisão de produto | `docs/correcao-arquitetura-01-descoberta-automatica.md` |
| Chave de IA | Não configurada; matching usa o fallback determinístico | `docs/AI_AGENTS.md` |
| **Teste do staging por segunda rede/aparelho** | Precisa de uma segunda origem; **ainda não realizado** | `docs/STAGING_DEMO.md` §7.1 |

## 7. OBSOLETO e DOCUMENTAÇÃO DESATUALIZADA

Mapa do que o `plano-implementacao.md` (commit `dbc4fe3`) ainda mostra e
que não vale mais. Números são linhas desse arquivo; os textos antigos
foram **preservados** como histórico.

| Onde | O que o plano diz | Realidade | Classificação |
|---|---|---|---|
| Título da Fase 1 (L22) e da Fase 5 (L166) | "EM ANDAMENTO" | Todos os itens relevantes concluídos em fases posteriores | DOC. DESATUALIZADA |
| L9–L20 | Restrição de plataforma "Floot" | O projeto foi portado para Node/Express/Postgres | DOC. DESATUALIZADA (contexto histórico) |
| L149, L154 | Logística/agendamento "não construídos" | Logística (Fase 6) e agendador (Fase 12) existem | DOC. DESATUALIZADA (o enum morto segue PENDENTE) |
| L159 | "Matching automático ainda não existe" | Existe: v1.4 | DOC. DESATUALIZADA |
| L241, L940, L1041 | Capacidade/raio e UI de configuração ausentes | Fases 22–23: modelagem e tela `matching` | DOC. DESATUALIZADA |
| L1126 | Item "não marcado" que apenas afirma o escopo da Fase 24 | Não é pendência | OBSOLETO |
| L1393, L1556 (parte), L1678 (parte), L1766 (parte) | "`needs.status` atualizado automaticamente" como decisão pendente | Fase 37 decidiu: é decisão administrativa, independente do ledger | OBSOLETO (decidido) |
| L1402 | Corrida em `receive → concluída` "fora do escopo" | `concludeOpportunityIfAllTerminalAndReceived` trava a linha do registro (`forUpdate`) | DOC. DESATUALIZADA (corrigida na Fase 28) |
| L1556, L1678, L2015 | `need_remaining` no matching e endpoint de progresso "não implementados" | Fase 42 (progresso) e Fase 43 (matching 1.4) | CONCLUÍDO |
| L2015 | Allocation manual → need "não implementada" | Fase 45 | CONCLUÍDO |
| L1831, L1907 | Compatibilidade física universal "não implementada" | Decisão arquitetural registrada, não pendência | Decisão CONGELADA |
| L2109 | Overflow horizontal do diálogo em ~375 px | Corrigido na Fase 69 | DOC. DESATUALIZADA |
| L2196, L2335, L2416, L2480, L2550 | "SEC-0x restantes" | Todos fechados (L2613) | CONCLUÍDO |
| L2257 | Pipeline de e-mail sem `trim()` | `login`, `register` e `invites` já usam `.trim()` (Fase 51) | CONCLUÍDO |
| "Fases seguintes (não iniciadas)" (L3538) | Itens 2–8 do master prompt como futuros | A maior parte foi feita; o que resta está nas seções 2–6 | DOC. DESATUALIZADA |
| "Como cada fase deve ser entregue" (L3567), item 2 | Atualizar `status-implementacao.md` | Substituído por este documento | DOC. DESATUALIZADA |
| `status-implementacao.md` | "Última atualização: fase 4"; lista como inexistente o que existe | Congelado em 24/09 | HISTÓRICO |
| `status-fase5.md` | Matching "versão 1.0"; sem testes automatizados; agendador "não observado" | Versão 1.4; 407 testes; cron observado | HISTÓRICO |
| `auditoria-descoberta.md` | Contrato em `helpers/connectors/types.tsx` | Hoje `helpers/connectorsTypes.tsx` | HISTÓRICO |

Correção a uma afirmação da Fase 71: `membership_status = inativo` **não está
sem uso** no código de negócio. `auth/account-delete_POST.ts` o **escreve**
(desativa todas as memberships do usuário) e os guards o **leem**. O que não
existe é qualquer fluxo de **gestão** que o defina.

## 8. Decisões arquiteturais congeladas (não reabrir sem evidência)

- **Matching 1.4:** limiares 90/70, reserva de 30 min, renormalização só
  entre critérios aplicáveis, unidades incompatíveis → `score:null`,
  elegibilidade por `requiredRemaining > 0`, desempate determinístico,
  avaliações antigas nunca reescritas.
- **Modelo B:** ledger append-only (`original`/`correction`/`reversal`),
  `is_countable`, FK composta por organização, saldo derivado e nunca
  persistido. `stock_transaction_id`: sem validação física universal, por
  decisão (Fase 34).
- **Necessidade:** `needs.status` é decisão administrativa, independente do
  ledger (Fase 37); `need_resolutions` com `UNIQUE(need_id)`.
- **Lifecycle:** `reservada`/`atribuida`/`concluida` só por atribuição,
  decisão e recebimento; conclusão exige tudo terminal e ao menos um
  recebimento.
- **Infraestrutura:** nginx same-origin, dois pools (3 + 5), shutdown
  gracioso, `errorResponse` classificado, gate de `build:server` no CI.

## 9. HISTÓRICO (permanece como registro, sem ser confundido com o estado atual)

`plano-implementacao.md` (Fases 1–70, achados e decisões da época),
`status-implementacao.md`, `status-fase5.md`, `auditoria-descoberta.md`,
`correcao-arquitetura-01/02`, e as seções "Estado original" dos documentos
de produção/staging. Cada um recebeu, na Fase 72, apenas um aviso no topo
apontando para este documento.

## 10. Fase 94 — conciliação do núcleo (estoque × ledger × prestação de contas)

Auditoria sobre `a628bd4` (worktree `levora-f94`, branch `fase-94-estoque-consistencia`; banco de teste descartável `levora_f94_test`, nenhum banco de desenvolvimento/produção tocado).

**Método.** Em vez de reler o relatório, `test/stockReconciliation.test.ts` executa 6 sequências determinísticas (semente fixa, 40 operações cada) pelos **endpoints reais** — recebimentos, correções positivas/negativas/de unidade, estornos contábeis e com retirada física, aprovações, lançamentos manuais — e recalcula cada invariante por **SQL independente** (sem os helpers do relatório): estoque (Σ delta × `inventory-items` × relatório × histórico; saldo nunca negativo em nenhum ponto do histórico), saldo inicial + movimentação = saldo final, ajustes da rede = ajustes ligados ao ledger, necessidades (hoje/fim/início+período, componentes recebido+correções+estornos, faltante/excedente — a sobra permanece contabilizada), cartões × listas × ledger (doações, correções, estornos contábeis × físicos), aditividade entre períodos adjacentes, histórico lista todas as linhas, 1 evento de auditoria por correção/estorno e por movimento manual, `original` preservado com sua entrada física. Cobertura real das sequências: de 5 a 15 correções com efeito físico, de 5 a 13 estornos contábeis e de 1 a 5 com retirada física por semente (mistura impressa e conferida). Controle negativo: quebrar 2 filtros do relatório derruba os 6 testes.

**Resultado da conciliação:** nenhuma divergência — estoque, ledger e relatório fecham em todas as sequências. Semântica conferida no código: reversão padrão contábil com retirada física opcional; correção positiva aparece como correção (não nova doação) e pode gerar excedente; correções/estornos exigem `logistica.gerencie` e redução de estoque passa por aprovação; os eventos do período levam ao histórico/auditoria da atribuição.

**Defeito comprovado e corrigido — quantidades fora de NUMERIC(12,3).** As colunas de quantidade são `NUMERIC(12,3)`, mas 5 pontos de entrada (`stock-transactions`, `allocations-receive`, `opportunities-receive`, `needs`, e também `opportunity-allocations`, `opportunities`, `opportunity-registry`) só validavam `> 0`. Evidência (teste que falhava): `0,0004` virava `0,000` no banco, violava o CHECK e respondia **HTTP 500** nos 5 caminhos testados; `0,0006` e valores com mais de 3 casas/acima de 999.999.999,999 não tinham contrato. **Correção:** `src/helpers/quantityRules.ts` (`positiveQuantity`, `nonZeroQuantity`: máx. 999.999.999,999 e no máx. 3 casas) usada pelos 7 schemas ⇒ **400 de validação, nada persistido**; valores válidos (0,001 … 999.999.999,999) seguem aceitos. Teste: `test/quantityPrecision.test.ts` (7).

**Decisão de produto (dono, pós-Fase 94) — IMPLEMENTADA:** a tabela "Movimentação por item" inclui o item quando ele (1) teve movimentação no período **ou** (2) tem saldo final ≠ 0 ao fim do período; sem movimentação e com saldo final zero continua fora. Implementação: o `HAVING` de `impactReport.tsx` ganhou `OR Σ delta (created_at < fim) <> 0` (menor mudança, mesma fonte `stock_transactions`); item só com saldo mostra movimentação do período = 0, saldo inicial = final = acumulado real (o saldo anterior não é movimentação), sem lançamento artificial e sem alterar cartões/totais. Tela: o texto vazio passou a "Nenhuma movimentação e nenhum saldo de estoque neste período." Testes: o teste da Fase 85 que documentava o comportamento antigo foi atualizado e `impactReport.test.ts` ganhou 4 testes (A com movimentação, B só com saldo, C saldo zero fora, D só movimento futuro fora; não-inflação de cartões/doações/Σ do período; reconciliação com Σ `stock_transactions` e ledger intocado; filtro por item; saldo que zera dentro do período) — controle negativo: remover a nova condição derruba 4 testes. Contrato: `docs/PRESTACAO_CONTAS_ESPECIFICACAO.md` §4.2.

**Flake investigado e corrigido (`impactReport.test.ts`, isolamento entre organizações):** falhou 1 vez em 2 rodadas completas e passava isolado. Causa comprovada: o teste procurava a substring `"999"`/`"555"` no JSON inteiro do relatório, e os timestamps (ms) e o horário de geração contêm esses dígitos ao acaso — com dados SEM nenhum 999/555, a checagem antiga casou em 3 de 400 relatórios (≈0,75%). Correção: asserção estrutural (as quantidades da org B não aparecem como números do relatório de A; strings/datas ignoradas). Sem retry, sem sleep.

**Segundo flake (`impactReport.test.ts`, contagem de consultas “sem N+1”):** falhou 1 vez em 4 rodadas completas. Causa por leitura do código: `getServerUserSession` faz uma limpeza oportunista de sessões com probabilidade `CleanupProbability = 0,1` (um `DELETE` a mais ao acaso); quando o sorteio caía em UMA das duas medições, `qBig ≠ qSmall`. Correção: o teste fixa `Math.random` só durante a contagem. 10 execuções seguidas estáveis; sem retry/sleep e sem relaxar a asserção.

**Continuação — validação de quantidade de ponta a ponta nos 4 caminhos restantes (pós-7d2110e).** `test/quantityEndpoints.test.ts` (98 testes, banco descartável `levora_f94_test`) chama os endpoints REAIS: `opportunities-receive` (`quantityReceived`, obrigatória, permissão `oportunidades.gerencie`), `opportunity-allocations` (`quantityAllocated`, obrigatória, só administrador da plataforma), `opportunities` (`quantityOffered`, opcional) e `opportunity-registry` (`quantity`, opcional, só administrador da plataforma). Por caminho: válidos 0,001 / 1 / 12,345 / 100 / 999.999.999,999 / string decimal `"12.345"` ⇒ 200 com o valor exato persistido; inválidos 0, −1, −0,001, 0,0004, 0,0006, 1,2345, 0,0015, 1.000.000.000, 1e12, 1e21, texto, `null`, string vazia, objeto, lista, `true` (e ausente nos obrigatórios) ⇒ **400** — nunca 500 — e snapshot idêntico de estoque, ledger, auditoria, atribuições, oportunidades e registro, com status da oportunidade/descoberta intacto; sem permissão ⇒ 403 mesmo com valor válido. Diferença intencional de contrato: nos opcionais, quantidade ausente é aceita (grava NULL).

**Dois defeitos reais descobertos por esses testes e corrigidos:** (1) `z.coerce.number()` aceitava `true` como 1 (e `null`/`""` como 0 sem erro de tipo): `quantityRules.ts` agora faz parsing ESTRITO (número ou string decimal; rejeita boolean, null, lista, objeto, vazio, hexadecimal e notação científica). (2) Aritmética binária em `number`: na atribuição, `0,1 + 0,2 > 0,3` recusava (409) uma atribuição que cabe exatamente no total da descoberta; e `computeNeedProgress` devolvia resíduos como `0,19999999999999998`. Correção mínima: `roundQuantity` (escala da coluna, 3 casas) em `opportunity-allocations_POST` (comparação e `available`), no `remaining` do `opportunityMatching` e em `computeNeedProgress`. Testes: `quantityEndpoints` (soma 0,1+0,2 numa descoberta de 0,3) e `quantityPrecision` (progresso 0,3−0,1=0,2).

**Mais 2 pontos de entrada com o MESMO defeito, achados ao auditar os schemas restantes e corrigidos:** `inventory-items_POST` (`initialQuantity`, opcional, ≥ 0 — grava a entrada de estoque inicial) e `organization-capacities_POST` (`maxCapacity`, obrigatória, ≥ 0). Antes: `0,0004` ⇒ HTTP 500 (no cadastro do item a transação inteira falhava) e `true` ⇒ aceito. Correção: `nonNegativeQuantity` (zero permitido). Testes no mesmo `quantityEndpoints.test.ts` (agora 140): inválidos ⇒ 400 com item/capacidade NÃO criados, estoque e auditoria idênticos; `0`/ausente ⇒ item sem entrada de estoque; válidos 0,001 … 999.999.999,999 ⇒ valor exato; sem `inventario.lance`/`organizacao.gerencie` ⇒ 403. Controle: com os dois schemas antigos, 22 desses testes falham (500 e 200 indevido). Limite de cobertura restante: o `needs-status` (baixa automática de estoque) deriva a quantidade do próprio estado e não recebe quantidade do cliente — sem entrada a validar; demais `z.coerce.number()` do repositório são inteiros/ids/limites (não quantidades de domínio).

**Política de excedentes — decisão do dono, implementada e provada (pós-b850eb4).** PERMITIR receber acima do alocado/necessário; ledger com o valor real, sem corte; `fulfilled`/`requiredRemaining`/`surplus` derivados do ledger; excedente não é nova doação nem migra de necessidade; permissões, dupla aprovação, motivo e auditoria intactos. Comparação com a implementação: tudo já estava implementado, **exceto** o indicador de excedente no evento de auditoria do RECEBIMENTO (`atribuicao.recebida` agora leva `needId`, `quantidadeAlocada`, `acimaDaAlocacao`, `excedenteAlocacao`, `excedenteNecessidade`, `progressoNecessidade`; correções/estornos ganharam `quantidadeAlocada`/`acimaDaAlocacao`/`excedenteAlocacao`). Testes: `test/surplusPolicy.test.ts` (13). Detalhes e matriz regra × prova: `LEDGER_CORRECOES_ESPECIFICACAO.md` §AG.

**Edição de dados — PRIMEIRO ESCOPO AUTORIZADO (pós-e8d6534): nome da organização. IMPLEMENTADO.** Somente `organizations.name`; nenhuma outra entidade/campo.
- **Regra:** só o **proprietário ativo** (permissão existente `propriedade.gerencie`, que o administrador não tem) de organização **com acesso liberado** (`status = ativa`, o mesmo guard das demais ações restritas; em análise/suspensa ⇒ 403). Permissão e membership relidas **sob o lock da organização** (proprietário rebaixado/desativado no meio da requisição não renomeia). Rate limit de 20/h por usuário.
- **Endpoint:** `POST organization-name` (`organization-name_POST.ts`/`.schema.ts`); corpo **estrito** `{ organizationId, name }` — qualquer outro campo (slug, tipo, status, cidade, estado, documento, proprietário, membros…) ⇒ 400. Texto: espaços externos removidos; 2–120 caracteres; sem caracteres de controle; vazio/só espaços/tipo inválido ⇒ 400. Nome igual ao atual ⇒ 200 `changed:false`, sem escrita e sem auditoria.
- **Auditoria:** `organizacao.nome_alterado` (entidade `organization`, ator = o proprietário, metadata só `{ nomeAnterior, nomeNovo }`), como último passo da transação.
- **Impacto verificado:** `name` é só exibição (lista de organizações, relatório, convites, candidatos do matching, auditoria histórica); o **slug** (identificador público) e a elegibilidade do matching não dependem dele; não há índice único no nome. Estoque, ledger, necessidades e membros ficam intactos (provado por snapshot).
- **Interface:** botão “Renomear” no cabeçalho da organização, **só para o proprietário de organização ativa**, abre `RenameOrganizationDialog` (contador, botão desabilitado se inválido/igual, “Salvando...”, erro inline com `role="alert"`, mensagem específica para 403/429). **Sem atualização otimista:** após o sucesso recarrega `["organizations"]` e a trilha de auditoria e só então fecha; o título vem do servidor.
- **Testes:** `test/organizationName.test.ts` (26, banco descartável): proprietário altera (campo a campo preservado, outra organização intacta, auditoria), listagem/relatório refletem, mesmo nome sem auditoria, dados operacionais intactos, duas renomeações simultâneas com auditorias encadeadas; administrador/operador/voluntário/sem vínculo/outra organização/proprietário inativo/em análise/suspensa/proprietário rebaixado sob lock ⇒ 403 (sem sessão ⇒ 401) sem efeito; 13 nomes inválidos e 9 campos extras ⇒ 400 sem efeito, limites 2 e 120 aceitos; contrato estático da interface. Controles: trocar a permissão por `organizacao.gerencie` ou remover `.strict()` derruba testes.
- **Preview real** (API+Vite locais, banco descartável, removidos depois): login → organização → Renomear; botão desabilitado com nome só de espaços; salvar `"  Associação Preview Renomeada  "` ⇒ título atualizado pelo servidor + toast de sucesso, slug/tipo/status/cidade/estado intactos e 1 evento de auditoria; com o proprietário rebaixado no banco, o diálogo permanece aberto com “Somente o proprietário ativo pode alterar o nome da organização”, nome e auditoria inalterados. Layout 375/390/768/desktop, claro/escuro, sem rolagem horizontal (um overflow de 2px do `Input` global no diálogo foi achado e corrigido).
- **Limites que continuam SEM autorização (nada implementado):** slug, tipo, status de aprovação, cidade, estado, documento, proprietário/membros, e a edição de **necessidades** (título, quantidade necessária, prioridade, unidade, item — impacta ledger/progresso e matching), **itens de inventário** (nome, unidade, categoria — a unidade condiciona a contabilização das linhas do ledger e o saldo) e **fontes** (conector, status, frequência). Para cada uma é preciso decidir campos editáveis, quem edita, aprovações, auditoria e o efeito sobre ledger/estoque/matching. Observação: o cadastro inicial da organização não impõe máximo de tamanho ao nome (só o mínimo); esta edição impõe 120 — alinhar o cadastro é decisão separada.

**Edição de dados — SEGUNDO ESCOPO AUTORIZADO (pós-bc74408): nome da fonte de descoberta. IMPLEMENTADO.** Somente `sources.name`.
- **Regra:** só administrador da plataforma autenticado (o mesmo `requirePlatformAdmin` do cadastro de fontes); sem aprovação adicional. Sem sessão ⇒ 401; usuário comum, operador e proprietário de organização ⇒ 403; fonte inexistente ⇒ 404. Rate limit de 30/h por usuário.
- **Endpoint:** `POST source-name` (`source-name_POST.ts`/`.schema.ts`); corpo **estrito** `{ sourceId, name }` — tipo, conector, endereço/método de acesso, credencial, organização autorizadora, permissões, notas de política, status, estado de conexão, frequência/limite/campos de execução, id, autor e datas ⇒ 400. O `UPDATE` só escreve `name` (a linha é travada com `FOR UPDATE`; uma escrita operacional simultânea, por ex. mudança de status, não é perdida). Texto: espaços externos removidos; 2–120 caracteres; sem controle; vazio/só espaços/tipo inválido ⇒ 400. Nome igual ao atual (após normalizar) ⇒ 200 `changed:false`, sem escrita e sem auditoria. **Limite coerente com a criação:** o cadastro só exige mínimo 2 e não tem máximo; fontes antigas com nome > 120 continuam funcionando em todo o sistema e podem ser renomeadas para um nome válido (só reenviar o mesmo nome longo é recusado).
- **Auditoria:** `fonte.nome_alterado` (entidade `source`, ator = o administrador, metadata só `{ nomeAnterior, nomeNovo }`; sem organização; nenhuma referência de credencial), último passo da transação — se a auditoria falhar a renomeação é desfeita (provado por teste).
- **Impacto verificado:** `sources.name` só é exibição (lista de fontes, lista de descobertas, atribuições da organização); conector, matching e execução usam `connector_key`/status, não o nome.
- **Interface:** na lista “Registro de fontes” da página de plataforma, um botão de lápis por fonte abre `RenameSourceDialog` (contador, botão desabilitado se inválido/igual, “Salvando...”, erro inline com `role="alert"`, mensagens para 403/404/429). **Sem atualização otimista:** após o sucesso recarrega `["sources"]` e `["opportunity-registry"]` e só então fecha; o nome mostrado é o confirmado pelo servidor. Nenhum dado operacional/credencial aparece (`sources_GET` nunca devolve `credentialRef`).
- **Testes:** `test/sourceName.test.ts` (25, banco descartável): administrador renomeia (todos os demais campos idênticos, outra fonte intacta, auditoria), mesmo nome sem auditoria, nome novo na lista de descobertas, listagem sem `credentialRef`, concorrência (auditorias encadeadas + status simultâneo preservado); 401/403 (comum, operador, proprietário)/404 e id inválido sem efeito; 13 nomes inválidos e 19 campos extras ⇒ 400 sem efeito, limites 2 e 120; fonte antiga com nome longo; atomicidade (falha na auditoria desfaz); contrato estático da interface. Controles: remover o guard ou o `.strict()` derruba testes.
- **Preview real** (API+Vite locais, banco descartável, removidos): renomear “Fonte manual” ⇒ lista mostra o nome confirmado, banco com só o nome alterado e 1 auditoria, `credential_ref` intacto e nunca exibido; com o administrador rebaixado no banco o diálogo mostra “Somente administradores da plataforma podem renomear fontes.” e nada muda. Layout 375/390/768/desktop, claro/escuro, sem rolagem horizontal.
- **Continuam SEM edição autorizada:** tudo o mais de fontes (tipo, conector, acesso, credencial, permissões, status/conexão, execução), os demais campos de organização, **necessidades** e **itens de inventário** (efeitos sobre ledger, progresso, estoque e matching a decidir separadamente).

**Edição de dados — TERCEIRO ESCOPO AUTORIZADO (pós-3e6397b): dados cadastrais da necessidade. IMPLEMENTADO.** Somente `needs.title`, `needs.description` e `needs.priority`.
- **Regra:** reaproveita `necessidades.gerencie` via `requirePermission` (proprietário, administrador e operador; voluntário não), sem aprovação adicional; mantém os guards de organização (em análise/suspensa ⇒ 403). Sem sessão ⇒ 401; usuário sem vínculo, voluntário, vínculo inativo e proprietário de OUTRA organização ⇒ 403; necessidade inexistente ou de outra organização ⇒ 404.
- **Endpoint:** `POST need-details` (`need-details_POST.ts`/`.schema.ts`); corpo **estrito** `{ organizationId, needId, title?, description?, priority? }` (≥ 1 campo; qualquer outro — `quantityNeeded`, `unit`, `itemId`, `status`, autor, timestamps — é rejeitado com 400). O `UPDATE` só tem essas 3 colunas.
- **Limites de texto (coerentes com a criação, `needs_POST`):** título 3–200 caracteres após `trim`, sem caracteres de controle; descrição até 2000, `trim`, vazio vira `null`, TAB/LF/CR permitidos. **Compatibilidade:** dados antigos fora do limite NÃO são alterados automaticamente; editar só outro campo de uma necessidade legada continua válido, pois só os campos enviados são validados.
- **Transação:** permissão + vínculo ativo relidos sob lock (`readActorUnderLock`), necessidade lida com `FOR NO KEY UPDATE` (lição da Fase 81: não conflita com o FOR KEY SHARE do recebimento ⇒ sem deadlock), `UPDATE`, auditoria como último passo. Valores normalizados iguais aos atuais ⇒ sucesso `changed:false`, sem escrita e sem auditoria.
- **Auditoria:** `necessidade.editada` (entidade `need`, organização, ator; metadata `{ alteracoes: { campo: { de, para } } }` só dos campos realmente alterados). Falha na auditoria ⇒ rollback (testado).
- **Não toca:** quantidade, unidade, item, status, ledger, estoque, saldo, recebimentos, alocações, resoluções (snapshot antes/depois nos testes).
- **Matching (analisado no código e provado em teste):** o motor lê a necessidade VIVA; `title` alimenta o `keywordScore` e `priority` alimenta `necessidade_urgencia` (40/65/85/100). A varredura periódica (oportunidades `aguardando_destinacao`, limite 20) reavalia com os dados editados; as linhas de `match_evaluations` já gravadas são snapshots imutáveis e NÃO são reescritas. A edição não dispara avaliação, reserva nem atribuição. **Defasagem documentada:** até a próxima varredura a avaliação exibida reflete título/prioridade antigos (o que foi avaliado na época); o diálogo avisa isso. Não há lacuna de cobertura; reavaliação imediata seria decisão de produto (não implementada).
- **Interface:** botão de lápis por necessidade (só com `necessidades.gerencie`) abre `EditNeedDialog` (valores atuais, validação no cliente só dos campos alterados, envia só o que mudou, “Salvando...”, erros 403/404/429 e genérico em `role="alert"`); após sucesso invalida `["needs", org]` e `["audit-log", org]` e recarrega do servidor, sem atualização otimista.
- **Testes:** `test/needDetails.test.ts` (35, banco descartável): papéis permitidos/negados, 17 entradas inválidas, 14 campos extras, limites, dados legados, no-op sem auditoria, atomicidade, concorrência (edição × status; edição × recebimento, 3 rodadas, ledger 120/estoque 120; duas edições encadeando auditorias), matching (avaliações antigas intactas; a nova usa urgência 100), `needs_GET` reflete o persistido, contrato estático da UI. 3 controles de mutação provaram que os testes têm dentes.
- **Preview real** (API+Vite locais, banco descartável, removidos): título `"  Cestas básicas — urgente  "` + prioridade Crítica ⇒ lista mostra o confirmado pelo servidor; banco só com título/prioridade alterados (300 kg, unidade e status intactos) e 1 auditoria com `de/para`; 375px sem overflow. (Os cenários 403 na UI, 768/desktop e tema escuro, inicialmente pendentes, foram verificados no fechamento de QA abaixo.)
- **Fechamento de QA da edição de necessidades (pós-57ea3bc) — nenhum código de produção alterado.** Ambiente: API+Vite locais em portas dedicadas, banco descartável `levora_f94_dev` e dados sintéticos, tudo removido depois; o `levora_solidaria` original não foi tocado.
  - **“Primeiro clique em Salvar com a lista de prioridade aberta” — causa real, NÃO é defeito do diálogo.** Reproduzido no navegador com log de eventos: com a lista aberta (esperando ≥ 2 s), `elementFromPoint` sobre o botão Salvar devolve o **overlay do diálogo**, e o `pointerdown`/`click` têm como alvo o overlay. Causa: o `DismissableLayer` do Radix (Select modal) coloca `pointer-events: none` inline no conteúdo do diálogo (camada abaixo) enquanto a lista está aberta (conferido: `style="pointer-events: none"` no `[role=dialog]`); o 1º clique fora cai no overlay e só FECHA a lista, como um `<select>` nativo. O 2º clique salva. Há uma janela transitória de poucos ms após abrir a lista em que o botão ainda recebe o clique (foi o que fez um clique imediato salvar), por isso o comportamento parecia intermitente. É o comportamento do design system para qualquer Select dentro de Dialog; contorná-lo exigiria mexer em camadas/ponteiros (e `setTimeout`/`modal`), com risco para foco e teclado. **Decisão: não alterar.**
  - **Teclado verificado de ponta a ponta (teclas reais):** Enter abre a lista, setas navegam, Enter escolhe e fecha a lista (foco volta ao seletor), Enter no botão Salvar salva — persistido no banco (prioridade `baixa`) com 1 auditoria nova. Escape com a lista aberta fecha só a lista e mantém o diálogo.
  - **Erro 403 na interface:** com o proprietário rebaixado a voluntário no banco (diálogo já aberto), Salvar mostra “Seu papel nesta organização não permite editar necessidades.” em `role="alert"`, o diálogo continua aberto e o banco **não muda** (mesmo título/prioridade, mesma contagem de auditorias) — coerente com o 403 real da API (`requirePermission`).
  - **Layout/tema:** 768px e desktop (1280px), claro e escuro, com o erro visível: sem rolagem horizontal, diálogo dentro da viewport, botões 40 px de altura; no escuro os campos têm fundo escuro e texto claro e a lista de prioridade tem fundo/texto corretos. Armadilha de método registrada: ao alternar `body.dark` num painel não desenhado, as *transições* CSS não avançam e os campos aparecem brancos (artefato de verificação, não defeito; com transições desligadas os valores computados são os corretos). A lista aberta do Select é mais estreita que o campo (estilo pré-existente do componente compartilhado, fora do escopo).
  - **Não verificado:** 375/390 px e tema escuro em 375/390 (só 375 claro na entrega anterior); leitor de tela; navegador diferente do embutido. O painel do navegador ficou intermitentemente “não desenhado”, então cliques por referência às vezes precisaram ser repetidos.
  - **Teste de regressão (sem dependência nova):** o repositório não tem ambiente DOM/jsdom/Playwright, e jsdom não reproduz o teste de acerto (hit-testing) de camadas, então a interação visual em si não tem teste automatizado — fica registrada aqui. Em `test/needDetails.test.ts` (agora 37 testes) foram adicionados: contrato estático (Select compartilhado do Radix; escolher a opção só altera o estado local; `<form onSubmit>` + `<Button type="submit">` para o salvamento por teclado; **nenhum paliativo** — `onInteractOutside`/`pointerEvents`/`setTimeout`/`modal=` e `pointer-events`/`z-index` no CSS do diálogo) e um teste de endpoint de edição **só da prioridade** (o que o seletor produz) que persiste e mantém título/descrição.
- **Continuam SEM edição autorizada:** quantidade, unidade, item vinculado, status, estoque, fonte operacional, aprovação, demais campos de organização e **itens de inventário**. Próximas decisões de produto (nenhuma implementada): edição de quantidade/unidade/item/status de necessidade e itens de inventário (efeitos sobre ledger/progresso/estoque/matching); limite do recebido ao alocado/necessário (§4).

**Manutenção:** `package-lock.json` — `source-map-js` 1.2.1 → 1.2.2 (GHSA-68fv-2mgg-jv7q, só dev/build; mesma correção já validada na Fase 93.1) para o `npm audit` ficar em 0 nesta linha.

**Lacunas restantes (nenhuma bloqueada por decisão humana além da observação acima):** limite do recebido ao alocado/necessário segue sendo decisão pendente (§4); edição de dados (§2).
