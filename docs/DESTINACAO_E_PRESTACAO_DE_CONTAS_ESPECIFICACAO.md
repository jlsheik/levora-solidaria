# Especificação — Destinação de recursos, atendimento de necessidades e prestação de contas (Fase 99A)

**Especificação, não implementação.** Nenhum código, schema, migration, endpoint, helper, tela, teste ou configuração foi alterado por este documento. Ele foi escrito sobre a `master` no commit `d2c955d` (merge da Fase 98, CI do run `38621942694` verde em `test` e `qa-browser`). Tudo que está descrito como "hoje" foi lido no código desse commit; o que ainda não existe no banco está marcado como tal.

Convenção: **[E1]–[E6]** são as decisões de produto já tomadas pelo dono e consolidadas aqui. **[D-n]** é uma decisão que o código ou a evidência disponível não permite fechar: fica explicitamente pendente, com alternativas e efeitos (seção 19). **[T-n]** é decisão técnica resolvível na implementação.

Documentos relacionados: `docs/LEDGER_CORRECOES_ESPECIFICACAO.md` (semântica do ledger de recebimentos e estorno físico), `docs/PRESTACAO_CONTAS_ESPECIFICACAO.md` (relatório de impacto atual), `docs/RBAC_PERMISSOES.md`, `docs/PRIVACY.md`, `docs/ROADMAP_ATUAL.md`.

---

## 1. Objetivo e limites da fase

Fechar conceitualmente o percurso:

> Oferta → atribuição → logística → recebimento → estoque → **destinação** → **atendimento da necessidade** → prestação de contas.

Cada etapa tem significado próprio e nenhuma é tratada como sinônimo de outra:

| Etapa | O que prova | O que NÃO prova |
|---|---|---|
| Atribuição | A rede designou a oferta a uma organização | Que o recurso chegou |
| Recebimento (`stock_transactions` entrada + `need_fulfillments`) | Que o recurso chegou à organização | Que foi usado ou distribuído |
| Estoque (saldo) | Quanto está fisicamente guardado | Origem de cada unidade (o estoque é fungível, sem lotes) |
| Saída de estoque | Que a quantidade deixou o estoque | Para quê, para quem ou se atendeu uma necessidade |
| **Destinação** (nova) | A finalidade declarada de uma saída, com quantidade, unidade, data e, quando há, a necessidade e um comprovante opcional | A identidade de quem recebeu (não se coleta) |
| **Atendimento** (novo significado) | Quantidade líquida contabilizável destinada a uma necessidade | — |

**Dentro desta especificação:** modelo de dados, regras de negócio, fluxos, reversões, unidades, privacidade, RBAC, telas, compatibilidade histórica, migrações, testes e critérios de aceite, para uma implementação posterior em subfases.

**Fora:** qualquer implementação; cadastro nominal de beneficiários [E5]; tabela de conversão de unidades [E4]; edição de necessidades e de itens de inventário (decisão de produto separada, ver [D-6]); notificação por e-mail (SMTP).

O sistema deve conseguir responder, com dados auditáveis: o que foi doado; quanto foi recebido e em qual unidade; quanto resta em estoque; quanto saiu; com qual finalidade; qual necessidade recebeu; quantas pessoas foram atendidas **em termos agregados declarados**; quais saídas ainda não têm destinação estruturada; o que foi corrigido ou estornado; e como isso aparece nos relatórios.

---

## 2. Mapa atual do código e da cadeia de dados (verificado)

### 2.1 Cadeia real

| Etapa | Ponto de entrada | Tabelas | Observações verificadas |
|---|---|---|---|
| Oferta da rede | `src/endpoints/opportunity-registry_POST.ts` (só admin da plataforma) | `opportunity_registry` | `unit` e `quantity` anuláveis |
| Oferta local | `src/endpoints/opportunities_POST.ts` | `donation_opportunities` (`unit`, `quantity_offered`, `linked_need_id`) | módulo separado do matching e do ledger |
| Atribuição | matching (`src/helpers/opportunityMatching.tsx`) ou `opportunity-allocations_POST.ts` | `opportunity_allocations` | Fase 98: prazo, expiração, pausa |
| Logística | `allocations-logistics_POST.ts` | `logistics_events` (imutável) | |
| Recebimento da rede | `allocations-receive_POST.ts` | `stock_transactions` (`entrada`), `need_fulfillments` (`original`), `logistics_events`, `files` (comprovante) | a unidade gravada é a do **item** (`item.unit`); a unidade da oferta **não é lida** |
| Recebimento local | `opportunities-receive_POST.ts` | `stock_transactions` (`entrada`) | **não** cria linha no ledger; `donation_opportunities.unit` **não é lida** |
| Saldo de estoque | `src/helpers/stockBalance.tsx` | soma de `stock_transactions.delta` | |
| Saída de estoque | `stock-transactions_POST.ts` (tipo `saida`) e `needs-status_POST.ts` | `stock_transactions` (`saida`) | `reason` é texto livre (mínimo 2 caracteres); **dois** escritores de `saida` |
| Ajuste de estoque | `stock-transactions_POST.ts` (tipo `ajuste`) e `src/helpers/needFulfillmentCorrections.tsx` | `stock_transactions` (`ajuste`) | ajuste negativo ≥ 20 ou ≥ 30 % do saldo exige dupla aprovação (`approval_requests`, tipo `ajuste_estoque_alto_risco`) |
| Progresso da necessidade | `src/helpers/needFulfillment.tsx` (`getNeedFulfillmentBalance`, `computeNeedProgress`) | `need_fulfillments` | mede **suprimento recebido** pela rede, não entrega (ver 2.3) |
| Resolução administrativa | `needs-status_POST.ts` | `need_resolutions` (UNIQUE `need_id`) | ver 2.2 |
| Correção/estorno de recebimento | `allocations-receipt-correct_POST.ts`, `allocations-receipt-reverse_POST.ts` | `need_fulfillments` (`correction`/`reversal`), `stock_transactions` (`ajuste`) | efeito físico é sempre **um** `ajuste` |
| Prestação de contas | `impact-report_GET.ts` + `src/helpers/impactReport.tsx` | leitura | `saidas` é um total por item, sem finalidade |
| Comprovantes | `files-upload_POST.ts`, `files-download_GET.ts` | `files` (`purpose` só aceita `comprovante_entrega`) | download exige **associação à organização**, não a permissão `arquivos.leia` |

### 2.2 `needs-status_POST` hoje (comportamento que a Fase 99 muda)

Ao mudar uma necessidade para `atendida` (exige `necessidades.gerencie` **e** `inventario.lance`):

- se a necessidade tem `item_id`, ainda não tem linha em `need_resolutions` e o status anterior não era `atendida`, o endpoint insere uma **saída automática de toda a `quantity_needed`** (`reason = "Baixa automática: necessidade … marcada como atendida"`), sem comparar unidades, e grava `need_resolutions.stock_transaction_id`; se o saldo é insuficiente, responde 409;
- se não tem item vinculado, grava uma resolução **declarativa** (`stock_transaction_id = NULL`);
- o status é livre entre `aberta`, `atendida` e `cancelada`; reverter o status não desfaz a saída nem a resolução; uma segunda passagem por `atendida` não gera segunda baixa (UNIQUE `need_id`).

Consequência: "atendida" hoje significa "a quantidade total necessária saiu do estoque, ou alguém declarou que sim", independentemente do que foi de fato entregue, em que unidade, ou se houve entrega parcial.

### 2.3 O ledger `need_fulfillments` mede suprimento, não atendimento

- `allocation_id` é **NOT NULL** e referencia `opportunity_allocations`: só recebimentos da rede entram no ledger.
- A interface já o chama de "Recebido pela rede" (`src/pages/organizacoes.$organizationId.necessidades.tsx`) e de "Parcialmente atendida pela rede".
- `requiredRemaining` desse ledger é usado pelo **matching** e por `opportunity-allocations_POST.ts` para não destinar à necessidade mais do que ela precisa. Esse uso é correto e **precisa continuar sendo a medida de suprimento**: se o matching passasse a usar a quantidade destinada, a rede enviaria recursos de novo a quem já os tem parados em estoque.
- `src/helpers/impactReport.tsx` calcula `statusWarning = (status === "atendida" && requiredRemaining > 0)`.

### 2.4 Unidades: três conceitos, uma comparação

| Unidade | Onde mora | Comparada com quê hoje |
|---|---|---|
| da oferta | `opportunity_registry.unit`, `donation_opportunities.unit` (anuláveis) | **com nada** no recebimento |
| do item | `inventory_items.unit` (NOT NULL) | é a unidade do saldo e do `quantity` gravado no ledger |
| da necessidade | `needs.unit` (NOT NULL) | com a do item, só em `createNeedFulfillment`, via `normalize()` (texto: acentos e caixa); divergência grava `is_countable = false` + `unit_mismatch_note`; o estoque recebe a quantidade bruta |

`normalize()` não é conversão: "caixa" e "caixas" são tratadas como diferentes.

### 2.5 O que o histórico consegue e não consegue provar

- **Prova com confiança:** origem da oferta, decisão, ator e prazo da atribuição, eventos de logística, recebimento (quantidade, item, data, ator, comprovante), correções e estornos do recebimento, saldo e cada movimento de estoque, auditoria encadeada por hash.
- **Deixa de explicar o destino:** qualquer `saida` (livre) e a baixa automática. Não há vínculo estruturado com finalidade, necessidade, comprovante ou quantidade de pessoas.
- **Não é provável sem lotes:** qual doação específica foi entregue. O estoque é um saldo fungível por item; uma saída de arroz não identifica de qual entrada veio.

---

## 3. Problemas comprovados pelo código

| # | Problema | Evidência |
|---|---|---|
| P1 | Saída de estoque é quantidade com motivo livre, sem finalidade estruturada | `stock-transactions_POST.schema.ts`: `reason: z.string().min(2)`; `stock_transactions.reason TEXT` |
| P2 | "Atendida" gera saída automática da quantidade **total** necessária | `needs-status_POST.ts` (bloco `willConsumeStock`) |
| P3 | Resolução declarativa permite "atendida" sem lastro físico algum | `needs-status_POST.ts` (`willCreateDeclarativeResolution`) |
| P4 | Dois conceitos com nome parecido: ledger de suprimento ("fulfillments") e "atendida" administrativa; relatório chama o ledger de "atendimento" | `prestacao-contas.tsx` ("Líquido do atendimento desta atribuição"); `necessidades.tsx` |
| P5 | Doação local vinculada a necessidade (`linked_need_id`) não tem efeito algum na necessidade; o ledger não consegue representá-la | `opportunities-receive_POST.ts` não toca o ledger; `need_fulfillments.allocation_id NOT NULL` |
| P6 | Unidade da oferta nunca é comparada com a do item; saldo recebe quantidade bruta | `allocations-receive_POST.ts` seleciona só `item.unit`; `opportunities-receive_POST.ts` não lê `unit` |
| P7 | `statusWarning` só enxerga o suprimento (ledger), não entrega | `impactReport.tsx` |
| P8 | Comprovantes: só `comprovante_entrega` (recebimento); download por associação, não por permissão/finalidade | `files-upload_POST.schema.ts`, `files-download_GET.ts` |
| P9 | `saidas` do relatório é um total por item, sem separar finalidade nem saídas sem destinação | `impact-report_GET.schema.ts` (`itemMovements`) |
| P10 | Edição de unidade/quantidade/item de necessidades e itens de inventário não existe (decisão de produto pendente), então "exigir a correção dos dados" só tem os caminhos "escolher/criar outro item" ou corrigir a oferta | `docs/ROADMAP_ATUAL.md` §2 |

---

## 4. Decisões E1 a E6 consolidadas

### E1 — Toda saída física nova tem destinação estruturada
- Saída (`type = saida`) nova **exige** um registro de destinação criado **na mesma transação**. A finalidade vem de uma lista fechada (nada de texto livre como categoria).
- `ajuste` continua no fluxo atual (permissões, dupla aprovação, motivo) e **nunca** é tratado como entrega a beneficiários. `entrada` não muda.
- Categorias iniciais (revisáveis na implementação, ver [D-3]): `atendimento_coletivo`, `distribuicao_familias`, `instituicao_parceira`, `doacao_terceiros`, `perda_descarte`.
- `doacao_terceiros` e `perda_descarte` **não** podem apontar para necessidade (sem forçar necessidade artificial); as três primeiras podem, e só elas podem contar para o atendimento.
- Não há backfill: saídas antigas ficam "sem destinação estruturada" (seção 13).
- O endpoint `needs-status_POST` deixa de criar saídas (E2).

### E2 — "Necessidade atendida" = quantidade efetivamente destinada e contabilizável
Regras (todas verificáveis):

1. Entregas parciais podem ser registradas; cada destinação informa quantidade e unidade.
2. Atendimento líquido = Σ destinações contabilizáveis − Σ estornos das mesmas.
3. Destinação com unidade incompatível com a da necessidade **não** aumenta o atendimento (E4).
4. A necessidade só está completamente atendida quando o líquido contabilizável ≥ `quantity_needed`.
5. Mudar o status para `atendida` **nunca** cria saída de estoque (P2 deixa de existir). Quem aplica `atendida` é o sistema, quando o líquido contabilizável alcança a quantidade (6.4); o `needs-status_POST` passa a **recusar** `atendida` manual (409, informando quanto falta).
6. Quando há entrega parcial, a interface mostra o atendido e o que falta.
7. Atendimento contabilizável acima do solicitado exige autorização explícita e auditada (6.3).
8. Encerrar sem entrega total usa o estado já existente `cancelada` com motivo auditado (ver [D-2] para a alternativa de um novo estado); **nunca** `atendida`.
9. Necessidades antigas e suas `need_resolutions` continuam legíveis e não são reabertas nem reclassificadas.
10. O significado vale para endpoints, telas e relatórios: onde hoje se lê "atendida/atendimento" para o ledger, passa a ler-se "recebido/suprimento".

### E3 — Doação local com `linked_need_id`
- O recebimento local **não** é atendimento. Só uma destinação física válida contribui.
- Como o estoque é fungível (sem lotes), a destinação se liga à **necessidade** diretamente (campo `need_id` da destinação), e não à doação de origem. Assim a mesma quantidade nunca conta por duas fontes: o atendimento tem **uma só fonte, a destinação**.
- `linked_need_id` da doação local passa a ser apenas uma **sugestão de pré-seleção** no formulário de destinação do mesmo item (não é vínculo contábil).
- O ledger `need_fulfillments` **não muda** na Fase 99: continua significando suprimento recebido por atribuição da rede. Ver comparação de modelos na seção 5.2 e a alternativa de ledger unificado.

### E4 — Unidades
Seção 9. Em resumo: sem conversão automática; saldo na unidade do item; recebimento com unidade da oferta incompatível é bloqueado por padrão; destinação física pode existir sem ser contabilizável; relatórios separam quantidade física e contabilizável; nunca se somam grandezas incompatíveis.

### E5 — Privacidade
Sem cadastro nominal. Registra-se só o mínimo (seção 10).

### E6 — Imutabilidade e reversão
Destinação é imutável e se corrige por **novos eventos** que referenciam o original, como o ledger. Três cenários distintos de reversão, cada um com sua movimentação compensatória (seção 7).

---

## 5. Modelo de dados recomendado

### 5.1 Tabela `stock_destinations` (recomendada)

Uma tabela de eventos, imutável, com duas espécies de linha:

```
stock_destinations
  id                       BIGSERIAL PK
  organization_id          INTEGER NOT NULL  -> organizations(id) ON DELETE RESTRICT
  entry_type               TEXT NOT NULL     CHECK IN ('original', 'reversal')
  item_id                  INTEGER NOT NULL  -> inventory_items(id) ON DELETE RESTRICT
  stock_transaction_id     BIGINT            -- movimento físico: saída (original); entrada/ajuste compensatório (reversal); NULL só em reversal documental
  need_id                  INTEGER           -- NULL = destinação sem necessidade
  destination_type         TEXT NOT NULL     CHECK IN ('atendimento_coletivo','distribuicao_familias','instituicao_parceira','doacao_terceiros','perda_descarte')
  quantity                 NUMERIC(12,3) NOT NULL CHECK (> 0)
  unit                     TEXT NOT NULL     -- unidade do item no momento (canônica)
  is_countable             BOOLEAN NOT NULL  -- contabilizável para a necessidade (regras 6.2)
  delivered_on             DATE NOT NULL     -- data efetiva da destinação (não futura)
  people_served            INTEGER           CHECK (>= 0) -- agregado declarado; NULL = não informado
  notes                    TEXT              -- observações operacionais não sensíveis (limite de tamanho)
  proof_file_id            INTEGER           -- comprovante opcional
  surplus_reason           TEXT              -- preenchido só quando excede a necessidade (6.3)
  reverses_destination_id  BIGINT            -> stock_destinations(id) ON DELETE RESTRICT
  reversal_kind            TEXT              CHECK IN ('correcao_registro','devolucao_fisica','estorno_documental')
  reason                   TEXT              -- obrigatório em reversal
  created_by_user_id       INTEGER NOT NULL  -> users(id)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Integridade que o banco garante (não só o TypeScript):**

- FK composta `(stock_transaction_id, organization_id)` → `stock_transactions(id, organization_id)` (o UNIQUE já existe, criado para o ledger): um movimento de outra organização é rejeitado.
- FK composta `(need_id, organization_id)` → `needs(id, organization_id)` (UNIQUE já existe): necessidade de outra organização é rejeitada.
- FK composta `(proof_file_id, organization_id)` → `files(id, organization_id)`: exige adicionar `UNIQUE (id, organization_id)` em `files`, trivialmente verdadeiro por ser `id` a chave primária (migration própria, classificação "satisfeita por construção").
- CHECKs por espécie: `original` ⇒ `stock_transaction_id NOT NULL`, `reverses_destination_id IS NULL`, `reversal_kind IS NULL`, `reason IS NULL`; `reversal` ⇒ `reverses_destination_id NOT NULL`, `reversal_kind NOT NULL`, `reason NOT NULL`; `reversal_kind = 'estorno_documental'` ⇔ `stock_transaction_id IS NULL`.
- CHECK de finalidade: `destination_type IN ('doacao_terceiros','perda_descarte')` ⇒ `need_id IS NULL` e `is_countable = false`.
- `UNIQUE (stock_transaction_id) WHERE stock_transaction_id IS NOT NULL`: cada movimento físico pertence a no máximo uma linha de destinação.
- Gatilho de validação (padrão de `need_fulfillments_validate_entry`): para `original`, a movimentação é `saida`, do mesmo item e organização, com `quantity = -delta` e `unit = inventory_items.unit`; para reversão, a original existe, é da mesma organização, `Σ reversões ≤ quantidade da original` (travando a linha da original), e o movimento compensatório tem o tipo coerente com `reversal_kind` (seção 7); `is_countable` e `need_id` da reversão herdam os da original.
- No máximo **uma destinação original não totalmente revertida por movimento** (gatilho que trava a linha de `stock_transactions`): uma saída não recebe duas destinações normais; só depois de um estorno documental total o mesmo movimento pode ser re-destinado (seção 7.3).
- Gatilhos `BEFORE UPDATE`/`BEFORE DELETE` reutilizando a função de bloqueio já usada em `stock_transactions` e `need_fulfillments` (`audit_log_block_mutation`): imutável.
- Regra anterior do projeto: **nenhuma FK nova usa `ON DELETE CASCADE/SET NULL` contra tabelas imutáveis** (todas `RESTRICT`).

### 5.2 Alternativas comparadas

| Modelo | Descrição | Prós | Contras | Veredicto |
|---|---|---|---|---|
| **M1** | Tabela de eventos `stock_destinations` (acima) | Separa suprimento e atendimento; não toca ledger nem estoque; reversões como eventos; constraints fortes | Tabela nova; relatórios novos | **Recomendado** |
| M2 | Colunas extras em `stock_transactions` (`destination_type`, `need_id`...) | Menos tabelas | Tabela imutável e central misturaria conceitos; reversão exigiria outra estrutura de qualquer forma; colunas anuláveis para entrada/ajuste | Rejeitado |
| M3 | Estender `need_fulfillments` com origem genérica (`allocation_id` NULL + `destination_id`, `CHECK num_nonnulls(allocation_id, destination_id) = 1`) | Um só ledger | Mistura suprimento e atendimento no mesmo total (reintroduz o P4); exige relaxar um NOT NULL que protege o ledger; mexe em fórmula consumida por matching e relatório | Só se o produto exigir ledger único (ver abaixo) |
| M4 | Guardar a finalidade em JSON/metadata de auditoria | Zero schema | Não consultável, sem integridade, sem constraints | Rejeitado |

**Origem do atendimento (pergunta de E3):** com estoque fungível, a origem do atendimento é a **destinação** (uma fonte). "Atribuição da rede" e "doação local" são origens do **suprimento** (entradas), não do atendimento. Se mais adiante o produto quiser atribuir cada destinação a uma entrada específica, as opções são (a) leitura derivada FIFO (relatório, sem gravar), ou (b) lotes explícitos de estoque ([D-1]); nenhuma é necessária para provar o atendimento e **nenhuma** deve ser adotada silenciosamente.

**Se o dono preferir ledger único (M3):** exige `allocation_id` anulável **com** `destination_id` e `CHECK (num_nonnulls(allocation_id, destination_id) = 1)`, FK composta para a organização em ambos, `entry_type` do ledger ganhando semântica de espécie de linha, e a fórmula de saldo passando a separar por origem; o matching continuaria precisando só das linhas de suprimento. É mais invasivo e fica fora da recomendação.

### 5.3 Relações de leitura (sem colunas redundantes)

- **Atendido(need)** = Σ `quantity` de `original` com `is_countable` − Σ `quantity` de `reversal` com a original contabilizável (todas as espécies de reversão reduzem).
- **Recebido(need)** = fórmula do ledger atual (`getNeedFulfillmentBalance`), sem alteração.
- **Saídas sem destinação estruturada** = `stock_transactions.type = 'saida'` sem linha em `stock_destinations`, subclassificadas: *baixa automática histórica* (`need_resolutions.stock_transaction_id` aponta para ela) e *saída manual anterior* (as demais).
- Nenhum saldo é persistido; tudo é calculado no SQL sobre o conjunto completo (o limite de exibição vale só para listas), como em `impactReport.tsx`.

---

## 6. Regras de negócio completas

### 6.1 Registrar destinação (fluxo normal)
Em **uma transação**, na ordem de travas da seção 15.3:
1. autoriza (`inventario.lance` **e** `destinacoes.registre`, isolamento por organização);
2. trava o item (`FOR UPDATE`), confere saldo (nunca negativo, como hoje);
3. se há `need_id`: trava a necessidade (`FOR NO KEY UPDATE`), confere que é da organização e que `status ≠ cancelada`; se a necessidade tem `item_id`, o item da saída **deve ser o mesmo** (409 caso contrário); decide `is_countable` (6.2);
4. se contabilizável: confere o excesso (6.3);
5. insere a saída (`stock_transactions`, `reason` gerado a partir da finalidade e da necessidade — o texto deixa de ser a fonte da verdade) e a linha de destinação ligada a ela;
6. se o líquido alcançou a quantidade, aplica a transição automática (6.4);
7. audita (`destinacao.registrada`) por último; qualquer falha reverte tudo.
Idempotência: a unicidade do movimento impede a segunda destinação; reenviar a mesma requisição depois de sucesso devolve 409 (não duplica saída).

### 6.2 Contabilizável
`is_countable = true` somente se **todas**: finalidade ∈ {`atendimento_coletivo`, `distribuicao_familias`, `instituicao_parceira`}; `need_id` informado; `normalize(item.unit) === normalize(need.unit)`. Caso contrário a destinação existe como fato físico, `is_countable = false`, e a interface avisa **antes** de confirmar ("esta destinação não contará para o atendimento da necessidade: unidades diferentes").

### 6.3 Excedente
Se `atendido + quantidade > quantity_needed`, a destinação contabilizável é recusada (409) a menos que **proprietário ou administrador** informe um motivo (`surplus_reason`); a linha guarda o motivo e a auditoria registra `destinacao.excedente_autorizado`. Sem motivo não há atendimento acima do solicitado. O relatório já distingue `surplus` no ledger; aqui passa a distinguir também o excedente de atendimento.

### 6.4 Estado da necessidade (consistente)
- `atendida` passa a ser **estado do sistema**: aplicado, na mesma transação, quando o líquido contabilizável alcança `quantity_needed` (auditoria `necessidade.atendida_automaticamente`).
- Se uma reversão derruba o líquido abaixo da quantidade e a necessidade está `atendida` **e não tem linha em `need_resolutions`** (ou seja, foi atendida pelo novo modelo), o sistema volta a `aberta` (auditoria `necessidade.reaberta_automaticamente`). Necessidades `atendida` por resolução antiga **nunca** são reabertas pelo sistema (preserva o histórico). A regra P-L8 de `docs/LEDGER_CORRECOES_ESPECIFICACAO.md` continua valendo para as **correções do ledger de recebimentos**: elas não alteram `needs.status`; a reabertura automática descrita aqui vale só para a queda do **atendido por destinação**.
- `needs-status_POST` com `atendida` manual: **recusado** (409, explicando que o atendimento vem das destinações). `cancelada` com atendimento parcial exige motivo e fica visível como "cancelada com atendimento parcial de X".
- `aberta` (reabertura manual) segue permitida como hoje.

### 6.5 Quem pode o quê
Seção 11.

### 6.6 Datas
`delivered_on` não pode ser futura. Retroagir é permitido; destinações com data anterior a 30 dias do registro ficam marcadas na auditoria (limite sujeito a [D-4]).

### 6.7 O que continua intocado
Recebimento da rede (inclusive ledger, correções e estorno físico), matching, atribuições (Fases 95 a 98), idempotência do recebimento local (Fase 96), exclusão por recusa (Fase 97), dupla aprovação de ajustes negativos.

---

## 7. Fluxos de reversão e correção (E6)

Princípio: nunca editar nem apagar; nunca criar saldo físico fictício; **a movimentação compensatória existe só quando o fato físico a justifica**. Reverter pode ser parcial (quantidade ≤ saldo não revertido da original).

| Cenário | O que realmente aconteceu | Movimento compensatório | Linha em `stock_destinations` | Quem | Auditoria |
|---|---|---|---|---|---|
| **7.1 Correção de registro** (`correcao_registro`) | A saída foi registrada em quantidade/dados **maiores do que ocorreu**: parte do recurso nunca saiu | `ajuste` **positivo** de igual quantidade (o recurso continua fisicamente lá), vinculado à linha de reversão | `reversal`, `stock_transaction_id` = ajuste | proprietário/administrador (`destinacoes.corrija`) | `destinacao.revertida` + motivo; ajuste positivo não passa por aprovação hoje ([D-5]) |
| **7.2 Devolução física** (`devolucao_fisica`) | O recurso foi entregue e **voltou** ao estoque | `entrada` positiva (devolução) | `reversal`, `stock_transaction_id` = entrada | proprietário/administrador | idem; a entrada exige `inventario.lance` |
| **7.3 Estorno documental** (`estorno_documental`) | A entrega ocorreu fisicamente; **o registro** (necessidade, finalidade, quantidade atribuída) estava errado | **nenhum** | `reversal`, `stock_transaction_id` NULL | proprietário/administrador | idem; libera o movimento para uma nova destinação correta, com a mesma saída |

Regras comuns:
1. Cada reversão referencia a original, informa autor, data, motivo e quantidade.
2. `Σ reversões ≤ quantidade da original` (gatilho com trava na original); a mesma quantidade não é revertida duas vezes; reversões concorrentes se serializam e a segunda lê o estado confirmado.
3. O atendimento líquido da necessidade cai pela quantidade contabilizável revertida; a original nunca é alterada.
4. O movimento compensatório e a linha de reversão nascem na **mesma transação**; falha reverte os dois.
5. Se o `ajuste` compensatório fosse **negativo** (não ocorre nos três cenários acima), valem as regras e a dupla aprovação existentes.
6. Reversão de destinação **não** desfaz recebimentos nem o ledger da rede.
7. "Corrigir quantidade" = reversão parcial/total + (se necessário) nova saída com destinação correta; não existe edição.

---

## 8. Impacto sobre estoque e ledger

| Item | Efeito |
|---|---|
| `stock_transactions` | Estrutura **inalterada**. `saida` nova só nasce junto de uma destinação. Aparecem `ajuste`/`entrada` compensatórios vinculados a reversões. |
| `need_fulfillments` | **Inalterado** (suprimento). Matching, `opportunity-allocations_POST` e correções do recebimento continuam usando-o. |
| `need_resolutions` | Sem novas linhas após a implantação (sem baixa automática nem resolução declarativa). Permanece para o histórico. |
| `needs` | Estrutura inalterada; `status` passa a ter regras de 6.4. |
| Saldos | Nenhum saldo muda por causa desta fase; só a **classificação** das saídas novas. |
| Relatório | Ganha medida "atendido (destinação)" ao lado de "recebido (suprimento)" (seção 12). |

Vocabulário obrigatório (um significado por palavra): **Recebido** = entrada da rede ou doação no estoque; **Suprimento** = recebido contabilizável de uma necessidade pelo ledger; **Em estoque** = saldo; **Saiu** = saída física; **Destinado** = saída com destinação estruturada; **Atendido** = destinado contabilizável líquido; **Atendida** = estado do sistema quando o atendido alcança o necessário (ou estado histórico).

---

## 9. Política de unidades [E4]

1. O saldo e as saídas são na **unidade canônica do item** (`inventory_items.unit`).
2. **Recebimento da rede:** se `opportunity_registry.unit` está preenchida e `normalize(unit da oferta) ≠ normalize(item.unit)`, o recebimento é **bloqueado** (409) com mensagem que orienta escolher outro item ou criar o item com a unidade correta. Se a oferta não informa unidade, o recebimento é permitido e registrado como "unidade da oferta não informada" (auditoria e relatório) — nunca se presume compatibilidade.
3. **Recebimento local:** mesma regra com `donation_opportunities.unit`.
4. Uma nota explicativa **não** converte unidades e não libera um recebimento bloqueado.
5. **Necessidade × item no suprimento (ledger):** comportamento atual preservado (`is_countable = false` + `unit_mismatch_note` quando divergem); não muda.
6. **Destinação:** conforme 6.2 — fisicamente válida, contabilizável só com unidades compatíveis, avisada antes da confirmação.
7. **Relatórios** separam "quantidade física" (todas as destinações) de "quantidade contabilizável" (só as que contam) e **nunca somam unidades diferentes**: totais são por item/unidade.
8. **Conversões futuras** exigem tabela explícita (par de unidades, fator, ator autorizado, vigência, auditoria) e decisão própria. **Não implementada.**
9. Limitação conhecida: `normalize()` é textual (caixa/acentos); "caixa" ≠ "caixas". Um vocabulário controlado de unidades é melhoria futura ([D-7]).
10. Histórico: recebimentos antigos com unidade divergente permanecem como estão.
11. **Caminho de correção (dependência real):** como não existe edição de item/necessidade/oferta ([D-6]), o caminho imediato para um bloqueio é criar/escolher um item com a unidade certa; corrigir a unidade da oferta exigiria uma operação administrativa nova (não especificada aqui). Sem esse caminho a regra de bloqueio pode travar um recebimento legítimo — por isso a subfase de unidades vem **depois** de confirmar o caminho de correção ([D-6]).

---

## 10. Privacidade e LGPD [E5]

- **Sem cadastro nominal** nesta fase. Campos de destinação: finalidade, quantidade, unidade, data, necessidade (se houver), `people_served` agregado (inteiro), observações não sensíveis, comprovante opcional, autor e data, histórico de reversão.
- `people_served` **não** é número de pessoas distintas: somas de registros podem contar a mesma pessoa mais de uma vez. Relatórios o rotulam como "soma das quantidades de pessoas declaradas nos registros".
- Não se pedem nomes, contatos, documentos nem dados sensíveis. A interface orienta a **não** colocar dados pessoais em observações e a **não** enviar comprovantes com documentos ou rostos desnecessários.
- Comprovantes: arquivos já privados (nunca URL pública), com propósito próprio `comprovante_destinacao`. **Requisito novo:** o download deve ser autorizado **pela finalidade** (leitura de destinações) e não só pela associação à organização, como hoje (P8).
- Acesso por função e organização: seção 11.
- Retenção e revisão: não há política de retenção configurável hoje; a Fase 99 **não** a cria. A decisão de prazo de retenção de destinações e comprovantes e a base legal aplicável exigem **revisão jurídica** ([D-8]); este documento não é parecer legal.
- Correção sem apagar: toda correção é um evento novo; nada é removido (a trilha é de auditoria).
- O texto de `docs/PRIVACY.md` recebe uma seção separando **diretrizes aprovadas** (planejadas) de **controles já existentes**.

---

## 11. RBAC e isolamento multi-organização

Permissões novas (catálogo em `src/helpers/permissions.tsx`, só quando um endpoint real as exigir, como a política do projeto):

| Permissão | Proprietário | Administrador | Operador | Voluntário |
|---|---|---|---|---|
| `destinacoes.leia` (ver destinações e comprovantes) | sim | sim | sim | não |
| `destinacoes.registre` (+ `inventario.lance`) | sim | sim | sim | não |
| `destinacoes.corrija` (reversões, autorizar excedente) | sim | sim | não | não |

- Isolamento: toda consulta filtra por `organization_id`; FKs compostas impedem referência cruzada; endpoints seguem o padrão `requirePermission(user.id, organizationId, …)`.
- Download de comprovante: exige `destinacoes.leia` para `purpose = comprovante_destinacao` (e mantém as regras atuais para `comprovante_entrega`).
- A leitura de destinações não é concedida a voluntário (minimização), ao contrário de `inventario.leia`.
- Dupla aprovação: inalterada; só se aplica a `ajuste` negativo de alto risco.

---

## 12. Experiência e interfaces

**Princípio de linguagem:** os nomes refletem o que os dados provam. "Destinação registrada" (declarada pela organização) — **nunca** "entregue ao beneficiário" como afirmação, e nunca "atendida" para o que é só recebido.

1. **Estoque (`inventario`)**: "Saída" vira **"Registrar destinação"** (diálogo): item, quantidade (unidade do item exibida), finalidade (lista fechada), necessidade (opcional; sugere a necessidade vinculada à doação local e filtra por item/unidade), data, pessoas atendidas (opcional), observações (com aviso de não sensível), comprovante (opcional, `FileDropzone`). Avisos antes de confirmar: unidade incompatível (não contará), excesso sobre o necessário (exige motivo, só proprietário/administrador), saldo insuficiente. Movimento "ajuste" permanece separado.
2. **Nova aba "Destinação"** (nav da organização): histórico com filtros (período, item, necessidade, finalidade, situação: ativa/revertida/corrigida), estados de carregamento, vazio, erro e sem permissão; ação "Corrigir/estornar" (proprietário/administrador) com os três cenários explicados em linguagem simples.
3. **Necessidades**: três números lado a lado — Necessário, **Recebido pela rede** (suprimento, como hoje) e **Atendido (destinado)** — com a faixa "faltam X"; o rótulo "Parcialmente atendida pela rede" deixa de existir (vira "Recebido parcialmente"); `atendida` aparece como estado do sistema; necessidades antigas `atendida` mostram "histórico, sem destinação estruturada".
4. **Prestação de contas**: bloco "Destinação" (por finalidade, por item/unidade, por necessidade), colunas Recebido × Em estoque × Destinado × Saldo, "saídas sem destinação estruturada" (com as duas subclasses descritas em 5.3), registros corrigidos/revertidos marcados, comprovantes com acesso protegido, quantidade **física** e **contabilizável** separadas. `statusWarning` passa a comparar `atendida` com o **atendido**.
5. **Administração da plataforma**: leitura agregada (sem comprovantes) para acompanhar o percurso; sem edição.
6. Responsivo em 375/390/768/1280, navegação por teclado, rótulos e `aria-live` nos avisos, sem expor IDs internos nem dados pessoais; reaproveita o design system e os componentes existentes.

---

## 13. Compatibilidade histórica

- **Sem backfill.** Nenhuma destinação é criada a partir de saída + texto livre.
- Saídas antigas permanecem, listadas como "histórico sem destinação estruturada"; as geradas pela baixa automática ficam marcadas "baixa automática histórica (resolução da necessidade)".
- `need_resolutions` existentes continuam legíveis; necessidades `atendida` antigas não são reabertas e seu atendimento (destinação) é 0 e indicado como histórico — nunca recalculado a partir da saída automática.
- Ledger e recebimentos antigos: inalterados.
- O relatório distingue "registros herdados" de "novos registros" por existência (ou não) da linha de destinação, sem reclassificar.
- Comprovantes `comprovante_entrega` seguem como estão.

---

## 14. Sequenciamento de migrations

**Estado verificado em `origin/master` (`d2c955d`):** `0001` a `0015` contíguas (`0014_allocation_response_deadline`, `0015_platform_assignment_settings` são da Fase 98). O teste `test/schemaMigrations.test.ts` exige numeração `0001..000N` sem lacunas nem duplicatas; `test/migrationCompat.test.ts` exige uma classificação em `db/migrationCompat.ts` por arquivo. Não se criam exceções.

**Trabalhos concorrentes (apenas locais, fora do histórico remoto):** `0014_agent_platform.sql` como arquivo não versionado no checkout principal (base `a628bd4`); `0015_identity_foundation` a `0019_social_reauth` nas branches locais `fase-89` a `fase-94-login-integrado-preview` (também sobre `a628bd4`, já pulando o `0014` reservado). Nada disso está na `master` nem tem PR.

**Previsão para a Fase 99 (a confirmar no momento de implementar):**
- `0016_files_id_organization_unique.sql` — `UNIQUE (id, organization_id)` em `files` (classe "restrição satisfeita por construção").
- `0017_stock_destinations.sql` — tabela nova, índices, função/gatilhos (classe "tabela nova vazia"; sem `ALTER TABLE`).
- Regra de decisão: no dia da implementação, `git fetch`, listar `db/migrations` na `master`, usar os **próximos números contíguos livres**. Se agentes/identidade tiverem entrado antes, recalcular **antes** de criar arquivos.

**Plano para as migrations concorrentes (documentado, não executado aqui):**
1. Cada trabalho entra por rebase/merge sobre a `master` vigente e é renumerado **na entrada**, na ordem em que for integrado, mantendo a ordem relativa interna (identidade `0015→…→0019` continua em bloco).
2. A renumeração atualiza, no próprio trabalho: nomes dos arquivos, chaves de `MIGRATION_COMPAT` e de `CHECKS`, `db/schema.sql`, referências em documentos (por exemplo, o documento de identidade cita `0014_agent_platform.sql`) e fixtures de teste.
3. O teste de sequência e o de classificação passam sem exceção; a cadeia completa é validada em banco descartável (instalação nova × atualização, como em `schemaMigrations`).
4. **Risco local:** `schema_migrations` registra o nome do arquivo; um banco que já aplicou o nome antigo verá o renomeado como pendente e falhará com "já existe". Esses bancos são descartáveis (desenvolvimento/teste dos worktrees) e devem ser **recriados**; nenhum banco preservado está envolvido. Qualquer banco que precise ser preservado exige plano específico e validado antes de renomear.
5. Nenhum dos trabalhos é tocado por esta especificação.

---

## 15. Estratégia de implantação, concorrência e rollback

### 15.1 Implantação
Aditiva e gradual (seção 17): as primeiras subfases não mudam nenhum contrato existente; a mudança de contrato (saída exige destinação; `atendida` deixa de baixar estoque) acontece numa subfase própria, junto com a interface correspondente. Não há consumidores externos da API v1 hoje (só a SPA, publicada junto com o servidor), mas a mudança é de contrato e deve ser registrada em `docs/VERSIONAMENTO_API.md`.

### 15.2 Rollback
- Migrations aditivas, sem backfill: reverter o schema é opcional e só é seguro **antes** de existir qualquer destinação real; depois, a correção é "para frente".
- Reverter só o código **depois** de destinações existirem é perigoso (o código antigo voltaria a baixar estoque ao marcar `atendida`): exige remover o caminho de baixa antes de qualquer retorno, ou manter o contrato novo.
- Cada subfase precisa de `git revert` do commit de merge e de um teste que prove o comportamento anterior preservado.

### 15.3 Ordem de travas (única para toda a Fase 99)
`atribuição → oportunidade → **item → necessidade** → auditoria (por último)`. Justificativa verificada: `allocations-receive_POST` trava atribuição → item; a Fase 81 já resolveu o ciclo necessidade↔item usando `FOR NO KEY UPDATE` na necessidade; `needs-status_POST` deixa de travar item (não baixa mais estoque), eliminando o ciclo; a destinação trava o item primeiro e a necessidade depois.

### 15.4 Cenários de concorrência e falha
1. Duas destinações simultâneas da mesma saída → uma vence, a outra 409 (unicidade do movimento).
2. Duas destinações simultâneas para a mesma necessidade perto do limite → serializadas pela trava da necessidade; a segunda vê o líquido atualizado e é recusada ou exige motivo de excedente.
3. Destinação × `cancelada` da necessidade → quem travar primeiro vence; a outra lê o estado confirmado.
4. Duas reversões simultâneas da mesma original → serializadas; a soma nunca passa da original.
5. Reversão × nova destinação do mesmo movimento (após estorno documental) → serializadas pela trava do movimento.
6. Falha de auditoria no meio → rollback total (saída, destinação, compensatório, transição de status).
7. Falha ao gravar o comprovante → a destinação não nasce com referência inexistente (FK composta).
8. Saída com saldo insuficiente concorrente → a segunda recebe 409 sem efeito.
9. Transição automática `atendida` × reabertura manual → serializadas pela trava da necessidade.
10. Fase 98: o scheduler e as atribuições não participam dessa cadeia; nenhuma trava nova entre elas.

---

## 16. Matriz de testes e critérios de aceite

Todos com PostgreSQL real, banco `_test`, travas seguradas e falhas injetadas no banco (padrão das Fases 95 a 98). Cada item é objetivo e verificável.

**Destinação e atomicidade**
- A-01 Uma saída de atendimento gera exatamente uma destinação válida.
- A-02 Saída e destinação são atômicas (falha em qualquer ponto não deixa uma sem a outra).
- A-03 Falha de auditoria não deixa saída sem destinação.
- A-04 A mesma saída não recebe duas destinações normais (concorrente e sequencial).
- A-05 `saida` sem destinação é recusada para novas saídas; `ajuste` e `entrada` seguem como antes.
- A-06 `doacao_terceiros` e `perda_descarte` com necessidade são rejeitadas no banco.
- A-07 Referência a necessidade, movimento ou comprovante de outra organização é rejeitada pelo banco (FK composta), além da API.

**Atendimento**
- B-01 Atendimento parcial somado corretamente; mostra atendido e o que falta.
- B-02 Mudar o status não cria saída (nenhum caminho de `needs-status_POST` insere em `stock_transactions`).
- B-03 `atendida` manual sem líquido suficiente é recusada; automática no limite, com auditoria.
- B-04 Excedente recusado sem motivo; com motivo (proprietário/administrador) é aceito e marcado.
- B-05 Unidade incompatível não aumenta o atendimento; registra `is_countable = false`.
- B-06 Necessidade com `item_id` só aceita destinação do mesmo item.
- B-07 Reversão reduz o líquido; `atendida` do novo modelo reabre; `atendida` histórica (com `need_resolutions`) não reabre.
- B-08 `cancelada` com atendimento parcial exige motivo e fica identificável.
- B-09 Matching e `opportunity-allocations_POST` continuam usando o suprimento (ledger) — destinações não alteram `requiredRemaining`.

**Reversão**
- C-01 O registro original nunca é alterado nem apagado (gatilhos).
- C-02 Soma das reversões ≤ original; reversões concorrentes serializadas.
- C-03 `correcao_registro` gera ajuste positivo; `devolucao_fisica` gera entrada; `estorno_documental` não gera movimento.
- C-04 Devolução ao estoque só existe com retorno físico correspondente (nunca saldo fictício).
- C-05 Estorno documental total libera o movimento para nova destinação; parcial não.
- C-06 Permissões: operador não corrige; voluntário não lê.

**Ledger, doação local e unidades**
- D-01 Doação local não conta duas vezes: o recebimento não cria linha em `need_fulfillments`; a destinação conta uma vez.
- D-02 `linked_need_id` só pré-seleciona; não altera atendimento.
- D-03 Recebimento (rede e local) com unidade da oferta incompatível é bloqueado; com unidade não informada, permitido e sinalizado.
- D-04 Quantidade física e contabilizável aparecem separadas; nunca se somam unidades diferentes.
- D-05 Nenhuma conversão automática existe.

**Histórico e relatórios**
- E-01 Saídas antigas continuam intactas e aparecem como "sem destinação estruturada" (com as duas subclasses).
- E-02 `need_resolutions` antigas legíveis; nenhuma necessidade antiga reaberta.
- E-03 Migração sem backfill: contagem de linhas de `stock_destinations` = 0 após aplicar.
- E-04 Reconciliação por item e período: saldo inicial + entradas + ajustes − saídas = saldo final, e saídas = com destinação + sem destinação.
- E-05 `statusWarning` compara `atendida` com o atendido.
- E-06 `people_served` rotulado como soma declarada.

**Segurança, privacidade e interface**
- F-01 Comprovante só é lido por quem tem `destinacoes.leia` da organização dona; outra organização, voluntário e anônimo recebem 403/401.
- F-02 Upload do novo propósito segue as validações atuais (tipo real, tamanho, nome seguro).
- F-03 Isolamento: nenhuma consulta de destinação vaza dados entre organizações.
- F-04 Nenhum campo pede nome, contato ou documento; limites de tamanho nas observações.
- F-05 Cadeia de auditoria íntegra (`verifyAuditLogChain`).
- F-06 Interface em 375/390/768/1280, claro e escuro, teclado e leitor de tela; estados vazio, erro, carregando, sem permissão; avisos de unidade e de excedente.
- F-07 `qa:visual` com cenários novos (diálogo, aba, estados vazio/erro); `qa:security` sem regressão.

**Regressões**
- G-01 Todas as proteções das Fases 94 a 98 continuam passando (suíte completa, `qa:security`, `qa:visual`).
- G-02 Idempotência do recebimento local (Fase 96) e exclusão por recusa (Fase 97) intactas.

---

## 17. Sequência de implementação por subfase

A ordem proposta foi ajustada pelo código real: **unidades antes**, porque impedem que novos dados incoerentes sejam gravados enquanto se constrói o resto; e **o corte de `needs-status_POST` só depois** de existir o registro de destinação.

| Subfase | Problema resolvido | Mudanças previstas | Dependências | Migrations | Riscos | Testes | Critério de aceite / evidência |
|---|---|---|---|---|---|---|---|
| **99B Unidades no recebimento** | P6 | Bloquear recebimento (rede e local) com unidade da oferta incompatível; sinalizar unidade não informada | Confirmar caminho de correção [D-6]; revisão da mensagem | — | travar recebimento legítimo sem caminho de correção | D-03, D-05 | Recebimentos incompatíveis 409; compatíveis e não informados passam; regressões |
| **99C Modelo e migrações** | base de dados | `0016` (files UNIQUE), `0017` (`stock_destinations` + gatilhos), tipos em `schema.tsx`, classificação em `migrationCompat` | número livre confirmado (seção 14) | 2 | gatilhos errados | A-06, A-07, C-01, E-03 + `schemaMigrations` | schema novo = schema atualizado; tabela vazia |
| **99D Registro atômico** | P1 | Endpoint de destinação (saída + destinação + auditoria + comprovante), permissões `destinacoes.*`, restrição de `saida` em `stock-transactions_POST` | 99C | — | quebra de contrato (seção 15.1) | A-01 a A-05, F-01 a F-04 | critérios A e F |
| **99E Significado de "atendida"** | P2, P3, P4, P7 | Cálculo do atendido; transição automática; `needs-status_POST` sem baixa e sem `atendida` manual; excedente com motivo; `cancelada` com motivo; doação local como pré-seleção (E3) | 99D | — | números do relatório mudam de rótulo | B-01 a B-09, D-01, D-02 | critérios B e D |
| **99F Reversões e correções** | E6 | Três cenários (7.1 a 7.3), gatilho de soma, ajuste/entrada compensatórios | 99D, 99E | — | concorrência | C-01 a C-06 | critérios C |
| **99G Relatórios** | P9 | Bloco Destinação; medidas recebido × atendido; saídas sem destinação; `statusWarning` novo; reconciliação | 99D a 99F | — | alterar contrato de `impact-report_GET` | E-01 a E-06 | critérios E |
| **99H Interfaces** | experiência | Diálogo, aba Destinação, necessidades, prestação de contas, administração | 99D a 99G | — | regressão visual | F-06, F-07 | QA visual e acessibilidade |
| **99I Comprovantes e privacidade** | P8 | Propósito `comprovante_destinacao`, autorização por finalidade, textos de orientação, seção ativa de `PRIVACY.md` | 99D | — | vazamento de comprovante | F-01, F-02, F-04 | critérios F |
| **99J Validação final** | integração | Ponta a ponta, concorrência, `qa:security`, CI, atualização do roadmap | todas | — | — | G-01, G-02 + todas | seção 20 |

Observação: o ledger de recebimentos **não** muda em nenhuma subfase (seção 5.2). Se o dono escolher M3, haverá uma subfase própria **depois** de 99J, com migration e testes de contabilidade novos.

---

## 18. Limitações e riscos conhecidos

- **Estoque fungível:** não se prova qual doação foi entregue; o relatório prova entradas por origem, saídas por finalidade e a reconciliação por item.
- **`people_served`** é declarado e não deduplica pessoas.
- **Rótulos de relatório e telas** mudam de significado ("atendimento" → "recebido/suprimento" para o ledger): risco de confusão na transição e testes que fixam textos.
- **Mudança de contrato** em `stock-transactions_POST` e `needs-status_POST` (sem consumidores externos conhecidos).
- **Bloqueio por unidade** pode travar um recebimento legítimo enquanto não houver edição/correção de dados ([D-6]).
- **Comprovantes** podem conter dados pessoais enviados por engano: mitigação por orientação e por acesso restrito, não por detecção.
- **Positivo sem aprovação:** o ajuste positivo da correção de registro não passa por dupla aprovação hoje ([D-5]).
- **Numeração de migrations** pode mudar antes da implementação (seção 14).
- A cobertura visual do CI continua reduzida (18 de 27 cenários, só Chrome); a Fase 99 precisa adicionar cenários próprios.

---

## 19. Decisões que continuam dependendo de evidência ou revisão

| # | Questão | Alternativas e efeitos | Recomendação |
|---|---|---|---|
| D-1 | Atribuir cada destinação a uma entrada/doação específica | (a) não atribuir (estoque fungível); (b) leitura derivada FIFO (só relatório); (c) lotes explícitos | (a) agora; (b) como análise futura; (c) só com requisito real |
| D-2 | Estado para encerrar necessidade sem entrega total | usar `cancelada` + motivo; ou novo valor de enum (`ALTER TYPE ADD VALUE` é irreversível) | `cancelada` + motivo |
| D-3 | Lista final de finalidades (ex.: consumo interno?) | manter as cinco; ou acrescentar | revisar com as organizações antes da migração |
| D-4 | Limite de retroação de `delivered_on` | 30 dias com marca; ou sem limite; ou bloqueio | marca em 30 dias |
| D-5 | Dupla aprovação para ajuste positivo de correção de registro | manter só proprietário/administrador; ou aprovar | manter, com motivo obrigatório |
| D-6 | Caminho para corrigir unidade/dados de item, necessidade e oferta | usar item novo; criar edição (decisão de produto já pendente); correção administrativa de unidade da oferta | decidir **antes** de 99B |
| D-7 | Vocabulário controlado de unidades | texto livre normalizado (hoje); ou lista | lista, em fase futura |
| D-8 | Retenção, base legal e prazos para destinações e comprovantes | exige revisão jurídica | fora desta especificação |

---

## 20. Condições objetivas para declarar a Fase 99 concluída

Só se **todas** valerem, com evidência (comandos e resultados reais, CI no commit integrado):
1. As subfases 99B a 99J integradas, cada uma com o critério da seção 17.
2. A matriz da seção 16 implementada e aprovada (nenhum item removido ou enfraquecido).
3. Nenhuma saída nova sem destinação; nenhum caminho cria saída ao mudar status.
4. Atendimento calculado só por destinações contabilizáveis líquidas; suprimento e atendimento separados nos relatórios.
5. Doação local com `linked_need_id` conta uma vez, só por destinação.
6. Nenhuma conversão automática de unidade; quantidades física e contabilizável separadas.
7. Saídas e resoluções antigas preservadas e identificadas; zero backfill.
8. Comprovantes protegidos por finalidade, sem dado pessoal exigido.
9. Cadeia de auditoria íntegra; Fases 94 a 98 sem regressão; `qa:security` e `qa:visual` (incluindo cenários novos) aprovados.
10. `docs/ROADMAP_ATUAL.md`, `docs/PRIVACY.md` e `docs/RBAC_PERMISSOES.md` refletindo exatamente o que está implementado (não o planejado).
11. O fluxo de doação não é declarado concluído de ponta a ponta antes disso.
