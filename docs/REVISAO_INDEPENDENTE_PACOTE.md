# Pacote para revisão técnica independente (PR #30 e PR #31)

**Não é uma revisão.** Este documento orienta um revisor humano independente; nenhuma aprovação foi dada nem simulada. Os PRs seguem Draft; sem merge, sem deploy, sem CI remoto (workflow `CI` desativado por cobrança).

| | PR-1 #30 | PR-2 #31 |
|---|---|---|
| Base ← head | `master` ← `integracao/m32-m39` | `integracao/m32-m39` ← `integracao/m40-m42` |
| SHA (M48) | `82d969120c9e20079f8355b9336d691624829de7` | `d6e6c30f18f4322ee06688bd1ac3a8dadc2f58b4` |
| Migrations | 0032–0038 (+0039–0040 chegam via PR-2) | 0039–0040 |
| Tema | plataforma, agentes, auditoria, integridade, operação | jornada de necessidades, ofertas, matching, destinação, prestação de contas |

**Dependência:** o PR-2 contém o PR-1 (merge `--no-ff`). Revisar o PR-1 primeiro; no PR-2 revisar só o diff próprio (`integracao/m32-m39...integracao/m40-m42`). Squash do PR-1 exige sincronizar o PR-2 antes do retarget.

## 0. Lista curta prioritária (M50) — o que um profissional técnico deve examinar primeiro

1. **Autenticação/MFA/sessões:** `src/endpoints/auth/*` (login, password-change, mfa-*), `identityKeys.tsx`, `sessionLifecycle.tsx`, `stepUp.tsx`, `platformBootstrap.tsx`; ordem de locks entre login × MFA × exclusão de conta.
2. **RBAC e isolamento entre organizações:** `permissions.tsx`, `platformAccess.tsx`, e **toda** consulta que recebe `organizationId`.
3. **Ledger e concorrência:** `needFulfillment*.tsx`, `receiptPosting.tsx`, `stockExit.tsx`, `stockBalance.tsx`, `lockOrder.tsx`.
4. **Migrations 0032–0040** (sem "down"; restaurar backup é o retorno).
5. **Agentes e permissões:** `agentRegistry.tsx`, `automationControls.tsx`, `schedulerControl.tsx`, `agent-engine-run`, `background-tasks-retry`.
6. **Auditoria/integridade:** `auditLog.tsx`, `verifyAuditChain.tsx`, `auditChainReceipt.tsx`.
7. **Backup/recuperação:** `docs/DATABASE_RECOVERY.md`, `scripts/release-db-check.mjs`, `docs/STAGING_PREPARACAO_M49.md` §7.
Decisões que o revisor deve cobrar do proprietário: recuperação de acesso, retenção, política de agentes.

## 1. Riscos principais (por ordem de impacto)

1. **Isolamento entre organizações** (vazamento de ofertas, necessidades, comprovantes, auditoria).
2. **Integridade do estoque/ledger** sob concorrência (reserva, atribuição, recebimento, destinação, estorno): saldo derivado nunca negativo/duplicado.
3. **Autorização**: papéis de organização × acesso de plataforma; segunda autorização (dupla aprovação); MFA obrigatório na plataforma.
4. **Motor de agentes**: nada executa sem habilitação; pausa global; simulação não altera dados reais; reprocessamento não duplica.
5. **Auditoria**: cadeia de hash (`audit_log`) e comprovantes (`audit_chain_receipts`) — evidência não pode ser alterada sem detecção; auditoria não pode vazar dado pessoal.
6. **Migrations**: ordem, idempotência, falha parcial, dados pré-existentes (sem "down").
7. **Arquivos/antimalware**: nenhum arquivo liberado sem análise em produção.
8. **Sessão/identidade**: cookie, expiração, revogação, step-up, recuperação do owner.
9. **Operação**: logs sem dados pessoais, readiness, agendador opt-in.

## 2. Arquivos prioritários (`src/helpers/` salvo indicação)

- **Agentes/eventos (PR-1):** `agentRegistry.tsx`, `agentTools.tsx`, `automationControls.tsx`, `domainEvents.tsx`, `policyLimits.tsx`, `policyRules.tsx`, `exceptionQueue.tsx`, `integrityAlerts.tsx`, `schedulerControl.tsx`; endpoints `agents-enable`, `agent-engine-run`, `automation-controls*`, `platform-automation-controls*`, `exception-queue*`, `integrity-alerts*`, `background-tasks-retry`.
- **Permissões/isolamento:** `permissions.tsx`, `platformAccess.tsx`, `membershipAdmin.tsx`, `lockOrder.tsx`; `test/permissions.test.ts`, `test/crossOrgIsolation.test.ts`.
- **Auditoria/integridade:** `auditLog.tsx`, `verifyAuditChain.tsx`, `auditChainReceipt.tsx`; migrations 0037–0038.
- **Operação:** `readiness.tsx`, `opLog.tsx`, `identityKeys.tsx`, `scheduler.tsx`, `emailAdapter.tsx`; `server/index.ts`; `scripts/release-validate.mjs`, `scripts/release-db-check.mjs`.
- **Jornada/matching (PR-2):** `opportunityMatching.tsx`, `runMatchingSweep.tsx`, `needFulfillment*.tsx`, `receiptPosting.tsx`, `stockBalance.tsx`, `stockExit.tsx`, `concludeOpportunity.tsx`, `reopenOpportunity.tsx`, `recoverStuckOpportunities.tsx`, `expireReservations.tsx`, `destinationCorrections.tsx`, `destinationProofs.tsx`, `allocationRefusals.tsx`; endpoints `allocations-receive`, `opportunities`, `stock-transactions`, `stock-destinations*`; migrations 0036, 0039, 0040.
- **Arquivos:** `fileScan*.tsx`, `files-upload`, `files-download`, `files-rescan`.

## 3. Fluxos críticos para percorrer no código

(a) oferta → matching → reserva → atribuição → recebimento → destinação (com comprovante) → prestação de contas; (b) estorno/correção de destinação e de atendimento (segunda autorização); (c) agente: habilitar → pausa global → execução manual → evento → reprocessamento; (d) login → MFA → step-up → sessão → logout/revogação; (e) migration incremental falha no meio; (f) upload → análise → liberação/retenção.

## 4. Pontos de concorrência e garantias a confirmar por outra pessoa

| Ponto | Mecanismo declarado | Teste existente |
|---|---|---|
| Ordem de locks no ledger/membros | `lockOrder.tsx`, `ledgerLockOrder` | `ledgerLockOrder.test.ts` |
| Reabertura/atribuição concorrentes | UPDATE condicional + versão da oferta | `opportunityReopenConcurrency.test.ts`, `matchingNonReappearance.test.ts` |
| Agentes concorrentes | lease/lock por execução | `agentConcurrency.test.ts`, `scheduledTaskLock.test.ts` |
| Regularização de unidades | locks próprios | `unitRegularizationConcurrency.test.ts` |
| Reanálise de arquivos | estado final imutável por gatilho | `fileScan.test.ts`, `fileScanQueue.test.ts` |
| Login × ativação de MFA | lock da linha do usuário | `mfaFlows.test.ts`, `identitySessions.test.ts` |
| Deadlock de pool | pools separados | `dbPoolIsolation.test.ts` |

**O revisor deve confirmar** que as invariantes valem sob **READ COMMITTED** e que não há caminho de escrita sem checagem de organização; que nenhum endpoint de leitura devolve dados de outra organização; que o gatilho de arquivo não pode ser contornado por outro propósito; que a ordem de locks é consistente entre `account-delete`, login e administração de membros.

## 5. Migrations a revisar

0032 (`agent_platform`), 0033 (`agent_event_engine`), 0034 (`agent_event_runs_insufficient_data`), 0035 (`agent_event_reevaluations`), 0036 (`opportunity_version_and_changes`), 0037 (`audit_chain_verifications`), 0038 (`audit_outcome_correlation_receipts`), 0039 (`need_journey_correlation`), 0040 (`matching_runs`). Perguntas: tabelas novas vazias? colunas novas com padrão seguro? índices/locks em tabelas grandes? compatibilidade com `db/migrationCompat.ts`? Ensaio local: banco novo e incremental a partir do schema da `master` (release:db-check, 24/24).

## 6. Evidência existente por risco (local, sintética)

Backend 3075 testes (4 ignorados declarados) e interface 230 na árvore dos PRs (M47; reexecutados em M49 apenas os afetados); `release:db-check` 24/24; Chrome 157 e Edge 157 reais (22 jornadas, 72 células responsivas); ensaio de instalação/restauração (M49). **Nada disso é CI remoto, revisão humana nem staging.**

## 7. Limitações conhecidas

Sem recuperação de senha (ver matriz final); Microsoft sem cadastro novo e não qualificada; ClamAV real validado só localmente (15–16/10/2026); sem âncora externa da cadeia de auditoria; agentes em simulação; categoria opcional; divergência de quantidade exige revisão; sem vinculação posterior de oferta; sem retenção/exclusão automática (decisão pendente); `npm audit` não executado; gate visual desabilitado; Firefox/Safari/leitor de tela não testados; privilégios do banco de produção dependem da infraestrutura.

## 8. Critérios de aprovação sugeridos

- Nenhum achado aberto de isolamento entre organizações, perda/duplicação de saldo, escalonamento de privilégio ou vazamento de dado pessoal em log/auditoria.
- Migrations 0032–0040 aprovadas por quem administrará o banco.
- CI verde no head publicado de cada PR (após reativação autorizada).
- Decisões do proprietário registradas (ver `docs/LANCAMENTO_MATRIZ_FINAL.md`).
- Aprovação humana registrada no GitHub **por quem revisou**.
