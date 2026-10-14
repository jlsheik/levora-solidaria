# Especificação — correção, estorno e excedente do ledger de atendimento

Fase 76. **Especificação, não implementação.** Nenhum schema, migration,
endpoint, helper, tela, regra de matching, estoque, necessidade ou
auditoria foi alterado. Escrita sobre o baseline `28d4e3d`; tudo o que está
descrito como "hoje" foi lido no `HEAD` (o WIP da plataforma de agentes, que
modifica `db/schema.sql` e `allocations-receive_POST.ts`, **não** é descrito).

O Modelo B continua **congelado** estruturalmente: ledger append-only,
`entry_type`, `original`/`correction`/`reversal`, `is_countable`, quantidade
sempre positiva, relação com a allocation, `stock_transaction_id`, saldo
derivado, uma reversal por alvo, reversal não aponta para reversal.

Convenção: **[T-n]** decisão técnica (resolvível na implementação).
**[P-Ln]** decisão de produto: traz uma **recomendação**, claramente marcada,
mas é do dono do projeto decidir antes de codificar (seção 19).

> **Fase 77 (leia primeiro).** As seções **O–Y** (no fim) fecham o contrato
> operacional e **prevalecem** sobre qualquer trecho anterior que as contradiga
> (em especial: "um movimento físico por linha do ledger" em B.4/C/T-2 **não** é
> regra universal — ver seção P; e a "idempotência" de G.3 passa a ser chamada
> de controle otimista de estado — ver seção S). **Estado dos gates P-L1…P-L6:
> CONFIRMADOS pelo dono no brief da Fase 78** (a tabela da seção O e o
> veredito da seção Z registram o estado da Fase 77, em que estavam pendentes).
> **A Fatia 1 está implementada: ver a seção AA (Fase 78) no fim.**

## A. Modelo atual (auditado)

### A.1 Cadeia real

```
opportunity_registry ──< opportunity_allocations ──< need_fulfillments >── needs
                              │  (organization_id, need_id?)     │  (need_id herdado)
                              │                                   │
                              └─ match_evaluations.need_id        └── stock_transaction_id ──> stock_transactions ──> inventory_items
                                 (automáticas) OU                     (FK composta com a organização,
                                 allocations.need_id (manuais)         UNIQUE: 1 movimento = 1 linha)
```

- **Único produtor hoje:** `allocations-receive_POST`, dentro de uma
  transação que (1) trava a allocation e o item (`FOR UPDATE`), (2) insere um
  `stock_transaction` `entrada` com `delta = quantityReceived`, (3) marca a
  allocation `recebida`, (4) chama `createNeedFulfillment`, (5) registra
  logística e conclusão da oportunidade, (6) audita (`atribuicao.recebida`).
- A `need` é resolvida por **duas fontes exclusivas**: `match_evaluations`
  (allocation automática) ou `opportunity_allocations.need_id` (manual).
  Divergência entre as duas é erro estrutural. Sem nenhuma das duas,
  `need_id = NULL` (a linha existe, mas não conta para nenhuma necessidade).
- `quantity`/`unit` do ledger são os **do recebimento real**; a unidade vem do
  **item de inventário escolhido**, não da oportunidade.

### A.2 Fórmula canônica (única implementação: `needFulfillment.tsx`)

```
efeito = 0            se is_countable = false
efeito = +quantity    se entry_type ∈ { original, correction }
efeito = −quantity    se entry_type = reversal
saldo(need) = Σ efeito das linhas com need_id = need
fulfilled = saldo;  requiredRemaining = max(0, needed − fulfilled);  surplus = max(0, fulfilled − needed)
```

### A.3 O que o banco já garante (trigger `need_fulfillments_validate_entry` + índices)

| Regra | Garantia |
|---|---|
| Append-only | trigger de bloqueio de `UPDATE`/`DELETE` |
| 1 `original` por allocation | índice único parcial |
| `original` | sem alvo; exige `stock_transaction_id` |
| `correction`/`reversal` | exigem `reverses_fulfillment_id`; alvo da **mesma** allocation e organização; alvo **não** pode ser `reversal` |
| `need_id` | **herdado** do alvo, nunca livre |
| `correction` | `unit`, `quantity`, `is_countable` **livres** |
| `reversal` | herda também `unit`, `quantity`, `is_countable` (é "a reversão direta") |
| 1 `reversal` por alvo | índice único parcial |
| Lastro físico | FK composta com a organização; `UNIQUE(stock_transaction_id)` |

### A.4 Achados da auditoria (que a especificação precisa tratar)

- **F1 — `correction` é aditiva.** Soma `+quantity`; nunca subtrai. "Corrigir
  100 para 80" **não** é uma linha: é o par `reversal` + `correction`.
- **F2 — o ledger não consegue re-associar uma necessidade.** `need_id` é
  herdado por trigger. Um recebimento creditado à necessidade errada só pode
  ser **estornado**; o crédito não migra para outra necessidade pelo ledger.
- **F3 — a prestação de contas não lê o ledger.** `impact-report_GET` usa só
  `stock_transactions` (`type = 'entrada'`). Correções sem movimento de estoque
  e estornos hoje seriam **invisíveis** no relatório.
- **F4 — nada limita o recebido ao alocado** (nem ao necessário). `fulfilled`
  inclui qualquer excedente; `surplus` é só derivado.
- **F5 — nada impõe cadeia linear.** O schema aceita várias `correction`
  apontando para o mesmo alvo; a linearidade precisa ser regra de aplicação.
- **F6 — o matching não trava a necessidade nem o ledger.** Trava só a linha de
  `opportunity_registry`; lê o progresso por um `SELECT` agregado.
- **F7 — `recordAuditLogEntry` segura um advisory lock global** da cadeia de
  hash até o commit; a auditoria deve ser o **último** passo da transação.
- **F8 — `reversal.stock_transaction_id ≠ NULL` não tem contrato de domínio**
  (o código documenta que só `NULL` é exercitado). Esta fase o define (seção C).
- **F9 — `approval_requests.action_type` é `TEXT`:** um novo tipo de aprovação
  **não exige migration**.
- **F10 — documentação desatualizada:** a Fase 31 descreve "referência
  opcional" para `correction`; desde a Fase 32 ela é **sempre** obrigatória.

## B. Semântica oficial

### B.1 `original` (seção 2)

Registro do **recebimento físico real** de uma allocation aceita, no momento em
que ele acontece. Representa: a quantidade realmente recebida (`quantityReceived`),
na unidade do item de inventário em que entrou, com o lastro físico do
`stock_transaction` de `entrada` criado na mesma transação.

- **Conta para a necessidade** a mesma quantidade, **somente se**
  `is_countable = true`.
- `is_countable = false` quando a unidade do recebimento (normalizada: NFD, sem
  acento, minúscula) difere da unidade da necessidade. A relação com a
  necessidade (`need_id`) é preservada; só a **soma** é suprimida, para nunca
  misturar unidades.
- Sem conversão de unidades (nenhuma tabela de conversão existe nem será
  criada): unidades diferentes ⇒ **não contável**, sempre.
- Allocation sem necessidade ⇒ `need_id = NULL`: a linha registra o fato físico,
  mas não afeta nenhum progresso.

### B.2 Vocabulário e a **linha vigente**

Para uma allocation, a **linha vigente** é a linha `original`/`correction`
que **não** foi alvo de nenhuma `reversal` e que está na ponta da cadeia. A
cadeia é **linear** por regra de aplicação [T-1]: toda operação nova aponta
para a linha vigente. O efeito líquido da allocation é o efeito da linha
vigente (zero se estornada sem substituta).

### B.3 `correction` (seção 3) — "o valor passa a ser este"

Uma `correction` carrega **o valor correto** (quantidade, unidade, contabilidade)
da realização. Como é aditiva (F1), toda correção que **muda o efeito contado**
é executada como um **par atômico**:

1. `reversal` da linha vigente (cancela exatamente o que ela contava);
2. `correction` apontando para a mesma linha vigente, com o valor correto.

Líquido = `−q_antigo + q_novo`. Se a linha vigente **não conta** (`is_countable
= false`), o estorno não tem efeito a cancelar e **pode ser omitido**: só a
`correction`. Esta é a regra canônica **única** — não existe "correction de
delta" (o par é uniforme, legível e evita duas representações do mesmo
resultado).

| Caso | Linhas novas | `quantity` | `unit` | `is_countable` | Estoque | Efeito no saldo da necessidade |
|---|---|---|---|---|---|---|
| **100 → 80** (físico realmente 80) | `reversal`(vigente) + `correction` | rev: 100 (herdada) / corr: 80 | iguais | iguais | corr: `ajuste` −20 (regra de risco); rev: `NULL` | −100 + 80 = **80** |
| **100 → 120** (físico realmente 120) | `reversal`(vigente) + `correction` | rev: 100 / corr: 120 | iguais | iguais | corr: `ajuste` +20; rev: `NULL` | −100 + 120 = **120** |
| **Unidade corrigida**, original **não contável** (ex.: item "un", necessidade "kg", físico era kg) | só `correction` | 100 | "kg" | recalculado (`true`) | **nenhum** (físico já certo; relabel do item é assunto do inventário) | 0 → **+100** |
| **Unidade corrigida**, original **contável** | `reversal` + `correction` | rev: 100 / corr: 100 | corr: nova | recalculado | nenhum | −100 + (100 ou 0) |
| **Necessidade incorreta** | ⛔ **não suportado por correção** (F2) — só **estorno** | — | — | — | — | crédito sai da necessidade errada; **não** entra em outra |
| **Erro administrativo sem mudança física** (rótulo/contabilidade) | só `correction` (ou par, se contável) | conforme | conforme | conforme | **nenhum** (`NULL`) | conforme |

`correction.stock_transaction_id` é **`NULL` ou um movimento criado na mesma
transação** (nunca um id vindo do cliente — contrato da Fase 34).

### B.4 `reversal` (seção 4) — "isto não deveria contar"

Anula **integralmente** a linha alvo; o original **permanece intacto**. A
reversal herda `need_id`, `unit`, `quantity` e `is_countable` e, por derivação,
subtrai exatamente o que o alvo contava. Nunca existe "reversão parcial":
parcial é o par da seção B.3.

**Contrato novo (F8) para o lastro físico da reversal:**

- `stock_transaction_id = NULL` — estorno **puramente contábil** (o padrão
  recomendado; é o único caso já exercitado pelo código);
- `stock_transaction_id = <movimento compensador>` — estorno **com retirada
  física**: um `stock_transaction` do tipo `ajuste` negativo, do **mesmo item**
  do `original`, criado **na mesma transação**, vinculado à reversal (a `UNIQUE`
  impede reaproveitá-lo). **Correção da Fase 77:** o módulo **não** é "o `delta`
  do movimento do alvo" (errado em cadeias: o alvo pode ter `stock_transaction_id
  = NULL`); é o **saldo físico da allocation** definido na seção P.2.

Nunca há alteração física silenciosa: ou o movimento compensador existe e está
vinculado, ou a reversal declara explicitamente que **não** mexeu no estoque.

### B.5 Diferença entre correção e reversão (seção 5)

| Situação | Tipo | Regra de decisão |
|---|---|---|
| Erro **parcial** de quantidade | **Correção** (par) | o evento aconteceu; o valor estava errado |
| Erro **total** (evento nunca ocorreu / duplicado) | **Reversão** | o evento não deveria contar |
| Evento totalmente inválido | **Reversão** | idem |
| Divergência de **unidade** | **Correção** | o evento aconteceu; o rótulo estava errado |
| Correção **administrativa** (metadado) | **Correção** (sem estoque) | nada físico mudou |
| Erro de **associação com a need** | **Reversão** (+ limitação F2) | correção não pode trocar `need_id` |

O critério é **semântico** ("o evento aconteceu?"), não a conveniência técnica.

### B.6 Cadeias (seção 11)

| Operação | Permitida? | Como |
|---|---|---|
| `correction` de `original` | ✅ | par/correção apontando para a linha vigente |
| `correction` de `correction` | ✅ | idem, a vigente passa a ser a correção anterior |
| `reversal` de `original` | ✅ | cancela o `original` |
| `reversal` de `correction` | ✅ | cancela a correção vigente |
| `reversal` de `reversal` | ⛔ trigger (inalterado) | **desfazer um estorno** = nova `correction` com o valor desejado, apontando para a linha estornada |
| Duas `correction` no mesmo alvo | ⛔ por regra de aplicação [T-1] | só a vigente aceita novas operações |

Exemplo: `#1 original 100` → par `#2 reversal(#1)` + `#3 correction(#1)=80` → novo
ajuste: `#4 reversal(#3)` + `#5 correction(#3)=90`. Efeito: 100 −100 +80 −80 +90 = **90**.
Estorno total após correções: `#6 reversal(#5)` ⇒ líquido 0. Para "reativar":
`#7 correction(#5)=100` ⇒ 100.

**Invariante I-L1:** o saldo líquido de uma allocation nunca é negativo (cada
linha só é revertida uma vez, com a própria quantidade) — impossível por
construção.

## C. Estoque (seção 7)

Princípio **[T-2]**: o ledger conta o que **a necessidade recebeu**; o estoque
registra o que **fisicamente existe**. Um não deriva do outro. Toda variação
física é **um** `stock_transaction` vinculado a **uma** linha do ledger
(`UNIQUE`), criado na mesma transação — mas **nem toda linha do ledger gera
movimento físico** (a reversal contábil e a reversal de um par não geram). A
tabela abaixo é substituída pela matriz definitiva da seção P.4.

| Evento | Entrada | Saída | Nenhuma |
|---|:--:|:--:|:--:|
| `original` recebido | ✅ `entrada` (hoje) | | |
| `correction` com **mais** físico | ✅ `ajuste` positivo (vinculado à correction) | | |
| `correction` com **menos** físico | | ✅ `ajuste` negativo (vinculado à correction; **regra de risco**) | |
| `correction` só de metadado (unidade/contabilidade) | | | ✅ |
| `reversal` contábil (padrão) | | | ✅ |
| `reversal` com retirada física (opt-in) | | ✅ `ajuste` negativo (vinculado à reversal; **regra de risco**) | |

Regras:

- **Sem duplicação física:** no par de B.3 a reversal é `NULL` e **só a
  correction** carrega o `ajuste` líquido (−20 ou +20); nunca "saída 100 +
  entrada 80". Duas movimentações num par só são aceitas quando o **item
  muda** (fora do escopo, B.7).
- **Regra de risco existente (reutilizada, não reinventada):** `ajuste` negativo
  com `|delta| ≥ 20` **ou** `≥ 30%` do saldo exige **segunda pessoa**; quem pede
  não aprova. Estoque nunca fica negativo (409 `insufficient_stock`).
- **Estoque insuficiente:** se a retirada física não cabe (os itens já foram
  distribuídos), a operação com retirada é **recusada (409)**; o caminho é o
  estorno **contábil** (sem tocar o estoque) e, separadamente, o fluxo normal de
  ajuste/saída. Nada é "forçado".
- **Ajuste positivo** de correção não exige aprovação (só reduções são vetor de
  fraude).

### C.1 Item errado — fora do escopo [T-3]

O ledger não tem `item_id`. Trocar o item físico exige duas movimentações
(saída no item errado, entrada no certo). **Não** é coberto na primeira
implementação: o usuário usa estorno (com retirada) + fluxo normal de entrada.
Fica como limitação consciente.

## D. Necessidade (seção 8)

| Efeito | Regra |
|---|---|
| `fulfilled` | continua = saldo contável do ledger; correção/estorno o alteram **só pela fórmula** |
| `requiredRemaining` | `max(0, needed − fulfilled)`; sobe quando um estorno/correção negativa reduz o saldo |
| `surplus` | `max(0, fulfilled − needed)`; derivado, nunca persistido |
| `needs.status` | **não muda.** Continua decisão administrativa independente do ledger (Fase 37). Uma necessidade `atendida` pode passar a ter `requiredRemaining > 0`: a interface **avisa**, nada reabre sozinho |
| `need_resolutions` | intocado (conceito separado: consumo do estoque próprio) |

### D.1 Excedente (seção 6) — regra oficial recomendada **[P-L1/P-L2]**

Exemplo: necessidade 500; ledger chega a 650.

| Pergunta | Regra recomendada |
|---|---|
| Os 150 contam? | **Permanecem contabilizados em `fulfilled`** (o ledger é factual: o que chegou). Não há "corte" |
| São descartados do progresso? | Não. O progresso mostra `fulfilled = 650`, `requiredRemaining = 0`, `surplus = 150` |
| Podem ser transferidos? | **Não pelo ledger.** O excedente é **estoque da organização**; usá-lo em outra necessidade é o fluxo existente de consumo do estoque próprio |
| Pertencem à necessidade ou à organização? | **À organização** (o bem está no estoque dela) |
| Geram indicador? | Sim: `surplus` na tela da necessidade (já existe) e na prestação de contas (novo) |
| Afetam o matching? | Não além do que já valem: `requiredRemaining = 0` ⇒ necessidade **inelegível**; o `surplus` não entra |
| Afetam `requiredRemaining`? | Não (já é `max(0, …)`) |
| Afetam `surplus`? | Sim: é exatamente ele |

Quantidade recebida × alocada (seção 10), regra **recomendada**:

| Caso | Regra |
|---|---|
| recebido = alocado | fluxo normal |
| recebido < alocado | parcial; sem bloqueio |
| recebido > alocado | **permitido** (a realidade física manda) com **indicador** no evento de auditoria |
| `correction` leva acima do alocado/necessário | **permitida**, com **motivo obrigatório** e indicador de excedente [P-L2] |
| `reversal` leva abaixo de zero | **impossível** por construção (I-L1) |

## E. Matching 1.4 (seção 18)

**Nada muda no algoritmo.** `requiredRemaining > 0` e `needs.status = 'aberta'`
continuam sendo o critério de elegibilidade; o `quantidade` já compara com o
`requiredRemaining` real. Um estorno/correção que o aumente torna a necessidade
elegível **no próximo sweep** (a cada 15 min), naturalmente. `ALGORITHM_VERSION`
permanece 1.4; avaliações antigas nunca são reescritas.

Efeito de corrida aceito: como o matching lê o progresso sem travar a
necessidade (F6), uma operação do ledger concorrente pode fazê-lo decidir sobre
um saldo uma operação defasado; o erro é **autocorrigido no sweep seguinte** e
nunca viola I-L1 (ver G, caso 4).

## F. Auditoria (seção 12)

Padrão real `dominio.acao_participio`, em português; só ids e números, **sem
senha, token, JWT, cookie ou e-mail**:

| Ação | Quando | Metadata mínima |
|---|---|---|
| `atribuicao.recebimento_corrigido` | par/correction executado | `fulfillmentId` (correction), `reverteuFulfillmentId` (ou `null`), `allocationId`, `needId`, `quantidadeAnterior`, `quantidadeNova`, `unidadeAnterior`, `unidadeNova`, `efeitoEstoque` (`nenhum`/`entrada`/`saida`), `stockTransactionId` (ou `null`), `excedente` (número ou `0`), `motivo` |
| `atribuicao.recebimento_estornado` | reversal executada | `fulfillmentId`, `alvoFulfillmentId`, `allocationId`, `needId`, `quantidade`, `efeitoEstoque`, `stockTransactionId`, `excedente`, `motivo` |
| `atribuicao.recebimento_pendente_aprovacao` | operação com redução vira pedido (seção H) | `approvalRequestId`, `tipo` (`correcao`/`estorno`), `allocationId` |
| `atribuicao.recebimento_corrigido` / `_estornado` via aprovação | executada ao aprovar | os mesmos + `approvalRequestId` |

`motivo`: obrigatório, texto curto (até ~200 caracteres), com aviso de **não
incluir dado pessoal** (a trilha é imutável). Recusas (409/403/404) **não**
geram evento (padrão do projeto). A auditoria é o **último** passo da
transação (F7).

## G. Concorrência (seção 13)

### G.1 Protocolo de locks **[T-4]**

Ordem global proposta para as operações do ledger, compatível com os fluxos
existentes (receive trava allocation → item; `needs-status` trava need → item;
`stock-transactions` trava item; decisão de aprovação trava o pedido):

1. `approval_requests` (só ao decidir um pedido);
2. `opportunity_allocations` da allocation (`FOR UPDATE`) — **mesmo lock** do
   recebimento, da decisão e da logística;
3. `needs` da necessidade, se `need_id ≠ NULL` (`FOR UPDATE`) — mesmo lock do
   `needs-status`;
4. `inventory_items` envolvidos, em `id` crescente (`FOR UPDATE`);
5. linhas do ledger da allocation, `ORDER BY id` (`FOR UPDATE`) — para ler a
   linha vigente com o estado confirmado;
6. **auditoria por último** (advisory lock global).

Nenhum caminho existente trava nessa ordem invertida ⇒ sem ciclo. A allocation
é a âncora: serializa **todas** as operações do mesmo recebimento.

### G.2 Cenários

| # | Cenário | Lock / transação | Invariante | Resultado | Erro |
|---|---|---|---|---|---|
| 1 | **Duas correções simultâneas** da mesma allocation | ambas travam a allocation (2); a 2ª relê a linha vigente depois do lock | cadeia linear; precondição `expectedVigenteId` | 1ª aplica; 2ª vê a vigente mudada | **409** "o recebimento foi alterado" |
| 2 | **Correction + reversal** simultâneos | idem | 1 reversal por alvo (índice) + cadeia linear | serializados; a 2ª parte do estado novo | **409** |
| 3 | **Recebimento + correction** | receive trava a allocation (2); a correction só existe se a allocation já é `recebida` | só há correção depois do `original` | a correction aguarda o receive; sem `original` ⇒ recusada | **409** "ainda não recebida" |
| 4 | **Reversal + matching** | reversal trava allocation+need; matching trava só o registro (F6) | I-L1; matching tolera saldo defasado | matching pode alocar com o saldo anterior; o sweep seguinte corrige; `surplus` derivado absorve | nenhum |
| 5 | **Correction + `needs-status`** | ambos travam a **need** (3); status é independente do ledger | `needs.status` não é derivado | serializados; nenhum altera o outro | nenhum |
| 6 | **Duas operações consumindo o mesmo excedente** | consumo de estoque próprio trava o item (4); ajuste/estorno com retirada também | estoque nunca negativo; regra de risco | a 2ª relê o saldo do item sob o lock | **409** `insufficient_stock` |

### G.3 Controle otimista de estado (antes chamado "idempotência") **[T-5]**

> Fase 77: isto **não é idempotência**. É *controle otimista de estado /
> proteção contra retry obsoleto*; contrato fechado na seção S.

- **Sem chave de idempotência nesta fase (limitação consciente).** O ledger ser
  append-only **não** torna a operação idempotente.
- **Precondição otimista:** toda operação envia `expectedVigenteFulfillmentId`
  (a linha vigente que o cliente viu). Se a vigente mudou, **409**. Isso distingue
  **retry** (a vigente já mudou ⇒ 409, nada duplica) de **nova operação
  legítima** (o cliente relê o histórico e reenvia com a nova vigente).
- Duplicata de estorno é barrada também por `idx_..._one_reversal_per_target`.
- Custo aceito: um retry após sucesso responde 409, **não** repete a resposta
  original. Uma tabela de chaves de idempotência fica para depois, se houver
  demanda.

## H. Permissões (seção 15)

Regra: **reduzir** o que foi registrado é o vetor de fraude (esconder desvio);
**aumentar** ou **reclassificar** não é. Reuso integral das permissões
existentes — **nenhuma permissão nova** [P-L5/P-L6]:

| Operação | Quem executa | Aprovação |
|---|---|---|
| **Ver** histórico do recebimento | `logistica.leia` (todos os papéis, como hoje) | — |
| `correction` que **aumenta** ou só reclassifica (unidade/metadado) | `logistica.gerencie` (operador, administrador, proprietário) | não |
| `correction` que **reduz** o efeito contado, e **qualquer `reversal`** | `logistica.gerencie` **solicita**; **segunda pessoa** com `aprovacoes.decida` (administrador/proprietário) **aprova** | **sim** — mecanismo existente de dupla autorização (`approval_requests`, novo `action_type`), quem pede ≠ quem aprova |
| Efeito físico negativo | além do acima, sujeito à regra de risco do estoque | idem |
| **Outra organização** | **ninguém**: isolamento por organização (404/403), como em todo o domínio | — |
| **Administrador da plataforma** (`users.role = admin`) | **não corrige nem estorna** recebimentos de organizações (só lê a auditoria) | — |

A execução de um pedido aprovado **revalida tudo sob os locks** (vigente,
saldo, estoque) e registra o executor.

## I. Frontend (seção 16) — somente especificação

- **Onde:** na tela de **Atribuições** (rede Levora), no cartão de cada
  atribuição `recebida`: seção recolhível **"Histórico do recebimento"** com a
  cadeia (linha, tipo, quantidade, unidade, contável, quem, quando, motivo) e
  ações **"Corrigir recebimento"** e **"Estornar recebimento"** (visíveis só a
  quem pode; nunca na organização alheia).
- **Confirmação:** diálogo com o **antes → depois** (quantidade/unidade/efeito
  no estoque/efeito no saldo da necessidade e `requiredRemaining` resultante),
  motivo obrigatório e, quando há retirada física, o aviso de dupla autorização.
- **Excedente:** mostrado como "Excedente: N" (já existe na necessidade), com
  aviso ao corrigir acima do necessário.
- **Necessidade `atendida` com saldo faltante:** aviso, sem reabrir sozinha.
- **Estados concorrentes:** 409 ⇒ recarregar o histórico e avisar "o
  recebimento foi alterado por outra pessoa" (sem repetir a ação).
- **Pedido pendente de aprovação:** badge "Aguardando aprovação" no cartão e na
  fila de aprovações já existente.
- **Mobile:** alvos de ~44 px, diálogos do `Dialog` compartilhado, textos
  quebrando linha, sem rolagem horizontal; a cadeia vira lista vertical.
- Sem mockup; sem componente novo nesta fase.

## J. Prestação de contas (seção 17)

Princípio: **histórico imutável + saldo derivado.** Hoje o relatório não lê o
ledger (F3). O que passa a mostrar (a implementar):

- **Doações recebidas (movimentos físicos):** continua como está (as entradas
  originais **nunca** somem nem são editadas; o relatório não "apaga" nada).
- **Nova seção "Atendimento por necessidade (rede Levora)"**, lida do ledger:
  por necessidade — **recebido original**, **ajustes** (correções, com sinal),
  **estornos**, **líquido** (`fulfilled`), **necessário**, **faltante** e
  **excedente**; cada ajuste/estorno aparece **como linha própria** com data,
  autor e motivo.
- Movimentos físicos de `ajuste` ligados a correções/estornos aparecem na
  movimentação de estoque por item como hoje (tipo `ajuste`), com o motivo.
- O **saldo líquido** nunca substitui visualmente a linha original.

## K. Questões de produto (seção 19)

| ID | Pergunta | **Recomendação** (não é decisão) | Fundamento |
|---|---|---|---|
| **P-L1** | Excedente acima do necessário permanece contabilizado? | **Sim**, em `fulfilled`; `surplus` derivado; sem corte nem transferência pelo ledger | o ledger é factual; o bem está no estoque da organização |
| **P-L2** | Correction positiva pode criar excedente? | **Sim**, com motivo obrigatório e indicador | bloquear contraria a realidade física |
| **P-L3** | Correction negativa pode reduzir estoque físico? | **Sim, opt-in e dentro da regra de risco existente** (dupla autorização acima do limite; nunca negativo) | reutiliza a defesa contra "ajuste para encobrir desvio" |
| **P-L4** | Reversal deve criar transação física inversa? | **Opcional, opt-in**; o padrão é estorno **contábil** (`stock_transaction_id = NULL`), com a retirada física só quando o usuário a declara | evita alteração física silenciosa e o 409 de estoque já consumido |
| **P-L5** | Quem pode corrigir? | **Aumento/reclassificação:** `logistica.gerencie`. **Redução:** solicitar com `logistica.gerencie` + aprovar com `aprovacoes.decida` (segunda pessoa) | reduzir é o vetor de fraude |
| **P-L6** | Quem pode reverter? | **Todo estorno** é dupla autorização (solicita `logistica.gerencie`; aprova `aprovacoes.decida`, outra pessoa). Plataforma e outras organizações: ninguém | um estorno reduz o registrado |
| **P-L7** | Correção de unidade sem conversão? | **Sim**, **apenas como reclassificação** (nova unidade, `is_countable` recalculado contra a necessidade); **nunca** converte quantidades | não existe conversão e não será inventada |
| **P-L8** | Corrigir depois de a necessidade estar `atendida`? | **Sim**; `needs.status` **não** muda; a interface avisa | o status é administrativo e independente |
| **P-L9** | Corrigir depois de a oportunidade estar `concluída`? | **Sim**; o lifecycle **não** reabre (allocation permanece `recebida`, oportunidade `concluída`); estorno total deixa líquido 0 com a allocation `recebida` (**limitação registrada**) | o lifecycle está congelado; o evento de recebimento ocorreu |
| **P-L10** | Prazo máximo para corrigir? | **Sem prazo rígido** (a trilha é imutável e a redução já exige 2ª pessoa); alternativa: prazo de N dias para operador e ilimitado para administrador/proprietário | simplicidade; o risco já é mitigado pela aprovação |
| **P-L11** | Mover o crédito para **outra necessidade**? | **Não nesta fase** (F2: `need_id` é herdado). Reabrir isso exige mudar o Modelo B (congelado) | evidência concreta registrada |
| **P-L12** | Chave de idempotência persistente? | **Adiar**; usar a precondição otimista (G.3) | evita tabela nova sem demanda |
| **P-L13** | Motivo obrigatório e limite de tamanho? | **Sim**, curto, sem dado pessoal | a trilha é imutável |

### K.1 Decisões **técnicas** (resolvíveis na implementação)

| ID | Decisão |
|---|---|
| T-1 | Cadeia linear; operações apontam sempre para a linha vigente; correção que muda o efeito = par atômico `reversal` + `correction` |
| T-2 | (Fase 77, reformulada) Cada movimento físico é criado na mesma transação e vinculado a **no máximo uma** linha; **não** há "um movimento por linha": contrato por tipo de linha na seção P |
| T-3 | Troca de item físico fora do escopo |
| T-4 | Ordem de locks da seção G.1 |
| T-5 | Precondição `expectedVigenteFulfillmentId`; sem tabela de idempotência |
| T-6 | **Sem migration** prevista: `action_type` é `TEXT`; índices e trigger atuais bastam |
| T-7 | Novo `action_type` de aprovação (ex.: `correcao_recebimento`); o executor revalida sob locks |
| T-8 | O cálculo do efeito/saldo continua **só** em `needFulfillment.tsx` (nenhuma fórmula paralela) |

## L. Plano de testes de especificação (seção 21)

Postgres real; nenhum mock.

1. **Original:** contável/não contável; sem necessidade (`need_id NULL`).
2. **Correction:** 100→80, 100→120 (pares), efeito exato no saldo; unidade
   corrigida (sem/ com estorno); metadado puro; motivo obrigatório.
3. **Reversal:** herda quantidade/unidade/contável; saldo cai exatamente o que o
   alvo contava; original intacto; reversal contábil e com retirada física.
4. **Cadeias:** correction de correction; reversal de correction; "desfazer
   estorno" via correction; reversal de reversal rejeitada pelo trigger; duas
   correction no mesmo alvo rejeitadas pela aplicação; saldo por allocation
   nunca negativo.
5. **Excedente:** necessidade 500 com 650 ⇒ `surplus = 150`; estorno que reduz
   para 450 ⇒ `requiredRemaining = 50`, `surplus = 0`; correção acima do alocado.
6. **Unidade:** divergência ⇒ `is_countable = false`; correção para unidade
   igual ⇒ passa a contar; sem conversão.
7. **Estoque:** par sem duplicar movimento físico; ajuste positivo sem
   aprovação; negativo acima do limite ⇒ pedido; insuficiente ⇒ 409; nunca
   negativo; `UNIQUE` impede reaproveitar movimento.
8. **Necessidade:** `needs.status` não muda; `requiredRemaining` reflete; `atendida`
   com saldo faltante.
9. **Matching:** necessidade volta a ser elegível no sweep após estorno;
   `ALGORITHM_VERSION` e demais critérios intactos.
10. **Auditoria:** um evento por operação, metadata só com ids/números, nenhuma
    recusa gera evento, cadeia de hash íntegra.
11. **Concorrência (Promise.all + provas determinísticas com lock externo):**
    cenários 1–6 da seção G.2; sem deadlock; **controle negativo** removendo o
    lock da allocation.
12. **Retry:** mesmo request duas vezes ⇒ o segundo é 409 sem duplicar;
    reversal duplicada barrada pelo índice.
13. **Permissões e isolamento:** operador solicita, administrador/proprietário
    aprova, mesma pessoa não aprova; outra organização 404/403; administrador da
    plataforma recusado; IDOR por `fulfillmentId`.
14. **Prestação de contas:** original, ajuste, estorno, líquido e excedente
    aparecem; a linha original nunca desaparece.

## M. Escopo recomendado da próxima implementação

Fatiar para reduzir risco (cada fatia termina verde e isolada):

1. **Fatia 1 — leitura + estorno/correção contábeis:** helper de domínio
   (linha vigente, par atômico, validações, fórmula única), endpoint de
   **histórico** (`GET`) e endpoints de **correção** e **estorno** *sem efeito
   no estoque*, com precondição otimista, locks (G.1), auditoria e a regra de
   dupla autorização para reduções (novo `action_type`). Testes 1–4, 8, 10–13.
2. **Fatia 2 — efeito físico:** `ajuste` vinculado a correction/reversal, regra
   de risco, `insufficient_stock`, contrato B.4. Testes 7 e 9.
3. **Fatia 3 — interface e prestação de contas:** cartão de atribuição,
   histórico, diálogos, seção do relatório. Central Visual desktop/mobile.

**Pré-requisitos:** confirmar P-L1 a P-L6 (seção O — **hoje todos pendentes**; a
Fatia 1 **não** começa antes; as demais têm padrão seguro);
nenhuma migration; `opportunityMatching.tsx`, `need_resolutions`, lifecycle e o
Modelo B permanecem **intocados**.

## N. Não incluído (limitações conscientes)

Troca de item físico; mover crédito para outra necessidade; conversão de
unidades; chave de idempotência persistente; reabrir allocation/oportunidade
após estorno total; notificações das mudanças (dependem de SMTP, bloqueado).

---

# Fase 77 — fechamento das decisões e contrato definitivo

Somente especificação. Nenhum código, schema, migration, endpoint, helper, tela,
matching, estoque, `need_fulfillments`, `approval_requests` ou permissão foi
alterado. Baseline `28d4e3d`. As seções abaixo **prevalecem** sobre as A–N.

Fatos novos lidos no `HEAD` que sustentam esta fase:

- **F11 — a dupla autorização existente é executada na decisão.**
  `approval-requests-decide_POST` trava o pedido (`FOR UPDATE`), exige
  `status = 'pendente'`, recusa autoaprovação (403), **pré-valida tudo antes** de
  mudar o status e então, **na mesma transação** da decisão, executa a ação e
  audita. Nenhuma transação espera por humano: o pedido é uma linha persistida.
- **F12 — `approval_status` já tem `expirada`** (`pendente | aprovada | rejeitada
  | expirada`) e já existe varredura que expira pedidos após
  `APPROVAL_REQUEST_EXPIRATION_DAYS` (padrão 7). **Nenhum estado novo é
  necessário.**
- **F13 — o `payload` do pedido é JSONB e o executor o lê da linha**, nunca de
  entrada do cliente na hora de aprovar (padrão a manter).
- **F14 — a regra de risco atual só cobre `ajuste` físico negativo.** Estender a
  dupla autorização a *toda* redução/estorno **contábil** é decisão de produto
  nova (P-L5/P-L6), não reaproveitamento automático.

## O. Gates P-L1 a P-L6

Estado de cada gate. **Nenhuma recomendação foi tratada como decisão.**

| Gate | Pergunta | Estado | Recomendação (não vinculante) | Se o dono alterar |
|---|---|---|---|---|
| **P-L1** | Excedente acima da necessidade permanece contabilizado? | **AINDA PENDENTE** | Sim: permanece em `fulfilled`; `surplus` derivado | "Não" exigiria **cortar** o crédito (nova regra no Modelo B congelado): reabrir a especificação |
| **P-L2** | Correction positiva pode criar excedente? | **AINDA PENDENTE** | Sim, com motivo e indicador | "Não": a validação recusa (422) correção cujo líquido passa de `needed`; o excedente só nasce do `original` |
| **P-L3** | Correction negativa pode reduzir estoque físico? | **AINDA PENDENTE** | Sim, dentro da regra de risco | "Não": correção negativa é só contábil (matriz P.4) e a divergência vai para o fluxo normal de ajuste |
| **P-L4** | Reversal é contábil por padrão, com retirada física opcional? | **AINDA PENDENTE** | Sim | "Sempre contábil": some o campo de retirada; "sempre física": reversal exige estoque suficiente (409 frequente) |
| **P-L5** | Quem pode **solicitar** reduções? | **AINDA PENDENTE** | `logistica.gerencie` solicita; segunda pessoa com `aprovacoes.decida` aprova | "Execução direta": operação síncrona, sem pedido (a seção R não se aplica; o resto vale) |
| **P-L6** | Quem pode **solicitar/autorizar** estornos? | **AINDA PENDENTE** | Idem P-L5, para **todo** estorno | idem |

Regra de gate: **a Fatia 1 não começa** com qualquer um destes em "AINDA
PENDENTE". Cada gate vira CONFIRMADA ou ALTERADA PELO DONO, por escrito e com
data, nesta tabela.

## P. Contrato físico definitivo (corrige a Fase 76)

**Não** vale mais "uma movimentação física por linha do ledger". Contrato por
tipo de linha:

- **`original`**: o recebimento físico real **pode** gerar seu movimento
  (`entrada`), criado na mesma transação (comportamento atual).
- **`reversal`**: **por padrão contábil**, sem movimento físico
  (`stock_transaction_id = NULL`). Se P-L4 permitir retirada física, a reversal
  **pode** carregar o `ajuste` negativo inverso (P.3).
- **`correction`**: **pode** gerar **um único** movimento de `ajuste`
  correspondente ao **efeito líquido** da correção.
- **Par de correção** (`reversal(vigente)` + `correction`): o efeito físico é
  realizado **uma única vez**, pela diferença, **na `correction`**; a `reversal`
  do par tem `stock_transaction_id = NULL`. Nunca "−100 físico +80 físico".

### P.1 Exemplos obrigatórios

| Caso | Ledger | Saldo da allocation | Estoque |
|---|---|---|---|
| 100 → 80 | `reversal` −100 (herdada) + `correction` +80 | **80** | **um** `ajuste` **−20** (na correction) |
| 100 → 120 | `reversal` −100 + `correction` +120 | **120** | **um** `ajuste` **+20** |
| 100 → 100, mesma unidade e mesma contabilidade | **nada** | 100 | nada; a API devolve **422** `sem_alteracao` |
| 100 → 100 com unidade diferente | ver seção Q | conforme Q | nenhum |
| Reversal total (evento inválido), `original 100` | `reversal` −100 | **0** | **nenhum** por padrão; o original permanece no histórico |

Correção sem mudança efetiva **não cria linhas**. A única mudança sem alteração
de quantidade é a reclassificação de unidade da seção Q.

### P.2 Saldo físico da allocation

`saldoFísico(allocation) = Σ stock_transactions.delta` das linhas do ledger
daquela allocation (via `stock_transaction_id`). Em `original 100` seguido de
`correction 80 (ajuste −20)`: `100 − 20 = 80`. É a única base para calcular o
ajuste líquido e a retirada de uma reversal (corrige o "delta do alvo" de B.4).

- Ajuste líquido de uma correction (mesma unidade do item):
  `Δfísico = quantidadeNova − quantidadeVigente`.
- Item físico = o do movimento do `original` (a cadeia é de **um** item; troca
  de item segue fora do escopo, T-3).

### P.3 Retirada física numa reversal (só se P-L4 permitir)

- Valor: `−saldoFísico(allocation)` **inteiro** (nunca parcial; parcial é o par).
- `saldoFísico = 0`: não há o que retirar, a reversal é contábil.
- Estoque do item `< saldoFísico`: **409** `insufficient_stock`; o caminho é o
  estorno contábil.
- Vira **um** `ajuste` negativo vinculado à `reversal` (`UNIQUE`), na mesma
  transação.

### P.4 Matriz definitiva

| Operação | Ledger | Estoque físico padrão | Estoque físico opcional |
|---|---|---|---|
| `original` | `+q` | `entrada +q` | n/a |
| `correction` positiva (↑ quantidade, mesma unidade) | `reversal(vigente)` + `correction(+novo)` (reversal omitida se a vigente não conta) | **um** `ajuste` líquido **+Δ** (não exige aprovação de estoque) | n/a |
| `correction` negativa (↓ quantidade, mesma unidade), P-L3=SIM | idem | **um** `ajuste` líquido **−Δ** (regra de risco e 409 de estoque) | n/a |
| `correction` negativa, P-L3=NÃO | idem | **nenhum** | n/a |
| `correction` só de unidade/metadado | `correction` (e `reversal` se a vigente conta) | **nenhum** | n/a |
| `reversal` | `−q` herdada | **nenhum** | se P-L4=SIM: `ajuste −saldoFísico` vinculado à reversal |

Leitura: o par **nunca** gera dois movimentos; **nenhuma** operação altera o
estoque sem `stock_transaction` vinculado; nenhum `stock_transaction_id` vem do
cliente (contrato da Fase 34).

### P.5 Quantidade e unidade na mesma operação

**Recusada (422)**: unidade e quantidade são corrigidas em operações separadas.
Com unidade diferente da do item, a quantidade não tem significado físico no
item; combinar produziria um ajuste físico ambíguo.

## Q. Reclassificação de unidade (sem ambiguidade)

- **Definição:** trocar **apenas o rótulo** da unidade da linha do ledger
  (`unit`), mantendo `quantity`. **Não** converte quantidades, **não** usa fator,
  **não** cria tabela de conversão e **não** altera a unidade do item de
  inventário.
- **Comparabilidade:** a unidade nova só se justifica se o recebimento
  **realmente** foi naquela unidade (alegação do solicitante, registrada em
  `motivo`). O sistema não decide equivalência; decide só a **contabilidade**.
- **`is_countable` recalculado:** `normalizar(unidadeNova) ===
  normalizar(unidadeDaNecessidade)` (NFD, sem acento, minúscula, como hoje).
- **Saldo da necessidade** só pela fórmula única (`needFulfillment.tsx`):

| Antes → depois | Linhas | Efeito no saldo |
|---|---|---|
| não contável → contável | só `correction` (+q) | `+q` |
| contável → não contável | `reversal(vigente)` + `correction` não contável | `−q` |
| contável → contável (mesma unidade normalizada) | **nada** (422 `sem_alteracao`) | 0 |
| não contável → não contável (outro rótulo) | só `correction` administrativa (motivo obrigatório) | 0 |

- **Estoque:** **nenhum** ajuste físico em reclassificação de unidade.
- Alterar a unidade **sem** alterar a quantidade é permitido; alterar ambas na
  mesma operação não (P.5).

## R. Fluxo assíncrono da dupla autorização (se P-L5/P-L6 confirmadas)

```
solicitar -> pendente -> segunda pessoa analisa -> aprovar | rejeitar
                                                -> (aprovar) executar na mesma decisão
                                                -> (7 dias sem decisão) expirada
```

### R.1 Princípios

- **Nenhuma transação aberta esperando aprovação.** A solicitação é uma
  transação **curta e independente** que insere uma linha em `approval_requests`
  e audita; o pedido fica persistido.
- **Nenhuma conexão do pool presa** esperando decisão humana e **nenhum lock** de
  banco como espera humana. Locks existem só dentro de cada transação curta
  (solicitar; decidir).
- A execução acontece **na transação da decisão** (padrão F11): trava, revalida,
  executa, audita, tudo ou nada.

### R.2 Estados (sem estado novo)

| Estado | Significado | Transições |
|---|---|---|
| `pendente` | solicitado, aguardando segunda pessoa | para `aprovada`, `rejeitada`, `expirada` |
| `aprovada` | decidido **e executado** na mesma transação | final |
| `rejeitada` | recusado por segunda pessoa | final |
| `expirada` | varredura existente após 7 dias | final |

"Cancelado pelo solicitante" **não** existe (estado desnecessário; bastam a
rejeição e a expiração). Pedido **obsoleto** (precondição não bate) **não** é um
estado: ver R.5.

### R.3 Imutabilidade da solicitação

Gravado em `approval_requests` na criação: `organization_id`; `action_type`
(novo, ex.: `correcao_recebimento` / `estorno_recebimento`, **sem migration**,
F9); `requested_by_user_id`; `created_at`; `reason` (motivo, `NOT NULL`); e o
`payload` JSONB com **todos** os campos que a execução usará:

`allocationId`, `targetFulfillmentId` (a vigente vista, igual a
`expectedVigenteFulfillmentId`), `operacao` (`correcao` | `estorno`),
`quantidadeAnterior`, `quantidadeNova`, `unidadeAnterior`, `unidadeNova`,
`efeitoEstoque` (`nenhum` | `ajuste`), `itemId` e `deltaFisico` (quando
`ajuste`), `isCountableResultante`.

- Nenhum endpoint altera `payload`/`action_type`/`reason`/`organization_id`/
  `requested_by_user_id` depois de criado (a única mutação permitida é a
  decisão: `status`, `decided_*`, `decision_notes`). O plano de testes prova isso.
- O executor lê **somente** o `payload` da linha. A decisão **não** aceita
  quantidade, item, unidade, allocation ou fulfillment do cliente.
- Se o estado mudou, a execução **não** vira outra operação: **falha** (R.5).

### R.4 Autoaprovação e acesso (regra de domínio, não de frontend)

| Situação | Resultado |
|---|---|
| solicitante tenta aprovar o próprio pedido | **403** (regra do executor atual; vale para o proprietário também) |
| outra pessoa com `aprovacoes.decida` | pode decidir |
| pessoa sem `aprovacoes.decida` | **403** (`requirePermission`) |
| usuário de outra organização | **403** (não é membro) |
| pedido que não pertence à organização informada | **404** (consulta filtrada por `organizationId`, padrão atual) |
| administrador da plataforma | não decide (sem membership) |

### R.5 Precondição na aprovação

Na decisão, sob os locks (seção T), o executor compara a linha vigente **atual**
com `payload.targetFulfillmentId`. Se diferente: **409** `pedido_obsoleto`;
**nada** é executado e o pedido **permanece `pendente`** (padrão "pré-valida
antes de mudar o status", F11). O aprovador pode **rejeitar** (a rejeição **não**
revalida); senão ele expira. Para refazer, o solicitante relê o histórico e cria
**novo** pedido. Idem se o estoque deixou de comportar o `deltaFisico`: **409**
`insufficient_stock`, pedido segue `pendente`.

### R.6 Execução única

`aprovada` ocorre uma vez, junto com a execução (mesma transação). Segunda
tentativa de aprovar: o pedido já não está `pendente`, então **409**
(`invalid_status`, comportamento atual). Aprovar **não** autoriza nenhuma
operação futura.

### R.7 Um pedido pendente por allocation

Sob o lock da allocation, criar pedido com outro `pendente` para a mesma
allocation resulta em **409** `ja_ha_pedido_pendente` (sem índice novo; checagem
sob lock, lendo `payload->>'allocationId'`). Operação **direta** (aumento ou
reclassificação, sem aprovação) continua possível e torna o pedido pendente
**obsoleto** (R.5).

### R.8 O que a aprovação autoriza

- **Redução:** exatamente a operação do `payload` (quantidade nova, unidade,
  item, `deltaFisico`, allocation, fulfillment). Se há `ajuste` físico, a
  **mesma aprovação** o cobre; **não** há segundo pedido de estoque.
- **Reversal com retirada física:** o `payload` contém quantidade
  (`saldoFísico`), item, unidade, allocation e fulfillment. A execução **não pode
  alterar** nenhum deles; um `saldoFísico` recalculado diferente do do payload
  resulta em 409 `pedido_obsoleto`.
- Autor registrado nas linhas/movimentos criados = **solicitante** (padrão do
  ajuste aprovado); o aprovador fica em `decided_by_user_id` e na auditoria.

### R.9 Se o dono alterar P-L5/P-L6

"Execução direta": as mesmas validações e locks (seção T), mas na própria
requisição, sem `approval_requests`; auditoria com um evento só (seção U). O
restante da especificação não muda.

## S. Precondição `expectedVigenteFulfillmentId` (controle otimista de estado)

**Não é idempotência.** É *controle otimista de estado / proteção contra retry
obsoleto*. Não deduplica requisições; recusa operação baseada em estado antigo.

- **Onde entra:** campo obrigatório no corpo da operação de correção/estorno (o
  cliente envia a linha vigente que viu). No fluxo com aprovação vira
  `payload.targetFulfillmentId`, a **referência imutável** da aprovação.
- **Quando é validada:** (1) na **solicitação**, sob o lock da allocation; (2) na
  **decisão**, sob os locks, contra o `payload`. Nunca contra dado novo do
  cliente.
- **Erro:** **409** `recebimento_alterado` (solicitação) / `pedido_obsoleto`
  (decisão), com corpo sem dado de outra organização.
- **Pedido pendente:** **expira** pela varredura existente (7 dias) e fica
  obsoleto antes se a vigente mudar (R.5).
- **Cliente:** em qualquer 409 deve **reler o histórico** do recebimento antes de
  tentar de novo; nunca reenviar às cegas.
- **Retry após sucesso:** a vigente já mudou, logo 409; nada duplica; a resposta
  original **não** é repetida (limitação consciente, P-L12).

## T. Concorrência da aprovação

Ordem global (inalterada de G.1; compatível com a decisão atual, que trava o
pedido primeiro): **`approval_requests` → `opportunity_allocations` → `needs` →
`inventory_items` (id crescente) → linhas do ledger da allocation (id crescente)
→ auditoria**. A solicitação segue a mesma ordem sem o 1º passo.

| Cenário | O que acontece | Resultado |
|---|---|---|
| **A** solicitante cria redução | transação curta, pedido `pendente`, auditoria | nenhum lock retido depois do commit |
| **B** outro usuário aprova | trava pedido, allocation, …; revalida; executa; `aprovada` | sucesso |
| **C** entre A e B outra operação muda a vigente | B revalida e vê `targetFulfillmentId ≠ vigente` | **409** `pedido_obsoleto`; pedido segue `pendente`; solicitar de novo |
| **D** dois usuários aprovam o mesmo pedido | ambos pedem `FOR UPDATE` no pedido; o segundo, ao ganhar o lock, vê `status ≠ pendente` | só **uma** decisão vence; a outra recebe **409** |
| **E** aprovação × reversal concorrente (direta ou de outro pedido) | ambas serializam no lock da **allocation**; quem entra depois relê a vigente | a perdedora recebe **409** consistente (`pedido_obsoleto` ou `recebimento_alterado`) |

Provas determinísticas com **lock externo** (como nas Fases 73/74), mais
controle negativo removendo o lock da allocation. Nenhum lock é segurado entre a
solicitação e a decisão.

## U. Auditoria (um evento por fato, sem duplicar)

Padrão `dominio.acao_participio`:

| Fato | Evento | Observação |
|---|---|---|
| solicitação criada | `atribuicao.recebimento_pendente_aprovacao` | `approvalRequestId`, `operacao`, `allocationId` |
| execução (direta **ou** via aprovação) | `atribuicao.recebimento_corrigido` / `atribuicao.recebimento_estornado` | **um** evento; na via aprovada acrescenta `approvalRequestId` e `solicitanteUserId`; `actorUserId` = quem executou/aprovou |
| rejeição | `aprovacao.rejeitada` (existente) | sem evento novo |
| expiração | `aprovacao.expirada` (existente) | sem evento novo |

**Não** existe evento separado de "aprovação": a aprovação **é** a execução
(F11), logo um evento só. Metadata: apenas ids e números, `motivo` curto e ids de
usuário (nunca e-mail, nome, senha, token, JWT, cookie). Recusas (403/404/409/422)
**não** geram evento.

## V. Prestação de contas: o que o usuário vê

Nunca esconder o `original`; nunca reduzir o histórico a "saldo atual".

| Item | Rótulo na tela/relatório |
|---|---|
| `original` | **Recebimento** (quantidade, unidade, data, quem) |
| `correction` | **Correção** (valor novo, unidade, motivo, quem, quando) |
| `reversal` | **Estorno** (quantidade anulada, motivo, quem, quando) |
| pedido de aprovação | **Evento administrativo** ("Solicitado por X em …; decidido por Y em …"; "Rejeitado" / "Expirado"), separado das linhas contábeis |

Ordenado por tempo, cadeia visível, líquido **ao lado** (nunca no lugar). Ver
também a seção J.

## W. Necessidade e matching (confirmados, sem alteração)

- `fulfilled` = soma líquida das linhas **countable** (fórmula única em
  `needFulfillment.tsx`); `requiredRemaining = max(0, needed − fulfilled)`;
  `surplus = max(0, fulfilled − needed)`.
- `needs.status` continua **administrativo e independente**; um estorno pode
  gerar `requiredRemaining > 0` numa necessidade `atendida` (aviso, sem reabrir).
- Matching 1.4: `requiredRemaining > 0` (com `needs.status = 'aberta'`) é o
  **único** gatilho relacionado a progresso; `ALGORITHM_VERSION = 1.4`
  permanece; a necessidade volta a ser considerada no próximo sweep; o lifecycle
  da oportunidade anterior **não** reabre.

## X. P-L7 a P-L13 (decisão × recomendação × adiamento)

Nenhuma delas é "decisão do dono" ainda. A tabela separa recomendação de
adiamento consciente.

| ID | Tema | Estado | Conteúdo |
|---|---|---|---|
| P-L7 | Unidade | **Recomendação** (padrão seguro; seção Q) | só reclassificação, sem conversão |
| P-L8 | Depois de `atendida` | **Recomendação** | permitido; status não muda; aviso |
| P-L9 | Depois de oportunidade `concluída` | **Recomendação** + limitação registrada | permitido; lifecycle não reabre |
| P-L10 | Prazo | **Recomendação** | sem prazo rígido |
| P-L11 | Transferir crédito entre necessidades | **Adiamento consciente** | fora; exigiria mudar o Modelo B (F2) |
| P-L12 | Idempotência persistente | **Adiamento consciente** | só controle otimista (seção S) |
| P-L13 | Motivo obrigatório | **Recomendação** | sim, curto, sem dado pessoal |

## Y. Plano de testes futuro (nenhum implementado)

Postgres real, sem mocks.

1. **Correction** 100→80 e 100→120: linhas (`reversal` + `correction`), saldo e
   **um** movimento físico (−20/+20); `reversal` do par com
   `stock_transaction_id NULL`.
2. **Reversal** total: original intacto; saldo 0; sem movimento por padrão; com
   retirada (se P-L4): `ajuste −saldoFísico` vinculado; `UNIQUE` impede reuso.
3. **Correction positiva** sem aprovação de estoque; **negativa** dentro/acima da
   regra de risco; `insufficient_stock` 409; estoque nunca negativo.
4. **Correção sem mudança** (100→100): 422 `sem_alteracao`, zero linhas.
5. **Unidade:** todos os casos da tabela Q; unidade+quantidade juntas dão 422;
   nenhum ajuste físico; sem conversão.
6. **Excedente:** 500 com 650 dá `surplus 150`; estorno para 450 dá `remaining
   50`; correção acima do necessário (P-L2).
7. **Aprovação:** fluxo solicitar→decidir; payload imutável (nenhuma rota o
   altera); execução com os dados do payload, não do cliente; `expirada` não
   executa; `rejeitada` não executa e **não** revalida.
8. **Autoaprovação:** solicitante dá 403 (inclusive proprietário); sem
   `aprovacoes.decida` dá 403; outra organização 403/404; plataforma recusada.
9. **Retry/precondição:** reenvio após sucesso dá 409 sem duplicar; vigente
   mudada dá 409 `recebimento_alterado`; aprovação obsoleta dá 409
   `pedido_obsoleto` com pedido ainda `pendente`; segunda aprovação dá 409;
   segundo pedido pendente na allocation dá 409.
10. **Concorrência:** cenários A–E da seção T e 1–6 de G.2, com `Promise.all` e
    lock externo; sem deadlock; controle negativo; nenhuma transação aberta entre
    solicitar e decidir (verificar `pg_stat_activity`).
11. **Estoque:** o par nunca gera dois movimentos; o saldo físico da allocation
    bate com os `delta`; estoque nunca negativo.
12. **Auditoria:** um evento por fato (sem evento "aprovação" separado); metadata
    sem e-mail/token/senha; recusas sem evento; cadeia de hash íntegra.
13. **Matching:** a necessidade volta a `requiredRemaining > 0` após estorno e
    entra no próximo sweep; `ALGORITHM_VERSION` 1.4; lifecycle antigo intacto.
14. **Prestação de contas:** `original`, `correction`, `reversal` e evento
    administrativo aparecem; a linha original nunca some; líquido ao lado.

## Z. Veredito da Fase 77

**BLOQUEADA SOMENTE POR DECISÃO DE PRODUTO.** O contrato físico, a matriz, o
fluxo assíncrono, a precondição, a concorrência e a auditoria estão fechados e
sem ambiguidade. **P-L1 a P-L6 permanecem AINDA PENDENTES** porque nenhuma
resposta do dono foi registrada. A Fatia 1 não é implementada antes disso.

---

## AA. Fase 78 — Fatia 1 implementada (histórico, correção, estorno contábil, dupla autorização)

Baseline `28d4e3d`. **Sem migration** (o schema e o trigger atuais bastam;
`approval_requests.action_type` é `TEXT`). Matching 1.4, `need_resolutions`,
lifecycle, `stock_transactions` e Modelo B **não foram tocados**. **Nenhum novo
movimento físico é criado** (efeito físico = Fatia 2).

### AA.1 Gates confirmados pelo dono (brief da Fase 78, 2026-10-03)

| Gate | Estado |
|---|---|
| P-L1 excedente permanece contabilizado | **CONFIRMADA** (SIM) |
| P-L2 correction positiva pode criar excedente | **CONFIRMADA** (SIM) |
| P-L3 correction negativa pode reduzir estoque físico | **CONFIRMADA** (SIM) — implementação na Fatia 2 |
| P-L4 reversal contábil por padrão, retirada física opcional | **CONFIRMADA** (SIM) — implementação na Fatia 2 |
| P-L5 quem solicita reduções | **CONFIRMADA**: `logistica.gerencie`; aprovação por segunda pessoa com `aprovacoes.decida` |
| P-L6 estornos | **CONFIRMADA**: solicitante `logistica.gerencie`, aprovador `aprovacoes.decida` (outra pessoa) |

### AA.2 Endpoints (nomes reais) e permissões

| Endpoint | Método | Permissão | Resposta |
|---|---|---|---|
| `allocations-receipt-history` | GET | membro ativo + `logistica.leia` | histórico completo + token + progresso + pedido pendente + `viewer` |
| `allocations-receipt-correct` | POST | `logistica.gerencie` | 200 `executada` (aumento/reclassificação) ou 202 `pendente_aprovacao` (redução) |
| `allocations-receipt-reverse` | POST | `logistica.gerencie` | sempre 202 `pendente_aprovacao` |
| `approval-requests-decide` (existente, estendido) | POST | `aprovacoes.decida` | executa `correcao_recebimento` / `estorno_recebimento` na decisão |

Código: `src/helpers/needFulfillmentCorrections.tsx` (helper canônico da linha
vigente, planejamento, execução, auditoria e respostas de erro);
`src/components/ReceiptHistoryPanel.tsx` (UI, na tela de Atribuições).

### AA.3 Regras finais (e esclarecimentos sobre a especificação)

- **Linha vigente:** cadeia linear a partir do `original`; se a linha atual tem
  uma `correction` apontando para ela, a cadeia segue para a correction (com ou
  sem a `reversal` do par). Nunca `MAX(created_at)` (o par tem o mesmo instante).
- **Token de precondição (`expectedVigenteFulfillmentId`) — esclarecimento:** é
  o id da linha vigente quando a cadeia está **ativa** e o id da **reversal**
  quando está **estornada**. Assim, qualquer operação que mude o estado da
  cadeia muda o token (um estorno não deixaria o id da linha igual). A
  `correction` que "desfaz um estorno" aponta internamente para a linha estornada.
- **Quando exige aprovação:** todo estorno; e toda correção que **diminui a
  quantidade registrada** ou **diminui o efeito contado** (contável → não
  contável). Aumento, reclassificação e "desfazer estorno" executam direto.
- **`sem_alteracao` (422):** mesma quantidade e mesma unidade normalizada
  (exceto "desfazer estorno", que pode repetir os valores). **Quantidade e
  unidade juntas (422 `quantidade_e_unidade_juntas`).**
- **Os quatro casos de `is_countable`:** não contável→contável (só `correction`,
  +q); contável→não contável (par, −q, exige aprovação); contável→contável (mesma
  unidade normalizada: `sem_alteracao`); não contável→não contável (só
  `correction` administrativa, sem efeito).
- **Motivo:** o ledger não tem coluna de motivo e **não foi alterado**; o motivo
  vive na auditoria (um evento por operação, com `fulfillmentIds`) e em
  `approval_requests.reason`/`payload.motivo`; o histórico o recompõe da
  auditoria da mesma organização.
- **Pedido pendente:** no máximo um por allocation, checado **sob o lock da
  allocation** (409 `pedido_pendente`). Operação direta continua possível e
  torna o pedido pendente obsoleto.
- **`payload` do pedido** (imutável): organização, allocation,
  `targetFulfillmentId` (token), `headState`, `alvoLinhaId`, operação,
  quantidade/unidade anterior e nova, `isCountableResultante`,
  `efeitoEstoque: "nenhum"`, `deltaFisicoPlanejado` e `itemId` (**só
  planejamento para a Fatia 2; nada é executado**), `motivo`, `solicitadoEm`;
  solicitante em `requested_by_user_id`, data em `created_at`.
- **Expiração:** mecanismo existente (7 dias). Pedido `expirada` não pode ser
  aprovado; pedido velho ainda não varrido também não (409 `pedido_expirado`,
  verificado na decisão para os tipos do ledger). O ledger não é alterado.

### AA.4 Erros (HTTP / `code` estável)

| HTTP | `code` | Quando |
|---|---|---|
| 400 | (validação Zod) | motivo curto/longo, id malformado, quantidade inválida, sem quantidade/unidade |
| 403 | — | sem permissão, não-membro, membro inativo, **autoaprovação** |
| 404 | `atribuicao_nao_encontrada` | allocation de outra organização (IDOR) ou pedido de outra organização |
| 409 | `recebimento_alterado` | token desatualizado na solicitação (devolve o token atual) |
| 409 | `pedido_obsoleto` | token/estado mudou até a decisão; nada executa; o pedido segue `pendente` |
| 409 | `pedido_pendente` | já há pedido pendente nesta allocation |
| 409 | `ja_estornado` | estornar o que já está estornado |
| 409 | `nao_recebida` | allocation sem recebimento |
| 409 | `pedido_expirado` / (status ≠ pendente) | pedido vencido / já decidido (aprovação duplicada) |
| 409 | `insufficient_stock` / `payload_invalid` | payload adulterado ou item inexistente (caminho existente) |
| 422 | `sem_alteracao`, `quantidade_e_unidade_juntas`, `sem_dados` | correção sem efeito / combinação ambígua |

### AA.5 Auditoria e locks

- Eventos: `atribuicao.recebimento_pendente_aprovacao` (solicitação),
  `atribuicao.recebimento_corrigido` / `atribuicao.recebimento_estornado`
  (**um** evento na execução, direta ou aprovada; na aprovada traz
  `approvalRequestId` e `solicitanteUserId`), `aprovacao.rejeitada`,
  `aprovacao.expirada` (existentes). Metadata: ids, quantidades, excedente
  (antes/depois), `efeitoEstoque: "nenhum"` e `motivo`; sem e-mail/token.
- Ordem de locks: `approval_requests` (só na decisão) → `opportunity_allocations`
  → `needs` → (itens: não há nesta fatia) → linhas do ledger (id crescente) →
  auditoria por último. Nenhuma transação espera por humano.

### AA.6 Testes e limites conhecidos

- `test/needFulfillmentCorrections.test.ts` (44 testes, Postgres real,
  inclui `Promise.all` e **provas determinísticas com lock externo
  `FOR NO KEY UPDATE`** — `FOR UPDATE` seria inócuo, pois o `INSERT` do ledger
  já toma `FOR KEY SHARE` na allocation pela FK). Controle negativo executado:
  sem os locks da allocation e do ledger, as provas determinísticas falham.
- Limites: o efeito físico (P-L3/P-L4) é a Fatia 2; a seção "Atendimento por
  necessidade" da Prestação de Contas é a Fatia 3; o histórico mostra o `original`
  e a cadeia, mas não redesenha o relatório.

## AB. Fase 79 — fechamento das ressalvas da Fase 78

- **Estado dos gates:** P-L1 a P-L6 **confirmadas** (seção AA.1). **Fatia 1
  implementada e checkpointada.** **Fatia 2 (efeito físico, P-L3/P-L4) ainda
  pendente** — nenhuma `stock_transactions` é criada por correção/estorno.
- **`recebimento_alterado` na UI (validado em preview real):** o operador abre
  o histórico e o diálogo de correção (token carregado), outra pessoa altera a
  linha vigente, e ao concluir a operação obsoleta a API responde
  `409 recebimento_alterado`; a tela mostra "O recebimento foi alterado por
  outra operação. Recarregue o histórico antes de tentar de novo.", fecha o
  diálogo e **recarrega o histórico** (a operação antiga não é executada). É o
  mesmo mecanismo do `pedido_obsoleto` (`STALE_CODES` em
  `ReceiptHistoryPanel.tsx`). Verificado em desktop e em 375 px, sem overflow;
  sem overflow também em 390, 768 e 1280.
- **`payload_invalid` do ledger:** a decisão de um pedido do ledger com payload
  inválido continua `409` e com corpo só `{ message }`, mas a mensagem agora é a
  do domínio ("os dados da correção ou do estorno do recebimento são inválidos
  …") em vez de "item de inventário não encontrado" (que continua só para o
  ajuste de estoque). Não vaza o payload (teste cobre).
- **Dívida técnica herdada (não é blocker):** erros de validação Zod devolvem a
  mensagem bruta do `ZodError` ao cliente (`buildErrorResponse`, comportamento
  anterior à Fase 78). **Não foi alterado**; uma refatoração global fica para
  uma fase própria.

## AC. Fase 80 — Fatia 2 implementada (efeito físico no estoque)

Baseline `97f2e72`. **Sem migration.** Matching 1.4, `need_resolutions`, lifecycle
e Modelo B intocados. A seção AA.3 ("nenhum movimento físico") vale só para a
Fatia 1; **esta seção prevalece** para o efeito físico.

### AC.1 Contrato físico implementado

- **Um único `ajuste`** (`stock_transactions.type = 'ajuste'`, delta com sinal,
  nunca 0), criado **na mesma transação** do ledger, **antes** das linhas do ledger
  e com a auditoria por último. Qualquer falha desfaz tudo (testado: falha injetada
  no ledger depois do movimento, e na auditoria).
- **Base do cálculo = saldo físico real da allocation:** soma dos `delta` dos
  movimentos efetivamente ligados às linhas do ledger dela (nem toda linha tem
  movimento). Nunca a quantidade da linha.
- **Correção de quantidade** (mesma unidade do item): `delta = novo − saldo físico`.
  100→80 = `−20`; 100→120 = `+20`; 80→120 depois de 100→80 = `+40`. Nunca "saída
  100 + entrada 80". Vai na `correction`; a `reversal` do par fica sem movimento.
  `delta = 0` (ex.: 100→100) = nenhuma operação.
- **Correção só de unidade, ou de linha cuja unidade ≠ unidade do item:** sem
  movimento (sem conversão); `inventory_items.unit` nunca muda.
- **Estorno:** contábil por padrão (nenhum movimento). Com `withdrawStock: true`
  (opt-in, P-L4): um `ajuste` de `−saldo físico real` **inteiro**, ligado à
  **reversal**. Linha com unidade ≠ unidade do item ⇒ 422 `unidade_incompativel`;
  saldo físico ≤ 0 ⇒ 422 `sem_saldo_fisico` (defensivo: só alcançável com dado
  anômalo, pois uma cadeia estornada não aceita novo estorno).
- **"Desfazer estorno"** parte do saldo físico que ficou (estorno contábil ⇒
  100→150 = `+50`; depois de retirada física ⇒ repõe pelo delta).
- **Aprovação:** todo delta físico **negativo** exige segunda pessoa (inclusive
  "desfazer estorno" para menos que o saldo físico) — mais estrito que o limiar
  de risco do ajuste direto (≥20 ou ≥30%), então **não há regra paralela nem
  segundo pedido**: a mesma aprovação autoriza ledger + movimento. Positivo
  executa direto.
- **Estoque insuficiente:** `409 insufficient_stock` (mesma mensagem do estoque
  existente; nas rotas de solicitação também com `code`). Nada é criado; na
  decisão o pedido continua `pendente` (e rejeitável).
- **Pedido da Fatia 1** (`payload.efeitoEstoque = "nenhum"`) aprovado depois
  executa **só o contábil**, como foi autorizado.

### AC.2 Payload e imutabilidade

`payload` passa a carregar `efeitoEstoque` (`nenhum`|`ajuste`),
`deltaFisicoPlanejado` (= o executado), `itemId`, `retiradaFisica`,
`saldoFisicoAllocation`. Na decisão o plano é **recalculado sob os locks** e
precisa reproduzir exatamente item, delta, saldo físico e retirada do payload;
senão `409 pedido_obsoleto`, sem executar (testado com delta e item adulterados).
Nada de quantidade, item ou unidade vem do cliente na decisão.

### AC.3 Locks e o deadlock encontrado

Ordem: `approval_requests` → `opportunity_allocations` → `needs`
(**`FOR NO KEY UPDATE`**) → `inventory_items` (`FOR UPDATE`) → linhas do ledger →
auditoria. **Achado real:** com `needs FOR UPDATE` antes do lock do item, uma
decisão física concorrente com um recebimento do mesmo item **deu deadlock** (o
recebimento trava o item e depois toma `FOR KEY SHARE` na need pela FK do
ledger; o `FOR UPDATE` da need conflita com isso). `FOR NO KEY UPDATE` não
conflita com `KEY SHARE`. Coberto por teste determinístico (segurar a need em
`FOR KEY SHARE` não pode bloquear a decisão) e por rajada; controles negativos
executados (reverter o lock da need ou remover o lock do item faz os testes falharem).

### AC.3b Histórico e UI

`allocations-receipt-history` devolve, por linha, `stockTransactionId` e
`physicalDelta`, e no topo `item` (id, nome, unidade, saldo atual) e
`physicalBalance`. A tela mostra o efeito em cada linha ("Estoque: −20 kg",
"Estorno só contábil: o estoque físico não foi alterado"), a prévia física no
diálogo de correção e a opção "Retirar também do estoque físico" no estorno
(desmarcada por padrão). Prestação de contas: **sem redesign**; os `ajuste`
entram na fonte existente (`ajustes`/`netChange` do `impact-report`, testado).

### AC.4 Estado

Fatia 1 e Fatia 2 implementadas. **Fatia 3** (seção "Atendimento por
necessidade" na Prestação de Contas) continua pendente. Limites: troca de item
físico, conversão de unidades e chave de idempotência persistente seguem fora.

## AD. Fase 81 — revisão formal dos locks da need (e dois esclarecimentos)

### AD.1 Matriz real de locks (lida do código, não assumida)

Ordem global: `organização → allocation → need → item → ledger → auditoria`.
"—" = o fluxo não toca/trava aquela etapa. `KS` = `FOR KEY SHARE` (o que uma FK toma).

| Fluxo | Organização | Allocation | Need | Item | Ledger | Auditoria |
|---|---|---|---|---|---|---|
| `allocations-receive` | — | `FOR UPDATE` | — (só **KS**, pela FK do `INSERT` do ledger) | `FOR UPDATE` | `INSERT` (FK: KS em allocation/stock_tx) | advisory, último (antes dele: `FOR UPDATE` da oportunidade em `concludeOpportunity`) |
| `needs-status` | — | — | **`FOR NO KEY UPDATE`** (era `FOR UPDATE`) | `FOR UPDATE` (só se dá baixa) | — | último |
| correção / estorno (solicitação) | — | `FOR UPDATE` | **`FOR NO KEY UPDATE`** | `FOR UPDATE` | linhas `FOR UPDATE` (id crescente) + `INSERT` | último |
| decisão de aprovação do ledger | pedido `FOR UPDATE` (1º) | `FOR UPDATE` | **`FOR NO KEY UPDATE`** | `FOR UPDATE` | idem | último |
| `stock-transactions` / decisão de ajuste | (pedido `FOR UPDATE`) | — | — | `FOR UPDATE` | — | último |
| matching (`runMatchingForOpportunity`) | — | — | só lê (sem lock); `INSERT` de allocation/avaliação → KS | — | — | último |
| `allocations-decide` / `-logistics` | — | `FOR UPDATE` | — | — | — | último |

Nenhum fluxo trava a organização nestes caminhos (a trava da organização é só do
ciclo de membros). Nenhuma ordem contraria `allocation → need → item → ledger`.

### AD.2 Por que `FOR NO KEY UPDATE` é suficiente

Modos de lock de linha do Postgres: `KEY SHARE` < `SHARE` < `NO KEY UPDATE` < `UPDATE`.
`FOR NO KEY UPDATE` conflita com `FOR UPDATE`, com outro `NO KEY UPDATE`, com
`SHARE` e com qualquer `UPDATE` comum da linha (é o modo que um `UPDATE` que não
muda a chave já toma). **Só não conflita com `KEY SHARE`**, que é exatamente o que
a FK do ledger toma na need ao inserir uma linha. Logo:

- duas mutações incompatíveis na need (duas correções, correção × `needs-status`,
  correção × edição da need) **continuam serializadas** — provado em teste (a
  tentativa de outro `NO KEY UPDATE`, `FOR UPDATE` e `UPDATE` comum espera; só o
  `KEY SHARE` passa);
- `needs-status` continua serializado consigo mesmo (a proteção da Fase 35 contra
  baixa em dobro): os testes dela seguem verdes;
- a FK do ledger pode adquirir sua proteção sem esperar a correção — e é essa espera
  que fechava o ciclo (A: need → item; B: item → FK → need).

O recebimento não precisa de proteção contra a correção na need (ele só lê
`unit`, sem lock, e depende da allocation/item, que continuam travados).

### AD.3 Achado: o mesmo ciclo existia em `needs-status`

O ciclo não era só da Fatia 2: `needs-status` (need `FOR UPDATE` → item `FOR UPDATE`,
na baixa de estoque) × recebimento (item → FK → need) já deadlocava **no HEAD
anterior**, reproduzido com o endpoint real (40P01). Correção mínima: o mesmo
`FOR NO KEY UPDATE` na leitura da need de `needs-status_POST.ts`, pelas mesmas
razões de AD.2. Coberto por teste determinístico de fluxo real e por rajada.

### AD.4 Provas

`test/ledgerLockOrder.test.ts`: (1) o ciclo A/B reproduzido em SQL puro —
com `FOR UPDATE` exatamente um fluxo recebe `40P01`; com `NO KEY UPDATE` os dois
concluem; (2) a matriz de conflitos de AD.2; (3) fluxos reais (decisão física,
correção direta, estorno físico, `needs-status`) contra um recebimento "no meio";
(4) rajadas de 12 rodadas (aprovação × recebimento; `needs-status` × recebimento ×
aprovação). Controles negativos: reverter o lock da need (correção) ou
(`needs-status`) para `FOR UPDATE` faz as provas falharem com `40P01`; o código foi
restaurado e o hash conferido.

### AD.5 Correções ao que a Fase 80 registrou

- **`sem_saldo_fisico` é alcançável por estados legítimos** (a seção AC.1 o
  chamava de defensivo): retirada física → "desfazer estorno" só trocando a
  unidade (sem estoque) → voltar a unidade do item → nova retirada física. Tem
  teste de API; o ramo permanece.
- **O histórico não "fecha ao recarregar":** a tela mantém **um painel aberto por
  vez** (`expandedReceiptId`); abrir outro fecha o anterior. Comportamento herdado
  da Fatia 1, não um defeito de recarga.

## AE. Fase 82 — reconciliação final da Fatia 2 e preparação da Fatia 3

Somente documentação. Checkpoint verificado: `943cd3b` (pai `97f2e72`).

### AE.1 Contagem real de testes (execuções reais do Vitest em worktree limpo)

| Commit | Arquivos | Testes | Diferença | De onde vem |
|---|---:|---:|---:|---|
| `28d4e3d` | 46 | **460** | — | baseline da Fase 73 |
| `97f2e72` | 47 | **504** | +44 | `needFulfillmentCorrections.test.ts` (novo, 44; a Fase 79 só ajustou um teste existente) |
| `943cd3b` | 49 | **543** | +39 | `needFulfillmentPhysical.test.ts` (novo, **31**) + `ledgerLockOrder.test.ts` (novo, **8**) |

Decomposição por fase: Fase 80 = +30 (534 no total; o arquivo físico tinha 30
testes); Fase 81 = +8 (`ledgerLockOrder.test.ts`) **+1** (`sem_saldo_fisico`, no
arquivo físico, que passou a ter 31) = **+9** → 543. O total correto sempre foi
**543**; o erro foi de redação no relatório da Fase 81, que descreveu os "+9"
como "9 em `ledgerLockOrder` e mais 1" (isso daria 544, mas `ledgerLockOrder` tem
**8** testes). Três testes do arquivo da Fatia 1 foram **editados** (não
adicionados) na Fase 80, porque a semântica física mudou. `vitest list` não serve
como contagem (devolve 6 a menos nos três commits: 454/498/537); vale a execução.

**Estabilidade:** em `943cd3b` a suíte completa foi executada 4 vezes: 3 deram
543/543 e **1 deu 542/543 com um teste falhando**, cujo nome **não foi capturado**
(o filtro da saída descartou o detalhe) e que não reproduziu em 3 execuções
completas seguintes nem em 6 rodadas isoladas dos 4 arquivos sensíveis a
concorrência (100/100 em todas). Causa **não identificada**; o suspeito natural são
as provas determinísticas com `sleep` sob carga de CPU. Fica registrado como
**intermitência não explicada**, a investigar capturando a saída completa na
próxima falha.

### AE.2 Locks (confirmação, sem reabrir o código)

`needs-status_POST` e a correção/estorno físico usam `FOR NO KEY UPDATE` na need;
a FK do ledger toma `FOR KEY SHARE`; as provas de concorrência (`ledgerLockOrder`,
`needFulfillmentPhysical`) e os testes da Fase 35 (`needsStatus`) passam. A mudança
em `needs-status_POST.ts` foi uma **correção necessária de um deadlock
pré-existente** (need `FOR UPDATE` → item × recebimento: item → FK → need), descoberto
durante a revisão da ordem de locks e reproduzido com o endpoint real antes da
correção (seção AD).

### AE.3 Estado final da Fatia 2

**Concluídos:** correção física (positiva e negativa, um `ajuste` pelo delta sobre
o saldo físico real da allocation); estorno contábil; estorno físico opcional;
atomicidade ledger + estoque; estoque insuficiente; concorrência e ordem de locks;
auditoria; isolamento por organização; UI desktop e mobile.
`need_fulfillments` (Modelo B) **permanece estruturalmente congelado** — nenhuma
migration, coluna ou constraint foi alterada nas Fatias 1 e 2.

### AE.4 Dívidas conhecidas (não bloqueiam)

- Mensagens brutas de validação Zod chegam ao cliente (`buildErrorResponse`).
- Enforcement automático da ordem de locks (hoje: matriz da seção AD + testes).
- A tela de Atribuições mantém um painel de histórico aberto por vez (comportamento
  herdado da Fatia 1) e as listas recarregam após cada ação.
- Intermitência de um teste de suíte completa (AE.1).

### AE.5 Superfície atual da Prestação de Contas (auditoria para a Fatia 3; nada implementado)

Arquivos: `impact-report_GET.ts` (+ schema) e a página
`organizacoes.$organizationId.prestacao-contas.tsx` (178 linhas).

- **O que aparece hoje** (tudo lido de `stock_transactions`, `needs` e `audit_log`):
  cartões (necessidades cadastradas, atendidas, "Recebimentos registrados",
  eventos de auditoria); tabela "Movimentação de estoque por item" (entradas,
  saídas, ajustes, saldo no período, saldo atual); lista "Doações recebidas no
  período".
- **Como os movimentos físicos entram:** a tabela agrupa por item e tipo — os
  `ajuste` das Fatias 1/2 aparecem **somente** na coluna "Ajustes" (e no saldo
  líquido); a lista "Doações recebidas" e o cartão "Recebimentos registrados"
  filtram `type = 'entrada'` — portanto uma **correção positiva** (`ajuste +`) e uma
  **retirada física** (`ajuste −`) **não** aparecem como linhas nem nas contagens.
- **O ledger contábil (`need_fulfillments`) não é lido por esse relatório:** não há
  atendido/faltante/excedente por necessidade, nem original × correção × estorno,
  nem ligação com a allocation. Correções e estornos **só contábeis** são
  invisíveis ali.
- **Filtros:** apenas período (início/fim; padrão: do dia 1º do mês até hoje), sobre
  `created_at`. Há botão de impressão e folha de estilo de impressão. Acesso:
  `relatorios.leia` (proprietário/administrador) — mais restrito que o histórico do
  recebimento (`logistica.leia`).
- **Desktop/mobile:** a tabela já está num contêiner com rolagem horizontal
  (`tableScroll`); não há media query responsiva além da de impressão; o relatório
  não foi verificado em 375/390/768 nesta fase.
- **Desempenho:** hoje são ~8 consultas sequenciais (sem N+1 por linha). O ledger
  tem os índices necessários: `(organization_id, created_at DESC)`,
  `need_id` e `(allocation_id, created_at)`. Para o líquido por necessidade, o
  padrão a reutilizar é o agrupamento em lote de
  `getNeedFulfillmentBalanceBatch` (usado por `needs_GET`) — nunca um cálculo por
  necessidade em laço.

**O que a Fatia 3 precisa mostrar (a especificar):** por necessidade — recebido
original, correções (com sinal), estornos, **líquido** (`fulfilled` = fórmula única
de `needFulfillment.tsx`), necessário, faltante e **excedente**; cada correção e
estorno como linha própria (data, autor, motivo da auditoria, efeito físico,
ligação com o movimento de estoque), o `original` **sempre visível** (nunca
substituído pelo líquido); pedidos de aprovação como evento administrativo. Decidir
na especificação: líquido **acumulado** versus **no período**, e se a lista
"Doações recebidas" passa a incluir as correções físicas positivas.
**Restrição:** a Fatia 3 trabalha sobre dados já existentes — **sem** alterar o
ledger, o schema nem as regras para atender à UI.

## AF. Fase 83 — causa da intermitência (542/543) e fechamento

**Resultado: reproduzida, causa identificada, era um defeito do TESTE (não do
código de produção, nem do ambiente).**

### AF.1 Reprodução

Sequência de execuções completas em `943cd3b` com saída integral e relatório JSON
(log fora do Git), parando na primeira falha:

| Execução | Resultado | Teste que falhou |
|---:|---|---|
| 1 | 543/543 | — |
| 2 | 543/543 | — |
| 3 | **542/543** | `needFulfillmentPhysical.test.ts` › "caso 4: duas reversals físicas concorrentes — um pedido só; decisões concorrentes executam uma vez" |

A falha: `expect([d1.status, d2.status].sort()).toEqual([200, 409])` recebeu
`[200, 403]`. Isolado (só esse teste, sem os outros arquivos), reproduziu 1 vez em
24 execuções, com o mesmo `[200, 403]` — logo não depende da combinação de arquivos
nem de estado deixado por outro teste. As seis rodadas e as três execuções
completas anteriores (Fase 82) passaram porque a falha exige uma coincidência de
duas corridas aleatórias.

### AF.2 Causa

O teste disputava o pedido entre `operador` e `admin` (quem chega primeiro cria o
pedido; o outro recebe 409) e depois escolhia dois decisores **assumindo** quem era
o solicitante. Quando o `admin` ganhava a corrida do pedido, os dois decisores
concorrentes passavam a ser o proprietário e **o próprio solicitante (admin)**. A
decisão do solicitante então resulta em **403 (autoaprovação)** se ele trava o pedido
primeiro, ou **409 (já decidido)** se o proprietário trava primeiro — a verificação de
status vem antes da de autoaprovação. O resultado esperado `[200, 409]` só valia numa
das ordens.

Prova do mecanismo (experimento descartável, não commitado): 30 rodadas com o
**admin como solicitante** decidindo ao mesmo tempo que o proprietário: o
proprietário recebeu 200 nas 30; o solicitante nunca recebeu 200; o par de status foi
`[200, 409]` em 19 e `[200, 403]` em 11. **O código de produção está correto em todas
as ordens** (o solicitante nunca aprova; só uma decisão executa); o que variava era a
premissa do teste.

### AF.3 Correção (somente no teste)

Os dois que disputam o pedido passam a ser dois **operadores** (sem
`aprovacoes.decida`) e os dois decisores são o **administrador e o proprietário**,
que não podem ser o solicitante em ordem nenhuma. Sem retry, sem sleep, sem reduzir
concorrência. O teste antigo reproduzia 1/24 isolado; o corrigido passou 40/40
isoladas (a taxa antiga prevê cerca de 1,7 falhas em 40, então 0/40 é só indício; a
garantia vem de a autoaprovação ser logicamente impossível na nova composição).

### AF.4 Outras verificações

- Concorrência isolada e em conjunto: `ledgerLockOrder` (8), `needFulfillmentPhysical`
  (31), `needFulfillmentCorrections` (44) e `needsStatus` (17) passam sozinhos e juntos
  (100/100); sem conexões órfãs (`pg_stat_activity` vazio) nem locks pendurados.
- Maior duração de teste nas três execuções: 8,4 s (testes de timeout da Fase 53),
  contra o limite padrão de 15 s; os testes de concorrência desta frente ficaram em
  ≤ 5,3 s. Não há indício de falha por timeout.
- **Esperas temporais** nos testes de lock (`setTimeout`/`sleep`): as de 400 ms antes de
  `expect(finished).toBe(false)` só podem falhar se o lock **não** bloquear (a prova do
  controle negativo); duas são prazos que, em tese, sob CPU muito carregada poderiam
  falhar sem bug — o `Promise.race` de 3 s em `needFulfillmentPhysical` (decisão não
  pode esperar) e o `sleep(400)` seguido de `expect(finished).toBe(true)` para o
  `FOR KEY SHARE` em `ledgerLockOrder`. **Não foram observadas falhando e não foram
  alteradas** (a investigação não as incriminou); ficam registradas como fragilidade
  teórica.
- `needs-status_POST`, locks, ledger, estoque, matching e aprovação **não foram
  tocados**.

### AF.5 Contagem

Continua **543** (460 → 504 → 543); a correção alterou um teste existente, não
adicionou nenhum.


---

## AG. Fase 94 — política de excedentes: DECISÃO DE PRODUTO (dono) e comparação com a implementação

**Decisão (tomada pelo dono, pós-Fase 94):** permitir recebimentos acima da quantidade alocada ou necessária, sem bloquear o registro da realidade física. Isto **confirma e fecha** o que a seção D.1 recomendava (P-L1/P-L2, já CONFIRMADAS na Fase 78) e acrescenta um requisito: o excedente de um **recebimento** deve ser **identificável na auditoria**.

| Regra decidida | Já estava implementada? | Prova |
|---|---|---|
| recebido < alocado ⇒ parcial, sem bloqueio; = alocado ⇒ fluxo normal | **Sim** (nenhuma checagem de teto em `allocations-receive`) | `test/surplusPolicy.test.ts` (60, 100) |
| recebido > alocado ⇒ permitido; o ledger registra o valor REAL, sem corte | **Sim** | idem (130 contra 100: linha `original` = 130; estoque +130) |
| progresso derivado do ledger: `fulfilled` total, `requiredRemaining = max(0, needed − fulfilled)`, `surplus = max(0, fulfilled − needed)` | **Sim** (`needFulfillment.tsx`, fórmula única) | 250+120 contra 300 ⇒ `{370, 0, 70}` |
| correção que ultrapassa alocado/necessário ⇒ permitida, motivo obrigatório, indicador de excedente | **Sim** (permitida, motivo obrigatório; indicador do EXCEDENTE DA NECESSIDADE em `excedente`/`excedenteAnterior`) | correção 100→150 contra 120 |
| excedente não é nova doação nem migra para outra necessidade | **Sim** (doação = entrada física; ledger não transfere) | relatório: 1 doação; outra necessidade intacta |
| permissões, dupla aprovação, auditoria e demais integridades continuam | **Sim** | 403 sem permissão; correção negativa e estorno ⇒ 202 + aprovação por outra pessoa |
| excedente de um RECEBIMENTO identificável na auditoria, com ids e valores | **NÃO — lacuna fechada nesta fase** | abaixo |

**Lacuna e correção mínima.** O evento `atribuicao.recebida` só levava item, quantidade recebida e movimento de estoque; não dizia se o recebimento passou do alocado nem do necessário. Agora o metadata (só ids e números) inclui: `needId`, `quantidadeAlocada`, `acimaDaAlocacao` (boolean), `excedenteAlocacao` (`max(0, recebido − alocado)`), `excedenteNecessidade` (quanto **este** recebimento acrescentou ao `surplus` da necessidade; 0 se a unidade divergiu e a linha não conta) e `progressoNecessidade` (`{fulfilled, requiredRemaining, surplus}` após o recebimento, ou `null` sem necessidade). Os eventos `atribuicao.recebimento_corrigido` / `_estornado` ganharam `quantidadeAlocada`, `acimaDaAlocacao` e `excedenteAlocacao` (relativos à quantidade resultante; estorno ⇒ 0) além dos `excedente`/`excedenteAnterior` já existentes. Nada é bloqueado e nenhuma validação foi removida (quantidade, limites, locks, aprovação).

**Testes (`test/surplusPolicy.test.ts`, 13, Postgres descartável):** recebimento inferior/igual/superior ao alocado; superior ao necessário (incremento de excedente por recebimento, inclusive com a necessidade já satisfeita); sem transferência e sem inflar doações (relatório reconcilia: entradas, necessidade, estoque); correção positiva que gera excedente (par `reversal`+`correction`, original preservado, +físico, auditoria); sem motivo ⇒ 400; correção negativa com dupla aprovação e auditoria do aprovador; sem permissão ⇒ 403 sem efeito; estorno com retirada física (original intacto, excedente some, estoque −400) e estorno só contábil (estoque inalterado). Controle: sem as mudanças de auditoria 6 testes falham (os de indicador) e os de comportamento passam — confirmando que só o indicador era lacuna.
