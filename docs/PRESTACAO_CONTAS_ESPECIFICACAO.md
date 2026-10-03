# Especificação — Prestação de Contas (Fatia 3)

Fase 84. **Especificação, não implementação.** Nenhum código, schema, migration,
endpoint, helper, tela, regra de ledger/estoque/matching/necessidade/aprovação foi
alterado. Escrita sobre o baseline `5cafeb8`; o que está descrito como "hoje" foi
lido nesse commit (o WIP da plataforma de agentes não é descrito nem tocado).

Princípio: **a Prestação de Contas consome os dados existentes** (`stock_transactions`,
`need_fulfillments`, `needs`, `audit_log`). Nada é criado no ledger, no schema ou nas
regras para facilitar a tela: nenhuma coluna redundante, nenhum saldo duplicado.

Convenção: **[P-Rn]** decisão de produto (traz opções, implicações e uma
**recomendação**, que **não** é decisão até o dono confirmar — seção 16). **[T-n]**
decisão técnica resolvível na implementação.

Documentos relacionados: `docs/LEDGER_CORRECOES_ESPECIFICACAO.md` (semântica do ledger,
seções J e V já descrevem a intenção desta fatia), `docs/RBAC_PERMISSOES.md`.

---

## 1. Estado atual (auditado)

Arquivos: `src/endpoints/impact-report_GET.ts` (+ `.schema.ts`) e a página
`src/pages/organizacoes.$organizationId.prestacao-contas.tsx` (178 linhas) com seu
`.module.css`.

### 1.1 Acesso e filtro

- **Backend:** `requirePermissionToRead(user, org, "relatorios.leia")` — leitura, não exige
  organização já aprovada. Papéis com a permissão hoje: **proprietário e administrador**.
- **Frontend:** `canView` = papel `proprietario`/`administrador` (cópia local da regra; o
  servidor é a autoridade). Quem não pode vê um aviso; a consulta nem é feita.
- **Filtro:** só **período** (`De` / `Até`, `input type=date`). Padrão: dia 1º do mês corrente
  até hoje. A página envia `startDate = <De>T00:00:00` e `endDate = <Até>T23:59:59`
  (fuso do navegador) e o servidor usa `>= start` e `<= end`.
- **Atenção (defeito latente a tratar na implementação [T-1]):** `T23:59:59` deixa
  descoberto o último segundo do dia (`23:59:59,001–23:59:59,999`); o correto é limite
  superior **exclusivo** no início do dia seguinte.

### 1.2 Mapa de números → fonte → consulta

Oito consultas sequenciais (1 organização + 7 de dados), **sem N+1 por linha**:

| # | Elemento na tela | Fonte | Regra exata hoje |
|---|---|---|---|
| Q0 | Nome da organização | `organizations` | `name` |
| Q1 | Tabela "Movimentação de estoque por item": **Entradas / Saídas / Ajustes / Saldo no período** | `stock_transactions ⨝ inventory_items` | `GROUP BY item` no período por `created_at`: `Σ delta` de `entrada`; `Σ |delta|` de `saida`; `Σ delta` de `ajuste` (com sinal); líquido = entradas − saídas + ajustes |
| Q2 | Coluna **Saldo atual** | `stock_transactions` | `Σ delta` de **todo o histórico** do item (não depende do período) |
| Q3 | Lista "Doações recebidas no período" e cartão **"Recebimentos registrados"** (= `length` da lista) | `stock_transactions ⨝ inventory_items` | **só** `type = 'entrada'` no período (inclui entradas manuais de estoque **e** recebimentos da rede Levora) |
| Q4 | Cartão "Necessidades cadastradas" | `needs` | `created_at` no período |
| Q5 | Cartão "Necessidades atendidas" | `needs` | `status = 'atendida'` **e** `updated_at` no período (aproximação: `updated_at` muda com qualquer edição) |
| Q6 | (calculada, **não exibida**) necessidades canceladas | `needs` | `status = 'cancelada'` e `updated_at` no período |
| Q7 | Cartão "Eventos na trilha de auditoria" | `audit_log` | contagem de eventos da organização no período |

Também: botão **Imprimir / salvar PDF** (`window.print()`), `@media print` esconde
navegação, filtros e botão; **não há** media query responsiva além da de impressão.
A tabela física já está num contêiner com rolagem horizontal (`.tableScroll`).

### 1.3 Lacunas objetivas (o que a Fatia 3 resolve)

1. **O ledger contábil (`need_fulfillments`) não é lido.** Não há atendido/faltante/
   excedente por necessidade, nem original × correção × estorno.
2. **Os `ajuste` das Fatias 1/2 só aparecem na coluna "Ajustes"** (e no líquido). Uma
   correção positiva (`ajuste +`) ou uma retirada física (`ajuste −`) **não** aparece como
   linha e **não** entra em "Recebimentos registrados" (filtro `entrada`).
3. **Correções e estornos só contábeis são invisíveis** (não têm `stock_transactions`).
4. "Doações recebidas" mistura entradas manuais de estoque com recebimentos da rede, sem
   distinguir.
5. Não há ligação entre um recebimento e a necessidade/atribuição que ele atendeu.
6. Os números do cabeçalho misturam semânticas de data (criada × atualizada × evento).

---

## 2. Fontes de verdade (e o que cada uma NÃO diz)

| Domínio | Fonte única | Representa | **Não** representa |
|---|---|---|---|
| **Movimentação física** | `stock_transactions` | `entrada`, `saida`, `ajuste`; saldo físico do item = `Σ delta` | quanto a necessidade foi atendida |
| **Atendimento da necessidade** | `need_fulfillments` | `original`, `correction`, `reversal`; líquido contável; `fulfilled`/`requiredRemaining`/`surplus` (fórmula única em `needFulfillment.tsx`) | o que existe fisicamente no estoque |
| **Estado administrativo** | `needs.status` | decisão humana (`aberta`, `atendida`, `cancelada`…) | **nunca** é inferido do ledger |
| **Auditoria** | `audit_log` | quem, quando, motivo, aprovação (um evento por fato) | números contábeis (usado só para o **motivo** e a decisão) |

Regras de ouro:

- **O ledger e o estoque não são somados nem conciliados à força.** Um estorno contábil muda o
  ledger e não muda o estoque **de propósito** (P-L4); o relatório mostra os dois lados, lado a
  lado, e **nunca** um número único que os mistura.
- **A fórmula do líquido continua exclusivamente em `needFulfillment.tsx`.** O relatório não
  reimplementa `±quantity`/`is_countable`; reutiliza `getNeedFulfillmentBalanceBatch`
  (estendido, ver seção 9) e `computeNeedProgress`.
- **`needs.status` aparece à parte** (seção 8) e nunca é derivado de `fulfilled ≥ needed`.

---

## 3. Um fato, uma contagem (sem duplicação)

Classificação dos acontecimentos (cada um tem **uma** fonte primária; a outra fonte é só
anotação do mesmo fato):

| Natureza | Eventos | Fonte primária | Anotação na outra fonte |
|---|---|---|---|
| **Contábil** | `original`, `correction`, `reversal` | `need_fulfillments` | movimento físico ligado (`stock_transaction_id`) |
| **Físico** | `entrada`, `saida`, `ajuste` | `stock_transactions` | linha do ledger que o carrega (se houver) |
| **Administrativo** | pedido, aprovação, rejeição, expiração | `audit_log` / `approval_requests` | — |

Reconciliação (sem contar duas vezes):

- Um recebimento da rede é **um** fato com dois lados: a `entrada` física (`stock_transactions`)
  e o `original` contábil (`need_fulfillments.stock_transaction_id` aponta para ela). **Conta
  uma doação**; o ledger é só a anotação "via rede Levora, atribuição #N, necessidade X".
- Um **par de correção** (`reversal` do alvo + `correction` com o valor novo) é **um evento
  lógico** ("Correção de 100 para 80"). O ajuste físico, se houve, está na `correction`; a
  `reversal` do par não tem movimento. Exibir como **uma** linha, com o par disponível em
  detalhe (seção 7).
- Um **estorno** é um evento contábil; a **retirada física**, quando existe, é outro evento (físico)
  **ligado** ao primeiro. Dois fatos, duas linhas ligadas — nunca uma linha ambígua (P-R4).
- Contagens do cabeçalho contam **fatos de uma natureza** (doações, correções, estornos,
  pedidos), não linhas do ledger.

---

## 4. Contrato de cada número (proposta; depende das decisões da seção 14)

Todos os intervalos usam **início inclusivo e fim exclusivo** (`[start, endExclusivo)`),
sobre `created_at` do próprio evento — **uma regra de data por seção, declarada na tela**.
Nenhum número soma unidades diferentes: totais de quantidade são **por item/unidade**; os
cartões globais são **contagens**.

### 4.1 Cartões (resumo)

| Cartão | Definição | Fonte | Observação |
|---|---|---|---|
| Necessidades cadastradas | `needs` com `created_at` no período | `needs` | existente |
| Marcadas como atendidas no período | `status='atendida'` e `updated_at` no período | `needs` | existente; rótulo passa a dizer "marcadas" (decisão administrativa, não cálculo) e carrega a nota de aproximação |
| Doações recebidas | contagem de `entrada` no período | `stock_transactions` | substitui "Recebimentos registrados"; subtítulo "N via rede Levora" (as que têm `original` ligado) |
| Correções | eventos lógicos de correção no período | `need_fulfillments` | pares contam 1; correção sem `reversal` (só reclassificação) conta 1 |
| Estornos | `reversal` **não pareada** com correção no período | `need_fulfillments` | separa "só contábeis" de "com retirada física" |
| Pedidos pendentes | pedidos de ledger `pendente` hoje | `approval_requests` | informativo; sem filtro de período |
| Eventos na trilha de auditoria | contagem em `audit_log` no período | `audit_log` | existente |

### 4.2 Movimentação física por item (tabela existente, **mantida**)

Origem de **cada** coluna (todas de `stock_transactions`, sem duplicar o ledger):

| Coluna | Cálculo |
|---|---|
| Item / unidade | `inventory_items.name` / `unit` |
| Entradas | `Σ delta` de `entrada` no período |
| Saídas | `Σ |delta|` de `saida` no período |
| Ajustes | `Σ delta` de `ajuste` no período (**inclui** ajustes de correção e de retirada física; o detalhe está na seção 6) |
| Saldo no período | entradas − saídas + ajustes |
| Saldo | ver P-R5 (no fim do período e, se diferente, o atual) |

Acréscimo **opcional** (sem nova coluna de domínio): detalhar "Ajustes" em **ajustes de
correção/estorno da rede** × **outros ajustes**, distinguindo-os pelo vínculo
`need_fulfillments.stock_transaction_id` (um `ajuste` ligado ao ledger é "da rede").

### 4.3 Atendimento das necessidades (**seção nova**)

Por necessidade relevante (critério em P-R6): `necessidade` (título), `item/unidade`,
**necessário**, **recebido original**, **correções** (com sinal), **estornos**,
**líquido** (`fulfilled`), **faltante** (`requiredRemaining`), **excedente** (`surplus`),
`needs.status`, última alteração. Fórmulas: **só** as de `needFulfillment.tsx`
(`computeNeedProgress`). Detalhe na seção 8.

### 4.4 Eventos contábeis (**seção nova**: "Recebimentos, correções e estornos")

Lista cronológica **agrupada por atribuição (recebimento)**: o `original` sempre primeiro e
visível; depois as correções/estornos daquela atribuição, cada um com autor, data, motivo,
efeito contado e **efeito físico ligado**. O "líquido" aparece **ao lado**, nunca no lugar.
Detalhe nas seções 6, 7 e 12.

---

## 5. Decisão P-R1 — o que é o "líquido" do relatório

O líquido contábil de uma necessidade = `fulfilled` (soma dos efeitos contáveis do ledger).

| Opção | O que mostra | Prós | Contras / implicações |
|---|---|---|---|
| **A — acumulado histórico até a data final** | `fulfilled` com eventos `created_at < endExclusivo` | é o único valor em que `faltante`/`excedente` fazem sentido (compara com o necessário); estável | atividade do período fica escondida (uma correção de hoje sobre um recebimento de março some do "movimento"); exige variante "as of" do helper |
| **B — só os eventos do período** | Σ efeitos com `created_at ∈ [start, end)` | mostra o que mudou no período | **pode ser negativo** (estorno no período de algo recebido antes) e **não** compara com o necessário — confunde |
| **C — ambos** | "Acumulado até DD/MM" **e** "Líquido no período" | cada número tem sua pergunta; reconcilia: acumulado final = acumulado inicial + líquido do período | mais colunas (mobile vira cartões); precisa de rótulos claros |

**Recomendação (não é decisão): C**, com o **acumulado** como número principal da necessidade
(faltante/excedente) e o **líquido do período** como número de reconciliação.
Identidade verificável por teste: `acumulado(fim) = acumulado(início) + líquido(período)`.

---

## 6. Decisões P-R2 e P-R3 — correções no relatório

Exemplo: `original 100`, `correction +20` (estoque +20).

### P-R2 — correção **positiva** entra em "Doações recebidas"?

| Opção | Resultado | Implicações |
|---|---|---|
| **A** | "100 recebidos"; +20 só como "ajuste" | simples; mas a correção **fica sem linha própria** — o leitor não vê por que o estoque subiu 120 |
| **B** | "120 recebidos" | **substitui o histórico original** por um número novo e infla a contagem de doações — viola "nunca esconder o original" |
| **C** | "100 recebidos" + linha separada "Correção +20 (a mesma doação)" | 1 doação, 2 linhas relacionadas; líquido 120 ao lado; não infla a contagem |

**Recomendação (não é decisão): C.** A contagem de doações continua 1; a quantidade líquida
recebida (por item/unidade) é 120; a linha de correção é claramente marcada como **não sendo
uma nova doação**.

### P-R3 — correção **negativa** (original 100 → 80)

Mostrar **sempre** os três números; **nunca** apenas "80":

`Recebimento original: 100` · `Correção: −20 (de 100 para 80)` · `Líquido: 80`

| Opção | Apresentação |
|---|---|
| **A** | uma linha por correção (par colapsado): "Correção −20 (100 → 80)" |
| **B** | as duas linhas cruas do par (`reversal −100` + `correction +80`) | confuso para quem lê (−100/+80) |
| **C** | A por padrão, com "ver linhas do ledger" expansível (mostra o par cru) |

**Recomendação (não é decisão): C.** O delta mostrado é `novo − anterior` (derivado do par,
nunca gravado). O efeito físico aparece **ligado**: "Estoque: −20 kg".

Em ambos: a unidade do item governa; correção de **unidade** (reclassificação) aparece como
"Unidade corrigida de X para Y (sem conversão)" e **sem** efeito físico.

---

## 7. Decisão P-R4 — estorno (contábil × físico)

| Caso | Ledger | Estoque | Como aparece |
|---|---|---|---|
| **Estorno contábil** | `original` permanece; `reversal` aparece; líquido cai | **não muda** | uma linha "Estorno (só contábil)"; selo "estoque físico não alterado" |
| **Estorno físico** | `original` permanece; `reversal` aparece; líquido cai | `ajuste` negativo = saldo físico real da allocation | linha "Estorno" **mais** uma linha **ligada** "Retirada física −N" (natureza física) |

| Opção | Apresentação |
|---|---|
| **A** | duas linhas **ligadas** (contábil e físico), cada uma com sua natureza e seu valor |
| **B** | uma linha única "Estorno com retirada" | mistura dois fatos e dois números |
| **C** | A + selo de reconciliação "contábil −100 / físico −100" no cabeçalho do grupo |

**Recomendação (não é decisão): A** (com o selo do C só quando os dois lados existem).
Regras: nunca somar o efeito contábil e o físico; o cartão "Estornos" separa "só contábeis"
de "com retirada física"; a retirada física **não** é contada como uma segunda "doação" nem
como um segundo estorno — é o lado físico do mesmo estorno.

Transparência fim a fim (o usuário lê uma frase, sem logs): "**100 recebido → corrigido para
80 (−20; estoque −20) → estorno (−80 no atendimento) → retirada física (−80 no estoque)**".

---

## 8. Necessidades: atendimento e status

### 8.1 Seção "Atendimento das necessidades"

Escopo (P-R6): necessidades **criadas no período OU com evento de ledger no período OU
`aberta` com `fulfilled > 0`** (as que o dono precisa prestar contas), da organização.
Para cada uma: necessário, recebido (original), correções, estornos, **líquido**,
**faltante**, **excedente**, `needs.status`, última alteração (`needs.updated_at`).

`fulfilled`/`requiredRemaining`/`surplus` vêm de `getNeedFulfillmentBalanceBatch` +
`computeNeedProgress`, **em lote** (uma agregação para todas as necessidades da lista).
Recebido/correções/estornos vêm de **uma** agregação adicional por `need_id` e `entry_type`
(mesma consulta do lote, sem laço).

### 8.2 `needs.status` é exibido à parte

- Mostrado como está (`aberta`/`atendida`/…); **nunca** inferido de `fulfilled ≥ needed`.
- Pode existir `status = atendida` com `requiredRemaining > 0` (após estorno/correção):
  mostrar o aviso **factual**, sem reabrir:
  > "Necessidade marcada como atendida, mas há saldo faltante após ajustes."
- Pode existir `status = aberta` com `requiredRemaining = 0` (atendida de fato, ainda não
  marcada): mostrar sem alarme ("sem saldo faltante").
- Excedente: "Excedente: N" (o recebido acima do necessário **continua contado**, P-L1);
  pertence à organização, não é transferido pelo ledger.

---

## 9. Período e filtros

### 9.1 P-R5 — o que o filtro de período afeta

| Opção | Efeito |
|---|---|
| **A** | o período filtra **eventos** (cada seção pela `created_at` do seu evento); todos os **saldos** são "de hoje" |
| **B** | tudo é "as of" o fim do período (saldos físicos e contábeis recalculados até a data final); eventos pelo período |
| **C** | eventos pelo período; saldos "as of fim do período" **e**, se o fim ≠ hoje, mostra também "hoje" ao lado |

**Recomendação (não é decisão): C.** Regras declaradas na tela, uma linha por seção:

| Seção | Regra de data |
|---|---|
| Cartões de contagem | evento criado no período (ou a data de status, para "marcadas como atendidas") |
| Movimentação física | `stock_transactions.created_at ∈ [start, end)`; saldo **no fim do período** (`Σ delta` com `created_at < end`) + "hoje" quando diferente |
| Eventos contábeis | `need_fulfillments.created_at ∈ [start, end)` |
| Atendimento das necessidades | acumulado `created_at < end` (+ líquido do período, P-R1=C) |
| Auditoria | `audit_log.created_at ∈ [start, end)` |

### 9.2 Helper necessário (sem tocar no ledger) [T-2]

`getNeedFulfillmentBalanceBatch` hoje soma **todo** o histórico (sem data). Para o
acumulado "as of" e o líquido do período, a fórmula única ganha **limites de data
opcionais** (`before`, `from`/`to`) — parâmetro retrocompatível; `needs_GET` continua
chamando sem limite. A **mesma** expressão SQL (`case when entry_type='reversal' then
-quantity else quantity end`, `is_countable = true`) continua em **um** lugar.

### 9.3 Filtros adicionais (foco operacional; nenhum "só porque é fácil")

| Filtro | Decisão |
|---|---|
| Período | **mantido** (obrigatório) |
| **Item** | **incluir**: a tabela física e as doações são naturalmente por item |
| **Necessidade** | **incluir**: leva do atendimento aos eventos contábeis dela |
| **Tipo de evento** (original/correção/estorno/físico) | **incluir só na lista de eventos**, como alternador simples |
| Organização | **não** (o relatório é de **uma** organização; multi-organização é de plataforma, fora de escopo) |
| Status da necessidade | **adiar** (a seção de atendimento já mostra o status; reavaliar com uso) |

---

## 10. Quatro seções e a lista "Doações recebidas" (decisão de conteúdo)

### 10.1 "Recebido" — o que conta

- **Cartão "Doações recebidas"** = **`entrada` física** no período, com subcontagem "via rede
  Levora" (ligadas a um `original`). **Não** soma correção + original como duas doações.
- A **quantidade recebida** (por item/unidade) = entradas **mais** o efeito físico líquido das
  correções/estornos ligados, mostrada **separada**: "Recebido (entradas): 100 · Ajustes da rede:
  +20 · Líquido: 120" — cada parcela com sua origem (P-R2=C).

### 10.2 Lista "Doações recebidas" — o que pode aparecer

| Evento | Aparece como | Conta como doação? |
|---|---|---|
| `entrada` (rede ou manual) | linha de doação (selo "rede Levora"/"manual") | **sim** |
| `original` (ledger) | anotação da mesma doação (atribuição #N, necessidade X) | **não** (é a mesma) |
| correção positiva/negativa | sub-linha "Correção ±N" da doação, marcada "não é nova doação" | **não** |
| estorno contábil | sub-linha "Estorno (só contábil)" | **não** |
| retirada física | sub-linha ligada "Retirada física −N" | **não** |
| outros `ajuste` (sem ligação ao ledger) | **fora** da lista (ficam só em "Ajustes" da tabela física) | **não** |
| `saida` | **fora** da lista | **não** |

### 10.3 Seção "Histórico dos recebimentos" (eventos contábeis)

Por atribuição: `original` (visível sempre) → correções/estornos em ordem, cada um com **autor,
data, motivo** (do `audit_log`, mesma lógica do endpoint de histórico), **efeito no saldo**
e **efeito físico** ligado. Pedidos de aprovação aparecem como **evento administrativo**
("Solicitado por X; decidido por Y"; "Rejeitado"; "Expirado") — separados das linhas
contábeis. O "líquido" aparece ao lado.

---

## 11. Permissões e visibilidade

Regra: **preservar a separação** — `relatorios.leia` (proprietário/administrador) é mais
restrito que `logistica.leia` (todos os papéis). **Nenhuma permissão nova; nenhum acesso
ampliado** porque o relatório passa a ler o ledger.

| Conteúdo | Quem vê no relatório | Permissão | Observação |
|---|---|---|---|
| Movimentação/saldo de estoque | proprietário, administrador | `relatorios.leia` | como hoje |
| Atendimento das necessidades (agregado) | proprietário, administrador | `relatorios.leia` | agregado de organização |
| Histórico contábil (correções/estornos, motivo, autor) | proprietário, administrador | `relatorios.leia` | o **histórico por atribuição** já é visível a todo membro via `allocations-receipt-history` (`logistica.leia`); o relatório **consolida**, não é a única porta |
| Auditoria | **só contagem e o motivo** das operações do ledger; **nunca** os eventos crus | `relatorios.leia` | eventos crus continuam em tela própria com `auditoria.leia` |
| Autor das linhas | `users.display_name` apenas | — | **sem e-mail** nem dado pessoal além do nome já exibido no histórico |

O servidor (`requirePermissionToRead`) é a autoridade; a regra de `canView` do frontend
continua só como conveniência.

---

## 12. Multi-tenancy (prova conceitual — não depende do frontend)

1. **Toda** consulta filtra `organization_id = $org` **no SQL**: `stock_transactions`,
   `need_fulfillments` (coluna `organization_id NOT NULL`), `needs`, `inventory_items`,
   `audit_log` (eventos com `organization_id IS NULL`, de plataforma, ficam **fora**).
2. Integridade estrutural já existente: FK composta
   `(stock_transaction_id, organization_id) → stock_transactions(id, organization_id)` torna
   **impossível** um ledger de uma organização apontar para estoque de outra; o trigger do
   ledger exige `organization_id` igual ao do alvo; a `need` é herdada do alvo.
3. Junções auxiliares **também** restringem a organização (`needs.organization_id`,
   `inventory_items.organization_id`); `users` só entra para `display_name` do autor, nunca
   filtrando por usuário vindo do cliente.
4. O `organizationId` vem do **parâmetro validado + membership** (`requirePermissionToRead`),
   nunca de um id interno (`allocationId`, `fulfillmentId`) fornecido pelo cliente.
5. Teste futuro (seção 17): duas organizações com dados sobrepostos; o relatório de A nunca
   contém nenhuma linha, necessidade, item, motivo ou contagem de B; allocation/need de B
   passados por parâmetro de filtro devolvem vazio/404.

---

## 13. Desempenho

Hoje: 8 consultas sequenciais, sem N+1. Alvo: **no máximo ~12 consultas, todas em lote**, as
independentes em `Promise.all` (somente leitura), num único `REPEATABLE READ` se for preciso
coerência entre seções (como `allocations-receipt-history`).

| Consulta nova | Desenho | Índice existente |
|---|---|---|
| Eventos do ledger no período | `need_fulfillments` por `organization_id` + `created_at` (+ `ORDER BY created_at, id`), `LEFT JOIN stock_transactions` (movimento ligado, por PK), `LEFT JOIN needs`/`users` (por PK) | `idx_need_fulfillments_org (organization_id, created_at DESC)` |
| Motivo/aprovação | **uma** consulta em `audit_log` das 3 ações do ledger no período, mapeada por `metadata.fulfillmentIds` em memória (como o endpoint de histórico) | `idx_audit_log_org (organization_id, created_at DESC)` |
| Líquido por necessidade | `getNeedFulfillmentBalanceBatch` com limites opcionais (lote, `GROUP BY need_id`) | `idx_need_fulfillments_need` |
| Recebido/correções/estornos por necessidade | **uma** agregação `GROUP BY need_id, entry_type` | idem |
| Saldo físico no fim do período | `Σ delta` com `created_at < end` por item (lote) | `idx_stock_transactions_org (organization_id, created_at DESC)` |

- **Nunca** uma consulta por necessidade, por atribuição ou por linha.
- **Limite e truncamento (lista de eventos):** teto de **1.000 eventos** por resposta
  (`truncated: true` + total), cursor por `(created_at, id)` se a tela paginar; a
  **impressão** pede o teto completo e, se truncar, **avisa** (nunca imprime em silêncio um
  relatório incompleto).
- Contagens e somas por agregação SQL, não por carga de linhas.
- Performance medida por **contagem de consultas** em teste (não por tempo), para não
  virar benchmark.

---

## 14. Impressão

Mesma estrutura da tela, **expandida**:

1. Cabeçalho: organização, **período** e **a regra de data de cada seção** (uma linha cada);
2. Cartões de resumo;
3. Movimentação física por item;
4. Atendimento das necessidades (necessário, recebido, correções, estornos, líquido,
   faltante, excedente, status e o aviso factual quando aplicável);
5. Histórico dos recebimentos (original visível; correções e estornos com motivo, autor,
   data; físico ligado), **detalhes expandidos**;
6. Disclaimer (quantidades e unidades, sem valores monetários).

Regras: **sem** controles/filtros/botões; seções recolhíveis **abertas**; tabelas quebram
por linha, não cortam; **sem** segunda versão funcional — é a mesma árvore com CSS de
impressão (`@media print`). Aviso se a lista foi truncada pelo teto.

---

## 15. Mobile (375 / 390 / 768)

Estado hoje: sem media query responsiva além da de impressão; a tabela física tem rolagem
horizontal; **não foi verificada** em 375/390/768 nesta fase.

| Elemento | 375/390 | 768+ |
|---|---|---|
| Cartões de resumo | grade 2×N (já `auto-fit minmax(9rem,1fr)`) | 4 por linha |
| Movimentação física | **tabela mantida**, rolagem interna; colunas prioritárias fixas: **Item**, **Líquido**, **Saldo** (as demais rolam) | tabela completa |
| Atendimento das necessidades | **cartões** por necessidade (necessário/recebido/faltante/excedente em 2×2; status e aviso abaixo) | tabela |
| Histórico dos recebimentos | **linha do tempo vertical** por atribuição (cada evento um cartão) | linha do tempo/tabela |
| Filtros | empilhados, largura total; alvos de toque ≥ 44 px | em linha |

Prioridade de números no mobile: **faltante/excedente > líquido > recebido > necessário**.
Sem rolagem horizontal da **página**; rolagem só **interna** de tabelas. Nenhum conteúdo
funcional é sacrificado (o que não cabe vira cartão, não some). Validar no **Central
Visual** em 375, 390, 768 e desktop ≥ 1280 na implementação.

---

## 16. Tabela de decisões de produto

Todas **PENDENTES**; as recomendações **não** são decisões.

| ID | Decisão | Estado | Opções | Recomendação |
|---|---|---|---|---|
| **P-R1** | semântica do "líquido" | **PENDENTE** | A acumulado até a data final · B só o período · C ambos | **C** (acumulado principal + líquido do período; identidade `acum(fim)=acum(início)+período`) |
| **P-R2** | correção **positiva** em "Doações recebidas" | **PENDENTE** | A só como ajuste · B conta como recebido · C linha separada da mesma doação | **C** (1 doação; correção como sub-linha "não é nova doação") |
| **P-R3** | correção **negativa** | **PENDENTE** | A uma linha por correção · B par cru (−100/+80) · C A + par em detalhe | **C** (original 100 · correção −20 · líquido 80) |
| **P-R4** | estorno contábil × físico | **PENDENTE** | A duas linhas ligadas · B linha única · C A + selo de reconciliação | **A** (+ selo quando existem os dois lados) |
| **P-R5** | escopo do filtro de período | **PENDENTE** | A só eventos, saldos de hoje · B tudo "as of" · C eventos + "as of" + hoje | **C** |
| **P-R6** | quais necessidades entram na seção de atendimento | **PENDENTE** | A só criadas no período · B criadas ∪ com evento no período · C B + abertas com saldo atendido > 0 | **C** |
| **P-R7** | "Doações recebidas": incluir entradas manuais de estoque | **PENDENTE** | A só rede Levora · B todas as `entrada`, com selo de origem | **B** (como hoje, agora com selo) |
| **P-R8** | filtros adicionais | **PENDENTE** | só período · + item/necessidade/tipo de evento | **+ item, necessidade e tipo de evento** (seção 9.3) |

Dependências: P-R2/P-R3/P-R4 definem o **layout** da lista de eventos; P-R1/P-R5/P-R6
definem **queries e helper**; P-R7 define o **cartão** "Doações recebidas".

---

## 17. Plano de testes da futura implementação (nenhum escrito agora)

Postgres real, sem mocks; reutilizar os cenários de `needFulfillmentPhysical.test.ts`.

1. **Sem dados:** todas as seções vazias, sem erro, sem divisão por zero.
2. **Original:** uma doação da rede = 1 doação; ligação ao `original`; sem contagem dupla.
3. **Correção negativa (100→80):** original 100 visível; "Correção −20"; líquido 80; efeito físico −20 ligado.
4. **Correção positiva (100→120):** conforme P-R2 decidido; 1 doação; líquido 120; efeito físico +20.
5. **Estorno contábil:** `reversal` aparece, líquido cai, estoque não muda, selo "só contábil".
6. **Estorno físico:** `reversal` + retirada física **ligadas e separadas**; nenhum número que soma os dois.
7. **Cadeia longa** (corrigir, estornar, "desfazer estorno"): original sempre visível; identidade `acum(fim)=acum(início)+período`.
8. **Excedente** (necessidade 500, ledger 650): `surplus 150`; estorno reduz; sem corte.
9. **Necessidade parcial / atendida / atendida que voltou a faltar:** aviso factual **sem** reabrir; `needs.status` intacto.
10. **Filtros:** limites inclusivo/exclusivo (inclui o último segundo do dia); item; necessidade; tipo de evento; "as of" vs hoje.
11. **Multi-tenant:** duas organizações sobrepostas; nenhum vazamento de linha, item, necessidade, motivo, contagem; auditoria de plataforma (`organization_id NULL`) fora.
12. **Permissões:** `relatorios.leia` (proprietário/administrador) vê; operador e voluntário 403; membro inativo 403; não-membro 403; nenhuma permissão nova.
13. **Desempenho:** número de consultas **constante** com 1 e com 200 necessidades (sem N+1); teto de 1.000 eventos com `truncated`.
14. **Reconciliação:** por atribuição, `saldo físico = Σ movimentos ligados`; líquido contábil e físico **diferem** só em estorno contábil (esperado).
15. **Mobile** (Central Visual, 375/390/768/≥1280): sem rolagem horizontal da página; cartões; prioridade dos números.
16. **Impressão:** seções expandidas, filtros e regras de data no cabeçalho, aviso de truncamento; sem controles.
17. **Não regressão:** `ledger`, `estoque`, `matching`, `needs_GET`, `allocations-receipt-history` inalterados; contagem de testes anterior intacta.

---

## 18. Roadmap de implementação (sem migration)

Pré-requisito: **confirmar P-R1…P-R8** (seção 16). Nenhuma migration; ledger, estoque,
aprovação, matching e lifecycle **intocados**.

1. **3a — dados:** estender `getNeedFulfillmentBalanceBatch` com limites de data
   (retrocompatível, fórmula única); novas consultas em lote no endpoint do relatório
   (aditivas: campos novos, os existentes preservados); corrigir o limite superior para
   exclusivo [T-1]; testes 1–14 e 17.
2. **3b — tela:** seções "Atendimento das necessidades" e "Histórico dos recebimentos",
   cartões novos, filtros (item/necessidade/tipo), regras de data na tela.
3. **3c — mobile e impressão:** cartões/linha do tempo, `@media print` expandido; Central
   Visual 375/390/768/≥1280; testes 15–16.

Limites conscientes (herdados): troca de item físico, conversão de unidades, chave de
idempotência persistente; sem valores monetários.

---

## 19. Veredito

**BLOQUEADA POR DECISÕES DE PRODUTO** (P-R1 a P-R8 pendentes).
O domínio, as fontes, os contratos, o desempenho, a segurança, o mobile e a impressão
estão especificados; **não** há dependência técnica nova (sem migration). A implementação
só começa depois que o dono confirmar ou alterar cada decisão da seção 16.


---

## 20. Fase 85 — implementação (Fatia 3)

**Estado:** implementada sobre `5cafeb8`, **sem migration**, sem alterar ledger, estoque, matching,
aprovação, lifecycle ou permissões. As decisões P-R1…P-R8 da seção 16 foram **CONFIRMADAS** pelo dono
no brief da Fase 85 (a tabela acima registra o estado da Fase 84, em que estavam pendentes):

| ID | Decisão confirmada |
|---|---|
| P-R1 | ambos: **acumulado até o fim** + **movimentação do período** (+ "hoje" separado) |
| P-R2 | correção positiva em linha separada, marcada "não é nova doação" |
| P-R3 | original + correção + líquido (nunca só o líquido) |
| P-R4 | estorno contábil e retirada física como **duas linhas ligadas** |
| P-R5 | eventos do período + saldos no fim do período + hoje |
| P-R6 | necessidades com **atividade de atendimento no período OU saldo relevante no fim do período** (diferença da recomendação: necessidade apenas *criada* no período, sem atividade nem saldo, **não** entra; ela já está no cartão "cadastradas") |
| P-R7 | entradas manuais ficam em "Doações recebidas", com selo de origem |
| P-R8 | filtros: período, item, necessidade e tipo de evento |

### 20.1 Onde está

- `src/helpers/impactReport.tsx` — `buildImpactReport` (leitura em lote) e `classifyReceiptEvents` (puro).
- `src/endpoints/impact-report_GET.ts` (+ `.schema.ts`) — mesma rota, contrato ampliado;
  `relatorios.leia` (proprietário/administrador) no servidor; `endDate` passa a ser **exclusivo**.
- `src/helpers/needFulfillment.tsx` — `getNeedFulfillmentBalanceBatch(db, ids, { before, from, to })`:
  janelas **opcionais** (sem janela = comportamento anterior; `needs_GET` não muda). A fórmula
  continua escrita **uma vez**.
- `src/pages/organizacoes.$organizationId.prestacao-contas.tsx` (+ `.module.css`).
- `test/impactReport.test.ts` — 25 testes (Postgres real).

### 20.2 Decisões de implementação e desvios da especificação

- **Datas:** a tela envia `[início do dia De, início do dia seguinte a Até)` (fuso do navegador, o
  padrão do app); o servidor usa `>= start` e `< end` em **todas** as consultas. O defeito de
  `T23:59:59` foi eliminado. A tela também deixou de calcular o padrão do filtro em UTC
  (`toISOString`), que deslocava o dia à noite.
- **Tipos de evento (filtro):** `recebimento` (rede), `entrada_manual`, `correcao`, `estorno`.
  Filtram as **listas**; os cartões mostram todos os tipos (a tela diz isso, em "Escopo dos filtros").
  Item e necessidade valem para doações, histórico, necessidades e contagens; a movimentação por
  item só respeita o filtro de item; auditoria é a contagem da organização inteira.
- **Par de correção:** `reversal` + `correction` do mesmo alvo **na mesma transação** (mesmo
  `created_at`) = **um** evento "Correção de A para B"; `reversal` sem par = "Estorno";
  `correction` sobre alvo já estornado = "Desfazer estorno" (conta como correção). Um estorno
  anterior que depois foi desfeito continua contando como estorno (o pareamento exige o mesmo
  instante, não só o mesmo alvo).
- **Decomposição do acumulado:** `recebido + correções + estornos = líquido (fulfilled)`, por
  necessidade, numa agregação em lote; o líquido continua vindo da fórmula única e um teste afirma
  a igualdade.
- **Limites:** 1.000 eventos nas listas de doações e de eventos do ledger; 500 necessidades. Total,
  cartões e saldos vêm de agregações completas (testado com 999/1000/1001 e com 1.001 estornos);
  aviso explícito na tela e na impressão.
- **Consultas:** 13 consultas de dados (todas em lote) + as de sessão/permissão; o número é
  **constante** com 1 ou 100 necessidades/eventos (teste por contagem de `executeQuery`).
- **Auditoria:** só motivo e aprovador (nome) entram no relatório; nenhum evento cru, metadata,
  e-mail ou id técnico como informação principal.

### 20.3 Limites conscientes

- A visão "no início do período" e "no fim" usa `created_at` dos eventos; não há reconstrução do
  *status* administrativo em datas passadas (`needs.status` é sempre o atual).
- O relatório ainda **não** tem exportação além da impressão do navegador.


---

## 21. Fase 86 — fechamento da Fatia 3 (ressalvas da Fase 85)

**Estado final:** Prestação de Contas implementada e checkpointada (Fase 85 + esta revisão). Sem migration;
ledger, estoque, matching, aprovação, lifecycle e permissões **não** foram alterados.

### 21.1 Contrato do filtro de datas — `[startDate, endDate)`

O intervalo é **semiaberto**: `startDate` **inclusivo** (início do dia escolhido em "De") e `endDate`
**EXCLUSIVO** (início do dia **seguinte** ao escolhido em "Até"). Todas as consultas do relatório usam
`created_at >= startDate AND created_at < endDate`. Exemplo: filtro para 03/10 =
`>= 2026-10-03T00:00:00` e `< 2026-10-04T00:00:00` (fuso local do navegador; o servidor só recebe
instantes ISO). **Não** usar `T23:59:59` como limite superior (perde o último segundo).

A semântica está em **um** lugar para a tela: `src/helpers/reportDates.tsx` (`reportRange`,
`dayStart`, `nextDayStart`, `localISODate`); o endpoint repassa os instantes; o helper SQL e os
saldos "até o fim" (`before`) usam `<` (exclusivo). Mudança de contrato em relação ao relatório
anterior (que usava `<= endDate` com `T23:59:59`): o único cliente é a própria tela.

Testes: o intervalo montado pela tela; no endpoint, **23:59:59.000**, **23:59:59.500** e
**23:59:59.999** do último dia **entram**; **00:00:00.000 do dia seguinte não entra** (e é o primeiro
instante do dia seguinte); 00:00:00.000 do primeiro dia entra.

### 21.2 Impressão

- `window.print()` real abre o **diálogo nativo** e bloqueia o processo de renderização da página do
  painel (a automação não consegue ler o estado nem fechá-lo). **CSS de impressão validado; diálogo
  nativo não automatizado.**
- Validado: as regras de `@media print` da página foram aplicadas (sem condição de mídia) à página real
  com dados e filtro de item: navegação, filtros, nota de escopo e botão **somem**; as **tabelas**
  aparecem (os cartões móveis somem); o cabeçalho mostra **organização**, **período**, **filtros**
  ("item: Arroz") e **data de geração**; o **aviso de truncamento** continua visível.
- Mesma árvore de componentes; nenhuma segunda lógica de dados para impressão.

### 21.3 Tema escuro (375 / 390 / 768)

Mecanismo do app (`body.dark`, tokens existentes): sem alteração no Design System. Medido: sem
overflow horizontal em 375, 390 e 768 (`scrollWidth = largura`); cartões no lugar das tabelas;
razão de contraste **≥ 4,77:1** em todos os textos do relatório (cartões, rótulos, badges, aviso de
necessidade, aviso de truncamento, linha do tempo, filtros e estados vazios, estes ≥ 5,94:1).

### 21.4 Decisões, limite e filtros (resumo do que está implementado)

P-R1…P-R8 confirmadas (seção 20). Limite: 1.000 eventos só nas listas (500 necessidades), com aviso na
tela e na impressão; totais/cartões/saldos por agregação completa. Filtros: período, item,
necessidade e tipo de evento (o tipo filtra as listas; a movimentação por item só respeita o filtro
de item). Consultas: 13 de dados em lote, constantes com 1 ou 100 necessidades/eventos.

### 21.5 Limitações restantes

- A impressão real (diálogo nativo → PDF) não é automatizável aqui; foi validada pelas regras de CSS.
- `needs.status` é sempre o atual (não há reconstrução histórica do status).
- Sem exportação além da impressão do navegador.
