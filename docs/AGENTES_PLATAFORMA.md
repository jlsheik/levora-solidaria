# Plataforma de agentes — Fase 74 (Fase 1 de `AGENTES_ESPECIFICACAO.md`)

**Estado real: existe a fundação; nenhum agente existe ainda.** Esta fase
construiu o que todo agente futuro precisa para agir com segurança, sem
nenhuma chamada de IA e, portanto, **com custo de IA igual a zero**. Os
agentes da Camada A (Sentinela de Integridade etc.) são a Fase 2.

## O que foi entregue

| Peça | Onde | O que garante |
|---|---|---|
| Agente como principal não humano | `agent_principals`, `agentRegistry.tsx` | Cada agente tem identidade, versão, escopo (global ou uma organização) e interruptor `enabled` que só humano muda |
| Autor da auditoria | `audit_log.actor_type` (`user`/`agent`/`system`) e `actor_agent_principal_id`; `auditLog.tsx` | Toda ação de agente aparece com quem foi. O autor entra no hash **só** para agente/sistema: o hash de todo evento anterior continua válido |
| Barramento de eventos | `domain_events`, `domain_event_consumptions`, `domainEvents.tsx` | Evento só existe se a transação de negócio confirmou; cada consumidor processa cada evento uma vez; falhas têm limite de tentativas |
| Limites de política | `policy_limits`, `policyLimits.tsx` | Padrões conservadores em código; organização só restringe; leitura aplica sempre o mais restritivo |
| Motor de regras | `policyRules.tsx` (função pura) | Mesma entrada, mesma decisão: segue, exige revisão ou exige dupla autorização |
| Pausar / emergência | `automation_controls`, `automationControls.tsx` | Pausa bloqueia ferramentas que mudam dados; emergência deixa só alertas; global vale para todas as organizações |
| Alertas de integridade | `integrity_alerts`, `integrityAlerts.tsx` | Aviso para humano, deduplicado enquanto aberto; nunca acusação nem correção automática |
| Fila de exceções | `exception_queue`, `exception_decisions`, `exceptionQueue.tsx` | "A automação foi interrompida por uma regra de proteção"; revisão simples ou dupla autorização por duas pessoas diferentes; aprovação vale uma vez só |
| Camada de ferramentas | `agentTools.tsx` | Único caminho de um agente até o banco, em ordem fixa (ver abaixo) |

## Como um agente age (`invokeAgentTool`)

1. agente existe e está ligado;
2. a ferramenta está na **matriz do agente** (`agentRegistry.tsx`); se não,
   bloqueia e gera alerta de segurança (uma vez por agente+ferramenta);
3. entrada validada por schema (nunca texto livre vira decisão);
4. escopo: agente de uma organização só age nela; organização precisa existir;
5. pausa/emergência: pausa barra `mutate`; emergência barra tudo menos `alert`;
6. motor de regras: se exigir revisão/dupla autorização, **não executa** e
   cria a exceção (repetir o mesmo pedido reaproveita a exceção pendente);
7. executa em transação, com auditoria de agente. Se havia exceção aprovada,
   ela é consumida na mesma transação (`UPDATE ... WHERE consumed_at IS NULL`),
   então duas reexecuções simultâneas executam uma única vez.

Classes de ferramenta: `read` (lê), `alert` (só cria alertas), `mutate`
(muda dados).

Ferramentas existentes hoje: `create_integrity_alert`, `list_open_alerts`,
`get_policy_limits`. **Nenhuma ferramenta muda estoque, permissão,
aprovação ou dinheiro**, logo nenhum agente pode fazê-lo.

## API (todas por organização, com isolamento e permissão)

| Endpoint | Quem |
|---|---|
| `integrity-alerts_GET` | `automacao.leia` (proprietário, administrador) |
| `integrity-alerts-update_POST` (reconhecer / resolver / descartar) | `automacao.gerencie`, organização ativa |
| `exception-queue_GET` | `automacao.leia` |
| `exception-queue-decide_POST` (aprovar / rejeitar) | `automacao.gerencie`, organização ativa |
| `automation-controls_GET` | `automacao.leia` |
| `automation-controls_POST` (pausar / emergência da organização) | `automacao.gerencie`, organização ativa |
| `agents_GET` (visão geral: agentes do código, registro, alertas/exceções abertos) | `automacao.leia` |
| `policy-limits_GET` (padrão, global, da organização e efetivo) | `automacao.leia` |
| `policy-limits_POST` (a organização **só restringe**; audita `politica.limite_alterado`) | `automacao.gerencie`, organização ativa |
| `platform-automation-controls_GET` / `_POST` (pausa/emergência **global**) | equipe da plataforma (`platform_access`, `requirePlatformAdmin`) |

Operador e voluntário não veem nem decidem nada disso (menor privilégio).

## Eventos publicados hoje (para a Fase 2 consumir)

Gravados na mesma transação do negócio, só com ids e fatos (nenhum dado
pessoal, nenhum texto livre):

| Evento | Publicado por |
|---|---|
| `stock_transaction.created` | `stock-transactions_POST` |
| `allocation.received` | `allocations-receive_POST` |
| `opportunity.created` | `opportunities_POST` |
| `opportunity_registry.created` | `opportunity-registry_POST` |

Ainda **não há consumidor agendado**: nenhum job lê esses eventos até a
Fase 2 registrar os primeiros agentes.

## Limites de política: valores padrão a revisar

`policyLimits.tsx` (`POLICY_LIMIT_DEFS`). São conservadores de propósito
(D4 de `AGENTES_ESPECIFICACAO.md`), mas **são do dono do projeto**: revisar
antes de ligar qualquer agente que aceite oportunidades.

| Limite | Padrão | Efeito ao ultrapassar |
|---|---|---|
| `AUTO_ACCEPT_MAX_VALUE` | R$ 500 | dupla autorização |
| `FINANCIAL_APPROVAL_THRESHOLD` | R$ 0 | dupla autorização (qualquer valor financeiro) |
| `AUTO_PICKUP_MAX_DISTANCE_KM` | 50 km | revisão humana |
| `AUTO_LOGISTICS_MAX_COST` | R$ 0 | revisão humana |
| `HIGH_RISK_CATEGORIES` | medicamento, alimento_perecivel, item_perigoso, dinheiro | revisão humana |
| `MANUAL_REVIEW_REQUIRED_CATEGORIES` | medicamento | revisão humana |

## Decisões desta fase (e por quê)

- **Sem tabela `policy_rules`**: as regras ficam em código versionado e só
  os limites são configuráveis. Uma linguagem de regras seria superfície nova
  para erro sem necessidade hoje. Se um dia a plataforma precisar editar
  regras por tela, entra como fase própria.
- **Sem endpoint para editar limites ainda**: `setPolicyLimit` existe,
  validado e testado (organização só restringe, auditado); a tela e o
  endpoint entram junto com o painel de agentes. Até lá, os padrões em
  código valem.
- **Sem tela**: painéis de agentes são fora de escopo desta especificação.
- **FKs sem `CASCADE`/`SET NULL`** contra tabelas append-only (lição do
  incidente da Fase 66): o trigger de bloqueio quebraria a ação referencial.
- **Exceção aprovada vale uma única vez e só para o mesmo agente, a mesma
  ferramenta e a mesma entrada** (hash do pedido).
- **Dupla autorização** exige duas pessoas diferentes; qualquer rejeição
  encerra a exceção.

## Como acrescentar um agente ou ferramenta (Fase 2 em diante)

1. Ferramenta nova: `defineTool` em `agentTools.tsx` (classe, schema de
   entrada, `policyContext` se tiver risco, `audit`). Sem teste de
   caminho feliz, de negação e de modo pausado, não entra.
2. Agente novo: entrada em `AGENT_DEFINITIONS` (`agentRegistry.tsx`) com a
   lista **mínima** de ferramentas; `ensureAgentPrincipal` cria a linha.
3. Consumo de eventos: `consumeDomainEvents` num job do agendador (padrão
   de `scheduler.tsx`/`scheduledTaskLock.tsx`).
4. Todo agente precisa de um modo sem IA que funcione sozinho (invariante C2).

## Rastreabilidade e Central de Auditoria (M38)

A Central de Auditoria (`/organizacoes/:id/auditoria`, proprietário e administrador) liga **Oportunidade → Evento → Avaliação → Decisão → Exceção/revisão humana → Reavaliação → Auditoria** usando só vínculos persistidos (ver `docs/AUDITORIA_CENTRAL.md`). A avaliação passa a gravar `facts.versaoOportunidade` (versão do registro realmente usada); a decisão concluída **não é recalculada** quando a categoria muda depois — a tela mostra categoria considerada × atual e leva à alteração auditada. Reavaliar decisões concluídas continua sem regra definida pelo proprietário e **não foi implementado**.

## Correção de categoria da oportunidade e nova análise do Risk Engine (M37) — SOMENTE SIMULAÇÃO

**Jornada (tudo pela interface, sem SQL manual):** cadastrar a oferta (a categoria continua OPCIONAL) → evento v2 → Risk Engine registra `dados_insuficientes` → na lista de oportunidades a pessoa vê “Sem categoria”, o impacto e a avaliação incompleta → pessoa autorizada define/corrige a categoria → a lista avisa que há informação nova → pedido explícito de nova análise → o motor relê o registro, reavalia e registra uma NOVA avaliação vinculada à anterior (que permanece) → justificativa, histórico e auditoria.

**Edição (`opportunities-category_POST`, permissão existente `oportunidades.gerencie`, organização ativa):** trava a linha (FOR UPDATE; mesma ordem das demais: oferta primeiro, auditoria por último) → confere organização, estado editável (`registrada`, `em_contato`, `confirmada`; `recebida` e `cancelada` são finais e não podem ser contrariadas) e VERSÃO → valida a forma → grava categoria + versão+1 → histórico do recurso (`opportunity_changes`, de/para, versões, correlação, motivo) → auditoria `oportunidade.categoria_alterada` SEM valores (só campo, versões, correlação). Mesma categoria enviada de novo = sem alteração, sem versão consumida. **Editar NÃO publica evento, NÃO reavalia e NÃO executa nada.** Não há catálogo oficial de categorias (texto livre, 2–60 caracteres): nenhuma categoria é inventada; “categoria inexistente/proibida” não tem fonte documental — decisão pendente (catálogo). As sugestões mostradas são reais (já usadas na organização ou com regra na política).

**Concorrência (controle otimista + trava de linha):** a coluna `donation_opportunities.version` (migration 0036) é incrementada por TODO escritor do registro (edição de categoria, mudança de status, recebimento, regularização de unidade). A edição envia a versão que a pessoa viu (409 `conflito_de_versao` com a versão atual). A reavaliação relê o registro a CADA avaliação (nunca reutiliza leitura antiga) e a conclusão, já sob a cerca de política da M36, trava a linha da oferta (`FOR SHARE`; quem edita usa `FOR UPDATE`) e confere que a versão lida ainda é a atual; se mudou, recusa (`revalidar`) e o motor relê e reavalia. Resultado: uma decisão nunca é apresentada como baseada na categoria atual se usou uma versão antiga; a explicação mostra a origem (“registro da oportunidade, versão N”). Testes determinísticos (portões + gancho) e mutação (sem a conferência de versão, o teste F3 falha).

**Decisão já concluída e categoria alterada depois:** a decisão continua baseada na categoria considerada (a do evento original ou a do registro naquela versão); a tela mostra categoria considerada × atual e avisa. Reavaliar uma decisão JÁ concluída não foi autorizado (só `dados_insuficientes` é reavaliável) — decisão do proprietário.

**Regras preservadas:** evento original imutável; avaliação anterior preservada (`detail.previous` + `agent_event_reevaluations`); sem processamento retroativo de evento anterior à ativação do agente; pausa, agente desligado, política e limites respeitados; idempotência (dois pedidos iguais → um conclui, o outro 409); isolamento por organização.

**Divergência de quantidade:** continua “qualquer diferença na mesma unidade vai para revisão”, descrita na tela como regra atual **sem tolerância definida** (não há limiar homologado pelo proprietário).

### Caminhos privilegiados que contornam a cerca (somente inspeção do repositório; nada alterado)
O repositório NÃO define papéis, GRANT nem REVOKE de banco (nem nas migrations nem nos scripts): a aplicação usa uma única conexão (`DATABASE_URL`) com permissão de escrita em todas as tabelas. Portanto qualquer processo com essa credencial — psql/SQL direto, scripts de seed/QA/CLI de manutenção, uma migration — pode escrever em `policy_limits`, `automation_controls`, `agent_principals` ou `donation_opportunities` sem passar pela cerca de política nem pela conferência de versão. Dentro do código da aplicação, os escritores dessas tabelas são: `agents-enable_POST` (agente, com cerca), `agentRegistry` (apenas sincroniza `version` do agente; não altera `enabled`), `automationControls`/`policyLimits` (com cerca), `opportunities-category_POST`/`opportunities-status_POST`/`receiptPosting`/`unitRegularization` (oportunidade, com versão). Nenhum trigger foi criado para “provar proteção universal” (não há necessidade demonstrada). Mitigação possível, FORA do escopo: separar o papel de banco da aplicação do papel de manutenção e revogar escrita direta — decisão de infraestrutura do proprietário.

### Achado de produto
O formulário “Nova oportunidade” não tinha campo de categoria (toda oferta cadastrada pela tela nascia sem categoria). Foi acrescentado um campo OPCIONAL “Categoria”, em branco por padrão; deixar em branco continua válido.

## Consistência transacional, cobertura do ledger e reavaliação (M36) — SOMENTE SIMULAÇÃO

### Cerca de política (`policyFence.tsx`) — a condição de corrida da M35 foi fechada
**Problema:** a conclusão relia pausa/agente/limites na própria transação, em READ COMMITTED e sem travas: uma alteração concorrente podia confirmar entre a leitura e o commit, e a decisão avançava com política desatualizada. Reduzir a janela não a elimina; uma trava só do consumidor não protege nada se quem altera a política a ignora.

**Estratégia (a menor que dá garantia):** travas consultivas de TRANSAÇÃO do PostgreSQL, usadas pelos **dois lados**:
- quem decide (conclusão de simulação, e o pedido de reavaliação) toma a trava **compartilhada** global → organização e SÓ ENTÃO lê pausa, agente e limites;
- quem altera toma a **exclusiva** do seu nível: `setAutomationControl` (pausa/emergência, org ou global), `setPolicyLimit` (limite, org ou global) e `agents-enable_POST` (ligar/desligar agente).
Como a trava só é liberada no commit/rollback, o banco ORDENA estritamente cada par conclusão×alteração: ou a alteração confirmou antes (a conclusão a vê, porque a leitura vem depois da trava) ou a conclusão confirmou antes (a decisão valia no seu instante). Não existe terceiro caso. Duas alterações da mesma política também se serializam (sem violação de unicidade).

**Ordem de aquisição fixa (anti-deadlock):** global → organização. Quem altera a organização toma global compartilhada + organização exclusiva; quem altera o global toma só a global exclusiva; quem decide toma global compartilhada + organização compartilhada. A trava global da cadeia de auditoria é sempre a última de todas. `lock_timeout` de 5 s no lado que decide: se uma alteração demorar, a conclusão falha de forma recuperável.

**Outros garantidores (já existentes):** `UNIQUE(evento, agente)`; compare-and-set nas transições com histórico e auditoria na mesma transação; uso único da aprovação (`consumed_at`); exceção rejeitada é terminal e `decideException` trava a linha; a conclusão também recusa aprovação que não cobre a política atual (nº de aprovações exigido relido sob a cerca).

**Prova:** `test/agentConcurrency.test.ts` controla a ordem com portões e observa o bloqueio em `pg_locks` (sem `sleep`): A limite (alteração antes/depois), B pausa da organização e global, C agente desligado (inclui o endpoint real), D exceção rejeitada, E dois workers, F retry após falha dentro da transação, G estresse sem deadlock, H duas pessoas alterando o mesmo limite. Mutação: sem a cerca no lado que decide, os testes A1/A2/B1/C1 falham. O teste de deadlock é estresse COMPLEMENTAR; a garantia vem da ordem fixa.

**Limite conhecido:** a garantia vale para as alterações que usam a cerca. Uma escrita direta em SQL nas tabelas de política (fora do código da aplicação) não a usa.

### Cobertura de eventos do ledger
Ver `docs/AGENTES_PLATAFORMA.md` (tabela de publicadores abaixo). Novos em M36: `estoque_inicial`, `recebimento_oportunidade`, `estorno_destinacao`, `correcao_destinacao`, `estorno_recebimento`, `correcao_recebimento` (todos `stock_transaction.created` v2, mesma transação, ligados ao registro ORIGINAL por `reversesStockTransactionId`/`reversesAllocationId`; estorno/correção sem referência = análise insuficiente). Estorno **documental** não move estoque e não publica. O recebimento de ATRIBUIÇÃO (`receiptPosting:31`) não publica `stock_transaction.created` (já coberto por `allocation.received`; evita avaliar a mesma operação lógica duas vezes). Sem backfill.

### Reavaliação controlada de `dados_insuficientes`
`agent-event-reevaluate_POST` (`automacao.gerencie`): registra o pedido em `agent_event_reevaluations` (append-only; migration 0035) vinculado à execução e à auditoria por `correlation_id`; copia a decisão/explicação ANTERIOR; lê os dados novos dos REGISTROS de origem no servidor (categoria atual da oferta; “item já tinha saída” recalculado do ledger imutável; quantidade atribuída/unidade da atribuição) — nunca do pedido; revalida agente ligado, pausa, política e limites (a conclusão passa pela cerca); recusa evento anterior à ativação do agente. O evento e a execução original não são reescritos. Idempotente e concorrente-seguro (a execução é travada; o segundo pedido recebe 409). Não há reprocessamento automático.
**Não existe hoje tela/endpoint para corrigir a categoria de uma oferta já cadastrada**; a reavaliação lê o registro, então só ajuda quando a categoria passar a constar nele por um fluxo autorizado que o produto ainda não tem.

### Tolerância zero na divergência de recebimento — impacto
É um padrão conservador provisório da M35, NÃO uma regra especificada. Efeito: qualquer diferença de quantidade (na mesma unidade) gera uma exceção de revisão; recebimentos parciais ou arredondamentos legítimos criarão carga de revisão proporcional ao volume de recebimentos divergentes. Não foi inventada tolerância numérica.

### Decisões do proprietário (nenhuma foi tomada nem simulada)
| Tema | Opções | Impacto |
|---|---|---|
| Categoria da oferta | (a) continuar opcional; (b) obrigatória só em fluxos específicos; (c) obrigatória globalmente | (a) mantém ofertas sem categoria em “dados insuficientes”; (b)/(c) exigem fluxo de edição/validação, tratamento de dados antigos sem categoria (sem categoria fictícia) e de integrações que omitem o campo |
| Divergência de quantidade | (a) tolerância zero (hoje); (b) tolerância definida por política; (c) revisão manual conforme contexto | (a) volume de exceções; (b)/(c) exigem o valor/critério — não há base documental para propor números |
| Alto valor / valor monetário | definir fonte e limiar de “alto valor”, “conta nova”, “volume súbito”, “rajada” | hoje o sistema não registra valor; regras ficam como pendentes |
| Limites globais | quem altera, faixas, se pode ficar menos restritivo | escrita global segue desabilitada |
| Retenção | prazos por categoria e preservação da cadeia de auditoria | sem exclusão automática |
| Estorno × Sentinela | ajustes de correção/estorno de item já distribuído hoje vão para revisão (regra de ajuste) | pode gerar carga; decidir se estornos formais devem ser isentos |

## Regras próprias, publicadores v2 e decisão explicável (M35) — SOMENTE SIMULAÇÃO

**Publicadores reais** (todos chamam `domainEventPublishers.tsx` DENTRO da transação do fluxo, depois do último passo que pode falhar; falha/reversão ⇒ o evento nem existe — outbox transacional já existente, sem fila nova):

| Evento | Fluxo de domínio que o publica | Observação |
|---|---|---|
| `stock_transaction.created` | `stock-transactions_POST` (entrada/ajuste), `stockExit` (saída por destinação), `approval-requests-decide_POST` (ajuste de alto risco aprovado), **M36:** `inventory-items_POST` (estoque inicial), `receiptPosting` (recebimento de oportunidade local), `destinationCorrections` (devolução física/correção), `needFulfillmentCorrections` (estorno/correção de recebimento) | NÃO publicam (e não devem): recebimento de ATRIBUIÇÃO em `receiptPosting` (coberto por `allocation.received`), estorno documental (não move estoque) |
| `allocation.received` | `allocations-receive_POST` | Recusas (atribuição/item inexistente, unidade incompatível → caso de regularização) não publicam |
| `opportunity.created` | `opportunities_POST` | — |

**Contrato v2** (`v: 2`; payload sem `v` = v1, ainda aceito): ator (só o id numérico), saldo APÓS o lançamento, origem do lançamento, se o item já teve saída, quantidade atribuída × recebida e se a unidade é a mesma, categoria/quantidade/unidade da oferta. Nenhum texto livre ou dado pessoal; valor desconhecido é omitido (nunca 0). **Valor, distância e custo continuam sem fonte confiável no sistema** — não foram inventados nem calculados por API externa; aparecem como “não avaliados” e opcionais.

**Regras implementadas (sem número inventado)**

- Sentinela: `R-SENTINELA-SALDO-NEGATIVO` (invariante), `R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO` (“alteração de item já distribuído”), `R-SENTINELA-DIVERGENCIA-RECEBIMENTO` (recebido ≠ atribuído, mesma unidade, comparação em milésimos; **qualquer** diferença vai a revisão porque a tolerância não foi definida).
- Risk Engine: regras por categoria já existentes (`R-CATEGORIA-ALTO-RISCO` / `-REVISAO-MANUAL`, com os limites efetivos global+organização). **Sem pontuação numérica**: não há modelo definido; a decisão é por regras explícitas.
- **Não implementadas por falta de regra de negócio** (aparecem na tela como pendentes e nunca decidem): rajada de ajustes, entrada+saída de alto valor, mesma entrega em vários destinos, tolerância de recebimento, volume súbito, conta nova com alto valor.

**Dados ausentes** (`agentAssessment.tsx`, função pura): análise `completa` / `parcial` (regra não comparável, ex.: unidades diferentes) / `insuficiente` (dado OBRIGATÓRIO ausente: categoria da oferta; em eventos v1, “item já distribuído” de ajustes e “quantidade atribuída”). `insuficiente` ⇒ estado `dados_insuficientes` (migration 0034): **não aprova, não abre exceção, não conclui a simulação** e diz o que faltou. Valor/distância/custo ausentes são OPCIONAIS e não rebaixam a completude.

**Explicação**: cada execução grava em `agent_event_runs.detail` os fatos considerados, o que faltou, o resultado de cada regra (com o limite aplicado), as regras pendentes, a decisão, o instante e as avaliações anteriores (últimas 5). A tela mostra isso em “Por quê?”. Chaves do JSON em camelCase (a camada do banco converte nomes de chave).

**Pausa e retomada (revalidação)**: antes de continuar um evento bloqueado o motor reavalia TUDO com a política vigente (a decisão anterior só fica como histórico). A conclusão da simulação revalida, dentro da própria transação, pausa/emergência, agente ligado e política; se algo mudou, a conclusão é recusada (`revalidar:*`) e o motor reavalia uma vez. Ordem: por id crescente; não há expiração; quem autoriza a continuidade automática é a pessoa que retoma a automação / liga o agente. Rejeitada é terminal; `dados_insuficientes` só é reavaliado se a regra mudar e a execução for reprocessada manualmente (hoje não há reprocessamento automático).

## Motor de eventos dos agentes (M34) — SOMENTE SIMULAÇÃO

Reaproveita o barramento (`domain_events`) e a camada de ferramentas da Fase 74; não existe um segundo sistema de eventos.

```
evento interno → [recebido] → validação (tipo, estrutura, organização) → [validado | ignorado]
  → agente ligado (da organização ou global) → ferramenta `assess_event` (agente ligado → matriz → entrada → escopo da organização
    → pausa/emergência → limites efetivos → regras) → [bloqueado_politica | aguardando_aprovacao | autorizado_simulacao → simulacao_concluida]
  → auditoria + alerta interno quando cabe
```

- **Contratos hoje** (`EVENT_CONTRACTS`, em `agentEventEngine.tsx`, vindos de `docs/AGENTES_ESPECIFICACAO.md` §4): `stock_transaction.created` e `allocation.received` → Sentinela de Integridade; `opportunity.created` → Risk Engine. `opportunity_registry.created` (sem organização) não tem contrato com agente de organização. Nenhum tipo novo foi inventado.
- **Fatos de política**: só a *categoria* de `opportunity.created` existe hoje no payload (regras `R-CATEGORIA-*`). `estimatedValue`, `distanceKm` e `logisticsCost` são opcionais e alimentam as regras **existentes** quando um publicador passar a enviá-los; **nenhum publicador atual envia** — por isso a dupla autorização só é alcançável, hoje, por eventos sintéticos de teste. Decisão do proprietário: quais publicadores devem informar valor/distância/custo.
- **Inerte por padrão**: o motor nunca registra nem liga agente. Uma PESSOA (proprietário/administrador) liga o agente para a própria organização (`agents-enable_POST`, principal restrito à organização, auditado). Só eventos publicados **depois** do registro do agente são avaliados (não há inundação do histórico).
- **Estados**: `recebido`, `validado`, `ignorado`, `bloqueado_politica`, `aguardando_aprovacao`, `rejeitado`, `autorizado_simulacao`, `simulacao_concluida`, `falha`. `simulated` é sempre `true` (CHECK no banco): não existe linha de “execução real”.
- **Aprovação não executa**: aprovar a exceção leva a execução a `autorizado_simulacao`; a conclusão é um passo **separado** do motor, que reconfere pausa, limites e política e consome a aprovação (uso único). Se a política endureceu depois da aprovação, a aprovação antiga não cobre mais: abre-se **nova exceção** (`politica_alterada`); se afrouxou, conclui sem consumir a aprovação.
- **Pausa/emergência**: o evento é recebido e a execução fica `bloqueado_politica` (`automation_paused`/`automation_emergency`); nada avança. O histórico não é apagado; quando a pausa cessa o motor retoma de onde parou (sem repetir registros durante a pausa).
- **Idempotência e concorrência**: `UNIQUE (event_id, agent_principal_id)`; toda transição é compare-and-set com histórico e auditoria na mesma transação; duas instâncias, duas decisões ou duas conclusões simultâneas produzem uma única transição válida (a outra recebe conflito).
- **Isolamento**: o agente de uma organização só enxerga eventos dela; a ferramenta recusa `organizationId` trocado; as leituras filtram pela organização da permissão; o *payload* do evento nunca é devolvido pela API.
- **Falhas**: tentativa que falha fica registrada e é repetida; ao esgotar (3), a execução termina em `falha` com alerta — sem apagar nada.
- **Alertas internos** (sem e-mail/SMS/push): `agente_excecao_pendente` (nível `alto_risco` se dupla autorização, senão `operacional`), `automacao_pausada`, `agente_bloqueado_politica` (escopo), `agente_falha_repetida`/`agente_falha_processamento`; deduplicados enquanto abertos; o alerta de exceção é resolvido quando uma pessoa **decide** a exceção (nunca por visualização).
- **Tarefa agendada** `processAgentEvents` (a cada 5 min, `scheduled-jobs.json`): **DESABILITADA por padrão (M46)** — só é registrada no agendador e só executa se o servidor for iniciado com `AGENT_EVENTS_SCHEDULER_ENABLED=true` (valor exato; a mesma regra vale para a própria tarefa e para o reprocessamento manual, que responde 409 enquanto estiver desabilitada). Uma passada para todas as organizações; mesmo habilitada, inerte sem agente ligado por uma pessoa. O estado aparece em `/_api/__ready` (`agentEventsScheduler`). “Processar eventos agora” faz a mesma passada só para a organização do pedido.

### Retenção (só classificação/simulação)

`retention-preview_GET` classifica eventos, execuções, exceções, alertas e a trilha de auditoria e simula “mais antigos que N dias”. **Nenhuma exclusão existe** e a auditoria nunca é candidata a expirar. Decisões do proprietário pendentes: prazos de guarda de cada categoria, arquivamento × exclusão, como preservar a verificação da cadeia de auditoria, quem autoriza uma eventual rotina.

### Limites globais

Os limites globais aparecem em `/plataforma` **somente leitura** (`platform-policy-limits_GET`). A escrita global não foi implementada: faltam regras de negócio (quem autoriza, faixas, se pode ficar menos restritivo que o padrão). A escrita por organização continua só-mais-restritiva e agora grava antes/depois na auditoria (histórico na tela).

## Telas (M33)

`/organizacoes/:id/automacao` (proprietário e administrador; `?aba=` visao | excecoes | alertas | controles): visão geral dos agentes (busca, filtros, detalhe do que cada um pode fazer),
fila de exceções (aprovar/rejeitar com diálogo e justificativa; dupla autorização mostra o progresso e o histórico), alertas (reconhecer/resolver/descartar), pausa/emergência da
organização e limites de autonomia (validação "só mais restritivo" espelhada, o servidor decide). `/plataforma` ganhou o painel de pausa **global** ao lado do painel antimalware (M32).
A tela nunca é a autoridade: toda ação é revalidada e auditada no servidor. Aprovar uma exceção **não executa** nada.

## Migração

`db/migrations/0033_agent_event_engine.sql` (M34): `agent_event_runs` (estado atual de cada avaliação) e `agent_event_run_history` (transições, append-only por gatilho). Ambas novas e vazias; classificada como `safe` em `db/migrationCompat.ts`.

O arquivo é `db/migrations/0032_agent_platform.sql` (era `0014`, número já ocupado por `allocation_response_deadline` na linha principal; nenhum objeto da migração colidia).

## Testes

`test/agentOpsEndpoints.test.ts` (visão geral, limites, pausa global, histórico), `test/uiAgentOpsView.test.ts` e `test/uiAgentPanels.test.ts` (telas), `test/agentPlatform.test.ts` (núcleo: hash, limites, regras, pausa, eventos,
ferramentas, exceções, concorrência) e `test/agentEndpoints.test.ts` (API,
permissões, isolamento e eventos publicados pelos fluxos de negócio).

## Pendências conhecidas

- Demais agentes da Camada A e os consumidores de `stock_transaction.created`/`allocation.received` com regras próprias (hoje o motor só aplica as regras de política existentes).
- Fonte confiável de valor/distância/custo (hoje inexistente) para as regras de valor/dupla autorização valerem em eventos reais.
- Regras da Sentinela/Risk que dependem de limiar ou janela (rajada, volume súbito, alto valor, tolerância de recebimento).
- Notificação EXTERNA de alertas/exceções (e-mail/SMS/push): não existe; os alertas são internos e aparecem na tela e no indicador da navegação.
- Política de retenção (hoje só classificação/simulação; nenhuma exclusão).
- Escrita do limite global pela plataforma (aguarda regras de negócio).
- `ai_runs`, `ai_cache`, `ai_budgets` e `AiProvider` (Fase 5): nada aqui chama IA.

## Execução automática × reprocessamento operacional × ação manual (M47)

O controle `AGENT_EVENTS_SCHEDULER_ENABLED` NÃO é um bloqueio universal do motor de eventos: ele desliga somente o que é **automático e periódico**. Há três caminhos distintos:

| Caminho | Quem aciona | Controlado por `AGENT_EVENTS_SCHEDULER_ENABLED`? | Proteções que continuam valendo |
|---|---|---|---|
| **Execução automática** (cron `processAgentEvents`, a cada 5 min) | o servidor | **Sim** — desabilitada por padrão; só liga com o valor exato `true`, na própria inicialização do servidor | agente ligado por uma pessoa na organização, pausa global/emergência, limites, simulação (nada externo) |
| **Reprocessamento operacional** (`background-tasks-retry`, botão "Reprocessar" em Tarefas de fundo) | administrador da plataforma | **Sim** — responde 409 enquanto a tarefa estiver desligada (nada executa); para outras tarefas, vale como sempre | só administrador da plataforma; só execuções com status "falhou" |
| **Ação manual** (botão "Processar eventos agora…", `agent-engine-run`) | proprietário/administrador da organização, com confirmação | **Não** — é decisão humana explícita, por organização | permissão do papel, isolamento da organização, agente ligado, pausa global/emergência, limites, simulação |

Decisão registrada: a ação manual continua disponível com o agendador desligado porque é um ato humano, autorizado e limitado a uma organização; ela não contorna a pausa global nem os limites (teste `schedulerControl`, grupo "M47"). Quem precisa impedir também a ação manual usa a pausa global da plataforma.
