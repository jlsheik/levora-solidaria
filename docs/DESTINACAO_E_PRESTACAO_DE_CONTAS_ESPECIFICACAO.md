# Especificação — Destinação de recursos, atendimento de necessidades e prestação de contas (Fase 99A, revisão 99A.1)

**Especificação, não implementação.** Nenhum código, schema, migration, endpoint, helper, tela, teste ou configuração foi alterado por este documento. Escrito sobre a `master` no commit `d2c955d` (merge da Fase 98; CI do run `38621942694`, `test` e `qa-browser` verdes). O que está descrito como "hoje" foi lido no código desse commit; o que não existe no banco está marcado como tal.

**Revisão 99A.1:** incorpora as decisões definitivas de produto (seção 2) — procedimento auditável para divergência de unidades (D-6), as oito finalidades de destinação, encerramento de necessidade sem entrega total, datas retroativas, fora de escopo de lotes/FIFO, separação entre correção documental, estorno e devolução física — e remove as pendências de produto correspondentes. O que resta é **trabalho técnico futuro** (descrito) e **requisitos legais a validar** (seção 21).

Convenção: **[R-n]** = regra de negócio aprovada. **[T-n]** = decisão técnica resolvível na implementação. Nomes de tabelas/colunas/permissões "propostos" são o contrato conceitual; a numeração de migrations **não** é definitiva (seção 16).

Documentos relacionados: `docs/LEDGER_CORRECOES_ESPECIFICACAO.md` (ledger de recebimentos e estorno físico), `docs/PRESTACAO_CONTAS_ESPECIFICACAO.md` (relatório de impacto atual), `docs/RBAC_PERMISSOES.md`, `docs/PRIVACY.md`, `docs/ROADMAP_ATUAL.md`, `docs/VERSIONAMENTO_API.md`.

---

## 1. Objetivo e limites

Fechar conceitualmente o percurso:

> Oferta → atribuição → logística → recebimento → estoque → **destinação** → **atendimento da necessidade** → prestação de contas.

Cada etapa tem significado próprio; nenhuma é tratada como sinônimo de outra:

| Etapa | O que prova | O que NÃO prova |
|---|---|---|
| Atribuição | A rede designou a oferta a uma organização | Que o recurso chegou |
| Recebimento (`stock_transactions` entrada + `need_fulfillments`) | Que o recurso chegou à organização, em quantidade na unidade do item | Que foi usado ou distribuído |
| Estoque (saldo) | Quanto está fisicamente guardado | A origem de cada unidade (estoque agregado, sem lotes) |
| Saída de estoque | Que a quantidade deixou o estoque | Para quê, para quem, se atendeu uma necessidade |
| **Destinação** (nova) | A finalidade declarada de uma saída, com quantidade, unidade, data efetiva e, quando há, a necessidade e comprovante opcional | A identidade de quem recebeu (não se coleta) |
| **Atendimento** (novo significado) | Quantidade líquida contabilizável destinada a uma necessidade | — |

**Dentro:** modelo de dados, regras, fluxos, reversões, regularização de unidades, privacidade, RBAC, telas, compatibilidade histórica, migrações, testes e critérios de aceite, para implementação posterior em subfases.
**Fora:** qualquer implementação; cadastro nominal de beneficiários; conversão automática de unidades; rastreabilidade por lote/FIFO; transferência entre locais de estoque; notificação por e-mail (SMTP).

O sistema deverá responder, com dados auditáveis: o que foi doado; quanto foi recebido e em qual unidade; quanto resta; quanto saiu; com qual finalidade; qual necessidade recebeu; quantas pessoas foram atendidas (**agregado declarado**); quais saídas ainda não têm destinação estruturada; o que foi corrigido ou estornado; e como isso aparece nos relatórios.

---

## 2. Decisões de produto aprovadas

Todas as decisões abaixo estão **fechadas**; o que ainda precisa ser construído está na seção 19 (subfases) e o que depende de avaliação jurídica está na seção 21.

| Tema | Decisão aprovada | Onde está detalhada |
|---|---|---|
| **D-6 Unidades e dados** | Procedimento auditável de regularização: correção cadastral comprovada, conferência física (não é conversão), divergência dependente de conversão não suportada e caso sem informação permanecem **pendentes**; nenhuma conversão automática; nenhum lançamento de quantidade sem unidade confiável; nenhuma perda de rastreabilidade; vocabulário controlado de unidades | seção 10 |
| **Finalidades** | Oito finalidades fechadas: `atendimento_coletivo`, `distribuicao_familias`, `entrega_instituicao_parceira`, `uso_operacional_instituicao`, `doacao_a_terceiro`, `devolucao_ao_doador`, `perda`, `descarte`. Ajuste de estoque **não** é finalidade | seção 6 |
| **Encerramento de necessidade sem entrega total** | Estado `cancelada` com **motivo estruturado**; sem saída de estoque; parciais continuam contabilizados; preserva solicitado, atendido, saldo não atendido e motivo | seção 8.5 |
| **Data da destinação** | `delivered_on` (efetiva, informada) separada de `created_at` (registro, servidor); retroação de até 7 dias corridos pela organização; além disso exige autorização administrativa, justificativa e auditoria; nunca futura; relógio e fuso do servidor | seção 8.6 |
| **Lotes e FIFO** | Fora do escopo. A destinação liga-se à saída e ao item; o sistema não afirma de qual oferta saiu uma unidade | seção 7.4 |
| **Correção, estorno e devolução** | Quatro situações distintas: correção documental, correção de quantidade com movimento compensatório, devolução física, estorno documental sem retorno físico | seção 9 |
| **Métricas** | Recebido, suprimento recebido, em estoque, destinado, atendido, atendida e "sem destinação estruturada" são medidas distintas e nunca se somam entre si | seção 5 |
| **Registros históricos** | Preservados; nenhum backfill; nenhuma reclassificação silenciosa; correções por eventos | seção 15 |
| **Privacidade** | Sem cadastro nominal; só dados agregados e operacionais; comprovante opcional autorizado por finalidade | seção 12 |
| **Revisão jurídica** | Retenção, base legal e tratamento de comprovantes dependem de validação | seção 21 |
| **Ledger** | `need_fulfillments` continua sendo **suprimento recebido da rede** e não muda; o atendimento é derivado das destinações | seções 5 e 11 |
| **`atendida`** | Estado do sistema, derivado das destinações; nunca gera saída automática; `needs-status_POST` deixa de baixar estoque | seção 8.4 |

---

## 3. Mapa atual do código e da cadeia de dados (verificado)

### 3.1 Cadeia real

| Etapa | Ponto de entrada | Tabelas | Observações verificadas |
|---|---|---|---|
| Oferta da rede | `src/endpoints/opportunity-registry_POST.ts` (só admin da plataforma) | `opportunity_registry` | `unit` e `quantity` anuláveis |
| Oferta local | `src/endpoints/opportunities_POST.ts` | `donation_opportunities` (`unit`, `quantity_offered`, `linked_need_id`) | módulo separado do matching e do ledger |
| Atribuição | matching (`src/helpers/opportunityMatching.tsx`) ou `opportunity-allocations_POST.ts` | `opportunity_allocations` | Fase 98: prazo, expiração, pausa |
| Logística | `allocations-logistics_POST.ts` | `logistics_events` (imutável) | |
| Recebimento da rede | `allocations-receive_POST.ts` | `stock_transactions` (`entrada`), `need_fulfillments` (`original`), `logistics_events`, `files` | unidade gravada = a do **item**; a da oferta **não é lida** |
| Recebimento local | `opportunities-receive_POST.ts` | `stock_transactions` (`entrada`) | **não** cria linha no ledger; `donation_opportunities.unit` **não é lida** |
| Saldo | `src/helpers/stockBalance.tsx` | soma de `stock_transactions.delta` | |
| Saída | `stock-transactions_POST.ts` (`saida`) e `needs-status_POST.ts` | `stock_transactions` (`saida`) | `reason` livre (mín. 2 caracteres); **dois** escritores de `saida` |
| Ajuste | `stock-transactions_POST.ts` (`ajuste`) e `src/helpers/needFulfillmentCorrections.tsx` | `stock_transactions` (`ajuste`) | ajuste **negativo** ≥ 20 ou ≥ 30 % do saldo exige dupla aprovação (`approval_requests`, tipo `ajuste_estoque_alto_risco`); ajuste positivo não tem aprovação |
| Progresso da necessidade | `src/helpers/needFulfillment.tsx` | `need_fulfillments` | mede **suprimento recebido** (ver 3.3) |
| Resolução administrativa | `needs-status_POST.ts` | `need_resolutions` (UNIQUE `need_id`) | ver 3.2 |
| Correção/estorno de recebimento | `allocations-receipt-correct_POST.ts`, `allocations-receipt-reverse_POST.ts` | `need_fulfillments` (`correction`/`reversal`), `stock_transactions` (`ajuste`) | efeito físico é sempre **um** `ajuste` |
| Prestação de contas | `impact-report_GET.ts` + `src/helpers/impactReport.tsx` | leitura | `saidas` é total por item, sem finalidade |
| Comprovantes | `files-upload_POST.ts`, `files-download_GET.ts` | `files` (`purpose` só aceita `comprovante_entrega`) | download exige **associação à organização**, não a permissão `arquivos.leia` |

### 3.2 `needs-status_POST` hoje (comportamento que a Fase 99 substitui)

Ao mudar para `atendida` (exige `necessidades.gerencie` e `inventario.lance`): se a necessidade tem `item_id`, não há `need_resolutions` e o status anterior não era `atendida`, insere **saída automática da `quantity_needed` inteira** (sem comparar unidades; 409 se saldo insuficiente) e grava `need_resolutions.stock_transaction_id`; sem item, grava resolução **declarativa** (`stock_transaction_id = NULL`). O status é livre entre `aberta`, `atendida` e `cancelada`; reverter não desfaz a saída. "Atendida" significa hoje "a quantidade total saiu do estoque, ou alguém declarou que sim".

### 3.3 O ledger `need_fulfillments` mede suprimento, não atendimento

`allocation_id` é **NOT NULL** (só recebimentos da rede entram). A interface já o chama de "Recebido pela rede" (`src/pages/organizacoes.$organizationId.necessidades.tsx`). Seu `requiredRemaining` é usado pelo **matching** e por `opportunity-allocations_POST.ts` para não destinar à necessidade mais do que ela precisa; esse uso precisa continuar sendo a medida de **suprimento** — se passasse a usar a quantidade destinada, a rede reenviaria recursos a quem já os tem parados em estoque. `impactReport.tsx` calcula `statusWarning = (status === "atendida" && requiredRemaining > 0)`.

### 3.4 Unidades: três conceitos, uma comparação

| Unidade | Onde mora | Comparada com quê hoje |
|---|---|---|
| da oferta | `opportunity_registry.unit`, `donation_opportunities.unit` (anuláveis; texto livre) | **com nada** no recebimento |
| do item | `inventory_items.unit` (NOT NULL; texto livre digitado no formulário) | é a unidade do saldo e do `quantity` do ledger |
| da necessidade | `needs.unit` (NOT NULL; texto livre) | com a do item, só em `createNeedFulfillment`, via `normalize()`; divergência grava `is_countable = false` + `unit_mismatch_note` |

`normalize()` (acentos e caixa) **não é conversão**: "caixa" ≠ "caixas" e "un" ≠ "unidade". Valores observados nas sementes e testes do repositório: `kg`, `un`, `unidade` — **não** são um inventário dos dados reais (ver 10.5).

### 3.5 O que o histórico prova e não prova
Prova: origem da oferta, decisão, ator e prazo da atribuição, logística, recebimento (quantidade, item, data, ator, comprovante), correções e estornos do recebimento, saldo e cada movimento, auditoria encadeada por hash. **Deixa de explicar o destino:** qualquer `saida` (livre) e a baixa automática. **Não é provável sem lotes:** qual doação específica foi entregue.

---

## 4. Problemas comprovados pelo código

| # | Problema | Evidência |
|---|---|---|
| P1 | Saída é quantidade com motivo livre, sem finalidade estruturada | `stock-transactions_POST.schema.ts` (`reason: z.string().min(2)`) |
| P2 | "Atendida" gera saída automática da quantidade **total** | `needs-status_POST.ts` (`willConsumeStock`) |
| P3 | Resolução declarativa permite "atendida" sem lastro físico | `needs-status_POST.ts` (`willCreateDeclarativeResolution`) |
| P4 | Dois conceitos com nome parecido: ledger de suprimento e "atendida" administrativa; o relatório chama o ledger de "atendimento" | `prestacao-contas.tsx`, `necessidades.tsx` |
| P5 | Doação local com `linked_need_id` não tem efeito na necessidade; o ledger não a comporta | `opportunities-receive_POST.ts`; `need_fulfillments.allocation_id NOT NULL` |
| P6 | Unidade da oferta nunca é comparada com a do item; saldo recebe quantidade bruta | `allocations-receive_POST.ts`, `opportunities-receive_POST.ts` |
| P7 | `statusWarning` só enxerga suprimento | `impactReport.tsx` |
| P8 | Comprovantes: só `comprovante_entrega`; download por associação, não por finalidade | `files-upload_POST.schema.ts`, `files-download_GET.ts` |
| P9 | `saidas` do relatório é total por item, sem finalidade nem separação das sem destinação | `impact-report_GET.schema.ts` |
| P10 | Unidades são texto livre sem registro de aliases; não há edição de item/necessidade/oferta nem trilha de correção | formulários, `docs/ROADMAP_ATUAL.md` §2 |
| P11 | O fuso horário é o do navegador; não há fuso de negócio no servidor | `src/helpers/reportDates.tsx` |

---

## 5. Vocabulário e métricas (um significado por palavra)

| Termo | Definição | Fonte |
|---|---|---|
| **Recebido** | Recurso que chegou à organização (entrada de estoque da rede ou doação local) | `stock_transactions` entrada |
| **Suprimento recebido** | Entrada elegível de uma necessidade pelo ledger da rede, descontadas correções e estornos | `need_fulfillments` (inalterado) |
| **Em estoque** | Quantidade física disponível | soma de `stock_transactions.delta` |
| **Destinado** | Quantidade que saiu do estoque com finalidade estruturada | `stock_destinations` |
| **Atendido** | Quantidade de uma necessidade efetivamente destinada e contabilizável, líquida de reversões | derivado de `stock_destinations` |
| **Atendida** | Estado do sistema quando o atendido alcança o necessário (ou estado histórico, ver 15) | `needs.status` |
| **Sem destinação estruturada** | Saída histórica cuja finalidade não pode ser reconstruída com segurança | saída sem linha de destinação |

**Suprimento recebido e atendimento final são métricas distintas e nunca se somam como se fossem a mesma coisa.** O suprimento orienta a decisão de enviar recursos; o atendimento demonstra o uso final. A interface e os relatórios usam esses nomes e nunca "atendido" para o que é só recebido.

---

## 6. Finalidades de destinação (enumeração fechada)

Chaves técnicas estáveis (não mudam; rótulos podem mudar). Todas **exigem saída física** do estoque (a destinação é criada junto com a saída, ver 8.1). Ajuste de estoque **não** é finalidade.

| Chave / rótulo | Uso | Necessidade | Motivo exigido | Comprovante | Pessoas atendidas | Contabiliza atendimento | Indicadores |
|---|---|---|---|---|---|---|---|
| `atendimento_coletivo` — "Atendimento coletivo" | Uso ou distribuição para um grupo, sem identificar participantes | **pode** vincular (necessidade compatível) | não (observação opcional) | opcional | opcional (nº de pessoas do grupo, agregado) | **sim**, se vinculada e unidade compatível | "Destinado ao atendimento" |
| `distribuicao_familias` — "Distribuição a famílias" | Entrega direta de itens a famílias; sem nomes, contatos ou documentos | **pode** vincular | não | opcional | opcional; **significado fixo:** nº de famílias **ou** de pessoas, indicado por um campo `people_unit` (`familias`/`pessoas`) — nunca somados entre si | **sim**, se vinculada e unidade compatível | "Destinado ao atendimento" |
| `entrega_instituicao_parceira` — "Entrega a instituição parceira" | Entrega física a instituição parceira para a atuação social dela | **pode** vincular (registrado quando houver) | não | opcional | opcional | **sim**, se vinculada e unidade compatível (a entrega à instituição é a destinação; não afirma beneficiário final) | "Destinado ao atendimento (via instituição)" |
| `uso_operacional_instituicao` — "Uso operacional da organização" | Consumo interno necessário à operação | **não** | **sim** (descrição ≥ 10 caracteres) | opcional | não | **não** | "Destinado à operação" (separado do atendimento) |
| `doacao_a_terceiro` — "Doação a terceiro" | Transferência a entidade/destinatário externo fora do fluxo de instituição parceira | **não** | **sim** (≥ 10 caracteres) | opcional | não | **não** | "Doado a terceiros" |
| `devolucao_ao_doador` — "Devolução ao doador" | Devolução física ao doador ou fornecedor | **não** | **sim** (≥ 10 caracteres); referência opcional à oferta/doação de origem quando conhecida | opcional | não | **não** | "Devolvido ao doador" |
| `perda` — "Perda" | Perda física involuntária (avaria, deterioração) | **não** | **sim** (motivo + descrição ≥ 10 caracteres) | opcional | não | **não** | "Perdas" |
| `descarte` — "Descarte" | Eliminação intencional de recurso inutilizável ou impróprio | **não** | **sim** (motivo + descrição ≥ 10 caracteres) | opcional | não | **não** | "Descartes" |

Regras comuns:
1. **Necessidade vinculada** só nas três categorias de atendimento; as demais exigem `need_id IS NULL` (CHECK no banco).
2. **Contabilizável** (`is_countable`) = categoria de atendimento **e** `need_id` informado **e** unidade compatível (seção 10); nunca é contabilizável o que não serve a uma necessidade.
3. **Permissões:** `atendimento_coletivo`, `distribuicao_familias`, `entrega_instituicao_parceira`, `uso_operacional_instituicao` e `perda` exigem `inventario.lance` + `destinacoes.registre` (proprietário, administrador, operador). `doacao_a_terceiro`, `devolucao_ao_doador` e `descarte` (saídas de maior risco e sem finalidade de atendimento) exigem `destinacoes.corrija` (proprietário, administrador).
4. **Risco proporcional:** `perda`, `descarte`, `doacao_a_terceiro` e `devolucao_ao_doador` aplicam as **mesmas faixas da dupla aprovação de ajuste negativo** (quantidade ≥ 20 ou ≥ 30 % do saldo): a saída fica pendente num pedido de aprovação (novo tipo de ação) e, ao aprovar, a saída **e** a destinação são criadas numa única transação, revalidando saldo e estado. [T-1: reaproveitar `approval_requests`.]
5. **Reversão sem saldo fictício:** ver seção 9; só há entrada compensatória quando o recurso voltou fisicamente.
6. **Ajuste × perda:** um ajuste negativo continua sendo um ajuste. Para não haver duas baixas do mesmo fato, a interface passa a oferecer **"registrar perda/descarte"** (destinação) no lugar de "ajuste negativo" quando o motivo é perda; um ajuste negativo **antigo** que representava uma perda pode ser **classificado** por uma linha de destinação `perda`/`descarte` que **referencia o ajuste existente** (classificação documental, sem novo movimento), apenas por quem tem `destinacoes.corrija`. [T-2: o gatilho aceita `ajuste` negativo como movimento vinculado **somente** nestas duas categorias e só uma vez por movimento.]
7. **Limite documentado:** não há categoria de transferência entre locais de estoque, porque o modelo atual (saldo agregado por item e organização) não tem localizações internas.
8. Nenhuma categoria é acrescentada sem justificativa concreta e nova decisão de produto.

---

## 7. Modelo de dados recomendado

### 7.1 Tabela `stock_destinations` (eventos imutáveis)

Três espécies de linha, todas append-only (gatilhos de bloqueio como no ledger):

```
stock_destinations
  id                       BIGSERIAL PK
  organization_id          INTEGER NOT NULL -> organizations(id) ON DELETE RESTRICT
  entry_type               TEXT NOT NULL CHECK IN ('original','correction','reversal')
  item_id                  INTEGER NOT NULL -> inventory_items(id) ON DELETE RESTRICT
  stock_transaction_id     BIGINT            -- movimento físico: saída (original); ajuste negativo já existente (classificação, 6.6);
                                             -- entrada/ajuste compensatório (reversal); NULL em correction e em estorno documental
  need_id                  INTEGER           -- só categorias de atendimento
  destination_type        TEXT NOT NULL      CHECK IN (as oito chaves da seção 6)
  quantity                 NUMERIC(12,3)     CHECK (> 0)   -- original: quantidade da saída; reversal: quantidade afetada; correction: NULL
  unit                     TEXT              -- unidade canônica do item no momento (copiada)
  is_countable             BOOLEAN           -- original: decidido pelas regras; reversal: herdado da original
  delivered_on             DATE              -- data EFETIVA informada (original; correction pode corrigi-la)
  people_served            INTEGER           CHECK (>= 0)
  people_unit              TEXT              CHECK IN ('familias','pessoas')  -- obrigatório se people_served informado
  notes                    TEXT              -- observações operacionais não sensíveis (limite de tamanho)
  proof_file_id            INTEGER
  surplus_reason           TEXT              -- excedente autorizado (8.3)
  late_registration_reason TEXT              -- retroação > 7 dias (8.6)
  authorized_by_user_id    INTEGER           -- quem autorizou excedente/retroação, quando exigido
  reverses_destination_id  BIGINT            -> stock_destinations(id) ON DELETE RESTRICT   -- reversal e correction
  reversal_kind            TEXT              CHECK IN ('correcao_quantidade','devolucao_fisica','estorno_documental')
  reason                   TEXT              -- obrigatório em correction e reversal
  created_by_user_id       INTEGER NOT NULL -> users(id)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()  -- data de REGISTRO (servidor)
```

**Distinção das situações exigidas:** destinação original = `original`; correção documental = `correction` (só campos não contábeis, ver 9.1); estorno documental = `reversal` com `reversal_kind = 'estorno_documental'`; devolução física = `reversal` com `devolucao_fisica` ligada a **entrada** compensatória; correção de quantidade = `reversal` com `correcao_quantidade` ligada a **ajuste positivo** compensatório. Cada evento carrega motivo e ator; a quantidade original fica na linha original e a afetada na linha do evento; **data efetiva** (`delivered_on`) e **data de registro** (`created_at`) são colunas distintas; estado contabilizável e vínculo com a necessidade estão na original e são herdados.

**Integridade no banco (não só no TypeScript):**
- FK composta `(stock_transaction_id, organization_id)` → `stock_transactions(id, organization_id)` (UNIQUE já existe): movimento de outra organização é rejeitado.
- FK composta `(need_id, organization_id)` → `needs(id, organization_id)` (UNIQUE já existe).
- FK composta `(proof_file_id, organization_id)` → `files(id, organization_id)`: exige `UNIQUE (id, organization_id)` em `files` (verdadeiro por construção; migration própria).
- CHECKs por espécie: `original` ⇒ `stock_transaction_id` e `delivered_on` não nulos, `reversal_kind IS NULL`, `reverses_destination_id IS NULL`; `correction` ⇒ `reverses_destination_id` e `reason` não nulos, `quantity IS NULL`, `stock_transaction_id IS NULL`, e **nenhum** dos campos contábeis (`need_id`, `destination_type`, `is_countable`, `unit`); `reversal` ⇒ `reverses_destination_id`, `reversal_kind`, `reason` e `quantity` não nulos; `reversal_kind = 'estorno_documental'` ⇔ `stock_transaction_id IS NULL`.
- `destination_type` fora das três de atendimento ⇒ `need_id IS NULL` e `is_countable = false`; `people_served` só nas três de atendimento.
- `UNIQUE (stock_transaction_id) WHERE stock_transaction_id IS NOT NULL`: cada movimento físico pertence a no máximo uma linha.
- **Gatilho de validação** (padrão de `need_fulfillment_validate_entry`, com trava na linha de `stock_transactions` e na original): para `original`, o movimento é `saida` (ou `ajuste` negativo nos casos de 6.6) do mesmo item e organização, `quantity = -delta`, `unit = inventory_items.unit`; para reversão, a original existe, é da mesma organização, **Σ reversões ≤ quantidade da original** e o tipo do movimento compensatório é coerente (`devolucao_fisica` → entrada; `correcao_quantidade` → ajuste positivo; `estorno_documental` → nenhum); no máximo **uma destinação original ativa** (não totalmente revertida) por movimento; `is_countable`, `need_id`, `unit` e item herdados da original.
- Gatilhos `BEFORE UPDATE`/`BEFORE DELETE` com a função de bloqueio já usada (`audit_log_block_mutation`). Regra do projeto: nenhuma FK nova usa `CASCADE`/`SET NULL` contra tabelas imutáveis (todas `RESTRICT`).

**Como cada risco é evitado:**

| Risco | Garantia |
|---|---|
| Destinações duplicadas para a mesma saída | `UNIQUE (stock_transaction_id)` + gatilho de "uma original ativa" com trava no movimento |
| Reversões acima da original | gatilho Σ reversões ≤ original, serializado por trava na original |
| Reversões concorrentes incompatíveis | trava na original; a segunda lê o estado confirmado |
| Atendimento acima do permitido sem autorização | trava na necessidade + regra 8.3 + `surplus_reason` obrigatório |
| Referências entre organizações | FKs compostas por organização (stock, necessidade, arquivo) |
| Saldo físico criado por estorno documental | estorno documental exige `stock_transaction_id IS NULL`; só `devolucao_fisica`/`correcao_quantidade` geram movimento, e movimento compensatório exige o tipo coerente |
| Dupla contagem suprimento × destinado | ledger intocado; atendido derivado só de `stock_destinations` (seção 5) |
| Soma de unidades incompatíveis | `is_countable` só com unidade compatível; relatórios agregam por item/unidade |

### 7.2 Tabelas de apoio

- **`need_closures`** (eventos imutáveis; seção 8.5): `need_id` (FK composta com organização), `reason_code`, `reason_text`, `quantity_needed_snapshot`, `attended_snapshot`, `remaining_snapshot`, ator, `created_at`.
- **`unit_regularization_cases` + `unit_regularization_events`** (seção 10.4): caso (fatos de origem imutáveis) + eventos append-only (estado derivado).
- **Registro de unidades** (`unit_registry`, `unit_aliases`; seção 10.5).

### 7.3 Alternativas comparadas

| Modelo | Descrição | Veredicto |
|---|---|---|
| **M1** | Tabela de eventos `stock_destinations` (acima) | **Recomendado**: separa suprimento e atendimento; não toca estoque nem ledger; correções e reversões como eventos; constraints fortes |
| M2 | Colunas extras em `stock_transactions` | Rejeitado: tabela imutável e central misturaria conceitos; reversão exigiria outra estrutura |
| M3 | Estender `need_fulfillments` (origem genérica: `allocation_id` NULL + `destination_id`, `CHECK num_nonnulls(allocation_id, destination_id) = 1`) | Rejeitado: mistura suprimento e atendimento no mesmo total (reintroduz P4) e relaxa um NOT NULL que protege o ledger usado pelo matching. Só se o produto vier a exigir ledger único; exigiria FK composta por organização em ambas as origens e fórmula de saldo separada por origem |
| M4 | Finalidade em JSON/metadata de auditoria | Rejeitado: sem integridade nem consulta |

### 7.4 Lotes e FIFO — fora do escopo
Nesta fase não há rastreabilidade por lote, número de série ou FIFO. A destinação liga-se à **movimentação de saída** e ao **item** da mesma organização. O sistema **não afirma** que determinada saída veio de uma oferta específica: o estoque é agregado e isso não é sustentável pelos dados. A origem da doação e o percurso até o recebimento continuam rastreáveis no fluxo existente; a identidade física de cada unidade entregue **não** pode ser inferida. Lotes/FIFO ficam documentados como **evolução futura**, só se surgir necessidade operacional demonstrada (por exemplo, validade de alimentos).

### 7.5 Relações de leitura (sem colunas redundantes)
- **Atendido(necessidade)** = Σ `quantity` das `original` contabilizáveis − Σ `quantity` das `reversal` cuja original é contabilizável. `correction` não altera quantidade.
- **Suprimento(necessidade)** = fórmula atual do ledger.
- **Saídas sem destinação estruturada** = `stock_transactions.type = 'saida'` sem linha em `stock_destinations`, em duas subclasses: *baixa automática histórica* (referenciada por `need_resolutions.stock_transaction_id`) e *saída manual anterior*.
- Tudo é calculado no SQL sobre o conjunto completo; os limites de exibição valem só para listas (como em `impactReport.tsx`).

---

## 8. Regras de negócio

### 8.1 Registrar destinação (fluxo normal)
Em **uma transação**, na ordem de travas da seção 17.3:
1. autoriza (permissões da seção 13; isolamento por organização);
2. trava o item (`FOR UPDATE`) e confere o saldo (nunca negativo);
3. se há `need_id`: trava a necessidade (`FOR NO KEY UPDATE`), confere organização, `status ≠ cancelada`, e que o item é o mesmo se a necessidade tem `item_id` (409 caso contrário); decide `is_countable` (seção 10);
4. se contabilizável: confere o excesso (8.3);
5. confere a data efetiva (8.6);
6. insere a saída (`stock_transactions`; o `reason` é **gerado** a partir da finalidade e da necessidade — o texto deixa de ser a fonte da verdade) e a destinação ligada a ela;
7. se o atendido alcançou o necessário, aplica a transição automática (8.4);
8. audita por último (`destinacao.registrada`). Qualquer falha reverte tudo.
Reenviar uma requisição já efetivada devolve 409 (sem nova saída).

### 8.2 O que não muda
Recebimento da rede (ledger, correções, estorno físico), matching, atribuições (Fases 95 a 98), idempotência do recebimento local (Fase 96), exclusão por recusa (Fase 97), dupla aprovação de ajustes.

### 8.3 Excedente
Se `atendido + quantidade > quantity_needed`, a destinação contabilizável é recusada (409) a menos que proprietário ou administrador informe `surplus_reason` (guardado na linha, com `authorized_by_user_id`; auditoria `destinacao.excedente_autorizado`). Sem motivo, não há atendimento acima do solicitado.

### 8.4 Estado da necessidade (consistente)
- `atendida` passa a ser **estado do sistema**: aplicado, na mesma transação, quando o atendido líquido alcança `quantity_needed` (auditoria `necessidade.atendida_automaticamente`).
- Se uma reversão derruba o atendido abaixo da quantidade e a necessidade está `atendida` **sem linha em `need_resolutions`** (isto é, atendida pelo modelo novo), o sistema volta a `aberta` (auditoria `necessidade.reaberta_automaticamente`). Necessidades `atendida` por resolução antiga **nunca** são reabertas pelo sistema. A regra P-L8 de `docs/LEDGER_CORRECOES_ESPECIFICACAO.md` continua valendo para as correções do ledger de recebimentos (elas não alteram `needs.status`); a reabertura automática vale só para a queda do **atendido por destinação**.
- `needs-status_POST` com `atendida` manual: **recusado** (409, informando quanto falta). **Nenhum** caminho de `needs-status_POST` insere em `stock_transactions` ou `need_resolutions` depois da implantação. Entrega parcial **nunca** gera baixa automática.
- `aberta` (reabertura manual) segue como hoje.

### 8.5 Encerramento de necessidade sem entrega total
Usa o estado **existente** `cancelada` (não se cria estado duplicado) com **motivo estruturado**: `reason_code` ∈ {`recursos_insuficientes`, `necessidade_superada`, `duplicidade`, `desistencia_da_organizacao`, `outro`} + `reason_text` (obrigatório em `outro` e sempre que houver atendimento parcial). Grava um evento em `need_closures` com os instantâneos de solicitado, atendido e saldo não atendido. O cancelamento **não cria saída**. As entregas parciais já registradas continuam contabilizadas e visíveis ("cancelada com atendimento parcial de X"), sujeitas às regras de unidade e reversão. Nunca se muda para `atendida` sem atendimento contabilizável ≥ necessário. A quantidade solicitada original nunca é alterada.

### 8.6 Data efetiva da destinação
- `created_at` é a **data de registro**, do relógio do servidor/banco; `delivered_on` é a **data efetiva** informada.
- Não pode ser **futura** (destinação registrada como realizada).
- A organização pode registrar retroativamente até **7 dias corridos**; além disso exige **autorização administrativa** (`destinacoes.corrija`), `late_registration_reason` e auditoria.
- **Fuso e referência:** o servidor decide "hoje" no **fuso de negócio configurado no servidor** (padrão proposto `America/Sao_Paulo`, [T-3]: hoje não existe fuso de negócio no servidor, ver P11) e compara **datas de calendário**; o navegador só envia a data escolhida e **nunca** é a autoridade para aceitar datas retroativas ou futuras.
- Relatórios distinguem **data efetiva** e **data de registro** (filtros e colunas separados).
- Corrigir a data é uma `correction` (9.1): o valor anterior permanece na linha original.

### 8.7 Quem pode o quê
Seção 13.

---

## 9. Correções, reversões e devoluções (E6)

Princípios: nunca editar nem apagar; nunca criar saldo físico fictício; movimento compensatório **só** quando o fato físico o justifica; a correção documental **nunca** serve para contornar os controles de estoque.

| Situação | Quando | Movimento físico | Linha | Quem | Auditoria |
|---|---|---|---|---|---|
| **9.1 Correção documental** | campo **descritivo/administrativo** errado: `notes`, `people_served`/`people_unit`, `proof_file_id`, `delivered_on` (com 8.6) | **nenhum** | `correction` (campos novos; original intacta) | quem registrou ou `destinacoes.corrija`; data retroativa > 7 dias exige autorização | `destinacao.corrigida` com valor anterior e novo |
| **9.2 Correção de quantidade** (`correcao_quantidade`) | a saída foi registrada em quantidade **maior** do que ocorreu: parte do recurso nunca saiu | `ajuste` **positivo** compensatório vinculado à reversão | `reversal` | `destinacoes.corrija` | `destinacao.revertida` + motivo; o ajuste passa **pelo mesmo caminho e controles de ajuste de estoque**: se a regra de risco aplicável exigir aprovação (positiva ou negativa), ela se aplica; hoje só há aprovação para negativos |
| **9.3 Devolução física** (`devolucao_fisica`) | o recurso foi entregue e **voltou** ao estoque | `entrada` positiva (devolução) referenciando a saída/destinação | `reversal` | `destinacoes.corrija` + `inventario.lance` | idem |
| **9.4 Estorno documental** (`estorno_documental`) | a entrega ocorreu fisicamente, mas o **registro** estava errado (necessidade, finalidade, quantidade atribuída) | **nenhum** (sem entrada fictícia) | `reversal` sem movimento | `destinacoes.corrija` | idem; o atendimento contabilizável é compensado; **a mesma saída** pode receber nova destinação correta só depois de estorno total |

Regras comuns:
1. Campos que afetam o **atendimento** (`need_id`, `destination_type`, `quantity`, `unit`, `is_countable`) **não** podem ser alterados por correção documental: a correção é estorno (9.4) + nova destinação. Isso impede usar a "correção documental" para mudar atendimento ou estoque.
2. Cada evento referencia a original e informa autor, data, motivo e quantidade afetada.
3. `Σ reversões ≤ quantidade da original`; a mesma quantidade não é revertida duas vezes; reversões concorrentes se serializam.
4. O atendido cai pela quantidade contabilizável revertida; a original nunca é alterada.
5. O movimento compensatório e a linha de reversão nascem **na mesma transação**.
6. Um ajuste compensatório **negativo** (não ocorre nestes quatro casos) seguiria as regras e a dupla aprovação existentes.
7. Reverter uma destinação **não** desfaz recebimentos nem o ledger da rede.
8. A "devolução ao doador" é uma **finalidade** (saída para fora); a "devolução física" é a **reversão** de uma saída (o recurso volta ao estoque). Não se confundem.

---

## 10. Unidades e dados: procedimento auditável (D-6)

### 10.1 Regra de negócio fechada
1. **Nenhuma conversão automática de unidade.**
2. **Nenhum lançamento** (`stock_transactions`, `need_fulfillments`, `stock_destinations`) com quantidade cuja unidade não esteja estabelecida e confiável.
3. **Nenhuma perda de rastreabilidade:** o fato de que o recurso foi apresentado ou recebido fica registrado mesmo quando o recebimento precisa ser regularizado.
4. Uma nota explicativa **não** converte unidades e não substitui uma quantidade verificada.
5. O saldo é expresso na **unidade canônica do item**.

### 10.2 Erro de cadastro anterior ao recebimento (correção cadastral)
Quando a unidade da **oferta** (`opportunity_registry.unit`, `donation_opportunities.unit`), da **necessidade** ou de outro dado de origem está incorreta:
- **Se não há dependentes** (oferta/necessidade sem atribuição aceita, sem recebimento, sem movimentação de estoque e sem linha de ledger ou destinação), um ator autorizado pode corrigir por operação controlada e auditada: registro e campo identificados, **valor anterior e novo**, **motivo obrigatório**, ator e instante do servidor (`cadastro.correcao_registrada`), na mesma transação do UPDATE. Atores: oferta da rede → admin da plataforma; oferta local e necessidade → proprietário/administrador da própria organização (nova permissão `cadastro.corrija`; nunca troca genérica).
- **Se há dependentes**, o cadastro **não é alterado no lugar**: o histórico não é reinterpretado. Os valores históricos usados pelas operações anteriores permanecem (o ledger e as destinações copiam a unidade no momento). O caminho é um **evento corretivo** ligado ao original: para ofertas, nova oferta/recebimento regularizado por conferência física (10.4) preservando a original; para necessidades, `cancelada` (8.5) e nova necessidade com a unidade correta, com os parciais já feitos mantidos.

### 10.3 Item de estoque e unidade canônica
- Cada item tem **uma unidade canônica confiável**. A unidade de um item **já usado em movimentações não pode ser alterada** no lugar (os números históricos passariam a representar outra grandeza).
- Item sem movimentações pode ter a unidade corrigida pelo procedimento de 10.2 (auditado, `cadastro.correcao_registrada`).
- **Item com movimentações e unidade cadastrada errada** — procedimento de regularização documentado (sem conversão automática): (a) criar um **item substituto** com a unidade correta; (b) para o saldo remanescente, usa-se um par de lançamentos compensatórios **auditado** (nunca uma destinação fictícia): `ajuste` negativo no item antigo (zerando o saldo, com a dupla aprovação existente) e `ajuste` positivo no item novo, **apenas** com a quantidade **verificada por conferência física na unidade correta**; (c) o item antigo permanece, inativo na prática, com todo o histórico; (d) novas operações usam o substituto. Cada passo referencia o caso de regularização e a auditoria. É uma **reclassificação controlada**, não uma conversão.

### 10.4 Divergência no recebimento: pendência de regularização
> **Implementação (Fase 99C):** ver `docs/UNIDADES_REGULARIZACAO_99C.md`. *Transição deliberada:* oferta **sem unidade** (NULL) NÃO abre caso na implementação — a quantidade digitada por quem recebeu é uma observação física na unidade do item e a maioria das ofertas da rede tem unidade NULL; bloquear tudo isso impediria recebimentos legítimos. O caso abre quando a oferta **tem** unidade sem equivalência comprovada com a do item.

Aplica-se ao recebimento da rede e ao local quando a unidade da oferta (`unit` preenchida) **não é a unidade canônica do item** e **não existe equivalência aprovada** no registro de unidades (10.5) — comparação por **identificador canônico**, não por texto. Se a oferta não informa unidade, a unidade é **"não informada"** e segue o mesmo procedimento (a quantidade não é presumida na unidade do item).

**Comportamento:**
1. **Nada é lançado** como se fosse a quantidade do item: não há `stock_transactions`, ledger nem atendimento.
2. O evento **não é descartado**: cria-se (de forma idempotente e atômica, com auditoria) um **caso de regularização de unidade** com os fatos imutáveis: origem (atribuição ou doação local), item, organização, quantidade e unidade **ofertadas**, quem informou o recebimento e quando, etapa bloqueada ("recebimento"). A atribuição ou a doação **não** passa a `recebida`; mostra "recebimento pendente de regularização" (sem expirar por prazo da Fase 98 enquanto houver caso aberto).
3. O caso é classificado em **uma** das quatro categorias:

| Categoria | Significado | Saída possível |
|---|---|---|
| `erro_cadastral` | a unidade da oferta/necessidade está comprovadamente errada | correção (10.2) e retomada do fluxo |
| `conferencia_fisica` | a quantidade pode ser estabelecida por contagem/medição verificável na unidade canônica do item | conferência (abaixo) e retomada |
| `conversao_nao_suportada` | só resolveria com conversão ainda não suportada | **permanece pendente** até existir conferência física ou a funcionalidade aprovada |
| `informacao_insuficiente` | não há dados para decidir | **permanece pendente** |

**Conferência física (não é conversão):** um responsável autorizado informa a **quantidade efetivamente conferida na unidade canônica do item**, por contagem ou medição verificável. Registra-se: quantidade e unidade **originalmente ofertadas**; **quantidade conferida**; unidade canônica; **motivo da divergência**; ator que conferiu; **responsável pela validação** quando exigida; instante do servidor; evidência ou observação apropriada, **sem dados pessoais desnecessários**. Se a quantidade real não puder ser estabelecida com segurança, o caso **permanece pendente**; texto livre nunca substitui uma quantidade verificada.

**Validação:** a conferência por operador exige validação de proprietário/administrador **diferente** do autor; proprietário/administrador que conferiu exige validação de outra pessoa com essa função, **a menos que seja o único elegível**, caso em que a conferência é aceita e **marcada** "sem segunda validação" na auditoria e nos relatórios. [T-4: definir a regra exata no desenho da subfase.]

**Retomada:** só depois de a regularização produzir **quantidade e unidade válidas e auditadas**: numa única transação o sistema conclui o recebimento — `entrada` na unidade canônica com a **quantidade conferida**, linha de ledger (quando é recebimento da rede), mudança de estado da atribuição/doação, vínculo com o caso e auditoria — preservando no caso os valores ofertados.

### 10.5 Fila de pendências de unidade
Tela e consulta para os responsáveis autorizados, por organização, com: recurso (oferta/atribuição/doação), divergência (unidade ofertada × canônica), organização responsável, etapa bloqueada, categoria, idade do caso e **ações possíveis**.

| Ação | Quem | Permissão proposta |
|---|---|---|
| Ver os casos da própria organização | proprietário, administrador, operador | `regularizacao.leia` |
| Propor conferência física (informar quantidade conferida) | proprietário, administrador, operador | `regularizacao.confira` |
| Validar/aplicar a conferência (conclui o recebimento) | proprietário, administrador (≠ autor) | `regularizacao.valide` |
| Corrigir cadastro da oferta/necessidade/item **sem dependentes** | admin da plataforma (oferta da rede); proprietário/administrador (próprios) | `cadastro.corrija` |
| Classificar/reclassificar caso (`conversao_nao_suportada`, `informacao_insuficiente`) e acompanhar todas as organizações | admin da plataforma | — (papel de plataforma) |

Não existe permissão genérica para trocar unidade nem para alterar saldo: cada ação tem permissão própria, auditoria e escopo da organização.

### 10.6 Vocabulário controlado de unidades
- **Registro** `unit_registry` (identificador canônico estável, ex.: `kg`; **rótulo de interface** separado, ex.: "kg"; dimensão/classe: contagem, massa, volume, **embalagem**) e **aliases aprovados** `unit_aliases` (texto normalizado → identificador canônico, com aprovador e data).
- **Aliases só quando representam exatamente a mesma unidade** (singular/plural, abreviação inequívoca como `un` ≡ `unidade` **se revisado e aprovado**). **Não** se infere fator de conversão por semelhança textual; **não** se converte unidade de embalagem (caixa, pacote, saco, cesta, fardo) em unidade de conteúdo (kg, L, unidade).
- **Valores históricos ambíguos** (ex.: `un`, `pc`, `cx`, texto livre) **permanecem como estão** e são marcados "a revisar" até aprovação; nada é remapeado automaticamente.
- `normalize()` textual **não é conversão metrológica** e não pode ser tratada como tal; passa a ser, no máximo, uma etapa de **busca de alias candidato** para revisão humana, e a comparação de unidades usa o **identificador canônico**. Enquanto o registro não existir, a comparação conservadora é **igualdade exata do texto normalizado**; qualquer diferença vira divergência (por isso o inventário vem antes da regularização).
- **Início da implementação:** um **inventário** dos valores de unidade realmente existentes — consulta de contagem por valor distinto em `inventory_items.unit`, `needs.unit`, `opportunity_registry.unit`, `donation_opportunities.unit` e `need_fulfillments.unit` no banco **real** de cada ambiente —, classificação dos significados e **mapeamento revisado** por pessoas. Não se inventa uma lista universal de unidades sem examinar os dados atuais (os valores `kg`, `un`, `unidade` das sementes são só exemplos).
- Migração futura do vocabulário: colunas de referência **anuláveis** (`unit_id`) preenchidas **somente** onde há alias aprovado; as demais ficam nulas até revisão; os textos originais são preservados.

### 10.7 Destinação e necessidade
Conforme 8.1 e a seção 6: a destinação usa a unidade canônica do item; só conta para a necessidade se a unidade do item e a da necessidade forem **a mesma unidade canônica** (ou alias aprovado). Destinação física com unidade incompatível **existe**, com `is_countable = false` e **aviso antes de confirmar**; nunca aumenta o atendido; os relatórios separam **quantidade física** e **quantidade contabilizável** e agregam por item/unidade (nunca somam unidades diferentes). O ledger de suprimento mantém o comportamento atual (`is_countable = false` + nota) para a relação necessidade × item; isso **não** bloqueia estoque (a unidade do lançamento é a canônica).

---

## 11. Impacto sobre estoque e ledger

| Item | Efeito |
|---|---|
| `stock_transactions` | Estrutura **inalterada**. `saida` nova só nasce junto de uma destinação; aparecem `ajuste`/`entrada` compensatórios vinculados a reversões; recebimento em divergência de unidade **não** gera linha até a regularização. |
| `need_fulfillments` | **Inalterado**: suprimento recebido da rede. Matching, `opportunity-allocations_POST` e correções do recebimento continuam usando-o. |
| `need_resolutions` | Sem novas linhas após a implantação. Permanece para o histórico. |
| `needs` | Estrutura inalterada; `status` segue 8.4; encerramento por 8.5. |
| Saldos | Nenhum saldo muda por esta fase; muda a classificação das saídas novas. |
| Relatório | Ganha "atendido (destinação)" ao lado de "suprimento recebido" (seção 14). |

Doação local com `linked_need_id`: o recebimento **não** é atendimento; o vínculo vira **sugestão de pré-seleção** no formulário de destinação do mesmo item; o atendimento tem **uma única fonte**, a destinação, de modo que a mesma quantidade nunca conta por duas fontes (recebimento local não cria linha de ledger).

---

## 12. Privacidade e comprovantes [E5]

**Requisitos aprovados (ainda NÃO implementados; ver `docs/PRIVACY.md`):**
- **Sem cadastro nominal** de beneficiários. Registra-se: finalidade, quantidade, unidade, data efetiva e de registro, necessidade (se houver), número agregado de pessoas/famílias com `people_unit`, observações operacionais **não sensíveis**, comprovante opcional, autor, histórico de correção e reversão.
- `people_served` **não** é número de pessoas distintas: relatórios o rotulam "soma das quantidades declaradas nos registros".
- Não se pedem nomes, contatos, documentos ou dados sensíveis. A interface orienta a **não** colocar dados pessoais em observações e a **não** anexar documentos identificáveis sem necessidade; não há detecção automática (a mitigação é orientação e acesso restrito).
- **Comprovantes** com propósito próprio `comprovante_destinacao`; privados, sem URL pública. **Autorização por finalidade do arquivo:** pertencer à mesma organização **não basta** (hoje basta, P8). A leitura considera a **finalidade** (`purpose`), o **recurso ao qual o arquivo está ligado** (a destinação), a **função** do usuário e a permissão `destinacoes.leia`; arquivos de finalidades antigas mantêm as regras atuais. Isolamento por organização na consulta e na integridade referencial (FK composta).
- **Auditoria de acesso e alteração, quando aplicável:** alterações (anexar, trocar, remover referência por `correction`) sempre auditadas; registro de **acesso/leitura** de comprovante é requisito a avaliar por custo e finalidade [T-5] (a auditoria atual registra ações; leitura de arquivo já registra `arquivo.baixado`).
- **Retenção e revisão:** não há política de retenção configurável; a Fase 99 não a cria. Prazos, base legal e tratamento dependem de **avaliação jurídica** (seção 21).
- Correção sem apagar: toda correção é evento novo; nada é removido.

---

## 13. RBAC e isolamento multi-organização

Permissões **propostas** (só entram no catálogo `src/helpers/permissions.tsx` quando um endpoint real as exigir):

| Permissão | Proprietário | Administrador | Operador | Voluntário |
|---|---|---|---|---|
| `destinacoes.leia` (destinações, comprovantes, necessidades fechadas) | sim | sim | sim | não |
| `destinacoes.registre` (+ `inventario.lance`) — categorias comuns e `perda` | sim | sim | sim | não |
| `destinacoes.corrija` (reversões, correção de data retroativa, excedente, `doacao_a_terceiro`, `devolucao_ao_doador`, `descarte`, classificação de ajuste como perda) | sim | sim | não | não |
| `regularizacao.leia` / `regularizacao.confira` | sim | sim | sim | não |
| `regularizacao.valide` | sim | sim | não | não |
| `cadastro.corrija` (10.2, sem dependentes) | sim | sim | não | não |

- Toda consulta filtra por `organization_id`; FKs compostas impedem referência cruzada; endpoints seguem `requirePermission(user.id, organizationId, …)`.
- Papéis de **plataforma** (admin da plataforma): correção de oferta da rede, classificação de casos de regularização, leitura agregada **sem** comprovantes.
- Dupla aprovação: inalterada nos ajustes; estendida (T-1) às saídas de maior risco de 6, reutilizando o mecanismo.

---

## 14. Experiência e interfaces

**Linguagem:** os nomes refletem o que os dados provam. "Destinação registrada" (declarada pela organização) — **nunca** "entregue ao beneficiário" como afirmação, e nunca "atendida" para o que é só recebido.

1. **Estoque:** "Saída" vira **"Registrar destinação"** (diálogo): item, quantidade (unidade canônica visível), finalidade (as oito, com descrição), necessidade (somente nas três categorias de atendimento; sugere a vinculada à doação local e filtra por item/unidade), data efetiva (com aviso e exigência de justificativa/autorização além de 7 dias), pessoas/famílias (opcional, com `people_unit`), observações (aviso de não sensível), comprovante (opcional, `FileDropzone`). Avisos **antes** de confirmar: unidade incompatível (não contará), excesso (exige motivo), saldo insuficiente, necessidade de aprovação por risco. Ajuste continua separado (e oferece "registrar perda/descarte" quando o motivo é perda).
2. **Aba "Destinação":** histórico com filtros (período por data **efetiva** e por data de **registro**, item, necessidade, finalidade, situação ativa/corrigida/revertida), estados de carregamento, vazio, erro e sem permissão; ações "Corrigir" (9.1) e "Estornar/devolver" (9.2–9.4) com os cenários explicados em linguagem simples.
3. **Fila de pendências de unidade** (10.5): lista por organização, categoria, etapa bloqueada, idade, ações permitidas ao papel; fluxo de conferência física e de validação; indicador de pendências na área da organização (mesmo padrão da Fase 98: fonte única, sem contagem paralela).
4. **Necessidades:** três números — Necessário, **Suprimento recebido** (ledger, como hoje) e **Atendido (destinado)** — com o que falta; `atendida` como estado do sistema; "histórico, sem destinação estruturada" para as antigas; encerramento por `cancelada` com motivo estruturado ("cancelada com atendimento parcial de X").
5. **Prestação de contas:** bloco "Destinação" (por finalidade, item/unidade, necessidade); colunas Recebido × Em estoque × Destinado × Saldo; "saídas sem destinação estruturada" (duas subclasses); registros corrigidos/revertidos marcados; comprovantes com acesso protegido; **física** × **contabilizável** separadas; indicadores distintos de operação, terceiros, devoluções, perdas e descartes; `statusWarning` compara `atendida` com o **atendido**.
6. **Administração da plataforma:** leitura agregada e fila de regularização (todas as organizações), sem edição de saldos.
7. Responsivo em 375/390/768/1280, teclado, rótulos e `aria-live` nos avisos, sem expor IDs internos nem dados pessoais; reaproveita o design system.

---

## 15. Compatibilidade histórica

- **Sem backfill.** Nenhuma destinação, caso de regularização ou alias é criado automaticamente a partir de saída + texto livre ou de unidades existentes.
- Saídas antigas permanecem, como "histórico sem destinação estruturada"; as da baixa automática ficam marcadas "baixa automática histórica (resolução da necessidade)". Nenhuma é reclassificada silenciosamente.
- `need_resolutions` existentes continuam legíveis; necessidades `atendida` antigas não são reabertas e têm atendido por destinação = 0, indicado como histórico — nunca recalculado a partir da saída automática.
- Recebimentos antigos com unidade divergente permanecem como estão (ledger com `is_countable = false` e nota).
- Correções posteriores **nunca reinterpretam** movimentos históricos: valem para o futuro ou por evento corretivo ligado ao original (10.2, 10.3).
- O relatório distingue "registros herdados" de "novos registros" pela existência da linha de destinação.
- Comprovantes `comprovante_entrega` seguem como estão.

---

## 16. Sequenciamento de migrations

**Estado verificado (`origin/master`, `d2c955d`):** `0001` a `0015` contíguas (`0014_allocation_response_deadline` e `0015_platform_assignment_settings` são da Fase 98). `test/schemaMigrations.test.ts` exige numeração `0001..000N` sem lacunas nem duplicatas e `test/migrationCompat.test.ts` exige classificação em `db/migrationCompat.ts`. **Não se criam exceções.**

**Trabalhos concorrentes (apenas locais, fora do histórico remoto):** `0014_agent_platform.sql` (arquivo não versionado no checkout principal, base `a628bd4`) e `0015_identity_foundation` a `0019_social_reauth` (branches locais de identidade). Esta especificação **não** os toca, não renumera e não altera bancos que os tenham aplicado.

**Estratégia (os números abaixo são previsões, não definitivos):**
- A implementação da destinação pede **migrations aditivas separadas** por classe: restrição única em `files` (satisfeita por construção); tabelas novas (`stock_destinations`, `need_closures`, casos/eventos de regularização, registro de unidades); colunas de referência anuláveis para o vocabulário. A **quantidade e a ordem** dessas migrations serão definidas na subfase correspondente.
- **No dia em que cada subfase com migration começar**: `git fetch`, listar `db/migrations` na `master` **daquele momento**, usar os **próximos números contíguos livres** e reconfirmar antes de criar arquivos. Se agentes ou identidade tiverem sido integrados antes, os números mudam. **Nenhum número atual é definitivo.**
- Agentes e identidade serão integrados depois, **renumerados na entrada** na ordem de integração (mantendo a ordem relativa interna de cada bloco), atualizando nomes, chaves de `MIGRATION_COMPAT`/`CHECKS`, `db/schema.sql`, referências em documentos e fixtures; testes de sequência e classificação passam sem exceção; cadeia completa validada em banco descartável (instalação nova × atualização).
- **Risco local:** `schema_migrations` guarda o nome do arquivo; um banco que aplicou o nome antigo verá o renomeado como pendente e falhará com "já existe". Bancos de desenvolvimento/teste descartáveis devem ser **recriados**; qualquer banco que precise ser **preservado** exige plano específico e validado antes de renomear.

---

## 17. Implantação, concorrência e rollback

### 17.1 Implantação
Aditiva e gradual (seção 19): as primeiras subfases não mudam contratos existentes; a mudança de contrato (saída exige destinação; `atendida` deixa de baixar estoque; recebimento com divergência vira pendência) ocorre em subfases próprias, junto com a interface correspondente. Não há consumidores externos conhecidos da API v1 (só a SPA, publicada com o servidor), mas as mudanças devem ser registradas em `docs/VERSIONAMENTO_API.md`.

### 17.2 Rollback
Migrations aditivas e sem backfill: reverter o schema só é seguro **antes** de existir dado real; depois, a correção é "para frente". Reverter só o código depois de destinações existirem é perigoso (o código antigo voltaria a baixar estoque ao marcar `atendida`). Cada subfase exige reverter o commit de merge e um teste que prove o comportamento anterior preservado quando aplicável.

### 17.3 Ordem de travas (única para toda a Fase 99)
`atribuição → oportunidade → item → necessidade → caso de regularização → auditoria (por último)`. Verificado: `allocations-receive_POST` trava atribuição → item; a Fase 81 resolveu o ciclo necessidade↔item com `FOR NO KEY UPDATE`; `needs-status_POST` deixa de travar item (não baixa mais estoque), eliminando o ciclo; a destinação trava item e depois necessidade.

### 17.4 Cenários de concorrência e falha
1. Duas destinações da mesma saída → uma vence, a outra 409.
2. Duas destinações perto do limite da necessidade → serializadas pela trava; a segunda vê o líquido atualizado.
3. Destinação × cancelamento da necessidade → quem travar primeiro vence.
4. Duas reversões da mesma original → Σ nunca passa da original.
5. Reversão × nova destinação do mesmo movimento (após estorno total) → serializadas pela trava do movimento.
6. Falha de auditoria → rollback total (saída, destinação, compensatório, transição de status, caso).
7. Falha ao gravar o comprovante → FK composta impede referência inexistente.
8. Saída com saldo insuficiente concorrente → a segunda recebe 409 sem efeito.
9. Transição automática `atendida` × reabertura manual → serializadas pela trava da necessidade.
10. Duas conferências do mesmo caso → serializadas pela trava do caso; a segunda lê o estado confirmado; o recebimento é concluído **uma vez**.
11. Conferência × correção cadastral do mesmo recurso → serializadas; correção só sem dependentes.
12. Recebimento (Fase 96) idempotente concorrente com abertura de caso → um só caso aberto por origem.

---

## 18. Matriz de testes e critérios de aceite

Todos com PostgreSQL real em banco `_test`, travas seguradas, falhas injetadas no banco (padrão das Fases 95 a 98).

**Destinação e atomicidade** — A-01 uma saída de atendimento gera exatamente uma destinação válida; A-02 saída e destinação atômicas; A-03 falha de auditoria não deixa saída sem destinação; A-04 a mesma saída não recebe duas destinações normais (concorrente e sequencial); A-05 saída nova sem destinação é recusada, `ajuste`/`entrada` seguem como antes; A-06 categorias sem atendimento com necessidade são rejeitadas **no banco**; A-07 referência a necessidade, movimento ou comprovante de outra organização rejeitada pelo banco; A-08 cada uma das oito categorias com seus campos obrigatórios, permissões e efeitos (tabela da seção 6); A-09 perda/descarte/terceiro/devolução acima das faixas de risco ficam pendentes de aprovação e criam saída + destinação atomicamente ao aprovar; A-10 classificar um ajuste negativo antigo como perda não cria segunda baixa.

**Atendimento** — B-01 parcial somado e "o que falta" corretos; B-02 mudar status não cria saída (nenhum caminho de `needs-status_POST` insere em `stock_transactions`); B-03 `atendida` manual recusada, automática no limite; B-04 excedente sem motivo recusado, com motivo (proprietário/administrador) aceito e marcado; B-05 unidade incompatível não aumenta o atendimento; B-06 necessidade com `item_id` só aceita o mesmo item; B-07 reversão reduz o atendido; `atendida` do modelo novo reabre, a histórica não; B-08 `cancelada` exige motivo estruturado, não cria saída, preserva solicitado/atendido/saldo; B-09 matching e `opportunity-allocations_POST` seguem usando suprimento.

**Datas** — H-01 data futura recusada; H-02 retroação ≤ 7 dias aceita; H-03 > 7 dias exige autorização, justificativa e auditoria; H-04 relógio/fuso do servidor decidem (o navegador não autoriza); H-05 `delivered_on` e `created_at` distintos e filtráveis separadamente; H-06 correção de data preserva o valor anterior.

**Correções e reversões** — C-01 original nunca alterada nem apagada; C-02 Σ reversões ≤ original, concorrentes serializadas; C-03 `correcao_quantidade` → ajuste positivo pelo caminho de ajustes; `devolucao_fisica` → entrada; `estorno_documental` → nenhum movimento; C-04 nenhum saldo fictício; C-05 estorno total libera nova destinação do mesmo movimento, parcial não; C-06 permissões; C-07 correção documental **não** altera campos de atendimento (rejeitada no banco); C-08 correção documental não contorna aprovação de estoque.

**Unidades** — U-01 divergência no recebimento **não** cria `stock_transactions`, ledger nem atendimento e **não** perde o evento (caso aberto, idempotente); U-02 oferta sem unidade segue o mesmo procedimento; U-03 conferência física conclui o recebimento uma vez, na unidade canônica, preservando ofertado × conferido; U-04 validação por segunda pessoa; "sem segunda validação" marcada; U-05 caso `conversao_nao_suportada`/`informacao_insuficiente` permanece pendente; U-06 correção cadastral sem dependentes audita anterior/novo/motivo; com dependentes é recusada no lugar; U-07 unidade de item com movimentos não muda; U-08 nenhuma conversão automática existe; U-09 aliases só se aprovados; embalagem ≠ conteúdo; U-10 quantidade física e contabilizável separadas; nunca se somam unidades diferentes.

**Ledger e doação local** — D-01 doação local não conta duas vezes (recebimento não cria ledger; destinação conta uma vez); D-02 `linked_need_id` só pré-seleciona; D-03 `need_fulfillments` inalterado.

**Histórico e relatórios** — E-01 saídas antigas intactas e aparecem como "sem destinação estruturada" (duas subclasses); E-02 `need_resolutions` antigas legíveis, nenhuma necessidade reaberta; E-03 migração sem backfill (0 linhas novas); E-04 reconciliação por item/período: saldo inicial + entradas + ajustes − saídas = saldo final, e saídas = com destinação + sem destinação; E-05 `statusWarning` compara com o atendido; E-06 `people_served` rotulado; E-07 indicadores de operação, terceiros, devoluções, perdas e descartes separados do atendimento.

**Segurança, privacidade e interface** — F-01 comprovante só por quem tem `destinacoes.leia` da organização dona e finalidade compatível; outra organização, voluntário e anônimo recebem 403/401; F-02 upload do novo propósito segue as validações atuais; F-03 isolamento total; F-04 nenhum campo pede nome, contato ou documento; limites de tamanho; F-05 cadeia de auditoria íntegra; F-06 interface em 375/390/768/1280, claro/escuro, teclado, leitor de tela, estados vazio/erro/carregando/sem permissão; F-07 `qa:visual` com cenários novos (diálogo, aba, fila de pendências) e `qa:security` sem regressão.

**Regressões** — G-01 Fases 94 a 98 sem regressão (suíte completa, `qa:security`, `qa:visual`); G-02 idempotência do recebimento local (Fase 96) e exclusão por recusa (Fase 97) intactas; G-03 prazo e expiração de atribuições (Fase 98) não expiram atribuição com recebimento pendente de regularização.

---

## 19. Sequência de implementação por subfase

Ordem revisada pelas dependências reais: **unidades antes** de qualquer destinação contabilizável; o **modelo de destinação** antes de mudar o significado de `atendida`. As migrations de cada subfase têm números definidos só no dia (seção 16).

| Subfase | Objetivo | Dependências | Escopo | Riscos | Testes | Critérios de conclusão (evidência) |
|---|---|---|---|---|---|---|
| **99B Inventário e vocabulário de unidades** | base confiável de unidades | — | consulta de inventário nos bancos reais; classificação; mapeamento revisado; `unit_registry`/`unit_aliases` (migration aditiva); colunas `unit_id` anuláveis preenchidas só com alias aprovado; comparação por identificador canônico | mapear errado; pressa em remapear ambíguos | U-08, U-09 | inventário documentado e revisado; mapeamento aprovado; nenhum valor ambíguo alterado |
| **99C Regularização auditável de unidades e dados** | P6, P10 | 99B | casos/eventos de regularização; recebimento (rede e local) vira pendência em divergência; conferência física e validação; correção cadastral sem dependentes; procedimento de item substituto; fila e permissões | travar fluxo legítimo; compatibilidade com Fase 96 e Fase 98 | U-01 a U-07, G-02, G-03 | divergência nunca lança estoque; conferência conclui o recebimento uma vez; fila funcional |
| **99D Modelo de destinação e migration aditiva** | base de dados | 99B | `stock_destinations`, `need_closures`, `UNIQUE` em `files`; gatilhos; tipos; classificação em `migrationCompat` | gatilhos errados | A-06, A-07, C-01, C-07, E-03 + `schemaMigrations` | schema novo = schema atualizado; tabelas vazias |
| **99E Registro atômico de saída e destinação** | P1 | 99D | endpoint de destinação; oito categorias; permissões `destinacoes.*`; aprovação por risco; restrição de saída livre; datas (8.6) | quebra de contrato | A-01 a A-10, H-01 a H-06, F-01 a F-04 | critérios A e H |
| **99F Progresso parcial e regra definitiva de `atendida`** | P2, P3, P4, P7 | 99E | atendido derivado; transição automática; `needs-status_POST` sem baixa nem `atendida` manual; excedente; `cancelada` com motivo; doação local como pré-seleção | números mudam de rótulo | B-01 a B-09, D-01 a D-03 | critérios B e D |
| **99G Correções, reversões e devoluções físicas** | E6 | 99E, 99F | quatro situações da seção 9 | concorrência | C-01 a C-08 | critérios C |
| **99H Relatórios de impacto** | P9 | 99E a 99G | bloco Destinação; recebido × atendido; sem destinação; indicadores separados; reconciliação | contrato de `impact-report_GET` | E-01 a E-07, U-10 | critérios E |
| **99I Interface de destinação e prestação de contas** | experiência | 99C a 99H | diálogo, aba, fila de pendências, necessidades, prestação de contas, administração | regressão visual | F-06, F-07 | QA visual e acessibilidade |
| **99J Comprovantes, privacidade e permissões** | P8 | 99E | propósito `comprovante_destinacao`; autorização por finalidade; textos de orientação; `PRIVACY.md` ativo | vazamento de comprovante | F-01, F-02, F-04 | critérios F |
| **99K Validação de ponta a ponta** | integração | todas | ponta a ponta, concorrência, `qa:security`, CI, atualização do roadmap | — | G-01 a G-03 + todas | seção 22 |

O ledger de recebimentos **não** muda em nenhuma subfase. Se um dia o produto exigir ledger único (M3), será uma subfase própria **depois** de 99K, com migration e testes de contabilidade novos.

---

## 20. Limitações e riscos conhecidos

- **Estoque agregado:** não se prova qual doação foi entregue; o relatório prova entradas por origem, saídas por finalidade e a reconciliação por item.
- **`people_served`** é declarado e não deduplica pessoas.
- **Rótulos** mudam de significado ("atendimento" → "suprimento recebido" para o ledger): risco de confusão e testes que fixam textos.
- **Mudança de contrato** em `stock-transactions_POST`, `needs-status_POST` e nos recebimentos (sem consumidores externos conhecidos).
- **Carga operacional:** casos de regularização e validação por segunda pessoa podem sobrecarregar organizações pequenas; mitigação: regra do único elegível (T-4) e fila clara.
- **Comprovantes** podem conter dados pessoais enviados por engano: orientação e acesso restrito, sem detecção.
- **Unidades históricas ambíguas** só serão resolvidas por revisão humana (99B).
- **Numeração de migrations** pode mudar antes da implementação (seção 16).
- A cobertura visual do CI continua reduzida (18 de 27 cenários, só Chrome); a Fase 99 precisa adicionar cenários próprios.

---

## 21. Requisitos legais a validar (dependem de avaliação jurídica)

Este documento **não** é parecer legal e não declara obrigações específicas. Dependem de validação:
- prazo de **retenção** de destinações, comprovantes e casos de regularização;
- **base legal** e finalidade para o tratamento dos dados agregados e dos comprovantes;
- adequação do `people_served`/`people_unit` quando as quantidades forem pequenas (risco de reidentificação);
- tratamento de comprovantes que, apesar da orientação, contenham dados pessoais (eliminação sob solicitação × imutabilidade da trilha);
- eventual exigência de convênios ou financiadores sobre comprovação de entrega.

Todas as demais decisões de produto desta especificação estão **definidas** (seção 2). O que falta construir é **trabalho técnico**: [T-1] aprovação por risco das saídas de maior risco; [T-2] classificação de ajuste antigo como perda; [T-3] fuso de negócio no servidor; [T-4] regra exata de validação da conferência; [T-5] registro de leitura de comprovantes; inventário e vocabulário de unidades (99B); interface administrativa (99I).

---

## 22. Condições objetivas para declarar a Fase 99 concluída

Só se **todas** valerem, com evidência (comandos e resultados reais, CI no commit integrado):
1. As subfases 99B a 99K integradas, cada uma com o critério da seção 19.
2. A matriz da seção 18 implementada e aprovada (nenhum item removido ou enfraquecido).
3. Nenhuma saída nova sem destinação; nenhum caminho cria saída ao mudar status; ajuste continua separado.
4. Atendimento calculado só por destinações contabilizáveis líquidas; suprimento e atendimento separados nos relatórios e nas telas.
5. Doação local com `linked_need_id` conta uma vez, só por destinação.
6. Nenhuma conversão automática; nenhum lançamento com unidade incerta; divergência sempre vira caso auditável e retomável; quantidade física e contabilizável separadas.
7. Saídas e resoluções antigas preservadas e identificadas; zero backfill.
8. Comprovantes protegidos por finalidade, sem dado pessoal exigido.
9. Cadeia de auditoria íntegra; Fases 94 a 98 sem regressão; `qa:security` e `qa:visual` (com cenários novos) aprovados.
10. `docs/ROADMAP_ATUAL.md`, `docs/PRIVACY.md` e `docs/RBAC_PERMISSOES.md` refletindo exatamente o que está implementado (não o planejado).
11. O fluxo de doação não é declarado concluído de ponta a ponta antes disso.
