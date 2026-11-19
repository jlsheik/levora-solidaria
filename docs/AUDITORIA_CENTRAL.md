# Central de Auditoria, rastreabilidade e verificação da cadeia (M38)

Escopo: **somente leitura** sobre a trilha existente (`audit_log`) e sobre as tabelas de domínio já persistidas. Nada aqui cria um segundo sistema de auditoria, um novo algoritmo de integridade, nem reescreve registros históricos.

## 1. O que existia (inventário real, antes da M38)

| Item | Situação encontrada |
|---|---|
| Escrita | `recordAuditLogEntry` (único caminho recomendado), dentro da transação do negócio; trava de transação (`pg_advisory_xact_lock`) serializa TODA escrita na cadeia. |
| Granularidade da cadeia | **Uma única cadeia GLOBAL** (todas as organizações), na ordem de `id`. Não existe cadeia por organização. `audit_log.organization_id` só classifica o evento. |
| Hash | SHA-256 de `organização|ator|ação|entidade|id|metadados (chaves ordenadas)|instante|hash anterior` (+ ator agente/sistema). Eventos de usuário antes da Fase 74 não incluem o ator no hash — continuam verificáveis. |
| Imutabilidade | gatilhos `BEFORE UPDATE/DELETE` recusam alteração pela aplicação. |
| Verificação | `verifyAuditLogChain` (recalcula tudo e compara) — via `GET /audit-log-verify` (só equipe da plataforma) e tarefa agendada (`background_task_runs`). **Não havia interface, nem registro do pedido/resultado, nem estado "em andamento".** Lacuna confirmada na árvore atual. |
| Consulta | `GET /audit-log` (50 últimos, sem filtros, sem paginação) exibido na visão geral da organização. |
| Correlação | Não existe coluna. Só os eventos M36/M37 trazem `metadata.correlacao` (reavaliação e categoria). Antes disso, **não há correlação** — a Central não a inventa. |
| Quem consulta | `auditoria.leia` = proprietário e administrador. Verificação da cadeia = equipe da plataforma. |

### Cobertura real
- Eventos com hash: todos desde a migração 0003. Eventos anteriores (`event_hash` nulo) **não são verificáveis** e são contados à parte (`eventosPreExistentesSemHash`).
- A verificação **detecta**: conteúdo alterado (hash não bate), elo quebrado (hash anterior diferente), registro removido do meio (o seguinte aponta para um hash que não está mais na sequência), hash removido (vira "sem hash" e o elo seguinte acusa).
- A verificação **não detecta**: remoção de eventos do FIM da cadeia (não há âncora independente do último hash); recálculo completo da cadeia por quem tem escrita direta no banco; nada sobre eventos sem hash. Esses limites aparecem na tela.

## 2. O que a M38 acrescenta

### Migration `0037_audit_chain_verifications.sql`
- Tabela **operacional** `audit_chain_verifications` (escopo `global_chain`, quem pediu, estados `em_andamento → integra | inconsistencia | incompleta | falha_tecnica`, abrangência `max_audit_id_at_start`, contagens, até 100 `{id, motivo}` de divergências — **nunca hashes**). Separada da cadeia **de propósito** (gravar o resultado dentro da cadeia avaliada seria circular — mesma regra da Fase 53). Linha final imutável (gatilho), `DELETE` recusado, no máximo **uma** verificação em andamento (índice único parcial = limite operacional).
- Dois **índices** em `audit_log` (`(organization_id, id DESC)` para paginação por cursor e `(metadata->>'correlacao')` parcial). Nenhuma linha, coluna, hash ou gatilho da cadeia é alterado.
- O **pedido** de verificação é auditado (`auditoria.verificacao_solicitada`, organização nula, sem dados pessoais). O **resultado nunca** é gravado em `audit_log`.

### Endpoints (todos somente leitura, exceto o pedido de verificação)
| Endpoint | Permissão | O que faz |
|---|---|---|
| `GET /audit-center` | `auditoria.leia` na organização | Lista paginada por **cursor** (`id`), filtros no banco: período, área, ação exata, recurso, quem agiu (pessoa/agente/sistema), "falhas e recusas", correlação. Total filtrado (limitado a 10.000, dito em palavras) e `sinceId` para contar registros novos sem deslocar a página. |
| `GET /audit-center-entry` | idem | Detalhe: metadados minimizados, mesma correlação, mesmo recurso. 404 também para ids de outra organização. Hashes nunca saem. |
| `GET /audit-center-summary` | idem (+ `automacao.leia` para os dados dos agentes) | Indicadores do período e **histórico total em separado**; dado indisponível ao papel vem `null` (a tela mostra "—"), nunca zero. |
| `GET /audit-trace` | idem (+ `automacao.leia` para agentes, `oportunidades.leia` para oportunidade) | Rastreabilidade a partir de oportunidade, execução, exceção ou correlação. |
| `GET /audit-chain-verifications` | `auditoria.leia` (com organização) ou equipe da plataforma (sem) | Últimos resultados. Equipe da plataforma vê ids/motivos; organização vê só quantas divergências tocam **os eventos dela**. |
| `POST /audit-chain-verify` | **equipe da plataforma** | Pede a verificação (202, assíncrona). 409 se já há uma em andamento. |

### Paginação e ordenação
Ordem por `id` decrescente (único e monotônico; a trava da cadeia faz `id` = ordem de commit). Página N+1 = `id < último id da página N`. Registros novos têm `id` maior, então **não duplicam nem deslocam** páginas já lidas. `created_at` sozinho empata e não é cursor seguro. Garantia limitada à ordem de commit da cadeia; leitura em transação separada por página.

### "Resultado" (filtro "falhas e recusas")
`audit_log` **não tem coluna de resultado**. O filtro e o rótulo "Falha ou recusa" são derivados do **nome** da ação (`falhou`, `recusad…`, `rejeitad…`, `bloquead…`). "Registro" significa apenas que a operação foi registrada — **ausência do marcador não é sucesso comprovado**. Decisão pendente: um campo de resultado explícito.

## 3. Rastreabilidade (vínculos reais)
```
oportunidade ←(domain_events.entity_type/entity_id)← evento ←(agent_event_runs.event_id)← execução ←(exception_id)→ exceção ←(exception_decisions)
execução ←(agent_event_reevaluations.run_id/correlation_id)      oportunidade ←(opportunity_changes.correlation_id)
auditoria ←(entity_type+entity_id)                               auditoria ←(metadata.correlacao = correlation_id)   [só M36/M37]
```
Onde o vínculo não existe o passo aparece como "Sem registro de auditoria associado". Nenhum evento histórico foi reescrito para fabricar correlação. O versionamento da oportunidade usado em cada avaliação passa a ser gravado de forma estruturada (`facts.versaoOportunidade`); avaliações anteriores só têm o texto "registro da oportunidade (versão N)" ou "evento original" — a tela diz "versão não registrada nesta avaliação" quando não há.

### Decisão histórica × dados atuais
A tela mostra, lado a lado, a categoria **considerada** (do instante da avaliação) e a **atual**, as alterações posteriores (com link para o registro de auditoria da alteração) e a política considerada (regras violadas e limites vigentes). `recalculated` é sempre `false`: a decisão **não é recalculada nem anulada**. A reavaliação de decisões já concluídas continua dependendo de decisão do proprietário (ver §5).

## 4. Limites e privilégios de banco (documentação precisa)
- A cadeia é **global**: verificar significa conferir a cadeia inteira. Por isso só a equipe da plataforma executa; organizações leem o último resultado sem ver ids de outras.
- Sem âncora independente (hash publicado/assinado fora do banco), um ator com **escrita direta e privilegiada** no banco pode recalcular a cadeia inteira, ou truncar o fim dela, sem ser detectado. A verificação prova só o que o mecanismo consegue provar: consistência interna entre conteúdo gravado, hashes e elos.
- O repositório **não define papéis, GRANT ou REVOKE**: a aplicação usa uma única credencial (`DATABASE_URL`) com escrita em todas as tabelas. Qualquer processo com essa credencial (psql, scripts de seed/QA, migrations) contorna a cerca de política, a conferência de versão da oportunidade e, em tese, os gatilhos append-only (o dono da tabela pode desativá-los — foi exatamente o que o teste de adulteração faz, **somente em banco de teste descartável**).
- `audit_chain_verifications` também não é âncora: quem escreve no banco pode alterá-la (o gatilho a protege da aplicação, não do dono do banco).

### Proposta (NÃO aplicada) de separação de privilégios
1. Papel `levora_app` (login da aplicação): `SELECT/INSERT/UPDATE` nas tabelas de negócio; **somente `INSERT`+`SELECT`** em `audit_log`, `opportunity_changes`, `agent_event_run_history`, `agent_event_reevaluations`, `domain_events`; `INSERT/SELECT` e `UPDATE` só da transição de estado em `audit_chain_verifications`; **sem** `ALTER TABLE`, `TRIGGER`, `TRUNCATE`.
2. Papel `levora_owner` (donos dos objetos): só migrations e manutenção, fora do processo da aplicação; credencial guardada em cofre, uso auditado.
3. Papel `levora_readonly_audit` para verificações externas (`SELECT` em `audit_log`).
4. **Âncora independente**: gravar periodicamente o último `event_hash` + `id` em local fora do banco (ex.: objeto com retenção imutável/assinatura) e comparar na verificação — fecha a lacuna do truncamento do fim da cadeia.
5. Alertar (`integrity_alerts`) quando a verificação agendada encontrar inconsistência.
Esta proposta exige decisão de infraestrutura do proprietário; nenhum papel, credencial ou serviço foi criado ou alterado.

## 5. Decisões de negócio pendentes
- Reavaliar (ou não) decisões **já concluídas** depois de correção de categoria, e com que regra de aprovação.
- Campo de **resultado** explícito na trilha (hoje derivado do nome da ação).
- Âncora independente e separação de privilégios (§4).
- Retenção/arquivamento do histórico da trilha e das verificações.
- Se organizações podem pedir uma verificação **proporcional ao seu escopo** (exigiria cadeia por organização ou prova de inclusão — hoje não há).

## 6. Como reproduzir localmente
Use um PostgreSQL **descartável** em `127.0.0.1` (banco `*_test`), `DATABASE_URL` e `JWT_SECRET` sintéticos: `npx vitest run test/auditCenter.test.ts` (backend, 12 testes) e `npx vitest run --config vitest.ui.config.ts test/uiAuditCenter.test.ts` (interface). O teste de adulteração desliga os gatilhos **só** no banco de teste e os religa.

## 7. M39 — resultado explícito, correlação persistida, comprovantes e privilégios mínimos

### 7.1 Resultado EXPLÍCITO (fim da inferência pelo nome da ação)
- `audit_log.outcome` ∈ {`concluida`, `recusada`, `falhou`, `pendente`}, gravado **no ponto do código que conhece o desfecho**. `NULL` = **"Resultado não registrado"**: todo o histórico anterior e as operações ainda não instrumentadas. Não é sucesso, não é falha e **nunca** é deduzido do nome da ação (a inferência da M38 foi removida do servidor e da tela).
- Semântica: `concluida` = a operação registrada terminou; `recusada` = barrada por regra de domínio (pausa/política/limite, rejeição humana, evento fora do contrato); `falhou` = não terminou por erro; `pendente` = aceita, mas o desfecho final é **outro registro** (ex.: pedido de nova análise, exceção aguardando decisão, verificação pedida).
- **Garantias transacionais:** o registro de sucesso vive na **mesma transação** do negócio e é gravado depois do último passo que pode falhar — um rollback leva o registro junto (testado com falha real na publicação do evento: nenhum `concluida` para operação inexistente). A **falha** é auditada fora da transação revertida (`recordAuditFailure`, transação própria) ou pela própria máquina de estados do motor (`agente.evento_falha`, resultado `falhou`).
- Instrumentados: cadastro de oportunidade, alteração de categoria, pedido/recusa de nova análise, transições da execução do agente (mapa explícito `outcomeForRunStatus`), criação e decisão de exceção, alteração de limites e de pausa/emergência, ligar/desligar agente, alerta de integridade, lançamento de estoque (concluído/pendente de aprovação), pedido de verificação e geração de comprovante. **Não instrumentados (continuam "não registrado"):** o restante dos fluxos (destinação, matching, necessidades, login, etc.).

### 7.2 Versão do registro e compatibilidade do hash
- `audit_log.record_version`: **1** = formato histórico (o hash canônico **não** cobre resultado/correlação — todo hash já gravado continua verificável, nada foi recalculado nem reescrito); **2** = o hash cobre `outcome:<valor>` e `corr:<id>` (sempre presentes, vazios quando nulos).
- Constraint do banco: v1 só com colunas novas nulas; v2 exige ao menos uma. O verificador acusa `versao_inconsistente`, `versao_nao_suportada` e — novo — `hash_ausente_apos_inicio_da_cadeia` (um registro **sem hash depois do primeiro evento encadeado** não passa mais por "histórico"; só os anteriores ao primeiro hash, da migração 0003, continuam sendo "não verificáveis").
- Falsificar o resultado de um registro v2 (ex.: `recusada` → `concluida`) ou trocar sua correlação **quebra o hash** (testado).

### 7.3 Correlação persistida
- Gerada **no servidor** (`newCorrelationId`, UUID v4) na origem — cadastro de oportunidade, lançamento de estoque, recebimento — e copiada para `domain_events`, `agent_event_runs` (herdada do evento), `exception_queue`, `donation_opportunities` e `audit_log.correlation_id`. O corpo da requisição **nunca** a define (campo enviado pelo cliente é ignorado — testado). Não carrega dados (aleatório), é **diferente** do id do recurso (`entity_id`) e do id da operação pontual (`metadata.correlacao`, M36/M37).
- Registros anteriores à M39 **não ganham correlação**; a rastreabilidade diz isso. A Central distingue: **registro diretamente associado** (mesma entidade), **relacionado por correlação persistida** (outra entidade, mesma correlação) e **sem vínculo verificável**. A ordem no tempo não é apresentada como causalidade.

### 7.4 As três garantias de integridade
| | O que é | Estado |
|---|---|---|
| **A** | Consistência interna (`verifyAuditLogChain`) | Disponível. Não vê truncamento do fim nem recálculo completo. |
| **B** | Comparação com **comprovante anterior** | Disponível (local). Só vale se o comprovante foi preservado por quem **não** controla o banco. |
| **C** | **Âncora independente** (serviço externo, assinatura, carimbo de tempo) | **Não configurada.** Depende de autorização específica. |

### 7.5 Comprovante local da cadeia (garantia B)
- Formato `levora-audit-chain-receipt` v1, algoritmo `sha256`, escopo `global_chain`. Corpo (chaves ordenadas, `stableStringify`): `algorithm, capturedAt, eventCount, format, formatVersion, headHash, lastEventId, scope, unhashedEvents, verificationId, verificationResult` + `receiptDigest` (SHA-256 do corpo canônico sem esse campo). Só metadados: nenhum conteúdo de auditoria, dado pessoal ou segredo.
- **Só nasce** da última verificação **íntegra**; recusa se o estado mudou entre a verificação e o pedido (registro final ausente, sem hash ou contagem diferente).
- **Comparação** (`compareReceipt`), nesta ordem: forma/versão/algoritmo/digest/escopo → o registro final ainda existe? (`registro_final_ausente`) → mesmo hash? (`hash_do_registro_diferente`: alterado ou **cadeia recalculada**) → contagem até ele (`quantidade_menor`: registro intermediário removido) → consistência interna até ele (`inconsistencia_interna`: alteração sem recálculo). Registros posteriores são esperados (`eventsSinceReceipt`). Comprovante malformado, de outra versão/algoritmo ou de outro escopo recebe status explícito e **nunca** "confere". Resultados ficam em `audit_chain_receipt_comparisons` (append-only).
- **Modelo de confiança (dito na tela):** o arquivo é texto público, sem assinatura. O digest detecta edição acidental, não autoria. Quem controla o arquivo **e** o banco pode forjar um comprovante coerente com a cadeia adulterada — testado: o sistema aceita. Um comprovante no mesmo computador, sob o mesmo controle operacional, **não** é âncora independente.
- Permissão: gerar/comparar = **equipe da plataforma** (a cadeia é global; mesmo contrato da verificação). Organizações com `auditoria.leia` veem existência, data e estado — **sem** digest nem hash. Nenhuma permissão nova foi criada.

### 7.6 Privilégios mínimos do banco (protótipo, só em banco descartável)
`db/prototypes/leastPrivilege.ts` + `test/dbLeastPrivilege.test.ts` (não é migration, não é carregado pela aplicação). Papéis sintéticos com senha aleatória criados e removidos pelo teste.
- **runtime**: DML nas tabelas de negócio; só `SELECT`+`INSERT` nas tabelas append-only (descobertas no catálogo pelo gatilho `audit_log_block_mutation`, inclusive `audit_log`, comprovantes, comparações, histórico de oportunidade, eventos); em `audit_chain_verifications` `SELECT`+`INSERT` e `UPDATE` só das colunas de resultado. Sem DDL, `TRIGGER`, `TRUNCATE`, `DELETE` da trilha.
- **auditReader**: `SELECT` na trilha, verificações, comprovantes e comparações; **RLS** por organização (`levora.org_id`); não lê usuários/sessões nem altera nada.
- **migrator**: `CREATE` no schema; nenhum acesso aos dados de auditoria. (Alterar tabelas existentes exigiria ser dono delas — mudança de deploy **não** feita.)
- **Provado:** os fluxos reais (cadastro, categoria, motor, reavaliação, exceção, verificação, comprovante, comparação, Central) rodam com o papel runtime; as tentativas de alterar hash, apagar/truncar a trilha, desativar gatilho, fazer DDL, alterar/apagar verificações e comprovantes são recusadas pelo banco.
- **Não resolvido (dito, testado):** superusuário/**dono** desativa gatilhos e altera a trilha; o banco não aplica o RBAC da aplicação (o runtime altera política — quem autoriza é a aplicação); o runtime ainda **insere** registros novos (por isso o verificador trata linha sem hash após o início da cadeia como divergência); RLS não vale para superusuário/dono. Aplicar isso em produção exige mudança de implantação (papéis, donos, credenciais) **fora do escopo e não ativada**.

### 7.7 Decisões que dependem do proprietário
Âncora independente (qual serviço/assinatura/custódia); separação de papéis em produção; reavaliar decisões concluídas; instrumentar os demais fluxos com resultado; retenção dos comprovantes; quem guarda os comprovantes fora do banco.
