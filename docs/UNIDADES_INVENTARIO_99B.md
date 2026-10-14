# Fase 99B — inventário de unidades e vocabulário controlado

**Escopo:** somente leitura. Nenhuma tabela, migration, constraint, fluxo de escrita, ledger, estoque ou valor armazenado foi alterado. Classificar **não é converter nem corrigir**; a regularização auditável é a Fase 99C. Contrato de produto: `docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md`, seção 10.

Código: `src/helpers/unitVocabulary.ts` (vocabulário e classificação, puro), `src/helpers/unitInventory.ts` (agregação por organização), `src/endpoints/unit-inventory_GET.ts` (endpoint), `src/pages/organizacoes.$organizationId.unidades.tsx` (painel), `src/components/UnitText.tsx` (marcador discreto nas telas existentes).

## 1. Onde a unidade adquire significado de negócio

Há **seis colunas** `unit` no schema (`db/schema.sql`); `stock_transactions` **não** tem unidade — o saldo é expresso na unidade do item. O teste `test/unitInventory.test.ts` (caso 13) lê o schema e falha se aparecer uma coluna `unit` que não esteja no inventário.

| Origem (tabela.campo) | Anulável | Como o valor nasce | Onde vira significado de negócio |
|---|---|---|---|
| `inventory_items.unit` | não | texto livre digitado no formulário de item (`inventory-items_POST`) | unidade de **todo** o saldo; copiada para o ledger no recebimento da rede (`allocations-receive_POST`) |
| `needs.unit` | não | texto livre (`needs_POST`) | comparada à do item por `normalize()` em `createNeedFulfillment` (define `is_countable` e `unit_mismatch_note`) e no matching (`opportunityMatching.tsx`, critério de quantidade) |
| `donation_opportunities.unit` | sim | texto livre (`opportunities_POST`) | **não é lida** no recebimento local (`opportunities-receive_POST`) |
| `opportunity_registry.unit` | sim | texto livre (`opportunity-registry_POST`, só admin da plataforma) | comparada por `normalize()` com a unidade da necessidade no matching (quantidade nunca é comparada se divergir); **não é lida** no recebimento (`allocations-receive_POST`) |
| `organization_capacities.unit` | não | texto livre (`organization-capacities_POST`) | comparada por `normalize()` à unidade da oferta e ao uso de estoque (item × categoria × unidade) no matching |
| `need_fulfillments.unit` | não | copiada de `inventory_items.unit` no recebimento (imutável) | base de `computeNeedProgress` (soma só o que `is_countable`) |

Comparações existentes (todas por texto, **nenhuma** é conversão): `normalize()` de `opportunityMatching.tsx` (aparar, NFD sem acento, minúsculas) usado no matching, em `createNeedFulfillment` e no uso de capacidade. A Fase 99B **não** altera nenhuma delas.

## 2. Valores efetivamente encontrados

Todas as contagens abaixo são **agregadas** (GROUP BY), sem conteúdo de registros.

**Observados em banco (não é produção):** consulta somente leitura (`BEGIN READ ONLY`) ao banco **local de desenvolvimento** `levora_solidaria` (`localhost`, confirmado pelo `current_database()` antes das consultas), em 2026-10-14:

| Tabela | Valores (ocorrências) |
|---|---|
| `inventory_items` | `unidade` (1), `kg` (1) |
| `needs` | `kg` (5), `unidade` (2), `cestas` (1) |
| `donation_opportunities` | (vazia) |
| `opportunity_registry` | NULL (4), `unidade` (1) |
| `organization_capacities` | `kg` (1) |
| `need_fulfillments` | `kg` (5) |

Também foram observados, pelos testes de integração e pela semente do `qa:visual`, bancos **descartáveis** `_test`/`_qa` com dados sintéticos (valores plantados de propósito para cobrir cada classe).

**Encontrados apenas no código** (fixtures, testes, sementes e documentação; **não** observados em banco real): `kg`, `KG`, ` KG `, `unidade`, `unidades`, `litro`, `litros`, `ml`, `caixa`, `x`, `peça`, `galões` (testes e fixtures); `kg`, `un` (`db/seedStaging.ts`). **Nenhum banco de staging ou produção foi consultado**; os valores reais desses ambientes são desconhecidos e podem incluir outros textos — por isso o diagnóstico existe: ele os mostra por organização.

## 3. Vocabulário canônico (`unitVocabulary`)

Só entram aliases **comprovados** (mesma unidade, não semelhança):

| id canônico | rótulo | dimensão | grafias reconhecidas | critério |
|---|---|---|---|---|
| `quilograma` | kg | massa | `kg` (também `KG`, ` KG ` por caixa/espaços) | símbolo; diferença só de caixa e espaços |
| `unidade` | unidade | contagem | `unidade`, `unidades` | singular/plural da mesma palavra |
| `litro` | litro | volume | `litro`, `litros` | singular/plural da mesma palavra |
| `mililitro` | ml | volume | `ml` | símbolo; **não** é alias de litro |
| `caixa` | caixa | embalagem | `caixa`, `caixas` | singular/plural; embalagem **não** equivale a unidades de conteúdo |

**Ambíguos** (não classificados automaticamente; as leituras plausíveis são só informativas para o revisor): `un` (provável `unidade`, não revisado), `galão`, `galões` (recipiente ou medida de volume).

Classes retornadas por `classifyUnit`: `canonica`, `alias`, `ambigua`, `desconhecida`, `ausente`. O **valor bruto volta sempre idêntico**; o identificador canônico só é preenchido para `canonica`/`alias`. Chave de comparação: aparar, colapsar espaços, minúsculas, NFC — **sem remover acento** (diferente do `normalize()` do matching). Não existe fator de conversão em lugar nenhum.

**Desconhecidos** (exemplos reais ou de código sem prova de equivalência): `cestas` (observado no banco de desenvolvimento), `x`, `peça`. `cestas` é provavelmente embalagem, mas isso **não está provado** e fica `desconhecida` até revisão humana. `L`, `g`, `quilo`, `mililitro` (por extenso) também são `desconhecida`: nenhum é aceito por semelhança.

## 4. Diagnóstico administrativo

- **Rota:** `/organizacoes/:organizationId/unidades` (aba "Unidades"), `GET /_api/v1/unit-inventory`.
- **Autorização (no servidor):** membro **ativo** com a permissão existente `organizacao.gerencie` (proprietário e administrador), via `requirePermissionToRead`. Operador, voluntário, membro inativo, não-membro e anônimo são recusados (401/403). **Admin da plataforma sem vínculo não ganha acesso** — não há visão global nesta fase (limitação documentada: um inventário global dependeria de uma permissão de plataforma própria, que não foi criada).
- **Escopo:** sempre a organização informada. `opportunity_registry` (global) entra **somente** pelas ofertas atribuídas à própria organização.
- **Consulta:** `GROUP BY` no banco por origem (sem varrer registros no cliente), `LIMIT 501` por origem (aviso de truncamento). Usa os índices por organização existentes; nenhum índice ou migration novo.
- **Resposta:** só `(origem, valor bruto, ocorrências, classificação, unidade canônica, explicação)` — sem IDs, títulos, nomes ou contatos. Filtros: origem, classificação e trecho do valor (os totais independem dos filtros).
- **Somente leitura:** nenhum botão de correção; teste de integração compara o estado completo das tabelas antes/depois e um teste estático proíbe `INSERT/UPDATE/DELETE` no endpoint e no helper.
- **Telas existentes:** `UnitText` mostra a unidade **como gravada** (nunca troca por uma presumida) e só acrescenta "(a classificar)" para valores ambíguos/desconhecidos, em Estoque, Necessidades (quantidade necessária) e Oportunidades. Nenhum formulário de escrita foi alterado.

## 5. Pendências para a Fase 99C

Sem esta fase: inventário em **ambientes reais** (staging/produção) e revisão humana dos valores `ambigua`/`desconhecida`; decisão de quais viram alias; adoção do vocabulário nos fluxos de **escrita** (formulários, recebimento, matching); caso de regularização, conferência física, correção cadastral auditada e fila de pendências; visão global de plataforma (se desejada).
