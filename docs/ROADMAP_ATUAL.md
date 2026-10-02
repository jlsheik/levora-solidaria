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
| Equipe da organização | Convida, aceita, revoga, lista. **Não altera papel, não desativa, não sai.** | 13 endpoints `organization-*`; só `organization-members_GET` lê membros | **Seção 3** |
| Ledger de atendimento | Só linhas `original` são criadas; o schema aceita `correction`/`reversal` mas nenhum código as produz | `grep` em `endpoints/` e `helpers/`: nenhum produtor | Seção 4 |
| Discovery / conectores | Contrato `SourceConnector` + conector `manual`; nenhum conector real e **nenhum código chama `run()`** | `helpers/connectors*.tsx` (excluídos do build do servidor) | Seção 6 |
| IA | Apoio opcional no matching; sem chave configurada; agentes dos documentos (Scout, Outreach…) não existem | `aiClient.tsx` usado só em `opportunityMatching.tsx` | Seção 6 |
| Observabilidade | `__health`, logs, `background_task_runs`, auditoria; sem métricas nem alertas | `server/index.ts`, `docs/PRODUCTION_READINESS.md` §13–14 | Pós-MVP |
| Edição de dados | Cria, mas não edita: organização, necessidade (título/quantidade/prioridade), item de inventário, fonte | Inventário completo de endpoints (Fase 71) | Sem decisão registrada; levar ao dono quando surgir demanda |
| Autenticação de conta | Sem troca/redefinição de senha | `docs/SECURITY.md`, `docs/RATE_LIMITING.md` já registram | Seção 6 (depende de SMTP) |

## 3. PRÓXIMO — gestão de membros

Especificação completa em **`docs/MEMBROS_ESPECIFICACAO.md`** (Fase 72).
Alterar papel, desativar membro e sair da organização, com invariante de
"sempre ao menos um proprietário ativo". Não depende de nada externo e não
toca nas decisões congeladas (seção 8).

## 4. DECISÃO DE PRODUTO PENDENTE

Nenhum destes itens é bug; todos foram deliberadamente deixados para o dono
do projeto decidir (registrados em "instrução explícita" nas Fases 27–45).

| Item | Onde está registrado | O que falta decidir |
|---|---|---|
| Criar correção/reversão do ledger (estorno de recebimento) | `plano` L1678, L1766 | Quem pode estornar, o que acontece com o movimento de estoque e a oportunidade; interage com dupla aprovação |
| Política de excedente (recebido acima do necessário/alocado) | L1556, L2015 | Bloquear, alertar ou permitir; hoje `surplus` é só exibido |
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
