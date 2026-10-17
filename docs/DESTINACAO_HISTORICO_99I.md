# Fase 99I — aba "Destinação": histórico com filtros

## Escopo formal

Tabela de subfases de `docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md`: **99I Interface de destinação e prestação de contas** (dependências 99C a 99H; critérios F-06, F-07; "QA visual e acessibilidade"), e a seção 14 item 2: *aba "Destinação" — histórico com filtros (período por data efetiva e por data de registro, item, necessidade, finalidade, situação ativa/corrigida/revertida), estados de carregamento, vazio, erro e sem permissão; ações "Corrigir" e "Estornar/devolver"*.

Já existia antes da 99I: diálogo de destinação (99E), necessidades (99F), correção/reversão com histórico no Inventário (99G), prestação de contas com bloco Destinação (99H), fila de pendências de unidade (99C). A 99I entrega a **aba de histórico com filtros e totais**, reaproveitando os mesmos diálogos de ação.

Fora do escopo (decisão conservadora, a especificação não atribui):
- **Exportação**: a especificação não a menciona em nenhuma fase; **não foi implementada** (a resposta da API documenta isso). Se for aprovada no futuro, deve usar `destinationWhere` (filtro único) e `destinationTotals`.
- **Comprovantes** e leitura protegida: 99J. **Validação de ponta a ponta**: 99K. **Administração da plataforma** (item 6 da seção 14) e administração da plataforma ficam para depois.

## Contrato (`GET /stock-destinations`, estende o da 99G)

Parâmetros (todos validados no servidor; inválido = 400): `organizationId`; `from`/`to` datas civis `AAAA-MM-DD`, **ambas inclusivas**, calendário `America/Sao_Paulo`, `from ≤ to`, intervalo máximo de 731 dias; `basis` = `registro` (padrão) | `efetiva`; `destinationType` (uma das oito finalidades); `state` = `ativa` | `parcialmente_revertida` | `revertida` | `com_correcao`; `itemId`, `needId` (filtro na interface: parâmetro `need` da URL); `limit` (1–100, padrão 30); `beforeId` (keyset).

Resposta: `destinations` (como na 99G), `hasMore`, `canReverse`, `filters` (a base de data efetivamente usada) e `totals` (por **unidade**, sobre **todo** o conjunto filtrado, não só a página: registros, físico, revertido, físico líquido, atendimento, excedente).

## Semântica das datas e dos números

- `registro`: `created_at` da destinação **original**, comparado a `[00:00 BRT de from, 00:00 BRT do dia seguinte a to)`; a conversão de fuso é feita **no banco** (`AT TIME ZONE`), nunca no navegador.
- `efetiva`: data da entrega **com a correção documental mais recente de data** (a original permanece intacta). A mesma expressão (`effectiveDateExpr`) é usada pelo relatório da 99H — a 99I passou a compartilhá-la para os dois nunca divergirem (na 99H a data efetiva ignorava correções de data; isto foi alinhado).
- Um evento registrado depois da data efetiva é achado pela base que o usuário escolher; a resposta e a tela dizem qual foi usada.
- **Revertido e situação são o acumulado até hoje**, não "até a data de corte" do intervalo (limitação herdada da 99H, mantida e indicada na tela). Não há visão histórica por data de corte; ela exigiria uma regra própria e não foi inventada.
- Ordenação estável por `id` decrescente (keyset): mudar filtros não altera a ordem relativa e percorrer páginas não repete nem pula.
- Totais nunca somam unidades diferentes. Fórmulas idênticas às da 99H e da 99F (atendimento = `LEAST(aplicada, física − revertida)` só de contabilizáveis). Teste de coerência compara os totais da listagem com `buildImpactReport`.
- Saídas históricas **sem destinação estruturada** não aparecem na lista (não têm finalidade; nada é reclassificado); a tela remete à prestação de contas, onde estão em duas subclasses.

## Permissões e isolamento

Leitura: `inventario.lance` (proprietário, administrador, operador); voluntário = 403. Todas as consultas filtram `organization_id`; `itemId`/`needId`/`beforeId` de outra organização não revelam nada (resultado vazio). As ações de corrigir/reverter são as da 99G (reverter: proprietário/administrador); a listagem não executa nada.

## Interface

Página `/organizacoes/:id/destinacoes` (aba "Destinação" nas demais abas): filtros (data usada, de/até, finalidade, situação, item, limpar), guardados **na URL** (sobrevivem a recarregar e navegar); nota explicando as datas; erro de intervalo com orientação; totais por unidade; cartões responsivos com original, correções e reversões (tipo, se houve movimento físico, motivo, autor) e as ações "Corrigir dados"/"Reverter"; "Mostrar mais" mantém os filtros; estados de carregamento, erro, vazio com orientação e "sem permissão". O Inventário continua com a lista recente sem filtros.

## Testes

`test/destinationHistoryFilters.test.ts` (12, PostgreSQL real): limites 23:59:59/00:00:00 BRT, registro × efetiva, correção de data, finalidade/item/situação/combinações/vazio, paginação estável com e sem filtro, totais por unidade coerentes com a 99H, validação (11 entradas inválidas), permissões, isolamento e leitura sem escrita. Sensibilidade comprovada para: fuso (UTC no lugar de Brasília), data efetiva sem correções e limite do keyset. `qa:visual`: 6 cenários novos (perfil `ci`: 64).

## Limitações

Sem exportação; sem visão por data de corte; revertido/situação acumulados até hoje; ordenação só por registro mais recente; Edge: ver relatório de gates (execução dependente do ambiente).
