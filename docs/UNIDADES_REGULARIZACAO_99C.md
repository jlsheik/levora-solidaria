# Fase 99C — regularização auditável de unidades e recebimento seguro

Contrato de produto: `docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md`, seção 10 (D-6). Base: `docs/UNIDADES_INVENTARIO_99B.md`. Esta fase **não** cria a tabela de destinações, **não** muda o significado de `atendida`, **não** altera o ledger `need_fulfillments` (continua sendo suprimento recebido da rede) e **não** converte unidades.

## 1. O que existe agora

| Peça | Arquivo | Resumo |
|---|---|---|
| Vocabulário nos fluxos de escrita | `src/helpers/unitVocabulary.ts`, `src/helpers/unitInput.ts` | `canonicalizeUnitForWrite`, `unitsEquivalent`, `checkOfferUnitAgainstItem`; schemas dos cinco escritores usam `requiredUnitInput`/`optionalUnitInput` |
| Casos de regularização | `db/migrations/0016_unit_regularization.sql`, `src/helpers/unitRegularization.tsx` | `unit_regularization_cases` (estado) + `unit_regularization_events` (histórico append-only) |
| Lançamento do recebimento | `src/helpers/receiptPosting.tsx` | código **único** (extraído, sem mudança de comportamento) usado pelo recebimento normal e pela conclusão de um caso |
| Recebimento | `allocations-receive_POST`, `opportunities-receive_POST` | compatível → fluxo normal; divergente → caso (HTTP 202, nada lançado) |
| Endpoints do caso | `unit-regularization-{cases_GET,confer_POST,validate_POST,close_POST,correct_POST,correct-offer_POST,platform_GET}` | fila, conferência, validação, encerramento, correção cadastral (doação local e oferta da rede) |
| Interface | `/organizacoes/:id/regularizacao`, seção em `/plataforma`, aviso em Rede Levora, `UnitSelect` nos formulários | fila de pendências, diálogos, correção da oferta da rede pela plataforma |
| Proteções | `expireAssignmentDeadlines`, `allocations-logistics_POST` | atribuição com caso ativo não expira por prazo e não pode ser cancelada |

## 2. Escritores de unidade e validação

Todas as colunas `unit` com escritor próprio passam pelo vocabulário. Auditoria por busca no código (teste `unitWriteValidation` caso 8):

| Campo | Escritor | Regra para NOVOS registros |
|---|---|---|
| `inventory_items.unit` | `inventory-items_POST` | obrigatória; canônica ou alias; grava o rótulo canônico |
| `needs.unit` | `needs_POST` (a edição `need-details_POST` **não** altera unidade) | idem |
| `organization_capacities.unit` | `organization-capacities_POST` | idem |
| `donation_opportunities.unit` | `opportunities_POST` | opcional; vazio vira NULL (nada é inventado) |
| `opportunity_registry.unit` | `opportunity-registry_POST` (admin da plataforma; conectores usam o mesmo endpoint) | opcional; idem |
| `need_fulfillments.unit` | `createNeedFulfillment` | **copia** a unidade do item no recebimento; não há entrada do usuário |

- **Alias → rótulo canônico:** `unidades` grava `unidade`; `KG`, ` kg ` gravam `kg`; `Litros` grava `litro`. O contrato é compatível porque os rótulos (`kg`, `unidade`, `litro`, `ml`, `caixa`) já eram os valores correntes.
- **Recusa:** `un`, `galão(ões)`, `cestas`, `x`, `peça` etc. → HTTP 400 com a mensagem "A unidade … não é reconhecida/é ambígua … Escolha uma destas: kg, unidade, litro, ml, caixa." (sem SQL ou detalhes internos).
- **Histórico:** nenhum backfill, nenhum `UPDATE` em massa; registro antigo com unidade fora do vocabulário continua legível e editar outro campo não o altera.
- **Interface:** os formulários de item, necessidade, doação local, capacidade e oferta da rede usam `UnitSelect` (só o vocabulário; um valor histórico já gravado continua visível como "valor histórico").
- **Sementes:** `db/seedStaging.ts` usava `un` (ambíguo) e passou a `unidade`; a semente do `qa:visual` insere valores históricos diretamente de propósito (diagnóstico).
- **Matching e ledger:** as comparações `normalize(a) === normalize(b)` de unidade (matching: quantidade e capacidade; `createNeedFulfillment`; correções do ledger) passam a `unitsEquivalent`: **iguais se forem a mesma unidade canônica; sem classificação, só o mesmo texto** (comportamento anterior preservado para valores desconhecidos). Efeito: só um novo alias comprovado (ex.: `unidades` × `unidade`) passa a ser reconhecido; nenhum limiar, peso ou critério mudou e nada passa a ser inferido.

## 3. Recebimento com divergência

Compatibilidade (`checkOfferUnitAgainstItem`): unidade da **oferta** × unidade **do item**.

| Situação | Resultado |
|---|---|
| mesma unidade canônica (ou alias) / mesmo texto | **fluxo normal** (200): estoque, ledger e status `recebida` como antes |
| oferta **sem unidade** | **fluxo normal**. *Transição deliberada:* a quantidade digitada por quem recebeu é uma observação física na unidade do item que a tela mostra; bloquear toda oferta sem unidade (a maioria das ofertas da rede tem unidade NULL) impediria recebimentos legítimos. A ausência é registrada pela própria ausência de unidade na oferta (documentado na seção 10.4 da especificação, que previa o contrário) |
| unidades diferentes (`caixa` × `unidade`) | **caso** `unidade_diferente` |
| sem equivalência comprovada (`x` × `kg`, `un` × `unidade`) | **caso** `unidade_nao_classificada` |

Com divergência: **nada** é lançado (nem `stock_transactions`, nem `need_fulfillments`, nem atendimento); a atribuição/doação **não** muda de status (continua `aceita`/`em_coleta`/`em_transporte` ou a doação não `recebida`); o caso preserva a quantidade/unidade **ofertadas**, a quantidade **informada** por quem recebeu (sem unidade confirmada), o item e a unidade do item, as observações, quem abriu e quando (relógio do servidor). A resposta é **HTTP 202** com `pendingRegularization` e a atribuição aparece como "pendente de regularização" na Rede Levora.

Os quatro estados distinguíveis: (1) ainda não chegou = atribuição sem caso e não recebida; (2) chegou, pendente = caso `aberto`/`conferido`; (3) regularizado e lançado = caso `resolvido` + atribuição `recebida`; (4) não validado = caso `encerrado` ou `corrigido`. Nenhum status novo foi criado no enum: o estado "pendente" é **derivado do caso ativo** (índice único parcial), o que evita alterar todas as leituras, transições, scheduler e telas de status.

## 4. O caso: abertura, revisão e resolução

Estados: `aberto` → `conferido` → `resolvido` (lança o recebimento); `aberto|conferido` → `corrigido` (cadastro corrigido; nada lançado) ou `encerrado` (sem resolução; nada lançado); `conferido` → `aberto` (conferência devolvida). `resolvido`, `corrigido` e `encerrado` são terminais (gatilho no banco).

| Ação | Quem | Efeito |
|---|---|---|
| Ver a fila | `logistica.gerencie` (proprietário, administrador, operador) | só da própria organização |
| **Conferir** quantidade na unidade do item | `logistica.gerencie` | `conferido`; exige quantidade (positiva, ≤ 3 casas, ≤ 999.999.999,999, finita) e motivo ≥ 10 caracteres; **não lança nada** |
| **Validar** (aprovar/devolver) | `organizacao.gerencie` | aprovar **lança o recebimento uma vez**: entrada de estoque na unidade do item com a quantidade **conferida**, ledger (rede), status `recebida`, vínculo `resolved_stock_transaction_id`; devolver volta a `aberto` com motivo |
| Segunda validação | — | quem conferiu não valida a própria conferência, **salvo** se for o único proprietário/administrador ativo (decidido sob trava): aceito e marcado `without_second_validation` na auditoria e na fila. Conferir e validar no mesmo ato só vale nesse caso |
| **Corrigir unidade da doação local** | `organizacao.gerencie` | valor anterior/novo/motivo; a unidade nova precisa ser do vocabulário e **compatível** com a do item; caso `corrigido`; **não lança estoque** |
| **Corrigir unidade da oferta da rede** | admin da plataforma (`unit-regularization-correct-offer`) | idem; só se nenhuma outra atribuição da oferta já foi `recebida` com a unidade antiga (senão 409: o histórico não é reinterpretado; segue por conferência) |
| **Encerrar sem resolução** | `organizacao.gerencie` | categoria (`conversao_nao_suportada` ou `informacao_insuficiente`) + motivo; nada é lançado; um novo recebimento abre outro caso |

Sem permissão nova: reaproveita `logistica.gerencie` e `organizacao.gerencie`; o admin da plataforma só corrige a **própria oferta** (único ato transversal) e vê o mínimo (organização, título, unidades, quantidade).

Pendências de **revisão humana do vocabulário** (alias novo ou nova unidade canônica) **não** têm tela nesta fase: a criação de unidade canônica continua sendo uma mudança de catálogo em código revisada por pessoas (`unitVocabulary.ts`), para nenhuma organização criar interpretações globais conflitantes. Pedido de extensão registrado: `cestas`, `peça`, `un` e `galão` precisam de decisão semântica antes de entrar (ver seção 7).

## 5. Garantias de transação, concorrência e idempotência

- **Atomicidade:** abrir o caso, lançar o recebimento da resolução, atualizar o caso, gravar o evento e auditar são **uma** transação; falha de auditoria injetada no banco reverte tudo e a tentativa seguinte funciona (testes 35/36 e os de abertura/recebimento compatível).
- **Idempotência:** no máximo um caso ativo por atribuição e por doação (índices únicos parciais `uq_unit_regularization_active_*`) + verificação sob trava; retry devolve o mesmo caso (`created: false`), nunca estoque ou caso novo. A Fase 96 (recebimento local idempotente) permanece: a oferta é travada antes do status.
- **Ordem única de travas:** atribuição | doação → item → caso → oferta da rede → auditoria (última, por causa do advisory lock global). Receber, conferir, validar, encerrar, corrigir, expirar (`FOR UPDATE` na atribuição) e a logística respeitam a mesma ordem; teste de operações misturadas não encontra deadlock.
- **Revalidação:** num novo pedido de recebimento com caso ativo, se a unidade da oferta passou a ser compatível, o caso fecha como `corrigido` e o recebimento segue pelo fluxo normal.
- **Integridade no banco:** fatos de origem do caso imutáveis por gatilho; transições permitidas só as listadas; eventos e casos não podem ser alterados/apagados indevidamente; atribuição/doação/item de **outra organização** são rejeitados; `resolved_stock_transaction_id` usa FK composta com a organização.
- **Prazos da Fase 98:** `expireAssignmentDeadlines` não expira atribuição com caso ativo (também no seletor, para não ocupar o lote de 500); a pendência de prazo da tela deixa de aparecer. **Logística da Fase 95:** cancelar com caso ativo é 409; coleta/transporte continuam.

## 6. Migration

`0016_unit_regularization.sql` (**próximo número livre da `master` `30a22cd`, reconfirmado antes de criar**; `0001`–`0015` contíguas). Só `CREATE TABLE`/índices/funções/gatilhos, sem backfill, classificada `safe` / `tabela-nova-vazia`; refletida em `db/schema.sql` (teste de deriva instalação nova × atualização) e em `src/helpers/schema.tsx`. Os trabalhos locais de identidade e de agentes **não** foram tocados nem renumerados e continuarão precisando de renumeração na entrada. Rollback: aditiva e sem dados antigos — remover o código e, se desejado, `DROP` manual das duas tabelas e da função; depois de haver casos reais, o caminho é "para frente".

## 7. Inventário por ambiente e pendências de revisão humana

- **Banco local de desenvolvimento** (consulta somente leitura na 99B): `kg`, `unidade`, `cestas`, NULL. Nesta fase **nenhum banco de staging/produção foi acessado** (sem conexão de leitura autorizada configurada; nenhuma credencial foi buscada).
- **Para um administrador autorizado executar no próprio ambiente** (somente leitura, agregado, sem dados pessoais; rodar em `BEGIN READ ONLY`):

```sql
SELECT 'inventory_items' AS origem, unit AS valor, count(*) AS ocorrencias FROM inventory_items GROUP BY unit
UNION ALL SELECT 'needs', unit, count(*) FROM needs GROUP BY unit
UNION ALL SELECT 'donation_opportunities', unit, count(*) FROM donation_opportunities GROUP BY unit
UNION ALL SELECT 'opportunity_registry', unit, count(*) FROM opportunity_registry GROUP BY unit
UNION ALL SELECT 'organization_capacities', unit, count(*) FROM organization_capacities GROUP BY unit
UNION ALL SELECT 'need_fulfillments', unit, count(*) FROM need_fulfillments GROUP BY unit
ORDER BY origem, ocorrencias DESC;
```

  (Equivalente por organização: a aba **Unidades** da 99B.) O resultado deve ser classificado por pessoas com `classifyUnit`: canônico/alias → nada a fazer; ambíguo/desconhecido → decisão semântica.
- **Pendentes de revisão (não reclassificados):** `un` (provável `unidade`, não comprovado), `galão`/`galões`, `cestas` (provável embalagem), `peça`, `x`. **Pedido de extensão do vocabulário:** cada um precisa de uma decisão de produto (é alias de uma unidade existente? é uma unidade própria, e de que dimensão?) registrada antes de entrar em `unitVocabulary.ts`; nenhum foi aceito automaticamente porque a equivalência não está demonstrada (ex.: `cestas` é embalagem, não unidade de conteúdo; `galão` pode ser recipiente ou volume).

## 8. Limitações e fora de escopo

- Correção cadastral de **item de estoque** e de **necessidade** (unidade) com histórico segue **não implementada**: nenhum endpoint edita unidade no lugar; o procedimento do item substituto (spec 10.3) fica para etapa própria.
- Revisão/aprovação de **aliases** por tela (atribuir alias a unidade existente): sem tela nesta fase; é mudança de catálogo em código.
- Doação local: o caso e a conferência usam o mesmo fluxo, sem comprovante de upload (o recebimento local nunca teve).
- A fila de pendências não tem contador na visão geral nem notificação por e-mail.
- Sem destinação (`stock_destinations`), sem mudança em `atendida` e sem relatório de impacto novo: Fase 99D em diante.
